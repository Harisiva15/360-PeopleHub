/**
 * Work schedules: which days a person is expected to work.
 *
 * Migration 0054 added `work_schedule`, `work_schedule_day` and
 * `employee_schedule` and nothing read them. This is the service that does.
 *
 * ## What a schedule is, and is not
 *
 * A schedule says *which days*. A shift says *which hours, in which timezone,
 * with how much grace and break*. That separation survived 0015 and Phase 2g and
 * it survives here: `work_schedule_day.shift_id` points at the existing table and
 * nothing copies an hour out of it. A day with `shift_id` null means the
 * employee's own `shift_id` — which is NOT NULL and has been the authority since
 * 0015 — still applies, so a schedule that only names working days changes
 * nobody's hours.
 *
 * ## Effective dating, and the rule it follows
 *
 * `employee_schedule` is effective-dated with inclusive `valid_to`, and
 * `employee_schedule_no_overlap` makes two assignments covering one day
 * impossible. The supersession rule here is the one `employment_record` has used
 * since 0003, not a new invention:
 *
 *   - A change effective on the day the open assignment began **amends** that
 *     assignment rather than leaving a zero-day row behind.
 *   - Otherwise the open assignment is closed the day before the new one starts,
 *     so the two meet without overlapping, and the new one opens.
 *   - A **closed** period is never touched. Backdating into one is refused, with
 *     the dates named — see `assignEmployeeSchedule`.
 *
 * ## What this service deliberately does not do
 *
 * It does not resolve a calendar. `calendar/service.ts` still answers Monday to
 * Friday from its own rule and reads none of these tables; teaching it to is a
 * later phase, and doing it here would change what every existing leave count
 * means. It does not fall back to the default schedule for an employee who has no
 * assignment either — that is a policy decision belonging to whatever resolves
 * calendars, and guessing it here would hide the gap 0054 deliberately left.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class ScheduleError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

/** One weekday of a schedule. ISO numbering: 1 = Monday … 7 = Sunday. */
export interface WorkScheduleDay {
  dayOfWeek: number;
  working: boolean;
  /**
   * The shift this weekday runs on, where it differs from the person's usual one.
   * Null means the employee's own shift applies — see the module comment.
   */
  shiftCode: string | null;
  /** Resolved for display, so a screen needs no second request. */
  shiftName: string | null;
}

export interface WorkSchedule {
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  /** How many people are on it today, anyone not yet left included. */
  assignedNow: number;
  /** Present on a single read; empty on the list, which does not join them. */
  days: WorkScheduleDay[];
}

export interface WorkScheduleDayDraft {
  dayOfWeek: number;
  working: boolean;
  /** A shift code, or null for the employee's own. */
  shiftCode?: string | null;
}

export interface WorkScheduleDraft {
  code?: string;
  name?: string;
  description?: string | null;
  /**
   * The seven days. Optional on a create, where Monday to Friday is assumed —
   * which is the pattern 0054's own default records and the one the product has
   * always applied.
   */
  days?: WorkScheduleDayDraft[];
}

export interface EmployeeSchedule {
  id: string;
  employeeId: string;
  scheduleCode: string;
  scheduleName: string;
  /** Whether that schedule is still offered for new assignments. */
  scheduleActive: boolean;
  validFrom: string;
  /** Inclusive. Null means current. */
  validTo: string | null;
  createdAt: string;
}

export interface EmployeeScheduleDraft {
  scheduleCode: string;
  validFrom: string;
  /** Inclusive, or null for open-ended. */
  validTo?: string | null;
}

/* ------------------------------------------------------------------ *
 * Projections
 * ------------------------------------------------------------------ */

const WS_COLUMNS = `
  SELECT w.id, w.code, w.name, w.description, w.active, w.created_at, w.updated_at,
         (SELECT count(*)::int FROM employee_schedule es
            JOIN employee e ON e.id = es.employee_id
           WHERE es.work_schedule_id = w.id
             AND e.status <> 'exited'
             AND es.valid_to IS NULL) AS assigned_now
    FROM work_schedule w`;

const toSchedule = (r: Record<string, unknown>, days: WorkScheduleDay[]): WorkSchedule => ({
  code: r.code as string,
  name: r.name as string,
  description: (r.description as string | null) ?? null,
  active: Boolean(r.active),
  createdAt: (r.created_at as Date).toISOString(),
  updatedAt: (r.updated_at as Date).toISOString(),
  assignedNow: Number(r.assigned_now),
  days,
});

