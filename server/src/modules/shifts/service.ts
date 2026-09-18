/**
 * Shifts and overtime.
 *
 * **A shift here is a region's working hours, not a rotation.** Migration 0015
 * dropped `roster_entry` and made `shift` a working-hours profile tagged once
 * on the employee, because somebody in Chennai working US hours does not
 * rotate — and the important part, the timezone, had nowhere to live in the
 * old model. A 21:30 punch is three hours late or bang on time depending on
 * which clock you measure it against, and the site cannot tell you which.
 *
 * So `rosterFor` returns each person's standing shift across the days asked
 * about rather than a grid somebody fills in, and there is no per-day
 * assignment to make. Changing which hours a person works is a change to the
 * person, which is what `setEmployeeShift` does.
 *
 * **Approving overtime credits comp off in the same transaction.** The
 * approval, the balance and the ledger row all commit together, and
 * `credited_at` is what stops a retry crediting twice. Overtime pay credits
 * nothing; it is picked up by the next payroll run.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class ShiftError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ShiftError';
    this.code = code;
  }
}

export interface Overtime {
  id: string;
  empId: string;
  date: string;
  hours: number;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  compensation: 'Comp Off' | 'Overtime Pay';
  approverId: string | null;
  /** Days of comp off actually credited. 0 for overtime pay, or not yet credited. */
  credited: number;
}

export interface Shift {
  id: string;
  code: string;
  name: string;
  start: string;
  end: string;
  /** The clock these hours are measured against, as an IANA name. */
  timezone: string;
  region: string;
  night: boolean;
  flexible: boolean;
  /** How many people are on this profile, anyone not yet left included. */
  headcount: number;
}

const TO_STATUS: Record<string, Overtime['status']> = {
  pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
};
const TO_COMP: Record<string, Overtime['compensation']> = {
  comp_off: 'Comp Off', overtime_pay: 'Overtime Pay',
};
const FROM_COMP: Record<string, string> = {
  'Comp Off': 'comp_off', 'Overtime Pay': 'overtime_pay',
};

/** Hours of overtime that buy one day of comp off. */
const HOURS_PER_COMP_DAY = 8;

const OT_PROJECTION = `
  SELECT o.id, o.employee_id, o.work_date, o.hours, o.reason, o.status,
         o.compensation, o.approver_id, o.credited_at,
         COALESCE((SELECT sum(l.days) FROM leave_ledger l
                    WHERE l.overtime_id = o.id), 0) AS credited_days
    FROM overtime o`;

const toOt = (r: Record<string, unknown>): Overtime => ({
  id: r.id as string,
  empId: r.employee_id as string,
  date: r.work_date as string,
  hours: Number(r.hours),
  reason: (r.reason as string) ?? '',
  status: TO_STATUS[r.status as string] ?? 'Pending',
  compensation: TO_COMP[r.compensation as string] ?? 'Comp Off',
  approverId: (r.approver_id as string | null) ?? null,
  credited: Number(r.credited_days ?? 0),
});

/**
 * What this caller may see.
 *
 * Admins see everything; a manager sees their line, however deep; everyone
 * else sees only themselves. An admin with no employee row still reads, which
 * is why the null check sits inside the non-admin branch.
 */
function scope(caller: Caller, column: string, params: unknown[]): string {
  if (caller.role === 'admin') return '';
  if (!caller.employeeId) throw new ShiftError('this login has no employee record', 'forbidden');

  params.push(caller.employeeId);
  const p = `$${params.length}`;
  if (caller.role === 'employee') return `${column} = ${p}`;
  return `(${column} = ${p} OR ${column} IN (
     WITH RECURSIVE t AS (
       SELECT id FROM employee WHERE manager_id = ${p}
       UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
     ) SELECT id FROM t))`;
}

/** Everyone under this manager, however deep. Used by the two guarded writes. */
const LINE_SQL = `
  WITH RECURSIVE t AS (
    SELECT id FROM employee WHERE manager_id = $1
    UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
  ) SELECT 1 FROM t WHERE id = $2`;

