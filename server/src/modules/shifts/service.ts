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
  /**
   * The unpaid break, in minutes, that attendance deducts from worked time.
   *
   * Carried because the screen showed this from a client-side constant which said
   * 45 while the column said 60 — so an administrator read one number and the
   * worked-minutes calculation used another. The column is the authority.
   */
  breakMinutes: number;
  /**
   * How late somebody may punch in before attendance marks them late.
   *
   * Same reason as the break: the constant said 20 minutes for the India shift and
   * the column says 10, which is the figure the lateness test actually compares
   * against.
   */
  graceMinutes: number;
  /**
   * Whether the profile is still offered for new work.
   *
   * Always true in what this read returns, because the query filters on it. It is
   * carried for the shape rather than the value, so nothing has to change when
   * inactive profiles start coming back.
   */
  active: boolean;
  /** Chart colour, or null where the tenant has not chosen one. */
  colour: string | null;
  /**
   * The night allowance this profile attracts, or null where none is set.
   *
   * Carried so the editor can show and keep it. Nothing computes with it yet — the
   * statutory duty it exists for applies from the day an overnight profile is
   * actually run, and none is.
   */
  nightAllowance: number | null;
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
/*
 * Every column a Shift is built from, in one place.
 *
 * break_minutes, grace_minutes and colour arrived in 2g-A, because the screen had
 * been reading them from src/data/shifts.ts and the two disagreed. active arrived
 * with them and now carries a value worth reading, since this no longer filters on
 * it.
 */
const SHIFT_COLUMNS = `
  SELECT s.id, s.code, s.name, s.starts_at, s.ends_at, s.timezone,
         COALESCE(s.region, '') AS region, s.is_night, s.is_flexible,
         s.break_minutes, s.grace_minutes, s.active, s.colour,
         s.night_allowance,
         -- Not status = 'active': somebody serving notice still works the shift,
         -- and leaving them out understates every rota.
         (SELECT count(*)::int FROM employee e
           WHERE e.shift_id = s.id AND e.status <> 'exited') AS headcount
    FROM shift s`;

const toShift = (r: Record<string, unknown>): Shift => ({
  id: r.id as string,
  code: r.code as string,
  name: r.name as string,
  start: (r.starts_at as string | null)?.slice(0, 5) ?? '—',
  end: (r.ends_at as string | null)?.slice(0, 5) ?? '—',
  timezone: r.timezone as string,
  region: r.region as string,
  night: Boolean(r.is_night),
  flexible: Boolean(r.is_flexible),
  breakMinutes: Number(r.break_minutes),
  graceMinutes: Number(r.grace_minutes),
  active: Boolean(r.active),
  colour: (r.colour as string | null) ?? null,
  nightAllowance: r.night_allowance === null ? null : Number(r.night_allowance),
  headcount: Number(r.headcount),
});

/** One profile, read back after a write so the caller sees what was stored. */
async function oneShift(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  id: string,
): Promise<Shift> {
  const { rows } = await db.query(`${SHIFT_COLUMNS} WHERE s.id = $1`, [id]);
  return toShift(rows[0]!);
}

/**
 * The shift profiles this tenant runs, with how many people are on each.
 *
 * **Inactive profiles are returned too.** They used to be filtered out, which was
 * wrong in both directions: an employee may still be assigned to a withdrawn
 * profile — `setShiftActive` deliberately does not move anybody — and a historical
 * attendance row still has to resolve to the hours it was judged against. A read
 * that hides them makes both unresolvable and the screen cannot offer to bring one
 * back. Actives sort first, as locations and business units do, so the ordering
 * still reads as a list of what is in use.
 *
 * Headcount comes back with the profile rather than from a second call: the only
 * reason to list shifts is to see who works when, and names with no numbers beside
 * them answer nothing.
 */
