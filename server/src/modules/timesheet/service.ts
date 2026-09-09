/**
 * Timesheets — a week of hours per project and task, submitted for approval.
 *
 * **A "row" is a (project, task) pair, not a position.** The contract addresses
 * rows by index because the editor renders them as a list, but an index is not
 * an identity: delete row 0 and every later index means something different.
 * The schema already says what a row is — `timesheet_entry` is unique on
 * (timesheet, project, task, work_date) — so the index here is resolved against
 * a deterministic ordering of those pairs, and the pair is what gets written.
 *
 * **An empty row is seven zero-hour entries.** A row the user has added but not
 * filled in has to survive a reload, and per-day storage has nowhere to put a
 * row with no days. Seven rows of `0.00` are cheap and keep one representation
 * rather than two.
 *
 * **The total is never taken from the caller.** `total_hours` is recomputed
 * from the entries inside the same transaction as every edit, for the same
 * reason attendance recomputes worked minutes: it is the number that decides
 * what a client is billed and what a contractor is paid.
 *
 * **A submitted sheet is not editable.** The mock let any cell be typed over at
 * any status, which would let someone alter hours a manager had already
 * approved. Here, only a draft or a returned sheet takes edits.
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

export type TSStatus = 'Draft' | 'Submitted' | 'Approved' | 'Rejected' | 'Missing';

export interface TSRow {
  proj: string;
  task: string;
  /** Hours Monday through Sunday. */
  h: number[];
}

export interface Timesheet {
  id: string;
  empId: string;
  weekStart: string;
  rows: TSRow[];
  total: number;
  status: TSStatus;
  approverId: string | null;
  submittedOn: string | null;
  note: string;
}

/** 'returned' is the database's word for what the screens call 'Rejected'. */
const TO_STATUS: Record<string, TSStatus> = {
  draft: 'Draft', submitted: 'Submitted', approved: 'Approved', returned: 'Rejected',
};

/** Statuses that still accept edits. Everything else is a claim someone acted on. */
const EDITABLE = new Set(['draft', 'returned']);

const DAYS = 7;

/**
 * The sheet and its rows in one round trip.
 *
 * Rows are ordered by (project code, task) — the same pair the unique index is
 * built on — so the row index the editor sends means the same thing on the next
 * call as it did on the last.
 */
const PROJECTION = `
  SELECT t.id, t.employee_id, t.week_start, t.status, t.total_hours,
         t.submitted_on, t.approver_id, t.note,
         COALESCE(rows.rows, '[]'::jsonb) AS rows
    FROM timesheet t
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(r ORDER BY r->>'proj', r->>'task') AS rows
        FROM (
          SELECT jsonb_build_object(
                   'proj', p.code,
                   'task', e.task,
                   'h', (
                     SELECT jsonb_agg(COALESCE(d.hours, 0)::float8 ORDER BY d.offset_days)
                       FROM generate_series(0, ${DAYS - 1}) AS g(offset_days)
                       LEFT JOIN LATERAL (
                         SELECT x.hours, g.offset_days
                           FROM timesheet_entry x
                          WHERE x.timesheet_id = t.id
                            AND x.project_id = e.project_id
                            AND x.task = e.task
                            AND x.work_date = t.week_start + g.offset_days
                       ) d ON true
                   )
                 ) AS r
            FROM (
              SELECT DISTINCT project_id, task
                FROM timesheet_entry
               WHERE timesheet_id = t.id
            ) e
            JOIN project p ON p.id = e.project_id
        ) AS pairs
    ) rows ON true`;

const toSheet = (r: Record<string, unknown>): Timesheet => ({
  id: r.id as string,
  empId: r.employee_id as string,
  weekStart: r.week_start as string,
  rows: (r.rows as TSRow[]).map((row) => ({
    proj: row.proj,
    task: row.task,
    // A row written before a day existed can come back short; the editor
    // indexes h[0..6] unconditionally.
    h: Array.from({ length: DAYS }, (_, i) => Number(row.h?.[i] ?? 0)),
  })),
  total: Number(r.total_hours ?? 0),
  status: TO_STATUS[r.status as string] ?? 'Draft',
  approverId: (r.approver_id as string | null) ?? null,
  submittedOn: (r.submitted_on as string | null) ?? null,
  note: (r.note as string) ?? '',
});

