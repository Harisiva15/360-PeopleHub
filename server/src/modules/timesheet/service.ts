/**
 * Timesheets — one entry per project, task and day.
 *
 * **The shape follows the table rather than the screen.** `timesheet_entry`
 * has always been one row per (project, task, date) with its own `billable`
 * flag and its own note; the API used to fold that into a weekly grid — a row
 * per project/task with seven day-columns — and the projection spent forty
 * lines rebuilding a shape the database never had. Entries come back as
 * entries now, and the grid, if anyone wants one, is a rendering.
 *
 * That also fixes something the grid could not express: billable was read off
 * the *project*, so the same project could never have a billable and a
 * non-billable line in one week. Consulting work does that constantly —
 * client development in the morning, internal standup in the afternoon.
 *
 * **Totals are derived, never sent.** `total_hours` on the sheet is
 * recomputed from the entries inside every write, so the header figure and the
 * rows cannot disagree. A client that posts a total is ignored.
 *
 * **Limits are checked where they mean something.** The 24-hour cap is per
 * *day*, not per entry — the column's own CHECK stops a single 25-hour row and
 * would happily take four seven-hour ones. The weekly ceiling is checked the
 * same way.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class TimesheetError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'TimesheetError';
    this.code = code;
  }
}

/** Monday to Sunday. */
const DAYS = 7;
/** Nobody works more than this in a day; the rest is a typing mistake. */
const MAX_DAY_HOURS = 24;
/** Nor more than this in a week, which is every hour there is. */
const MAX_WEEK_HOURS = 168;

export type TSStatus = 'Draft' | 'Submitted' | 'Approved' | 'Returned' | 'Rejected';

const TO_STATUS: Record<string, TSStatus> = {
  draft: 'Draft', submitted: 'Submitted', approved: 'Approved',
  returned: 'Returned', rejected: 'Rejected',
};
const FROM_STATUS: Record<string, string> = Object.fromEntries(
  Object.entries(TO_STATUS).map(([k, v]) => [v, k]),
);

export interface TSEntry {
  id: string;
  /** The day the work happened, as `YYYY-MM-DD`. */
  date: string;
  /** Project code, e.g. 'TOY-DA'. */
  proj: string;
  task: string;
  billable: boolean;
  hours: number;
  remarks: string;
}

export interface Timesheet {
  id: string;
  empId: string;
  /** Monday of the week, as `YYYY-MM-DD`. */
  weekStart: string;
  entries: TSEntry[];
  total: number;
  billable: number;
  nonBillable: number;
  status: TSStatus;
  approverId: string | null;
  submittedOn: string | null;
  actedOn: string | null;
  /** The employee's note to their manager, or the manager's reason back. */
  note: string;
}

const PROJECTION = `
  SELECT t.id, t.employee_id, t.week_start, t.status, t.submitted_on,
         t.approver_id, t.acted_on, COALESCE(t.note, '') AS note,
         COALESCE(e.entries, '[]'::jsonb) AS entries,
         COALESCE(e.total, 0)::float8 AS total,
         COALESCE(e.billable, 0)::float8 AS billable
    FROM timesheet t
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'id', x.id,
               'date', to_char(x.work_date, 'YYYY-MM-DD'),
               'proj', p.code,
               'task', x.task,
               'billable', x.billable,
               'hours', x.hours::float8,
               'remarks', COALESCE(x.note, '')
             ) ORDER BY x.work_date, p.code, x.task) AS entries,
             sum(x.hours) AS total,
             sum(x.hours) FILTER (WHERE x.billable) AS billable
        FROM timesheet_entry x
        JOIN project p ON p.id = x.project_id
       WHERE x.timesheet_id = t.id
    ) e ON true`;