export async function listShifts(caller: Caller): Promise<Shift[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${SHIFT_COLUMNS} ORDER BY s.active DESC, s.code`);
    return rows.map(toShift);
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

  const wanted = shiftCode.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    /*
     * Active only. A withdrawn profile keeps the people already on it — that is
     * what `setShiftActive` promises — but it is not offered for a new assignment,
     * which is the convention locations and business units already follow.
     */
    const s = await db.query(
      'SELECT id, active FROM shift WHERE code = $1', [wanted]);
    if (!s.rows[0]) throw new ShiftError(`no such shift: ${wanted}`, 'not_found');
    if (!s.rows[0].active) {
      throw new ShiftError(
        `${wanted} is not in use and cannot be assigned — activate it first`, 'invalid');
    }

    if (caller.role === 'manager') {
      const mine = await db.query(LINE_SQL, [caller.employeeId, empId]);
      if (!mine.rowCount) throw new ShiftError('that person is not in your team', 'forbidden');
    }

    /*
     * The profile they are leaving, read before the write so the audit row can say
     * what changed rather than only what it became. Doubles as the existence check.
     */
    const { rows: [was] } = await db.query(
      `SELECT e.code AS employee_code, sh.code AS shift_code
         FROM employee e LEFT JOIN shift sh ON sh.id = e.shift_id
        WHERE e.id = $1`, [empId]);
    if (!was) throw new ShiftError('no such employee', 'not_found');

    await db.query('UPDATE employee SET shift_id = $2 WHERE id = $1', [empId, s.rows[0].id]);

    /*
     * Recorded against the shift, because that is the subject this module shapes,
     * with the employee named in the detail. Moving somebody between working hours
     * decides what they are measured against, and the screen already claims it is
     * recorded — until now it was not.
     */
    if (was.shift_code !== wanted) {
      await shiftAudit(db, caller, 'employee_shift_changed', wanted, {
        employee: was.employee_code,
        employeeId: empId,
        from: was.shift_code ?? null,
        to: wanted,
      });
    }

    return { empId, shift: wanted };
  });
}

/* ------------------------------------------------------------------ *
 * Administering the profiles
 *
 * Until now a shift could only be created by a migration or by `seed.mjs`, which
 * meant a tenant working hours the four regional profiles do not describe had no
 * way to say so — and `users/service.ts` refuses to create an employee at all
 * when no shift exists. So this is the same gap the legal entity had in 2e.
 *
 * No migration. `app_rw` has had all four grants on `shift` since 0010, RLS is
 * enabled and forced, and `UNIQUE (tenant_id, code)` already refuses a duplicate.
 * What was missing was the service.
 * ------------------------------------------------------------------ */

/** What a profile can be created or corrected with. The code is set once. */
export interface ShiftDraft {
  code?: string;
  name?: string;
  startsAt?: string;
  endsAt?: string;
  breakMinutes?: number;
  graceMinutes?: number;
  isNight?: boolean;
  nightAllowance?: number | null;
  isFlexible?: boolean;
  colour?: string | null;
  timezone?: string;
  region?: string | null;
}

/** Same shape as a location code: `IN` and `ZZPROBE` are both 2-10 of these. */
const SHIFT_CODE = /^[A-Z0-9_-]{2,12}$/;
/** HH:MM or HH:MM:SS, which is what a `time` column accepts from a form. */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * Upper bounds that exist to catch a typo, not to express a policy.
 *
 * A twelve-hour break or a four-hour grace is not a working pattern, it is a
 * mistyped field — and `grace_minutes` feeds the lateness test, so a slip there
 * quietly stops anybody being marked late at all.
 */
const MAX_BREAK = 480;
const MAX_GRACE = 240;

/** Configuring working hours is an administrator's, as the rest of setup is. */
function mayShapeShift(caller: Caller, verb: string): void {
  if (caller.role !== 'admin') {
    throw new ShiftError(`only an admin may ${verb} a shift`, 'forbidden');
  }
}

/** A whole number in range, or a refusal naming the field. */
function whole(v: unknown, field: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ShiftError(`${field} is a whole number of minutes`, 'invalid');
  }
  if (v < 0) throw new ShiftError(`${field} cannot be negative`, 'invalid');
  if (v > max) throw new ShiftError(`${field} is at most ${max} minutes`, 'invalid');
  return v;
}

/**
 * Check a draft, and refuse what the schema cannot see.
 *
 * `shift` carries no CHECK constraints at all, so this is the only thing standing
 * between a form and a row that breaks attendance. Two of the checks are worth
 * explaining:
 *
 * **The timezone is verified against `pg_timezone_names`**, not a regex. The
 * column is plain `text` and `attendance/service.ts` passes it to `AT TIME ZONE`
 * on every read and every punch — an unrecognised value does not render oddly, it
 * raises, and it raises at punch time rather than when it was typed. Asking
 * PostgreSQL whether it knows the zone is the only check that means anything,
 * because PostgreSQL is what has to resolve it.
 *
 * **A shift must end after it starts, night or not.** The schema has `is_night`
 * and nothing implements overnight arithmetic: worked minutes come from
 * `punch_out - punch_in` as instants, and the lateness test is a plain
 * `time >` comparison. So `ends_at < starts_at` would not describe an overnight
 * shift, it would describe a shift whose stated hours no calculation agrees with.
 * `is_night` stays accepted and stored — it is what the night allowance and the
 * statutory transport duty hang off — but it does not unlock an ordering this
 * codebase cannot honour. A genuinely overnight profile needs the attendance
 * calculation changed first, which is a different phase.
 */
async function checkShift(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  d: ShiftDraft,
  partial: boolean,
): Promise<void> {
  const need = (v: unknown) => typeof v === 'string' && v.trim() !== '';

  if (!partial) {
    if (!need(d.code)) throw new ShiftError('a shift needs a code', 'invalid');
    if (!SHIFT_CODE.test(d.code!.trim().toUpperCase())) {
      throw new ShiftError(
        'a shift code is 2-12 characters: letters, digits, hyphen or underscore', 'invalid');
    }
    if (!need(d.name)) throw new ShiftError('a shift needs a name', 'invalid');
    if (!need(d.timezone)) throw new ShiftError('a shift needs a timezone', 'invalid');
    if (!need(d.startsAt) || !need(d.endsAt)) {
      throw new ShiftError('a shift needs a start and an end time', 'invalid');
    }
  }

  if (d.name !== undefined && !need(d.name)) {
    throw new ShiftError('a shift needs a name', 'invalid');
  }
  if (d.name !== undefined && d.name.trim().length > 120) {
    throw new ShiftError('a name is at most 120 characters', 'invalid');
  }

  for (const [field, v] of [['a start time', d.startsAt], ['an end time', d.endsAt]] as const) {
    if (v !== undefined && !CLOCK.test(String(v).trim())) {
      throw new ShiftError(`${field} is written as HH:MM, such as 09:30`, 'invalid');
    }
  }

  if (d.breakMinutes !== undefined) whole(d.breakMinutes, 'a break', MAX_BREAK);
  if (d.graceMinutes !== undefined) whole(d.graceMinutes, 'a grace period', MAX_GRACE);

  if (d.isNight !== undefined && typeof d.isNight !== 'boolean') {
    throw new ShiftError('a shift either runs overnight or it does not', 'invalid');
  }
  if (d.isFlexible !== undefined && typeof d.isFlexible !== 'boolean') {
    throw new ShiftError('a shift is either flexible or it is not', 'invalid');
  }
  if (d.nightAllowance !== undefined && d.nightAllowance !== null) {
    if (typeof d.nightAllowance !== 'number' || !Number.isFinite(d.nightAllowance)) {
      throw new ShiftError('a night allowance is an amount', 'invalid');
    }
    if (d.nightAllowance < 0) {
      throw new ShiftError('a night allowance cannot be negative', 'invalid');
    }
  }
  if (d.region !== undefined && d.region !== null
    && !/^[A-Z]{2}$/.test(String(d.region).trim().toUpperCase())) {
    throw new ShiftError('a region is a two-letter country code, such as IN', 'invalid');
  }

  if (d.timezone !== undefined) {
    const zone = d.timezone.trim();
    const { rows } = await db.query(
      'SELECT 1 FROM pg_timezone_names WHERE name = $1', [zone]);
    if (!rows[0]) {
      throw new ShiftError(
        `${zone} is not a timezone this database recognises — use an IANA name `
        + 'such as Asia/Kolkata', 'invalid');
    }
  }
}

/**
 * Does a shift end after it starts?
 *
 * Compared in SQL rather than in JavaScript so the stored values are what is
 * judged, whatever a form sent. Takes the pair that will be in the row after the
 * write, which on a patch means falling back to what is already there.
 */
async function endsAfterStart(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  startsAt: string | null,
  endsAt: string | null,
): Promise<boolean> {
  if (!startsAt || !endsAt) return true;
  const { rows } = await db.query(
    'SELECT ($1::time < $2::time) AS fine', [startsAt, endsAt]);
  return Boolean(rows[0]!.fine);
}

/** One audit row per shift configuration change, with the actor's name resolved. */
async function shiftAudit(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  caller: Caller,
  action: string,
  code: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                            subject_table, detail)
     SELECT 'config', $2, $1, COALESCE(e.full_name, 'system'), 'shift',
            $4::jsonb || jsonb_build_object('shift', $3::text)
       FROM employee e WHERE e.id = $1`,
    [caller.employeeId, action, code, JSON.stringify(detail)]);
}

