/**
 * Leave — the reference slice for a guarded state transition.
 *
 * The frontend contract says approving a leave request debits the balance, and
 * that a request cannot be approved twice. Both belong here, in one
 * transaction, for reasons the mock could only imitate:
 *
 *   - The debit and the status change commit together or not at all.
 *   - `SELECT ... FOR UPDATE` serialises two approvers clicking at once. The
 *     mock could not race; a real API does, and "check then write" without a
 *     lock is where double-debits come from.
 *   - The ledger has a partial unique index on (request, 'approval'), so even
 *     a bug that got past both would be refused by the database.
 *
 * Three layers for one rule is not paranoia. It is the rule that decides
 * whether somebody is paid for a day they did not work.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import { toBalanceRow, toHalfDayColumn, toLeaveRequest } from './mapper.ts';
import type { LeaveBalanceRow, LeaveRequest } from './mapper.ts';

export type { LeaveBalanceRow, LeaveRequest };

/**
 * Every read joins leave_type so the screens get the code they filter by
 * ('CL', 'EL') rather than the uuid the row stores.
 */
const REQUEST_PROJECTION = `
  SELECT lr.id, lr.employee_id, lt.code AS type_code, lr.starts_on, lr.ends_on,
         lr.days, lr.half_day, lr.reason, lr.status, lr.approver_id,
         lr.applied_on, lr.acted_on, lr.approver_note
    FROM leave_request lr
    JOIN leave_type lt ON lt.id = lr.leave_type_id`;

export class LeaveError extends Error {
  /*
   * Declared rather than a constructor parameter property: Node runs this file
   * by stripping types, which cannot synthesise the assignment a parameter
   * property implies. It typechecks either way, so the failure only appears at
   * runtime.
   */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'LeaveError';
    this.code = code;
  }
}


/** The leave year a date falls in, per the tenant's configured start month. */
async function leaveYearStart(db: TenantClient, onDate: string): Promise<string> {
  const { rows } = await db.query(
    `SELECT make_date(
              CASE WHEN EXTRACT(MONTH FROM $1::date) >= t.fiscal_year_start_month
                   THEN EXTRACT(YEAR FROM $1::date)::int
                   ELSE EXTRACT(YEAR FROM $1::date)::int - 1 END,
              t.fiscal_year_start_month, 1) AS year_start
       FROM tenant t WHERE t.id = current_tenant_id()`,
    [onDate],
  );
  const row = rows[0];
  if (!row) throw new LeaveError('tenant not found', 'no_tenant');
  return row.year_start as string;
}

/**
 * Re-read a request through the same projection the list uses.
 *
 * A mutation returning its own RETURNING row is how a create and a fetch end
 * up shaped differently — the create lacks the joined type code, and the bug
 * only shows after a refresh makes it reappear correctly.
 */
async function reload(db: TenantClient, id: string): Promise<LeaveRequest> {
  const { rows } = await db.query(`${REQUEST_PROJECTION} WHERE lr.id = $1`, [id]);
  if (!rows[0]) throw new LeaveError('no such leave request', 'not_found');
  return toLeaveRequest(rows[0]);
}

export interface ApplyLeaveInput {
  employeeId: string;
  /** The screens work in codes ('CL', 'EL'); the uuid is resolved here. */
  typeCode: string;
  startsOn: string;
  endsOn: string;
  days: number;
  reason: string;
  half?: string | null;
}

/**
 * Apply for leave. Deliberately does *not* touch the balance: an application
 * is a request, and reserving days on application is how balances drift when
 * requests are abandoned.
 */