/*
 * `::text` on both dates, which is how `employment.ts` reads the same kind of
 * column. `src/db/pool.ts` already maps `date` through unchanged rather than into
 * a `Date`, so the value arrives as `YYYY-MM-DD` and there is no local-midnight
 * conversion anywhere in the path — the cast makes that explicit at the query
 * instead of leaving it to a parser registration several files away.
 */
const ES_COLUMNS = `
  SELECT es.id, es.employee_id, es.created_at,
         es.valid_from::text AS valid_from, es.valid_to::text AS valid_to,
         w.code AS schedule_code, w.name AS schedule_name, w.active AS schedule_active
    FROM employee_schedule es
    JOIN work_schedule w ON w.id = es.work_schedule_id`;

const toAssignment = (r: Record<string, unknown>): EmployeeSchedule => ({
  id: r.id as string,
  employeeId: r.employee_id as string,
  scheduleCode: r.schedule_code as string,
  scheduleName: r.schedule_name as string,
  scheduleActive: Boolean(r.schedule_active),
  validFrom: r.valid_from as string,
  validTo: (r.valid_to as string | null) ?? null,
  createdAt: (r.created_at as Date).toISOString(),
});

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/** The same shape the migration's CHECK enforces, so the message comes first. */
const SCHEDULE_CODE = /^[A-Z0-9][A-Z0-9_-]{1,15}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Shaping how a company works is an administrator's, as the rest of setup is. */
function mayShapeSchedule(caller: Caller, verb: string): void {
  if (caller.role !== 'admin') {
    throw new ScheduleError(`only an admin may ${verb} a work schedule`, 'forbidden');
  }
}

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

function checkScheduleDraft(d: WorkScheduleDraft, partial: boolean): void {
  const need = (v: unknown) => typeof v === 'string' && v.trim() !== '';

  if (!partial) {
    if (!need(d.code)) throw new ScheduleError('a schedule needs a code', 'invalid');
    if (!SCHEDULE_CODE.test(d.code!.trim().toUpperCase())) {
      throw new ScheduleError(
        'a schedule code is 2-16 characters: letters, digits, hyphen or underscore',
        'invalid');
    }
    if (!need(d.name)) throw new ScheduleError('a schedule needs a name', 'invalid');
  }
  if (d.name !== undefined && !need(d.name)) {
    throw new ScheduleError('a schedule needs a name', 'invalid');
  }
  if (d.name !== undefined && d.name.trim().length > 120) {
    throw new ScheduleError('a name is at most 120 characters', 'invalid');
  }
}

/**
 * Check one weekday, and resolve its shift.
 *
 * Three rules, all of them the repository's existing ones rather than new policy:
 * the day is an ISO weekday; a day nobody works carries no shift, which is what
 * `work_schedule_day_off_has_no_shift` enforces; and an inactive shift cannot be
 * newly assigned, which is the convention locations, business units and shifts
 * themselves already follow — an inactive row stays readable so old records
 * resolve, and is not offered for new work.
 */
async function resolveDay(
  db: Db,
  d: WorkScheduleDayDraft,
): Promise<{ dayOfWeek: number; working: boolean; shiftId: string | null }> {
  if (typeof d.dayOfWeek !== 'number' || !Number.isInteger(d.dayOfWeek)
    || d.dayOfWeek < 1 || d.dayOfWeek > 7) {
    throw new ScheduleError(
      'a weekday is 1 to 7, Monday through Sunday', 'invalid');
  }
  if (typeof d.working !== 'boolean') {
    throw new ScheduleError('a weekday is either worked or it is not', 'invalid');
  }

  const wanted = typeof d.shiftCode === 'string' ? d.shiftCode.trim().toUpperCase() : null;
  if (!d.working && wanted) {
    throw new ScheduleError(
      'a day nobody works cannot name a shift — clear the shift or mark the day worked',
      'invalid');
  }
  if (!wanted) return { dayOfWeek: d.dayOfWeek, working: d.working, shiftId: null };

  /*
   * Row level security means another tenant's shift simply is not here, so an
   * unknown code and a borrowed one give the same answer — and saying anything
   * more specific would confirm that it exists somewhere.
   */
  const { rows } = await db.query(
    'SELECT id, active FROM shift WHERE code = $1', [wanted]);
  const shift = rows[0];
  if (!shift) throw new ScheduleError(`no such shift: ${wanted}`, 'invalid');
  if (!shift.active) {
    throw new ScheduleError(
      `${wanted} is not in use and cannot be assigned — activate it first`, 'invalid');
  }
  return { dayOfWeek: d.dayOfWeek, working: d.working, shiftId: shift.id as string };
}