/** Who the caller may see timesheets for. */
async function maySee(db: TenantClient, caller: Caller, empId: string): Promise<boolean> {
  if (caller.role === 'admin') return true;
  if (empId === caller.employeeId) return true;
  if (caller.role !== 'manager') return false;
  const r = await db.query(
    `WITH RECURSIVE t AS (
       SELECT id FROM employee WHERE manager_id = $1
       UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
     ) SELECT 1 FROM t WHERE id = $2`, [caller.employeeId, empId]);
  return (r.rowCount ?? 0) > 0;
}

async function load(db: TenantClient, id: string): Promise<Timesheet> {
  const { rows } = await db.query(`${PROJECTION} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw new TimesheetError('no such timesheet', 'not_found');
  return toSheet(rows[0]);
}

/**
 * Recompute the stored total from the entries.
 *
 * Called inside every mutation's transaction rather than trusted from the
 * caller — the total is what a client is invoiced against.
 */
async function retotal(db: TenantClient, id: string): Promise<void> {
  await db.query(
    `UPDATE timesheet t
        SET total_hours = COALESCE(
              (SELECT sum(e.hours) FROM timesheet_entry e WHERE e.timesheet_id = t.id), 0),
            updated_at = now()
      WHERE t.id = $1`, [id]);
}

/**
 * Fetch a sheet for editing: it must exist, belong to the caller, and still be
 * in a status that takes edits.
 */
async function forEdit(db: TenantClient, caller: Caller, id: string): Promise<{ status: string }> {
  const { rows } = await db.query(
    'SELECT employee_id, status FROM timesheet WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new TimesheetError('no such timesheet', 'not_found');
  if (rows[0].employee_id !== caller.employeeId && caller.role !== 'admin') {
    throw new TimesheetError('you can only edit your own timesheet', 'forbidden');
  }
  if (!EDITABLE.has(rows[0].status)) {
    throw new TimesheetError(
      `this timesheet is ${TO_STATUS[rows[0].status]?.toLowerCase() ?? rows[0].status} `
      + 'and can no longer be edited',
      'not_editable');
  }
  return rows[0] as { status: string };
}

/** Resolve a row index against the same ordering the projection returns. */
async function rowAt(
  db: TenantClient,
  id: string,
  rowIndex: number,
): Promise<{ project_id: string; task: string }> {
  const { rows } = await db.query(
    `SELECT e.project_id, e.task
       FROM (SELECT DISTINCT project_id, task FROM timesheet_entry WHERE timesheet_id = $1) e
       JOIN project p ON p.id = e.project_id
      ORDER BY p.code, e.task
      OFFSET $2 LIMIT 1`, [id, rowIndex]);
  if (!rows[0]) throw new TimesheetError(`no row ${rowIndex} on this timesheet`, 'no_row');
  return rows[0] as { project_id: string; task: string };
}

async function projectId(db: TenantClient, code: string): Promise<string> {
  const { rows } = await db.query('SELECT id FROM project WHERE code = $1 AND active', [code]);
  if (!rows[0]) throw new TimesheetError(`no such project: ${code}`, 'no_project');
  return rows[0].id as string;
}

export interface TimesheetQuery {
  empIds?: string[];
  weekStart?: string;
  since?: string;
  status?: TSStatus;
}

export async function listTimesheets(
  caller: Caller,
  q: TimesheetQuery = {},
): Promise<Timesheet[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  // Scope first and unconditionally: empIds narrows, it never widens.
  if (caller.role === 'employee') {
    params.push(caller.employeeId);
    where.push(`t.employee_id = $${params.length}`);
  } else if (caller.role === 'manager') {
    params.push(caller.employeeId);
    where.push(`(t.employee_id = $${params.length} OR t.employee_id IN (
       WITH RECURSIVE r AS (
         SELECT id FROM employee WHERE manager_id = $${params.length}
         UNION ALL SELECT c.id FROM employee c JOIN r ON c.manager_id = r.id
       ) SELECT id FROM r))`);
  }
  if (q.empIds?.length) {
    params.push(q.empIds);
    where.push(`t.employee_id = ANY($${params.length}::uuid[])`);
  }
  if (q.weekStart) { params.push(q.weekStart); where.push(`t.week_start = $${params.length}`); }
  if (q.since) { params.push(q.since); where.push(`t.week_start >= $${params.length}`); }
  if (q.status) {
    const db = Object.entries(TO_STATUS).find(([, v]) => v === q.status)?.[0];
    if (db) { params.push(db); where.push(`t.status = $${params.length}`); }
  }

  return withTenantReadOnly(caller, async (client) => {
    const { rows } = await client.query(
      `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.week_start DESC`, params);
    return rows.map(toSheet);
  });
}

/**
 * The sheet for one person's week, created as an empty draft if missing.
 *
 * Creation belongs here rather than in the editor, which used to conjure the
 * row mid-render. The unique on (tenant, employee, week_start) is what makes
 * the ON CONFLICT safe against two tabs opening the same week at once.
 */
export async function timesheetForWeek(
  caller: Caller,
  empId: string,
  weekStart: string,
): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    if (!(await maySee(db, caller, empId))) {
      throw new TimesheetError('that person is not in your team', 'forbidden');
    }

    // A week is a Monday. Anything else would let two overlapping "weeks"
    // exist for the same days and both look valid.
    const dow = await db.query('SELECT EXTRACT(ISODOW FROM $1::date)::int AS d', [weekStart]);
    if (dow.rows[0].d !== 1) {
      throw new TimesheetError('a timesheet week starts on a Monday', 'invalid');
    }

    const { rows } = await db.query(
      `INSERT INTO timesheet (employee_id, week_start, approver_id)
       SELECT $1, $2, e.manager_id FROM employee e WHERE e.id = $1
       ON CONFLICT (tenant_id, employee_id, week_start) DO UPDATE SET updated_at = now()
       RETURNING id`, [empId, weekStart]);

    return load(db, rows[0].id);
  });
}

/** Add a (project, task) row, as seven zero-hour days. */
export async function addRow(
  caller: Caller,
  id: string,
  proj: string,
  task: string,
): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    await forEdit(db, caller, id);
    const pid = await projectId(db, proj);

    const existing = await db.query(
      'SELECT 1 FROM timesheet_entry WHERE timesheet_id = $1 AND project_id = $2 AND task = $3',
      [id, pid, task]);
    if ((existing.rowCount ?? 0) > 0) {
      throw new TimesheetError('that project and task are already on this sheet', 'duplicate');
    }

    await db.query(
      `INSERT INTO timesheet_entry (timesheet_id, project_id, task, work_date, hours, billable)
       SELECT $1, $2, $3, t.week_start + g, 0, p.billable
         FROM timesheet t, project p, generate_series(0, ${DAYS - 1}) AS g
        WHERE t.id = $1 AND p.id = $2`, [id, pid, task]);

    await retotal(db, id);
    return load(db, id);
  });
}

export async function removeRow(caller: Caller, id: string, rowIndex: number): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    await forEdit(db, caller, id);
    const row = await rowAt(db, id, rowIndex);
    await db.query(
      'DELETE FROM timesheet_entry WHERE timesheet_id = $1 AND project_id = $2 AND task = $3',
      [id, row.project_id, row.task]);
    await retotal(db, id);
    return load(db, id);
  });
}

/**
 * Repoint a row at a different project or task.
 *
 * This moves every day of the row together, because the (project, task) pair
 * IS the row — changing it on Monday only would silently split one row in two.
 */
export async function setRow(
  caller: Caller,
  id: string,
  rowIndex: number,
  patch: { proj?: string; task?: string },
): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    await forEdit(db, caller, id);
    const row = await rowAt(db, id, rowIndex);
    const pid = patch.proj === undefined ? row.project_id : await projectId(db, patch.proj);
    const task = patch.task === undefined ? row.task : patch.task;

    if (pid === row.project_id && task === row.task) return load(db, id);

    const clash = await db.query(
      'SELECT 1 FROM timesheet_entry WHERE timesheet_id = $1 AND project_id = $2 AND task = $3',
      [id, pid, task]);
    if ((clash.rowCount ?? 0) > 0) {
      throw new TimesheetError('that project and task are already on this sheet', 'duplicate');
    }

    await db.query(
      `UPDATE timesheet_entry SET project_id = $2, task = $3
        WHERE timesheet_id = $1 AND project_id = $4 AND task = $5`,
      [id, pid, task, row.project_id, row.task]);

    await retotal(db, id);
    return load(db, id);
  });
}

/** Set one cell. The returned sheet already carries the recomputed total. */
export async function setHours(
  caller: Caller,
  id: string,
  rowIndex: number,
  dayIndex: number,
  hours: number,
): Promise<Timesheet> {
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new TimesheetError('hours must be between 0 and 24', 'invalid');
  }
  if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= DAYS) {
    throw new TimesheetError('a week has seven days', 'invalid');
  }

  return withTenant(caller, async (db) => {
    await forEdit(db, caller, id);
    const row = await rowAt(db, id, rowIndex);

    await db.query(
      `INSERT INTO timesheet_entry (timesheet_id, project_id, task, work_date, hours, billable)
       SELECT $1, $2, $3, t.week_start + $4::int, $5, p.billable
         FROM timesheet t, project p WHERE t.id = $1 AND p.id = $2
       ON CONFLICT (tenant_id, timesheet_id, project_id, task, work_date)
         DO UPDATE SET hours = EXCLUDED.hours`,
      [id, row.project_id, row.task, dayIndex, hours]);

    await retotal(db, id);
    return load(db, id);
  });
}

export async function submitTimesheet(caller: Caller, id: string): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    await forEdit(db, caller, id);
    await retotal(db, id);

    const { rows } = await db.query('SELECT total_hours FROM timesheet WHERE id = $1', [id]);
    if (Number(rows[0].total_hours) <= 0) {
      throw new TimesheetError('log at least one hour before submitting', 'empty');
    }

    await db.query(
      `UPDATE timesheet
          SET status = 'submitted', submitted_on = CURRENT_DATE, note = '', updated_at = now()
        WHERE id = $1`, [id]);
    return load(db, id);
  });
}

/** Pull a sheet back before anyone has acted on it. */
export async function recallTimesheet(caller: Caller, id: string): Promise<Timesheet> {
  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT employee_id, status FROM timesheet WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new TimesheetError('no such timesheet', 'not_found');
    if (rows[0].employee_id !== caller.employeeId && caller.role !== 'admin') {
      throw new TimesheetError('you can only recall your own timesheet', 'forbidden');
    }
    if (rows[0].status !== 'submitted') {
      throw new TimesheetError('only a submitted timesheet can be recalled', 'not_submitted');
    }

    await db.query(
      `UPDATE timesheet SET status = 'draft', submitted_on = NULL, updated_at = now()
        WHERE id = $1`, [id]);
    return load(db, id);
  });
}

/** A manager's decision on a submitted sheet. Shared by approve and reject. */
async function decide(
  caller: Caller,
  id: string,
  to: 'approved' | 'returned',
  note: string,
): Promise<Timesheet> {
  if (caller.role === 'employee') {
    throw new TimesheetError('only a manager or admin may decide this', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT employee_id, status FROM timesheet WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new TimesheetError('no such timesheet', 'not_found');

    if (rows[0].employee_id === caller.employeeId) {
      throw new TimesheetError('you cannot decide your own timesheet', 'self_approval');
    }
    if (!(await maySee(db, caller, rows[0].employee_id))) {
      throw new TimesheetError('that person is not in your team', 'forbidden');
    }
    if (rows[0].status !== 'submitted') {
      throw new TimesheetError(
        `only a submitted timesheet can be decided — this one is ${TO_STATUS[rows[0].status]?.toLowerCase()}`,
        'not_submitted');
    }

    await db.query(
      `UPDATE timesheet
          SET status = $2, approver_id = $3, acted_on = CURRENT_DATE, note = $4, updated_at = now()
        WHERE id = $1`, [id, to, caller.employeeId, note]);
    return load(db, id);
  });
}

export const approveTimesheet = (caller: Caller, id: string): Promise<Timesheet> =>
  decide(caller, id, 'approved', '');

export const rejectTimesheet = (caller: Caller, id: string, note: string): Promise<Timesheet> =>
  decide(caller, id, 'returned', note);