const toSheet = (r: Record<string, unknown>): Timesheet => {
  const total = Number(r.total ?? 0);
  const billable = Number(r.billable ?? 0);
  return {
    id: r.id as string,
    empId: r.employee_id as string,
    weekStart: r.week_start as string,
    entries: ((r.entries as TSEntry[]) ?? []).map((e) => ({
      id: e.id,
      date: e.date,
      proj: e.proj,
      task: e.task,
      billable: Boolean(e.billable),
      hours: Number(e.hours),
      remarks: e.remarks ?? '',
    })),
    total,
    billable,
    /* Derived rather than summed separately, so the three always reconcile. */
    nonBillable: Math.round((total - billable) * 100) / 100,
    status: TO_STATUS[r.status as string] ?? 'Draft',
    approverId: (r.approver_id as string | null) ?? null,
    submittedOn: (r.submitted_on as string | null) ?? null,
    actedOn: (r.acted_on as string | null) ?? null,
    note: (r.note as string) ?? '',
  };
};

/** What this caller may see: their own, their line, or everyone's. */
function scope(caller: Caller, column: string, params: unknown[]): string {
  if (caller.role === 'admin') return '';
  if (!caller.employeeId) {
    throw new TimesheetError('this login has no employee record', 'forbidden');
  }
  params.push(caller.employeeId);
  const p = `$${params.length}`;
  if (caller.role === 'employee') return `${column} = ${p}`;
  return `(${column} = ${p} OR ${column} IN (
     WITH RECURSIVE t AS (
       SELECT id FROM employee WHERE manager_id = ${p}
       UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
     ) SELECT id FROM t))`;
}

/* ---------------- reads ---------------- */

export interface TimesheetQuery {
  empIds?: string[];
  weekStart?: string;
  since?: string;
  status?: string;
}