/**
 * How many attendance rows were recorded against this profile.
 *
 * Counted from `attendance.shift_id`, which is stamped at punch time and — as the
 * Phase 2g investigation found — never read back. It is read here, for the one
 * thing it is good for: knowing whether a profile has a past.
 */
async function attendanceCount(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  shiftId: string,
): Promise<number> {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM attendance WHERE shift_id = $1', [shiftId]);
  return Number(rows[0]!.n);
}

/** Register a working-hours profile. */
export async function createShift(caller: Caller, draft: ShiftDraft): Promise<Shift> {
  mayShapeShift(caller, 'add');

  return withTenant(caller, async (db) => {
    await checkShift(db, draft, false);

    const code = draft.code!.trim().toUpperCase();
    const startsAt = draft.startsAt!.trim();
    const endsAt = draft.endsAt!.trim();

    if (!(await endsAfterStart(db, startsAt, endsAt))) {
      throw new ShiftError(
        'a shift must end after it starts. Overnight hours are not supported yet — '
        + 'attendance measures worked time between two punches and would not read '
        + 'them correctly', 'invalid');
    }

    const clash = await db.query('SELECT 1 FROM shift WHERE code = $1', [code]);
    if (clash.rows[0]) throw new ShiftError(`${code} is already a shift`, 'conflict');

    const { rows } = await db.query(
      `INSERT INTO shift (code, name, starts_at, ends_at, break_minutes, grace_minutes,
                          is_night, night_allowance, is_flexible, colour, active,
                          timezone, region)
       VALUES ($1, $2, $3::time, $4::time, $5, $6, $7, $8, $9, $10, true, $11, $12)
       RETURNING id`,
      [code, draft.name!.trim(), startsAt, endsAt,
        draft.breakMinutes ?? 60, draft.graceMinutes ?? 10,
        draft.isNight ?? false, draft.nightAllowance ?? null, draft.isFlexible ?? false,
        draft.colour?.trim() || null, draft.timezone!.trim(),
        draft.region?.trim().toUpperCase() || null]);

    await shiftAudit(db, caller, 'shift_created', code, {
      name: draft.name!.trim(), startsAt, endsAt, timezone: draft.timezone!.trim(),
      breakMinutes: draft.breakMinutes ?? 60, graceMinutes: draft.graceMinutes ?? 10,
    });

    return oneShift(db, rows[0]!.id as string);
  });
}