export async function listOvertime(
  caller: Caller,
  empIds?: string[],
  status?: string,
): Promise<Overtime[]> {
  const params: unknown[] = [];
  const where: string[] = [];

  const scoped = scope(caller, 'o.employee_id', params);
  if (scoped) where.push(scoped);

  if (empIds?.length) {
    params.push(empIds);
    where.push(`o.employee_id = ANY($${params.length}::uuid[])`);
  }
  if (status) {
    const stored = Object.keys(TO_STATUS).find((k) => TO_STATUS[k] === status);
    if (!stored) throw new ShiftError(`unknown status: ${status}`, 'invalid');
    params.push(stored);
    where.push(`o.status = $${params.length}`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${OT_PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY o.work_date DESC, o.created_at DESC`, params);
    return rows.map(toOt);
  });
}

export interface NewOvertime {
  empId?: string;
  date: string;
  hours: number;
  reason: string;
  compensation?: string;
}

/**
 * Claim overtime.
 *
 * The schema caps a claim at twelve hours in a day; anything above that is a
 * data-entry mistake or a working-time problem, and either way is not
 * something to wave through silently. Claiming for somebody else is refused —
 * the person who worked the hours is the one who says so.
 */
export async function raiseOvertime(caller: Caller, draft: NewOvertime): Promise<Overtime> {
  if (!caller.employeeId) {
    throw new ShiftError('this login has no employee record', 'forbidden');
  }
  const empId = draft.empId || caller.employeeId;
  if (empId !== caller.employeeId) {
    throw new ShiftError('you can only claim your own overtime', 'forbidden');
  }
  if (!draft.reason?.trim()) {
    throw new ShiftError('say what the extra hours were for', 'invalid');
  }
  if (!Number.isFinite(draft.hours) || draft.hours <= 0) {
    throw new ShiftError('overtime must be more than zero hours', 'invalid');
  }
  if (draft.hours > 12) {
    throw new ShiftError('more than 12 hours in one day needs an exception, not a claim', 'invalid');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date ?? '')) {
    throw new ShiftError('say which day the hours were worked', 'invalid');
  }

  const comp = FROM_COMP[draft.compensation ?? 'Comp Off'];
  if (!comp) throw new ShiftError(`unknown compensation: ${draft.compensation}`, 'invalid');

  return withTenant(caller, async (db) => {
    /* Hours not yet worked cannot have been worked. */
    const future = await db.query('SELECT $1::date > CURRENT_DATE AS ahead', [draft.date]);
    if (future.rows[0]?.ahead) {
      throw new ShiftError('that day has not happened yet', 'invalid');
    }

    const { rows } = await db.query(
      `INSERT INTO overtime (employee_id, work_date, hours, reason, compensation)
       VALUES ($1, $2::date, $3, $4, $5)
       RETURNING id`,
      [empId, draft.date, draft.hours, draft.reason.trim(), comp]);

    const back = await db.query(`${OT_PROJECTION} WHERE o.id = $1`, [rows[0]!.id]);
    return toOt(back.rows[0]!);
  });
}

/** The leave year a date falls in, per the tenant's configured start month. */
async function leaveYearStart(db: TenantClient, onDate: string): Promise<string> {
  const { rows } = await db.query(
    `SELECT make_date(
              CASE WHEN EXTRACT(MONTH FROM $1::date) >= t.fiscal_year_start_month
                   THEN EXTRACT(YEAR FROM $1::date)::int
                   ELSE EXTRACT(YEAR FROM $1::date)::int - 1 END,
              t.fiscal_year_start_month, 1) AS year_start
       FROM tenant t WHERE t.id = current_tenant_id()`, [onDate]);
  const row = rows[0];
  if (!row) throw new ShiftError('tenant not found', 'not_found');
  return row.year_start as string;
}

/**
 * Approve or reject a claim.
 *
 * Comp off is credited here, in the same transaction, guarded by
 * `credited_at`: an approval retried after a failed response must not credit
 * the balance twice. The approver is the session, not a name in the body — an
 * approval that took its approver from the request would let anyone sign
 * anyone else's.
 */
export async function actOnOvertime(
  caller: Caller,
  id: string,
  decision: 'approved' | 'rejected',
): Promise<Overtime> {
  if (caller.role === 'employee') {
    throw new ShiftError('only a manager or admin may act on overtime', 'forbidden');
  }
  if (!caller.employeeId) {
    /* An approval names its approver — the CHECK on the row insists on it. */
    throw new ShiftError(
      'this login is not an employee, so it cannot be recorded as the approver', 'forbidden');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new ShiftError(`unknown decision: ${decision}`, 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cur = await db.query(
      `SELECT id, employee_id, work_date, status, hours, compensation, credited_at
         FROM overtime WHERE id = $1 FOR UPDATE`, [id]);
    const row = cur.rows[0];
    if (!row) throw new ShiftError('no such overtime claim', 'not_found');

    if (row.status !== 'pending') {
      throw new ShiftError(`that claim was already ${row.status}`, 'already_decided');
    }
    if (row.employee_id === caller.employeeId) {
      throw new ShiftError('you cannot approve your own overtime', 'self_approval');
    }
    /* A manager may only act on their own line; an admin on anyone's. */
    if (caller.role === 'manager') {
      const mine = await db.query(LINE_SQL, [caller.employeeId, row.employee_id]);
      if (!mine.rowCount) throw new ShiftError('that person is not in your team', 'forbidden');
    }

    await db.query(
      `UPDATE overtime
          SET status = $2, approver_id = $3, approved_on = CURRENT_DATE
        WHERE id = $1`, [id, decision, caller.employeeId]);

    /*
     * Eight hours of overtime is one day of comp off, rounded down: a part-day
     * credit is not something the leave ledger can hold, and rounding up would
     * hand out a full day for five hours' work.
     */
    if (decision === 'approved' && row.compensation === 'comp_off' && !row.credited_at) {
      const days = Math.floor(Number(row.hours) / HOURS_PER_COMP_DAY);
      if (days > 0) {
        const yearStart = await leaveYearStart(db, row.work_date as string);
        const type = await db.query("SELECT id FROM leave_type WHERE code = 'CO' AND active");
        /*
         * No comp-off leave type configured is a setup gap, not a reason to
         * refuse hours that were genuinely worked. The approval stands and
         * credited_at is left unset, so the credit can still be made once the
         * type exists rather than being lost silently.
         */
        if (type.rows[0]) {
          const typeId = type.rows[0].id as string;
          await db.query(
            `INSERT INTO leave_balance (employee_id, leave_type_id, year_start, quota)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, employee_id, leave_type_id, year_start)
             DO UPDATE SET quota = leave_balance.quota + EXCLUDED.quota, updated_at = now()`,
            [row.employee_id, typeId, yearStart, days]);

          await db.query(
            `INSERT INTO leave_ledger
               (employee_id, leave_type_id, year_start, days, reason, overtime_id, note, created_by)
             VALUES ($1, $2, $3, $4, 'comp_off_credit', $5, $6, $7)`,
            [row.employee_id, typeId, yearStart, days, id,
              `${Number(row.hours)} hours on ${row.work_date}`, caller.employeeId]);

          await db.query('UPDATE overtime SET credited_at = now() WHERE id = $1', [id]);
        }
      }
    }

    const back = await db.query(`${OT_PROJECTION} WHERE o.id = $1`, [id]);
    return toOt(back.rows[0]!);
  });
}

/**
 * The shift profiles this tenant runs, with how many people are on each.
 *
 * Headcount comes back with the profile rather than from a second call: the
 * only reason to list shifts is to see who works when, and four names with no
 * numbers beside them answer nothing.
 */
export async function listShifts(caller: Caller): Promise<Shift[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT s.id, s.code, s.name, s.starts_at, s.ends_at, s.timezone,
              COALESCE(s.region, '') AS region, s.is_night, s.is_flexible,
              -- Not status = 'active': somebody serving notice still works
              -- the shift, and leaving them out understates every rota.
              (SELECT count(*)::int FROM employee e
                WHERE e.shift_id = s.id AND e.status <> 'exited') AS headcount
         FROM shift s WHERE s.active ORDER BY s.code`);
    return rows.map((r) => ({
      id: r.id as string,
      code: r.code as string,
      name: r.name as string,
      start: (r.starts_at as string | null)?.slice(0, 5) ?? '—',
      end: (r.ends_at as string | null)?.slice(0, 5) ?? '—',
      timezone: r.timezone as string,
      region: r.region as string,
      night: Boolean(r.is_night),
      flexible: Boolean(r.is_flexible),
      headcount: Number(r.headcount),
    }));
  });
}