export async function listTimesheets(
  caller: Caller,
  q: TimesheetQuery = {},
): Promise<Timesheet[]> {
  const params: unknown[] = [];
  const where: string[] = [];

  const scoped = scope(caller, 't.employee_id', params);
  if (scoped) where.push(scoped);

  if (q.empIds?.length) {
    params.push(q.empIds);
    where.push(`t.employee_id = ANY($${params.length}::uuid[])`);
  }
  if (q.weekStart) {
    params.push(q.weekStart);
    where.push(`t.week_start = $${params.length}::date`);
  }
  if (q.since) {
    params.push(q.since);
    where.push(`t.week_start >= $${params.length}::date`);
  }
  if (q.status) {
    const stored = FROM_STATUS[q.status];
    if (!stored) throw new TimesheetError(`unknown status: ${q.status}`, 'invalid');
    params.push(stored);
    where.push(`t.status = $${params.length}`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.week_start DESC, t.id`, params);
    return rows.map(toSheet);
  });
}

/**
 * One week, created on first sight.
 *
 * A week somebody has not touched has no row, and returning null would make
 * every caller handle "no timesheet yet" separately when an empty draft is the
 * correct answer for a week nobody has filled in.
 */
export async function timesheetForWeek(
  caller: Caller,
  empId: string,
  weekStart: string,
): Promise<Timesheet> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new TimesheetError('a week starts on a date', 'invalid');
  }
  if (caller.role === 'employee' && empId !== caller.employeeId) {
    throw new TimesheetError('you can only open your own timesheet', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    await db.query(
      `INSERT INTO timesheet (employee_id, week_start) VALUES ($1, $2::date)
       ON CONFLICT (tenant_id, employee_id, week_start) DO NOTHING`, [empId, weekStart]);
    const { rows } = await db.query(
      `${PROJECTION} WHERE t.employee_id = $1 AND t.week_start = $2::date`,
      [empId, weekStart]);
    if (!rows[0]) throw new TimesheetError('no such employee', 'not_found');
    return toSheet(rows[0]);
  });
}

/* ---------------- writes ---------------- */

/** The sheet, locked, with the checks every write shares. */
async function openForEdit(
  db: TenantClient,
  caller: Caller,
  id: string,
): Promise<{ employeeId: string; weekStart: string }> {
  const { rows } = await db.query(
    'SELECT employee_id, week_start, status FROM timesheet WHERE id = $1 FOR UPDATE', [id]);
  const row = rows[0];
  if (!row) throw new TimesheetError('no such timesheet', 'not_found');

  if (caller.role === 'employee' && row.employee_id !== caller.employeeId) {
    throw new TimesheetError('you can only edit your own timesheet', 'forbidden');
  }
  if (row.status !== 'draft' && row.status !== 'returned') {
    throw new TimesheetError(
      `a ${row.status} timesheet cannot be edited — recall it first`, 'not_editable');
  }
  return { employeeId: row.employee_id as string, weekStart: row.week_start as string };
}

/** Recompute the header total from the rows. Called by every write. */
async function retotal(db: TenantClient, id: string): Promise<void> {
  await db.query(
    `UPDATE timesheet
        SET total_hours = COALESCE(
              (SELECT sum(hours) FROM timesheet_entry WHERE timesheet_id = $1), 0),
            updated_at = now()
      WHERE id = $1`, [id]);
}

const reload = async (db: TenantClient, id: string): Promise<Timesheet> => {
  const { rows } = await db.query(`${PROJECTION} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw new TimesheetError('no such timesheet', 'not_found');
  return toSheet(rows[0]);
};

export interface EntryDraft {
  date: string;
  proj: string;
  task: string;
  billable?: boolean;
  hours?: number;
  remarks?: string;
}

/**
 * Check one entry's worth of input, and what it would do to the day and week.
 *
 * `exclude` skips an entry when editing it, so changing 8 hours to 9 is
 * measured against the day without its old value rather than on top of it.
 */
async function assertWithinLimits(
  db: TenantClient,
  sheetId: string,
  date: string,
  hours: number,
  exclude: string | null,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT COALESCE(sum(hours) FILTER (WHERE work_date = $2::date), 0)::float8 AS day,
            COALESCE(sum(hours), 0)::float8 AS week
       FROM timesheet_entry
      WHERE timesheet_id = $1 AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [sheetId, date, exclude]);

  const day = Number(rows[0]!.day) + hours;
  const week = Number(rows[0]!.week) + hours;

  if (day > MAX_DAY_HOURS) {
    throw new TimesheetError(
      `that would put ${day} hours on one day — the most there is is ${MAX_DAY_HOURS}`,
      'invalid');
  }
  if (week > MAX_WEEK_HOURS) {
    throw new TimesheetError(
      `that would put ${week} hours in the week — the most there is is ${MAX_WEEK_HOURS}`,
      'invalid');
  }
}

function assertDraft(draft: EntryDraft, weekStart: string): number {
  if (!draft.proj?.trim()) throw new TimesheetError('choose a project', 'invalid');
  if (!draft.task?.trim()) throw new TimesheetError('say what the work was', 'invalid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date ?? '')) {
    throw new TimesheetError('choose a day', 'invalid');
  }

  /* The day has to be inside the week the sheet is for. */
  const start = Date.parse(`${weekStart}T00:00:00Z`);
  const when = Date.parse(`${draft.date}T00:00:00Z`);
  const offset = Math.round((when - start) / 86_400_000);
  if (Number.isNaN(offset) || offset < 0 || offset >= DAYS) {
    throw new TimesheetError('that day is not in this week', 'invalid');
  }

  const hours = Number(draft.hours ?? 0);
  if (!Number.isFinite(hours)) throw new TimesheetError('hours must be a number', 'invalid');
  if (hours < 0) throw new TimesheetError('hours cannot be negative', 'invalid');
  if (hours > MAX_DAY_HOURS) {
    throw new TimesheetError(`${MAX_DAY_HOURS} hours is the most in a day`, 'invalid');
  }
  return Math.round(hours * 100) / 100;
}

export async function addEntry(
  caller: Caller,
  id: string,
  draft: EntryDraft,
): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    const { weekStart } = await openForEdit(db, caller, id);
    const hours = assertDraft(draft, weekStart);
    await assertWithinLimits(db, id, draft.date, hours, null);

    const proj = await db.query(
      'SELECT id FROM project WHERE code = $1 AND active', [draft.proj.trim()]);
    if (!proj.rows[0]) throw new TimesheetError(`no such project: ${draft.proj}`, 'not_found');

    /*
     * One entry per project, task and day — the table's own unique. A second
     * line for the same three is the same work said twice, so it merges rather
     * than failing on a constraint the person never sees.
     */
    await db.query(
      `INSERT INTO timesheet_entry
         (timesheet_id, project_id, task, work_date, hours, billable, note)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7)
       ON CONFLICT (tenant_id, timesheet_id, project_id, task, work_date)
       DO UPDATE SET hours = timesheet_entry.hours + EXCLUDED.hours,
                     billable = EXCLUDED.billable,
                     note = CASE WHEN EXCLUDED.note = '' THEN timesheet_entry.note
                                 ELSE EXCLUDED.note END`,
      [id, proj.rows[0].id, draft.task.trim(), draft.date, hours,
        draft.billable ?? true, (draft.remarks ?? '').trim()]);

    await retotal(db, id);
    return reload(db, id);
  });
}