/**
 * The fields a change to would make existing attendance mean something else.
 *
 * `timezone` is the sharpest: `attendance/service.ts` renders every stored punch
 * through `AT TIME ZONE sh.timezone` on the employee's *current* profile, so moving
 * it rewrites what every historical row displays.
 *
 * `starts_at`, `grace_minutes` and `break_minutes` are different in kind and still
 * protected. `attendance.late` and `attendance.worked_minutes` are stored columns,
 * computed once at punch time, so changing these does not silently rewrite them —
 * it does something arguably worse. It leaves rows whose stored verdict was reached
 * under settings the screen no longer shows, so a 09:35 punch marked on time sits
 * next to a profile claiming a three-minute grace and nothing explains the gap.
 *
 * `ends_at` is deliberately absent. Nothing in attendance reads it: worked minutes
 * come from the two punch instants and the lateness test uses `starts_at` only. It
 * is a stated figure, not an input, so correcting it rewrites no history.
 */
const ATTENDANCE_RELEVANT = ['startsAt', 'timezone', 'graceMinutes', 'breakMinutes'] as const;

/**
 * Correct a profile.
 *
 * The code cannot move: `employee.shift_id`, `attendance.shift_id` and
 * `site.default_shift_id` all point at the row, and the code is what a roster and
 * a joining request quote. Sending a different one is refused rather than ignored,
 * because dropping it silently would report a rename that did not happen.
 */