export async function applyForLeave(
  caller: Caller,
  input: ApplyLeaveInput,
): Promise<LeaveRequest> {
  if (caller.role !== 'admin' && input.employeeId !== caller.employeeId) {
    throw new LeaveError('you can only apply for your own leave', 'forbidden');
  }
  if (input.days <= 0) throw new LeaveError('a request must be at least half a day', 'invalid');

  return withTenant(caller, async (db) => {
    const overlap = await db.query(
      `SELECT 1 FROM leave_request
        WHERE employee_id = $1
          AND status IN ('pending', 'approved')
          AND daterange(starts_on, ends_on, '[]') && daterange($2::date, $3::date, '[]')`,
      [input.employeeId, input.startsOn, input.endsOn],
    );
    if ((overlap.rowCount ?? 0) > 0) {
      throw new LeaveError('those dates overlap a request you already have', 'overlap');
    }

    const type = await db.query('SELECT id FROM leave_type WHERE code = $1 AND active',
      [input.typeCode]);
    if (type.rowCount === 0) throw new LeaveError('no such leave type', 'invalid');

    const approver = await db.query(
      'SELECT manager_id FROM employee WHERE id = $1',
      [input.employeeId],
    );

    const { rows } = await db.query(
      `INSERT INTO leave_request
         (employee_id, leave_type_id, starts_on, ends_on, days, half_day, reason, approver_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.employeeId, type.rows[0].id, input.startsOn, input.endsOn,
        input.days, toHalfDayColumn(input.half ?? null), input.reason,
        approver.rows[0]?.manager_id ?? null,
      ],
    );
    return reload(db, rows[0]!.id as string);
  });
}

/**
 * Approve a request and debit the balance, atomically.
 */
export async function approveLeave(
  caller: Caller,
  requestId: string,
): Promise<LeaveRequest> {
  if (caller.role === 'employee') {
    throw new LeaveError('only a manager or admin may approve leave', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    // FOR UPDATE, not a plain SELECT: two approvers pressing at the same
    // moment would otherwise both read 'pending' and both debit.
    const { rows } = await db.query(
      'SELECT * FROM leave_request WHERE id = $1 FOR UPDATE',
      [requestId],
    );
    const request = rows[0];
    if (!request) throw new LeaveError('no such leave request', 'not_found');

    if (request.status !== 'pending') {
      throw new LeaveError(`this request is already ${request.status}`, 'not_pending');
    }
    if (request.employee_id === caller.employeeId) {
      throw new LeaveError('you cannot approve your own leave', 'self_approval');
    }
    if (caller.role === 'manager') {
      const reports = await db.query(
        `WITH RECURSIVE r AS (
           SELECT id FROM employee WHERE manager_id = $1
           UNION ALL
           SELECT c.id FROM employee c JOIN r ON c.manager_id = r.id
         ) SELECT 1 FROM r WHERE id = $2`,
        [caller.employeeId, request.employee_id],
      );
      if (reports.rowCount === 0) {
        throw new LeaveError('that person is not in your team', 'forbidden');
      }
    }

    const yearStart = await leaveYearStart(db, request.starts_on);

    const balance = await db.query(
      `SELECT id, quota, carried_over, used
         FROM leave_balance
        WHERE employee_id = $1 AND leave_type_id = $2 AND year_start = $3
        FOR UPDATE`,
      [request.employee_id, request.leave_type_id, yearStart],
    );
    const bal = balance.rows[0];
    if (!bal) throw new LeaveError('no leave balance for that type and year', 'no_balance');

    const available = Number(bal.quota) + Number(bal.carried_over) - Number(bal.used);
    if (available < Number(request.days)) {
      throw new LeaveError(
        `only ${available} day(s) available, ${request.days} requested`,
        'insufficient_balance',
      );
    }

    await db.query(
      'UPDATE leave_balance SET used = used + $1, updated_at = now() WHERE id = $2',
      [request.days, bal.id],
    );

    // The partial unique index on (tenant_id, leave_request_id) WHERE
    // reason = 'approval' makes a second debit impossible even if every check
    // above were somehow bypassed.
    await db.query(
      `INSERT INTO leave_ledger
         (employee_id, leave_type_id, year_start, days, reason, leave_request_id, created_by)
       VALUES ($1, $2, $3, $4, 'approval', $5, $6)`,
      [
        request.employee_id, request.leave_type_id, yearStart,
        -Number(request.days), requestId, caller.employeeId,
      ],
    );

    const updated = await db.query(
      `UPDATE leave_request
          SET status = 'approved', approver_id = $1, acted_on = CURRENT_DATE
        WHERE id = $2
        RETURNING *`,
      [caller.employeeId, requestId],
    );

    await db.query(
      `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                              subject_table, subject_id, detail)
       SELECT 'leave', 'approved', $1, COALESCE(e.full_name, 'system'),
              'leave_request', $2, jsonb_build_object('days', $3::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, requestId, request.days],
    );

    return reload(db, requestId);
  });
}