/**
 * Who is on which shift, across a span of days.
 *
 * Keyed by employee then date to match the shape the calendar renders, but
 * every working day for one person carries the same code: a shift is a
 * standing profile, not a per-day decision. Weekends come back as 'OFF'.
 */
export async function rosterFor(
  caller: Caller,
  empIds: string[],
  from: string,
  days: number,
): Promise<Record<string, Record<string, string>>> {
  if (!empIds.length) return {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new ShiftError('the roster needs a start date', 'invalid');
  }
  /* Two months is the most any rota view asks for; beyond that is a report. */
  const span = Math.min(Math.max(1, Math.trunc(days) || 7), 62);

  return withTenantReadOnly(caller, async (db) => {
    const params: unknown[] = [empIds];
    const scoped = scope(caller, 'e.id', params);

    const { rows } = await db.query(
      `SELECT e.id, s.code
         FROM employee e
         JOIN shift s ON s.id = e.shift_id
        WHERE e.id = ANY($1::uuid[])${scoped ? ` AND ${scoped}` : ''}`, params);

    const out: Record<string, Record<string, string>> = {};
    const start = Date.parse(`${from}T00:00:00Z`);
    for (const r of rows) {
      const perDay: Record<string, string> = {};
      for (let i = 0; i < span; i += 1) {
        const d = new Date(start + i * 86_400_000);
        /* Saturday and Sunday are the week off on every profile here. */
        const dow = d.getUTCDay();
        perDay[d.toISOString().slice(0, 10)] = dow === 0 || dow === 6 ? 'OFF' : (r.code as string);
      }
      out[r.id as string] = perDay;
    }
    return out;
  });
}