function checkDateRange(from: string, to: string | null | undefined): void {
  if (!YMD.test(from)) {
    throw new ScheduleError('a start date is written as YYYY-MM-DD', 'invalid');
  }
  if (to !== null && to !== undefined) {
    if (!YMD.test(to)) {
      throw new ScheduleError('an end date is written as YYYY-MM-DD', 'invalid');
    }
    if (to < from) {
      throw new ScheduleError('an end date cannot be before the start date', 'invalid');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

async function scheduleAudit(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  caller: Caller,
  action: string,
  subject: 'work_schedule' | 'employee_schedule',
  key: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                            subject_table, detail)
     SELECT 'config', $2, $1, COALESCE(e.full_name, 'system'), $5,
            $4::jsonb || jsonb_build_object('schedule', $3::text)
       FROM employee e WHERE e.id = $1`,
    [caller.employeeId, action, key, JSON.stringify(detail), subject]);
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

async function daysOf(db: Db, scheduleId: string): Promise<WorkScheduleDay[]> {
  const { rows } = await db.query(
    `SELECT d.day_of_week, d.working, s.code AS shift_code, s.name AS shift_name
       FROM work_schedule_day d
       LEFT JOIN shift s ON s.id = d.shift_id
      WHERE d.work_schedule_id = $1
      ORDER BY d.day_of_week`, [scheduleId]);
  return rows.map((r) => ({
    dayOfWeek: Number(r.day_of_week),
    working: Boolean(r.working),
    shiftCode: (r.shift_code as string | null) ?? null,
    shiftName: (r.shift_name as string | null) ?? null,
  }));
}

/**
 * Every schedule this tenant has, inactive ones included.
 *
 * Inactive patterns are returned for the same reason `listShifts` returns them:
 * an assignment may still name one — deactivating moves nobody — and a screen has
 * to resolve the code on a historical row. Actives sort first.
 *
 * Readable by every role. Which days a company works is not privileged
 * information, and an employee should be able to see the pattern they are on.
 * `days` is populated, in one extra statement for the whole list — see below.
 */
export async function listWorkSchedules(caller: Caller): Promise<WorkSchedule[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${WS_COLUMNS} ORDER BY w.active DESC, w.name`);

    /*
     * The weekdays come with the list, in one further statement for all of them.
     *
     * This used to return `days: []` and leave the single read to supply them,
     * which was fine while nothing listed patterns. A screen that shows which days
     * each pattern works then has two options: one request per row, or this. Two
     * statements for the whole list beats N+1, and the alternative the list left
     * open was the worse one.
     */
    const { rows: dayRows } = await db.query(
      `SELECT d.work_schedule_id, d.day_of_week, d.working,
              sh.code AS shift_code, sh.name AS shift_name
         FROM work_schedule_day d
         LEFT JOIN shift sh ON sh.id = d.shift_id
        ORDER BY d.work_schedule_id, d.day_of_week`);

    const byId = new Map<string, WorkScheduleDay[]>();
    for (const r of dayRows) {
      const id = r.work_schedule_id as string;
      const list = byId.get(id) ?? [];
      list.push({
        dayOfWeek: Number(r.day_of_week),
        working: Boolean(r.working),
        shiftCode: (r.shift_code as string | null) ?? null,
        shiftName: (r.shift_name as string | null) ?? null,
      });
      byId.set(id, list);
    }

    return rows.map((r) => toSchedule(r, byId.get(r.id as string) ?? []));
  });
}

