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

import { withTenant } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class LeaveError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'LeaveError';
  }
}

export interface LeaveRequestRow {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  startsOn: string;
  endsOn: string;
  days: string;
  status: string;
  approverId: string | null;
}

const toRow = (r: Record<string, unknown>): LeaveRequestRow => ({
  id: r.id as string,
  employeeId: r.employee_id as string,
  leaveTypeId: r.leave_type_id as string,
  startsOn: r.starts_on as string,
  endsOn: r.ends_on as string,
  days: r.days as string,
  status: r.status as string,
  approverId: (r.approver_id as string | null) ?? null,
});

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

export interface ApplyLeaveInput {
  employeeId: string;
  leaveTypeId: string;
  startsOn: string;
  endsOn: string;
  days: number;
  reason: string;
  halfDay?: 'first_half' | 'second_half';
}

/**
 * Apply for leave. Deliberately does *not* touch the balance: an application
 * is a request, and reserving days on application is how balances drift when
 * requests are abandoned.
 */
export async function applyForLeave(
  caller: Caller,
  input: ApplyLeaveInput,
): Promise<LeaveRequestRow> {
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
        input.employeeId, input.leaveTypeId, input.startsOn, input.endsOn,
        input.days, input.halfDay ?? null, input.reason,
        approver.rows[0]?.manager_id ?? null,
      ],
    );
    return toRow(rows[0]!);
  });
}

/**
 * Approve a request and debit the balance, atomically.
 */
export async function approveLeave(
  caller: Caller,
  requestId: string,
): Promise<LeaveRequestRow> {
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

    return toRow(updated.rows[0]!);
  });
}

/** Cancelling an approved request credits the days back. */
export async function cancelLeave(caller: Caller, requestId: string): Promise<LeaveRequestRow> {
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
    return toRow(updated.rows[0]!);
  });
}