/** How many people are on each shift profile, keyed by code. */
export async function shiftCoverage(caller: Caller): Promise<Record<string, number>> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT s.code, count(e.id)::int AS n
         FROM shift s
         LEFT JOIN employee e ON e.shift_id = s.id AND e.status <> 'exited'
        WHERE s.active
        GROUP BY s.code ORDER BY s.code`);
    return Object.fromEntries(rows.map((r) => [r.code as string, Number(r.n)]));
  });
}

/**
 * Move somebody onto a different shift profile.
 *
 * Not dated, because this is a change to the person and it takes effect from
 * now. Assigning a shift for one day is what `roster_entry` was for before
 * 0015 dropped it, and there is nowhere to put such a row.
 */
export async function setEmployeeShift(
  caller: Caller,
  empId: string,
  shiftCode: string,
): Promise<{ empId: string; shift: string }> {
  if (caller.role === 'employee') {
    throw new ShiftError('only a manager or admin may change a shift', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const s = await db.query('SELECT id FROM shift WHERE code = $1 AND active', [shiftCode]);
    if (!s.rows[0]) throw new ShiftError(`no such shift: ${shiftCode}`, 'not_found');

    if (caller.role === 'manager') {
      const mine = await db.query(LINE_SQL, [caller.employeeId, empId]);
      if (!mine.rowCount) throw new ShiftError('that person is not in your team', 'forbidden');
    }

    const { rowCount } = await db.query(
      'UPDATE employee SET shift_id = $2 WHERE id = $1', [empId, s.rows[0].id]);
    if (!rowCount) throw new ShiftError('no such employee', 'not_found');

    return { empId, shift: shiftCode };
  });
}