/** One schedule with its weekdays, and the shift each names. */
export async function getWorkSchedule(caller: Caller, code: string): Promise<WorkSchedule> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${WS_COLUMNS} WHERE w.code = $1`, [code.trim().toUpperCase()]);
    if (!rows[0]) throw new ScheduleError('no such work schedule', 'not_found');
    return toSchedule(rows[0], await daysOf(db, rows[0].id as string));
  });
}

/* ------------------------------------------------------------------ *
 * Writing a schedule
 * ------------------------------------------------------------------ */

/** Monday to Friday, which is what the product has always applied. */
const MON_TO_FRI: WorkScheduleDayDraft[] = [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
  dayOfWeek, working: dayOfWeek <= 5, shiftCode: null,
}));

/**
 * Register a pattern.
 *
 * **All seven days are written, always.** `work_schedule_day` has a unique key per
 * weekday and no default row, so a partial schedule would be one that answers
 * "is Wednesday worked" with nothing — and a resolver reading it later would have
 * to invent the answer. Omitting `days` means Monday to Friday rather than
 * meaning nothing.
 */
export async function createWorkSchedule(
  caller: Caller,
  draft: WorkScheduleDraft,
): Promise<WorkSchedule> {
  mayShapeSchedule(caller, 'add');
  checkScheduleDraft(draft, false);

  const code = draft.code!.trim().toUpperCase();
  const wanted = draft.days ?? MON_TO_FRI;

  if (wanted.length !== 7) {
    throw new ScheduleError(
      'a schedule covers all seven weekdays — send seven days, or none for Monday to Friday',
      'invalid');
  }
  const seen = new Set(wanted.map((d) => d.dayOfWeek));
  if (seen.size !== 7) {
    throw new ScheduleError('each weekday appears once, Monday through Sunday', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const clash = await db.query('SELECT 1 FROM work_schedule WHERE code = $1', [code]);
    if (clash.rowCount) {
      throw new ScheduleError(`${code} is already a work schedule`, 'conflict');
    }

    /* Resolved before the insert, so a bad shift refuses the whole schedule. */
    const days = [];
    for (const d of wanted) days.push(await resolveDay(db, d));

    const { rows } = await db.query(
      `INSERT INTO work_schedule (code, name, description, active)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [code, draft.name!.trim(), draft.description?.trim() || null]);
    const id = rows[0]!.id as string;

    for (const d of days) {
      await db.query(
        `INSERT INTO work_schedule_day
           (work_schedule_id, day_of_week, working, shift_id)
         VALUES ($1, $2, $3, $4)`, [id, d.dayOfWeek, d.working, d.shiftId]);
    }

    await scheduleAudit(db, caller, 'work_schedule_created', 'work_schedule', code, {
      name: draft.name!.trim(),
      workingDays: days.filter((d) => d.working).map((d) => d.dayOfWeek),
    });

    const back = await db.query(`${WS_COLUMNS} WHERE w.id = $1`, [id]);
    return toSchedule(back.rows[0]!, await daysOf(db, id));
  });
}

/**
 * Correct a pattern's name or description.
 *
 * The code cannot move: `employee_schedule` joins on the row and a code is what
 * an administrator quotes. Sending a different one is refused rather than
 * ignored, because dropping it silently reports a rename that did not happen.
 * The weekdays are changed through `setWorkScheduleDay`, one decision at a time.
 */
export async function updateWorkSchedule(
  caller: Caller,
  code: string,
  patch: WorkScheduleDraft,
): Promise<WorkSchedule> {
  mayShapeSchedule(caller, 'change');
  checkScheduleDraft(patch, true);

  const key = code.trim().toUpperCase();
  if (patch.code !== undefined && patch.code.trim().toUpperCase() !== key) {
    throw new ScheduleError(
      'a schedule code cannot change — every assignment joins on it. Create a new one',
      'invalid');
  }
  if (patch.days !== undefined) {
    throw new ScheduleError(
      'weekdays are changed one at a time, not through this call', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const { rows: [found] } = await db.query(
      'SELECT id FROM work_schedule WHERE code = $1', [key]);
    if (!found) throw new ScheduleError('no such work schedule', 'not_found');

    await db.query(
      `UPDATE work_schedule
          SET name = COALESCE($2, name),
              description = CASE WHEN $4::boolean THEN $3 ELSE description END,
              updated_at = now()
        WHERE id = $1`,
      [found.id, patch.name?.trim() ?? null,
        patch.description?.trim() || null, patch.description !== undefined]);

    await scheduleAudit(db, caller, 'work_schedule_updated', 'work_schedule', key,
      { ...patch });

    const back = await db.query(`${WS_COLUMNS} WHERE w.id = $1`, [found.id]);
    return toSchedule(back.rows[0]!, await daysOf(db, found.id as string));
  });
}

/**
 * Change one weekday.
 *
 * An upsert on `(work_schedule_id, day_of_week)`, because the unique key means
 * there is either a row to change or one to write and the caller should not have
 * to know which.
 */