export async function updateEntry(
  caller: Caller,
  id: string,
  entryId: string,
  patch: Partial<EntryDraft>,
): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    const { weekStart } = await openForEdit(db, caller, id);

    const cur = await db.query(
      `SELECT x.id, x.work_date, x.task, x.hours, x.billable, COALESCE(x.note, '') AS note,
              p.code AS proj
         FROM timesheet_entry x JOIN project p ON p.id = x.project_id
        WHERE x.id = $1 AND x.timesheet_id = $2`, [entryId, id]);
    if (!cur.rows[0]) throw new TimesheetError('no such entry', 'not_found');
    const now = cur.rows[0];

    const next: EntryDraft = {
      date: patch.date ?? (now.work_date as string),
      proj: patch.proj ?? (now.proj as string),
      task: patch.task ?? (now.task as string),
      billable: patch.billable ?? Boolean(now.billable),
      hours: patch.hours ?? Number(now.hours),
      remarks: patch.remarks ?? (now.note as string),
    };
    const hours = assertDraft(next, weekStart);
    await assertWithinLimits(db, id, next.date, hours, entryId);

    const proj = await db.query(
      'SELECT id FROM project WHERE code = $1 AND active', [next.proj.trim()]);
    if (!proj.rows[0]) throw new TimesheetError(`no such project: ${next.proj}`, 'not_found');

    await db.query(
      `UPDATE timesheet_entry
          SET project_id = $3, task = $4, work_date = $5::date,
              hours = $6, billable = $7, note = $8
        WHERE id = $1 AND timesheet_id = $2`,
      [entryId, id, proj.rows[0].id, next.task.trim(), next.date, hours,
        next.billable, (next.remarks ?? '').trim()]);

    await retotal(db, id);
    return reload(db, id);
  });
}

export async function removeEntry(
  caller: Caller,
  id: string,
  entryId: string,
): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    await openForEdit(db, caller, id);
    const { rowCount } = await db.query(
      'DELETE FROM timesheet_entry WHERE id = $1 AND timesheet_id = $2', [entryId, id]);
    if (!rowCount) throw new TimesheetError('no such entry', 'not_found');
    await retotal(db, id);
    return reload(db, id);
  });
}

/** The note to the manager. Separate from the entries, and editable with them. */
export async function setComment(
  caller: Caller,
  id: string,
  note: string,
): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    await openForEdit(db, caller, id);
    await db.query('UPDATE timesheet SET note = $2, updated_at = now() WHERE id = $1',
      [id, (note ?? '').trim()]);
    return reload(db, id);
  });
}

/**
 * Copy last week's lines onto this one.
 *
 * The shape of somebody's week rarely changes — same project, same handful of
 * tasks — and retyping it every Monday is the thing that stops timesheets
 * getting filled in. Hours come across too, because the common case is a
 * repeat; anything different is then an edit rather than an entry.
 *
 * Refuses when this week already has lines, rather than merging: somebody who
 * has started typing and then presses this meant to start again, and silently
 * doubling their morning is the worse guess.
 */
export async function copyPreviousWeek(caller: Caller, id: string): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    const { employeeId, weekStart } = await openForEdit(db, caller, id);

    const existing = await db.query(
      'SELECT 1 FROM timesheet_entry WHERE timesheet_id = $1 LIMIT 1', [id]);
    if (existing.rowCount) {
      throw new TimesheetError(
        'this week already has entries — clear them first', 'not_empty');
    }

    const prev = await db.query(
      `SELECT id FROM timesheet
        WHERE employee_id = $1 AND week_start = $2::date - 7`, [employeeId, weekStart]);
    if (!prev.rows[0]) {
      throw new TimesheetError('there is no previous week to copy', 'not_found');
    }

    const { rowCount } = await db.query(
      `INSERT INTO timesheet_entry
         (timesheet_id, project_id, task, work_date, hours, billable, note)
       SELECT $1, x.project_id, x.task, x.work_date + 7, x.hours, x.billable, x.note
         FROM timesheet_entry x WHERE x.timesheet_id = $2`, [id, prev.rows[0].id]);
    if (!rowCount) throw new TimesheetError('last week was empty', 'not_found');

    await retotal(db, id);
    return reload(db, id);
  });
}