/** Cancelling an approved request credits the days back. */
export async function cancelLeave(caller: Caller, requestId: string): Promise<LeaveRequest> {
  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM leave_request WHERE id = $1 FOR UPDATE',
      [requestId],
    );
    const request = rows[0];
    if (!request) throw new LeaveError('no such leave request', 'not_found');

    if (caller.role !== 'admin' && request.employee_id !== caller.employeeId) {
      throw new LeaveError('you can only cancel your own leave', 'forbidden');
    }
    if (request.status === 'cancelled') {
      throw new LeaveError('already cancelled', 'not_cancellable');
    }
    if (request.status === 'rejected') {
      throw new LeaveError('a rejected request cannot be cancelled', 'not_cancellable');
    }

    if (request.status === 'approved') {
      const yearStart = await leaveYearStart(db, request.starts_on);
      await db.query(
        `UPDATE leave_balance SET used = used - $1, updated_at = now()
          WHERE employee_id = $2 AND leave_type_id = $3 AND year_start = $4`,
        [request.days, request.employee_id, request.leave_type_id, yearStart],
      );
      await db.query(
        `INSERT INTO leave_ledger
           (employee_id, leave_type_id, year_start, days, reason, leave_request_id, created_by)
         VALUES ($1, $2, $3, $4, 'cancellation', $5, $6)`,
        [
          request.employee_id, request.leave_type_id, yearStart,
          Number(request.days), requestId, caller.employeeId,
        ],
      );
    }

    const updated = await db.query(
      `UPDATE leave_request SET status = 'cancelled', acted_on = CURRENT_DATE
        WHERE id = $1 RETURNING *`,
      [requestId],
    );
    return reload(db, requestId);
  });
}

/* ---------------------------------------------------------------------------
 * Reads
 * ------------------------------------------------------------------------- */

/**
 * Requests, narrowed to the caller's scope.
 *
 * `empIds` is a filter the caller may apply *within* what they can already
 * see — never a way to widen it. The scope clause is ANDed last, so a manager
 * asking for someone else's team gets nothing rather than everything.
 */