export async function setWorkScheduleDay(
  caller: Caller,
  code: string,
  draft: WorkScheduleDayDraft,
): Promise<WorkSchedule> {
  mayShapeSchedule(caller, 'change the days of');

  const key = code.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const { rows: [found] } = await db.query(
      'SELECT id FROM work_schedule WHERE code = $1', [key]);
    if (!found) throw new ScheduleError('no such work schedule', 'not_found');

    const d = await resolveDay(db, draft);
    const before = await db.query(
      `SELECT working, shift_id FROM work_schedule_day
        WHERE work_schedule_id = $1 AND day_of_week = $2`, [found.id, d.dayOfWeek]);

    await db.query(
      `INSERT INTO work_schedule_day (work_schedule_id, day_of_week, working, shift_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, work_schedule_id, day_of_week) DO UPDATE
         SET working = EXCLUDED.working,
             shift_id = EXCLUDED.shift_id,
             updated_at = now()`,
      [found.id, d.dayOfWeek, d.working, d.shiftId]);

    await scheduleAudit(db, caller, 'work_schedule_day_updated', 'work_schedule', key, {
      dayOfWeek: d.dayOfWeek,
      from: before.rows[0]
        ? { working: Boolean(before.rows[0].working) }
        : null,
      to: { working: d.working, shiftCode: draft.shiftCode?.trim().toUpperCase() ?? null },
    });

    const back = await db.query(`${WS_COLUMNS} WHERE w.id = $1`, [found.id]);
    return toSchedule(back.rows[0]!, await daysOf(db, found.id as string));
  });
}

/**
 * Withdraw a pattern from use, or bring it back.
 *
 * Nothing is deleted and nobody is moved. The people already on it keep it — an
 * assignment naming an inactive pattern still describes the days they worked —
 * and it simply stops being offered for a new one. Idempotent, as
 * `setBusinessUnitActive` and `setShiftActive` are.
 */
export async function setWorkScheduleActive(
  caller: Caller,
  code: string,
  active: boolean,
): Promise<WorkSchedule> {
  mayShapeSchedule(caller, 'activate or deactivate');
  if (typeof active !== 'boolean') {
    throw new ScheduleError('a schedule is either active or inactive', 'invalid');
  }

  const key = code.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const { rows: [found] } = await db.query(
      'SELECT id, active FROM work_schedule WHERE code = $1', [key]);
    if (!found) throw new ScheduleError('no such work schedule', 'not_found');

    if (found.active !== active) {
      await db.query(
        'UPDATE work_schedule SET active = $2, updated_at = now() WHERE id = $1',
        [found.id, active]);
      const { rows: [on] } = await db.query(
        `SELECT count(*)::int AS n FROM employee_schedule
          WHERE work_schedule_id = $1 AND valid_to IS NULL`, [found.id]);
      await scheduleAudit(db, caller, 'work_schedule_active_changed', 'work_schedule', key,
        { active, openAssignments: Number(on!.n) });
    }

    const back = await db.query(`${WS_COLUMNS} WHERE w.id = $1`, [found.id]);
    return toSchedule(back.rows[0]!, await daysOf(db, found.id as string));
  });
}

/* ------------------------------------------------------------------ *
 * Assignment
 * ------------------------------------------------------------------ */

/** Everyone under this manager, however deep. The same SQL `shifts` uses. */
const LINE_SQL = `
  WITH RECURSIVE t AS (
    SELECT id FROM employee WHERE manager_id = $1
    UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
  ) SELECT 1 FROM t WHERE id = $2`;

/**
 * May this caller see, or change, this person's schedule?
 *
 * The same rule `setEmployeeShift` applies, because it is the same kind of
 * decision: an admin anybody, a manager their own line however deep, an employee
 * only themselves. `write` tightens it — an employee may read their own pattern
 * and may not assign it.
 */
async function mayTouch(
  db: Db, caller: Caller, employeeId: string, write: boolean,
): Promise<void> {
  if (caller.role === 'admin') return;
  if (!caller.employeeId) {
    throw new ScheduleError('this login has no employee record', 'forbidden');
  }
  if (caller.role === 'employee') {
    if (write) {
      throw new ScheduleError(
        'only a manager or admin may assign a work schedule', 'forbidden');
    }
    if (caller.employeeId !== employeeId) {
      throw new ScheduleError('you can only read your own schedule', 'forbidden');
    }
    return;
  }
  /* A manager: themselves, or anybody in their line. */
  if (caller.employeeId === employeeId) return;
  const { rows } = await db.query(LINE_SQL, [caller.employeeId, employeeId]);
  if (!rows[0]) throw new ScheduleError('that person is not in your team', 'forbidden');
}