export async function updateShift(
  caller: Caller,
  code: string,
  patch: ShiftDraft,
): Promise<Shift> {
  mayShapeShift(caller, 'change');

  const key = code.trim().toUpperCase();
  if (patch.code !== undefined && patch.code.trim().toUpperCase() !== key) {
    throw new ShiftError(
      'a shift code cannot change — every employee, punch and site default joins '
      + 'on it. Create a new profile instead', 'invalid');
  }

  return withTenant(caller, async (db) => {
    await checkShift(db, patch, true);

    const { rows: [found] } = await db.query(
      `SELECT id, starts_at::text AS starts_at, ends_at::text AS ends_at,
              timezone, grace_minutes, break_minutes
         FROM shift WHERE code = $1`, [key]);
    if (!found) throw new ShiftError('no such shift', 'not_found');

    /*
     * The historical guard. Only the fields actually being changed count: sending
     * back the timezone a profile already has is how an edit form works, and
     * refusing that would make a shift with a past uneditable in every field.
     */
    const current: Record<string, unknown> = {
      startsAt: (found.starts_at as string | null)?.slice(0, 8) ?? null,
      timezone: found.timezone,
      graceMinutes: Number(found.grace_minutes),
      breakMinutes: Number(found.break_minutes),
    };
    const touched = ATTENDANCE_RELEVANT.filter((f) => {
      const next = patch[f];
      if (next === undefined) return false;
      if (f === 'startsAt') {
        const now = current.startsAt as string | null;
        return now === null || !now.startsWith(String(next).trim().slice(0, 5));
      }
      if (f === 'timezone') return String(next).trim() !== current.timezone;
      return Number(next) !== Number(current[f]);
    });

    if (touched.length) {
      const n = await attendanceCount(db, found.id as string);
      if (n > 0) {
        throw new ShiftError(
          `This shift has attendance history (${n} ${n === 1 ? 'record' : 'records'}). `
          + 'Create a new shift profile instead of changing attendance-relevant '
          + `settings (${touched.join(', ')}).`, 'conflict');
      }
    }

    const nextStart = patch.startsAt !== undefined
      ? patch.startsAt.trim() : (current.startsAt as string | null);
    const nextEnd = patch.endsAt !== undefined
      ? patch.endsAt.trim() : ((found.ends_at as string | null)?.slice(0, 8) ?? null);
    if (!(await endsAfterStart(db, nextStart, nextEnd))) {
      throw new ShiftError(
        'a shift must end after it starts. Overnight hours are not supported yet — '
        + 'attendance measures worked time between two punches and would not read '
        + 'them correctly', 'invalid');
    }

    /*
     * Absent leaves a field alone; present replaces it. A boolean flag per column
     * rather than COALESCE, so a null colour or night allowance can mean "clear
     * this" rather than "do not touch it".
     */
    await db.query(
      `UPDATE shift
          SET name = COALESCE($2, name),
              starts_at = COALESCE($3::time, starts_at),
              ends_at = COALESCE($4::time, ends_at),
              break_minutes = COALESCE($5, break_minutes),
              grace_minutes = COALESCE($6, grace_minutes),
              is_night = COALESCE($7, is_night),
              is_flexible = COALESCE($8, is_flexible),
              timezone = COALESCE($9, timezone),
              night_allowance = CASE WHEN $11::boolean THEN $10 ELSE night_allowance END,
              colour = CASE WHEN $13::boolean THEN $12 ELSE colour END,
              region = CASE WHEN $15::boolean THEN $14 ELSE region END
        WHERE id = $1`,
      [found.id,
        patch.name?.trim() ?? null,
        patch.startsAt?.trim() ?? null,
        patch.endsAt?.trim() ?? null,
        patch.breakMinutes ?? null,
        patch.graceMinutes ?? null,
        patch.isNight ?? null,
        patch.isFlexible ?? null,
        patch.timezone?.trim() ?? null,
        patch.nightAllowance ?? null, patch.nightAllowance !== undefined,
        patch.colour?.trim() || null, patch.colour !== undefined,
        patch.region?.trim().toUpperCase() || null, patch.region !== undefined]);

    await shiftAudit(db, caller, 'shift_updated', key, { ...patch });

    return oneShift(db, found.id as string);
  });
}

/**
 * Withdraw a profile from use, or bring it back.
 *
 * Deactivating is allowed even when people are on it, and nothing is moved: the
 * rule is that an inactive profile cannot be *newly* assigned, not that the people
 * already on it stop having working hours. `employee.shift_id` is untouched, the
 * row stays, and `listShifts` still returns it so an old attendance record and a
 * current employee both still resolve. There is no delete — three tables point at
 * this row and a profile somebody worked is history, not a typo.
 *
 * Idempotent, as `setBusinessUnitActive` is: asking for the state it already has
 * is not an error worth raising, it is a no-op.
 */
export async function setShiftActive(
  caller: Caller,
  code: string,
  active: boolean,
): Promise<Shift> {
  mayShapeShift(caller, 'activate or deactivate');
  if (typeof active !== 'boolean') {
    throw new ShiftError('a shift is either active or inactive', 'invalid');
  }
  const key = code.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const { rows: [found] } = await db.query(
      'SELECT id, active FROM shift WHERE code = $1', [key]);
    if (!found) throw new ShiftError('no such shift', 'not_found');

    if (found.active !== active) {
      await db.query('UPDATE shift SET active = $2 WHERE id = $1', [found.id, active]);
      const { rows: [on] } = await db.query(
        `SELECT count(*)::int AS n FROM employee
          WHERE shift_id = $1 AND status <> 'exited'`, [found.id]);
      await shiftAudit(db, caller, 'shift_active_changed', key,
        { active, peopleStillAssigned: Number(on!.n) });
    }

    return oneShift(db, found.id as string);
  });
}