/* ---------------- the workflow ---------------- */

export async function submitTimesheet(caller: Caller, id: string): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    await openForEdit(db, caller, id);

    const { rows } = await db.query(
      `SELECT COALESCE(sum(hours), 0)::float8 AS total,
              count(*) FILTER (WHERE task = '')::int AS untasked
         FROM timesheet_entry WHERE timesheet_id = $1`, [id]);
    if (Number(rows[0]!.total) <= 0) {
      throw new TimesheetError('there are no hours to submit', 'invalid');
    }
    if (Number(rows[0]!.untasked) > 0) {
      throw new TimesheetError('every line needs a task before this can go', 'invalid');
    }

    await db.query(
      `UPDATE timesheet SET status = 'submitted', submitted_on = CURRENT_DATE,
                            acted_on = NULL, updated_at = now()
        WHERE id = $1`, [id]);
    return reload(db, id);
  });
}

export async function recallTimesheet(caller: Caller, id: string): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT employee_id, status FROM timesheet WHERE id = $1 FOR UPDATE', [id]);
    const row = rows[0];
    if (!row) throw new TimesheetError('no such timesheet', 'not_found');
    if (caller.role === 'employee' && row.employee_id !== caller.employeeId) {
      throw new TimesheetError('you can only recall your own timesheet', 'forbidden');
    }
    if (row.status !== 'submitted') {
      throw new TimesheetError(
        `only a submitted timesheet can be recalled — this one is ${row.status}`,
        'not_recallable');
    }

    await db.query(
      `UPDATE timesheet SET status = 'draft', submitted_on = NULL, updated_at = now()
        WHERE id = $1`, [id]);
    return reload(db, id);
  });
}

/** Approve, return for correction, or refuse outright. */
export async function actOnTimesheet(
  caller: Caller,
  id: string,
  decision: 'approved' | 'returned' | 'rejected',
  note?: string,
): Promise<Timesheet> {
  if (caller.role === 'employee' || !caller.employeeId) {
    throw new TimesheetError('only a manager or admin may decide a timesheet', 'forbidden');
  }
  if (!['approved', 'returned', 'rejected'].includes(decision)) {
    throw new TimesheetError(`unknown decision: ${decision}`, 'invalid');
  }
  /* A refusal says why — the row's own CHECK insists, and a 409 from a
     constraint is a worse message than this one. */
  if (decision !== 'approved' && !note?.trim()) {
    throw new TimesheetError('say what needs fixing — the employee sees this', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT employee_id, status FROM timesheet WHERE id = $1 FOR UPDATE', [id]);
    const row = rows[0];
    if (!row) throw new TimesheetError('no such timesheet', 'not_found');
    if (row.status !== 'submitted') {
      throw new TimesheetError(
        `that timesheet is ${row.status}, not awaiting a decision`, 'already_decided');
    }
    if (row.employee_id === caller.employeeId) {
      throw new TimesheetError('you cannot decide your own timesheet', 'self_approval');
    }
    if (caller.role === 'manager') {
      const mine = await db.query(
        `WITH RECURSIVE t AS (
           SELECT id FROM employee WHERE manager_id = $1
           UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
         ) SELECT 1 FROM t WHERE id = $2`, [caller.employeeId, row.employee_id]);
      if (!mine.rowCount) throw new TimesheetError('that person is not in your team', 'forbidden');
    }

    await db.query(
      `UPDATE timesheet
          SET status = $2, approver_id = $3, acted_on = CURRENT_DATE,
              note = COALESCE($4, note), updated_at = now()
        WHERE id = $1`, [id, decision, caller.employeeId, note?.trim() ?? null]);
    return reload(db, id);
  });
}