/**
 * One employee's schedule history, newest first.
 *
 * Every row, including closed ones and ones naming a withdrawn pattern. That is
 * the point of effective dating: what applied in March has to stay answerable in
 * September.
 */
export async function employeeSchedules(
  caller: Caller,
  employeeId: string,
): Promise<EmployeeSchedule[]> {
  return withTenantReadOnly(caller, async (db) => {
    const known = await db.query('SELECT 1 FROM employee WHERE id = $1', [employeeId]);
    if (!known.rows[0]) throw new ScheduleError('no such employee', 'not_found');
    await mayTouch(db, caller, employeeId, false);

    const { rows } = await db.query(
      `${ES_COLUMNS} WHERE es.employee_id = $1 ORDER BY es.valid_from DESC`, [employeeId]);
    return rows.map(toAssignment);
  });
}

/**
 * The assignment covering a date, or null.
 *
 * **Null is an answer, not a failure.** 0054 deliberately left exited employees
 * with no trustworthy leaving date unassigned, and nothing here invents one for
 * them: a caller that needs a fallback has to choose one, and the choosing
 * belongs to whatever resolves calendars rather than being buried in a read.
 */
export async function employeeScheduleOn(
  caller: Caller,
  employeeId: string,
  on: string,
): Promise<EmployeeSchedule | null> {
  if (!YMD.test(on)) {
    throw new ScheduleError('a date is written as YYYY-MM-DD', 'invalid');
  }
  return withTenantReadOnly(caller, async (db) => {
    const known = await db.query('SELECT 1 FROM employee WHERE id = $1', [employeeId]);
    if (!known.rows[0]) throw new ScheduleError('no such employee', 'not_found');
    await mayTouch(db, caller, employeeId, false);

    const { rows } = await db.query(
      `${ES_COLUMNS}
        WHERE es.employee_id = $1
          AND daterange(es.valid_from, es.valid_to, '[]') @> $2::date`, [employeeId, on]);
    return rows[0] ? toAssignment(rows[0]) : null;
  });
}

/**
 * Put somebody on a schedule from a date.
 *
 * One transaction, and it does the whole change: the open assignment is closed
 * the day before the new one begins, or amended if it began on the same day, and
 * the new one is written. A caller does not have to edit the previous row, and
 * cannot leave a gap or an overlap by trying.
 *
 * **A closed period is never rewritten.** If the requested start lands inside an
 * assignment that already has an end date, the request is refused and the dates
 * are named. `employment_record` — the pattern this follows — only ever closes
 * the *open* record, so there is no precedent in this repository for editing
 * settled history, and inventing one here would change what a past month meant
 * without anybody asking for it. Correcting a historical period is a different
 * operation and it does not exist yet.
 *
 * **The database is the authority on overlap.** The checks below exist to give a
 * sentence instead of a constraint violation; `employee_schedule_no_overlap` is
 * what actually makes two assignments for one day impossible, including under
 * concurrency, where two callers can both pass these checks and only one can
 * commit.
 */