export async function listLeave(
  caller: Caller,
  q: { empIds?: string[]; status?: LeaveRequest['status'] } = {},
): Promise<LeaveRequest[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (caller.role === 'employee') {
    params.push(caller.employeeId);
    where.push(`lr.employee_id = $${params.length}`);
  } else if (caller.role === 'manager') {
    params.push(caller.employeeId);
    where.push(`(lr.employee_id = $${params.length} OR lr.employee_id IN (
       WITH RECURSIVE r AS (
         SELECT id FROM employee WHERE manager_id = $${params.length}
         UNION ALL
         SELECT c.id FROM employee c JOIN r ON c.manager_id = r.id
       ) SELECT id FROM r))`);
  }

  if (q.empIds?.length) {
    params.push(q.empIds);
    where.push(`lr.employee_id = ANY($${params.length}::uuid[])`);
  }
  if (q.status) {
    params.push(q.status.toLowerCase());
    where.push(`lr.status = $${params.length}`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${REQUEST_PROJECTION}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY lr.applied_on DESC, lr.starts_on DESC`,
      params,
    );
    return rows.map(toLeaveRequest);
  });
}

/** Whether the caller may see this person's balances. */
async function maySee(db: TenantClient, caller: Caller, empId: string): Promise<boolean> {
  if (caller.role === 'admin') return true;
  if (empId === caller.employeeId) return true;
  if (caller.role !== 'manager') return false;
  const r = await db.query(
    `WITH RECURSIVE t AS (
       SELECT id FROM employee WHERE manager_id = $1
       UNION ALL
       SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
     ) SELECT 1 FROM t WHERE id = $2`,
    [caller.employeeId, empId],
  );
  return (r.rowCount ?? 0) > 0;
}

const CURRENT_YEAR_START = `
  make_date(
    CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= t.fiscal_year_start_month
         THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
         ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END,
    t.fiscal_year_start_month, 1)`;

/** The full balance sheet for one person, current leave year. */
export async function balancesFor(caller: Caller, empId: string): Promise<LeaveBalanceRow[]> {
  return withTenantReadOnly(caller, async (db) => {
    if (!(await maySee(db, caller, empId))) return [];
    const { rows } = await db.query(
      `SELECT lt.code AS type_code, lb.quota, lb.carried_over, lb.used
         FROM leave_balance lb
         JOIN leave_type lt ON lt.id = lb.leave_type_id
         JOIN tenant t ON t.id = current_tenant_id()
        WHERE lb.employee_id = $1 AND lb.year_start = ${CURRENT_YEAR_START}
        ORDER BY lt.code`,
      [empId],
    );
    return rows.map(toBalanceRow);
  });
}

/** One type's balance, or null when the person has none of that type. */
export async function balanceFor(
  caller: Caller,
  empId: string,
  typeCode: string,
): Promise<LeaveBalanceRow | null> {
  const all = await balancesFor(caller, empId);
  return all.find((b) => b.type === typeCode) ?? null;
}

/**
 * Balance sheets for several people in one call, keyed by employee id.
 *
 * A team leave screen shows a row per person; without this it would be one
 * query per row.
 */
export async function balancesForMany(
  caller: Caller,
  empIds: string[],
): Promise<Record<string, LeaveBalanceRow[]>> {
  if (!empIds.length) return {};
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT lb.employee_id, lt.code AS type_code, lb.quota, lb.carried_over, lb.used
         FROM leave_balance lb
         JOIN leave_type lt ON lt.id = lb.leave_type_id
         JOIN tenant t ON t.id = current_tenant_id()
        WHERE lb.employee_id = ANY($1::uuid[]) AND lb.year_start = ${CURRENT_YEAR_START}
        ORDER BY lb.employee_id, lt.code`,
      [empIds],
    );
    const out: Record<string, LeaveBalanceRow[]> = {};
    for (const r of rows) {
      const id = r.employee_id as string;
      (out[id] ??= []).push(toBalanceRow(r));
    }
    return out;
  });
}

/**
 * Reject a request.
 *
 * No balance moves: a rejected request was never debited, because the debit
 * happens on approval rather than on application.
 */
export async function rejectLeave(
  caller: Caller,
  requestId: string,
  note?: string,
): Promise<LeaveRequest> {
  if (caller.role === 'employee') {
    throw new LeaveError('only a manager or admin may reject leave', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM leave_request WHERE id = $1 FOR UPDATE', [requestId]);
    const request = rows[0];
    if (!request) throw new LeaveError('no such leave request', 'not_found');
    if (request.status !== 'pending') {
      throw new LeaveError(`this request is already ${request.status}`, 'not_pending');
    }
    if (request.employee_id === caller.employeeId) {
      throw new LeaveError('you cannot reject your own leave', 'self_approval');
    }
    if (!(await maySee(db, caller, request.employee_id as string))) {
      throw new LeaveError('that person is not in your team', 'forbidden');
    }

    await db.query(
      `UPDATE leave_request
          SET status = 'rejected', approver_id = $1, acted_on = CURRENT_DATE,
              approver_note = COALESCE($2, approver_note)
        WHERE id = $3`,
      [caller.employeeId, note ?? null, requestId]);

    return reload(db, requestId);
  });
}