export async function assignEmployeeSchedule(
  caller: Caller,
  employeeId: string,
  draft: EmployeeScheduleDraft,
): Promise<EmployeeSchedule> {
  checkDateRange(draft.validFrom, draft.validTo);
  const from = draft.validFrom;
  const to = draft.validTo ?? null;

  if (typeof draft.scheduleCode !== 'string' || !draft.scheduleCode.trim()) {
    throw new ScheduleError('an assignment needs a schedule', 'invalid');
  }
  const wanted = draft.scheduleCode.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const emp = await db.query(
      'SELECT status, joined_on FROM employee WHERE id = $1', [employeeId]);
    if (!emp.rows[0]) throw new ScheduleError('no such employee', 'not_found');
    await mayTouch(db, caller, employeeId, true);

    /*
     * An exited employee is not given a new schedule. They have no days left to
     * be expected on, and an open-ended row would make them look current to
     * anything asking which pattern applies now — the same reasoning that keeps
     * `closeEmployment` from writing an open `exit` record.
     */
    if (emp.rows[0].status === 'exited') {
      throw new ScheduleError(
        'this person has left, so there is no schedule to assign them', 'invalid');
    }

    const sched = await db.query(
      'SELECT id, active FROM work_schedule WHERE code = $1', [wanted]);
    if (!sched.rows[0]) throw new ScheduleError(`no such work schedule: ${wanted}`, 'invalid');
    if (!sched.rows[0].active) {
      throw new ScheduleError(
        `${wanted} is not in use and cannot be assigned — activate it first`, 'invalid');
    }

    /*
     * Everything that already covers any part of the new range. Read inside the
     * transaction, and `FOR UPDATE` so a concurrent assignment waits rather than
     * reading the same gap.
     */
    const { rows: clashes } = await db.query(
      `SELECT id, to_char(valid_from, 'YYYY-MM-DD') AS vf,
              to_char(valid_to, 'YYYY-MM-DD') AS vt
         FROM employee_schedule
        WHERE employee_id = $1
          AND daterange(valid_from, valid_to, '[]')
              && daterange($2::date, $3::date, '[]')
        ORDER BY valid_from
        FOR UPDATE`, [employeeId, from, to]);

    const settled = clashes.filter((c) => c.vt !== null);
    if (settled.length) {
      const first = settled[0]!;
      throw new ScheduleError(
        `${from} falls inside a schedule period that has already ended `
        + `(${first.vf} to ${first.vt}). Historical periods are not rewritten — `
        + 'choose a start date after the last one, or correct that period first.',
        'conflict');
    }

    /* At most one open assignment can exist, so at most one clash remains. */
    const open = clashes[0];
    if (open) {
      if (open.vf === from) {
        /*
         * A change effective on the day the open assignment began amends it,
         * rather than leaving a zero-day row behind. The rule `employment_record`
         * has applied since 0003.
         */
        await db.query(
          `UPDATE employee_schedule
              SET work_schedule_id = $2, valid_to = $3::date, updated_at = now()
            WHERE id = $1`, [open.id, sched.rows[0].id, to]);
        await scheduleAudit(db, caller, 'employee_schedule_changed', 'employee_schedule',
          wanted, { employeeId, validFrom: from, validTo: to, amended: open.id });
        const back = await db.query(`${ES_COLUMNS} WHERE es.id = $1`, [open.id]);
        return toAssignment(back.rows[0]!);
      }
      if (open.vf > from) {
        throw new ScheduleError(
          `the current schedule period starts on ${open.vf}, after ${from}. `
          + 'Backdating before an existing period is not supported.', 'conflict');
      }
      await db.query(
        'UPDATE employee_schedule SET valid_to = ($2::date - 1), updated_at = now() '
        + 'WHERE id = $1', [open.id, from]);
      await scheduleAudit(db, caller, 'employee_schedule_closed', 'employee_schedule',
        wanted, { employeeId, assignment: open.id, closedOn: from, reason: 'superseded' });
    }

    let inserted;
    try {
      inserted = await db.query(
        `INSERT INTO employee_schedule
           (employee_id, work_schedule_id, valid_from, valid_to)
         VALUES ($1, $2, $3::date, $4::date) RETURNING id`,
        [employeeId, sched.rows[0].id, from, to]);
    } catch (e) {
      /*
       * The exclusion constraint, reached despite the checks above — two callers
       * assigning at once, where both saw a free range and only one may have it.
       * 23P01 is not something to show anybody.
       */
      if ((e as { code?: string }).code === '23P01') {
        throw new ScheduleError(
          'this person already has a work schedule covering that period', 'conflict');
      }
      throw e;
    }

    await scheduleAudit(db, caller, 'employee_schedule_created', 'employee_schedule',
      wanted, { employeeId, validFrom: from, validTo: to, supersededOpen: open?.id ?? null });

    const back = await db.query(`${ES_COLUMNS} WHERE es.id = $1`, [inserted.rows[0]!.id]);
    return toAssignment(back.rows[0]!);
  });
}

/**
 * End an open assignment without starting another.
 *
 * For somebody leaving, or a pattern that simply stops. Separate from assigning
 * because ending and replacing are different decisions, and a caller that means
 * one should not have to express it as the other.
 */
export async function closeEmployeeSchedule(
  caller: Caller,
  employeeId: string,
  assignmentId: string,
  validTo: string,
): Promise<EmployeeSchedule> {
  if (!YMD.test(validTo)) {
    throw new ScheduleError('an end date is written as YYYY-MM-DD', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const known = await db.query('SELECT 1 FROM employee WHERE id = $1', [employeeId]);
    if (!known.rows[0]) throw new ScheduleError('no such employee', 'not_found');
    await mayTouch(db, caller, employeeId, true);

    const { rows: [row] } = await db.query(
      `SELECT id, to_char(valid_from, 'YYYY-MM-DD') AS vf, valid_to
         FROM employee_schedule WHERE id = $1 AND employee_id = $2 FOR UPDATE`,
      [assignmentId, employeeId]);
    if (!row) throw new ScheduleError('no such schedule assignment', 'not_found');
    if (row.valid_to !== null) {
      throw new ScheduleError(
        'that period has already ended — historical periods are not rewritten',
        'conflict');
    }
    if (validTo < (row.vf as string)) {
      throw new ScheduleError(
        `an end date cannot be before the period began on ${row.vf}`, 'invalid');
    }

    await db.query(
      'UPDATE employee_schedule SET valid_to = $2::date, updated_at = now() WHERE id = $1',
      [assignmentId, validTo]);

    const back = await db.query(`${ES_COLUMNS} WHERE es.id = $1`, [assignmentId]);
    const out = toAssignment(back.rows[0]!);
    await scheduleAudit(db, caller, 'employee_schedule_closed', 'employee_schedule',
      out.scheduleCode, { employeeId, assignment: assignmentId, closedOn: validTo });
    return out;
  });
}

/* ------------------------------------------------------------------ *
 * The default pattern for a tenant
 * ------------------------------------------------------------------ */

/** The code 0054's backfill uses, so the helper and the migration agree. */
export const DEFAULT_SCHEDULE_CODE = 'DEFAULT_MF';

/**
 * Make sure this tenant has the default Monday-to-Friday pattern.
 *
 * Migration 0054 wrote one for every tenant that existed when it ran. A tenant
 * created afterwards has none, because the backfill is a statement and not a
 * trigger — so this is the helper that closes that gap, and it exists to be
 * called from wherever a tenant is provisioned.
 *
 * **There is nowhere to call it from yet.** Nothing in `server/src` creates a
 * tenant: `seed.mjs` and the test scripts insert the row directly. Rather than
 * inventing a provisioning route this phase does not need, the helper is written,
 * tested and left for whatever grows one.
 *
 * Idempotent and tenant-safe: running it twice changes nothing, and it assigns
 * nobody. **No shift is attached to any day** — `site.default_shift_id` is the
 * only candidate for a tenant default and 2h-A found it unread and unset, so
 * there is no authoritative source and a guess would be worse than a null.
 */
export async function ensureDefaultSchedule(caller: Caller): Promise<WorkSchedule> {
  mayShapeSchedule(caller, 'create the default schedule for');

  return withTenant(caller, async (db) => {
    const existing = await db.query(
      `${WS_COLUMNS} WHERE w.code = $1`, [DEFAULT_SCHEDULE_CODE]);
    if (existing.rows[0]) {
      /* Already there. Not an error, and nothing to change. */
      return toSchedule(existing.rows[0], await daysOf(db, existing.rows[0].id as string));
    }

    const { rows } = await db.query(
      `INSERT INTO work_schedule (code, name, description, active)
       VALUES ($1, 'Default Monday-Friday Schedule',
               'The pattern this product applies when nothing else is configured.', true)
       ON CONFLICT (tenant_id, code) DO NOTHING
       RETURNING id`, [DEFAULT_SCHEDULE_CODE]);

    /* A concurrent caller may have won the insert; read whichever row exists. */
    const id = rows[0]?.id as string | undefined
      ?? (await db.query('SELECT id FROM work_schedule WHERE code = $1',
        [DEFAULT_SCHEDULE_CODE])).rows[0]!.id as string;

    for (const d of MON_TO_FRI) {
      await db.query(
        `INSERT INTO work_schedule_day (work_schedule_id, day_of_week, working, shift_id)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT (tenant_id, work_schedule_id, day_of_week) DO NOTHING`,
        [id, d.dayOfWeek, d.working]);
    }

    if (rows[0]) {
      await scheduleAudit(db, caller, 'work_schedule_created', 'work_schedule',
        DEFAULT_SCHEDULE_CODE, { name: 'Default Monday-Friday Schedule', seeded: true });
    }

    const back = await db.query(`${WS_COLUMNS} WHERE w.id = $1`, [id]);
    return toSchedule(back.rows[0]!, await daysOf(db, id));
  });
}
