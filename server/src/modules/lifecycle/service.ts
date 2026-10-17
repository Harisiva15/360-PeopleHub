/**
 * The employment lifecycle.
 *
 * **There is no `setStage`, and that is the design.** The stage is derived —
 * here, in SQL, from the records the schema already keeps — so it cannot
 * disagree with them. `stageExpression` below is the whole rule, written once
 * and read by every query in this file.
 *
 * The precedence in it is the rule, not an implementation detail. Leaving
 * supersedes being active; long leave supersedes a promotion three months ago;
 * a candidate is a candidate whatever else is true. The first branch that
 * matches wins, and the order of the branches is the product decision.
 *
 * What this module writes is tasks — work somebody has to remember, which no
 * derivation can produce. Onboarding and offboarding tasks live in their own
 * tables and are deliberately not duplicated: two checklists that disagree
 * about whether a laptop came back is worse than one checklist in the wrong
 * place.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';
import { employeeScope } from '../../tenancy/scope.ts';
/* The one employment-history writer, shared with provisioning, users and exits. */
import { recordEmployment } from '../people/employment.ts';

export class LifecycleError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

export interface LifecycleTask {
  id: string;
  empId: string;
  stage: string;
  n: string;
  owner: string;
  assigneeId: string | null;
  due: string;
  done: boolean;
  doneOn: string | null;
  note: string;
}

export interface LifecycleSubject {
  id: string;
  name: string;
  code: string;
  dept: string;
  designation: string;
  site: string;
  managerId: string | null;
  startOn: string;
  onPayroll: boolean;
  /** Grade band code, or null where none has been recorded. */
  grade: string | null;
  /** The employee column, which confirming probation clears. */
  onProbation: boolean;
}

export interface Standing {
  empId: string;
  stage: string;
  since: string;
  daysInStage: number;
  nextAction: string | null;
}

export interface LifecycleRow {
  subject: LifecycleSubject;
  standing: Standing;
  openTasks: number;
}

export interface LifecycleFilter {
  q?: string | undefined;
  stage?: string | undefined;
  dept?: string | undefined;
  managerId?: string | undefined;
  site?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * The derivation, as a pair of correlated expressions.
 *
 * Both walk the same branches in the same order, so the stage and the date it
 * started can never describe different branches. Splitting them into two CASEs
 * that had to be kept in step by hand is exactly the kind of duplication this
 * module exists to avoid, so they are generated from one list.
 *
 * `LONG_LEAVE_DAYS` is a fortnight because anything shorter is a holiday, and
 * calling a holiday a lifecycle stage puts half the company in it every
 * December. `RECENT_MOVE_DAYS` is a quarter, after which a promotion is simply
 * somebody's job.
 */
const LONG_LEAVE_DAYS = 14;
const RECENT_MOVE_DAYS = 92;

const BRANCHES: { when: string; stage: string; since: string; next: string }[] = [
  {
    when: `e.status = 'exited'`,
    stage: `'Alumni'`,
    since: `COALESCE(e.left_on, x.last_working_day, CURRENT_DATE)`,
    next: `NULL`,
  },
  {
    when: `x.id IS NOT NULL AND x.status = 'in_clearance'`,
    stage: `'Offboarding'`,
    since: `x.last_working_day`,
    next: `'Complete clearance and settle dues'`,
  },
  {
    when: `x.id IS NOT NULL`,
    stage: `'Exit'`,
    since: `x.resigned_on`,
    next: `'Last working day ' || x.last_working_day::text`,
  },
  {
    when: `o.id IS NOT NULL AND o.status = 'pre_boarding'`,
    stage: `'Pre-boarding'`,
    /* When pre-boarding actually began, not the joining date it ends on. */
    since: `LEAST(COALESCE(o.first_task_on, o.joins_on), CURRENT_DATE)`,
    next: `o.pending_tasks::text || ' joining task(s) before day one'`,
  },
  {
    when: `o.id IS NOT NULL AND o.status <> 'completed'`,
    stage: `'Onboarding'`,
    since: `o.joins_on`,
    next: `o.pending_tasks::text || ' onboarding task(s) outstanding'`,
  },
  {
    when: `lv.id IS NOT NULL`,
    stage: `'Leave of Absence'`,
    since: `lv.starts_on`,
    next: `'Returns ' || lv.ends_on::text`,
  },
  {
    when: `mv.kind = 'promotion'`,
    stage: `'Promotion'`,
    since: `mv.occurred_on`,
    next: `'Confirm the change has taken effect in payroll'`,
  },
  {
    when: `mv.kind IS NOT NULL`,
    stage: `'Transfer'`,
    since: `mv.occurred_on`,
    next: `'Confirm the change has taken effect in payroll'`,
  },
  {
    when: `cf.occurred_on IS NULL AND e.joined_on > CURRENT_DATE - 180`,
    stage: `'Joined'`,
    since: `e.joined_on`,
    next: `'Probation review due ' || (e.joined_on + 180)::text`,
  },
];

const caseOver = (pick: 'stage' | 'since' | 'next') =>
  `CASE\n${BRANCHES.map((b) => `      WHEN ${b.when} THEN ${b[pick === 'next' ? 'next' : pick]}`).join('\n')}\n`
  + `      ELSE ${pick === 'stage' ? `'Active'` : pick === 'since' ? 'COALESCE(cf.occurred_on, e.joined_on)' : 'NULL'}\n    END`;

/**
 * Everything the derivation needs, joined once.
 *
 * Each lateral is the *one* row that matters — the open exit record, the
 * incomplete onboarding, the leave covering today, the most recent move. Doing
 * it any other way multiplies the employee row and makes every count wrong in
 * a way that looks like a data problem rather than a query problem.
 */
const BASE = `
  FROM employee e
  LEFT JOIN department d ON d.id = e.department_id
  LEFT JOIN site s ON s.id = e.site_id
  LEFT JOIN grade_band gb ON gb.id = e.grade_id
  LEFT JOIN LATERAL (
    SELECT xr.id, xr.status, xr.resigned_on, xr.last_working_day
      FROM exit_record xr
     WHERE xr.employee_id = e.id AND xr.status <> 'settled'
     ORDER BY xr.resigned_on DESC LIMIT 1
  ) x ON TRUE
  LEFT JOIN LATERAL (
    SELECT ob.id, ob.status, ob.joining_on AS joins_on,
           (SELECT count(*) FROM onboarding_task ot
             WHERE ot.journey_id = ob.id AND NOT ot.done) AS pending_tasks,
           /*
            * When pre-boarding actually began. The first completed task is the
            * record of it; the earliest due date is the fallback. The joining
            * date is neither — it is what pre-boarding ends on, and dating the
            * stage from it reported everybody as nought days in.
            */
           COALESCE(
             (SELECT min(ot.done_on) FROM onboarding_task ot
               WHERE ot.journey_id = ob.id AND ot.done),
             (SELECT min(ot.due_on) FROM onboarding_task ot
               WHERE ot.journey_id = ob.id)
           ) AS first_task_on
      FROM onboarding_journey ob
     WHERE ob.employee_id = e.id AND ob.status NOT IN ('completed', 'cancelled')
     ORDER BY ob.joining_on DESC LIMIT 1
  ) o ON TRUE
  LEFT JOIN LATERAL (
    SELECT lr.id, lr.starts_on, lr.ends_on
      FROM leave_request lr
     WHERE lr.employee_id = e.id
       AND lr.status = 'approved'
       AND lr.days >= ${LONG_LEAVE_DAYS}
       AND lr.starts_on <= CURRENT_DATE AND lr.ends_on >= CURRENT_DATE
     ORDER BY lr.starts_on DESC LIMIT 1
  ) lv ON TRUE
  LEFT JOIN LATERAL (
    SELECT er.reason AS kind, er.valid_from AS occurred_on
      FROM employment_record er
     WHERE er.employee_id = e.id
       AND er.reason IN ('promotion', 'transfer', 'role_change')
       AND er.valid_from >= CURRENT_DATE - ${RECENT_MOVE_DAYS}
     ORDER BY er.valid_from DESC LIMIT 1
  ) mv ON TRUE
  LEFT JOIN LATERAL (
    SELECT er.valid_from AS occurred_on FROM employment_record er
     WHERE er.employee_id = e.id AND er.reason = 'probation_confirmed'
     ORDER BY er.valid_from DESC LIMIT 1
  ) cf ON TRUE`;

interface Row {
  id: string; name: string; code: string; dept_code: string | null;
  designation: string; site_code: string | null; manager_id: string | null;
  joined_on: string; on_payroll: boolean;
  grade_code: string | null; on_probation: boolean;
  stage: string; since: string; days: string; next_action: string | null;
  open_tasks: string;
}

const toRow = (r: Row): LifecycleRow => ({
  subject: {
    id: r.id,
    name: r.name,
    code: r.code,
    dept: r.dept_code ?? '',
    designation: r.designation ?? '',
    site: r.site_code ?? '',
    managerId: r.manager_id,
    startOn: r.joined_on,
    onPayroll: r.on_payroll,
    grade: r.grade_code,
    onProbation: r.on_probation,
  },
  standing: {
    empId: r.id,
    stage: r.stage,
    since: r.since,
    daysInStage: Math.max(0, Number(r.days)),
    nextAction: r.next_action,
  },
  openTasks: Number(r.open_tasks),
});

/**
 * `since` is floored at today.
 *
 * Several branches read forward-looking dates — a joining date, a last working
 * day. Somebody in clearance whose last day is next month would otherwise be
 * reported as having entered the stage on a day that has not happened. They
 * are in it now; the record exists now; today is the honest floor.
 */
const SINCE = `LEAST((${caseOver('since')}), CURRENT_DATE)`;

const PROJECTION = `
  SELECT e.id, e.full_name AS name, e.code, d.code AS dept_code, e.designation,
         s.code AS site_code, e.manager_id, e.joined_on::text,
         /*
          * Null where none is recorded, deliberately. The employee mapper
          * coalesces a missing grade to L1, which on a promotion form would
          * tell somebody they hold a band nobody has given them.
          */
         gb.code AS grade_code, e.on_probation,
         /*
          * Everybody in this table is on the payroll. The demo's population
          * also carries candidates and joiners, who have no employee row —
          * and so cannot appear here at all. The two pipeline stages the
          * module can show against a real database are the ones with an
          * onboarding journey attached to a real person; Candidate and Offer
          * belong to the recruitment tables and are read from there.
          */
         TRUE AS on_payroll,
         (${caseOver('stage')}) AS stage,
         ${SINCE}::text AS since,
         (CURRENT_DATE - ${SINCE})::text AS days,
         (${caseOver('next')}) AS next_action,
         (SELECT count(*) FROM lifecycle_task lt
           WHERE lt.employee_id = e.id AND lt.done_on IS NULL)::text AS open_tasks
  ${BASE}`;

export async function listLifecycle(
  caller: Caller,
  f: LifecycleFilter = {},
): Promise<LifecycleRow[]> {
  const params: unknown[] = [];
  const where: string[] = [employeeScope(caller, 'e.id', params)];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (f.dept) where.push(`d.code = ${bind(f.dept)}`);
  if (f.site) where.push(`s.code = ${bind(f.site)}`);
  if (f.managerId) where.push(`e.manager_id = ${bind(f.managerId)}`);
  if (f.q?.trim()) {
    const p = bind(`%${f.q.trim()}%`);
    where.push(`(e.full_name ILIKE ${p} OR e.code ILIKE ${p} OR e.designation ILIKE ${p})`);
  }

  /*
   * The stage and the date it started are filtered outside the projection,
   * because a CASE cannot be referenced by its alias in its own WHERE. The
   * subquery is the ordinary way round that and costs nothing — Postgres
   * flattens it.
   */
  const outer: string[] = [];
  if (f.stage) outer.push(`stage = ${bind(f.stage)}`);
  if (f.from) outer.push(`since >= ${bind(f.from)}`);
  if (f.to) outer.push(`since <= ${bind(f.to)}`);

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(
      `SELECT * FROM (${PROJECTION} WHERE ${where.join(' AND ')}) q
       ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
       ORDER BY days::int DESC`,
      params,
    );
    return rows.map(toRow);
  });
}

export interface LifecycleDetail extends LifecycleRow {
  events: { on: string; type: string; note: string; from: string | null; to: string | null }[];
  tasks: LifecycleTask[];
}

export async function getLifecycle(
  caller: Caller,
  id: string,
): Promise<LifecycleDetail | null> {
  const params: unknown[] = [id];
  const scope = employeeScope(caller, 'e.id', params);

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(
      `${PROJECTION} WHERE e.id = $1 AND (${scope})`, params);
    if (!rows[0]) {
      /* Distinguish "not yours" from "not there": they need different answers. */
      const { rows: exists } = await db.query('SELECT 1 FROM employee WHERE id = $1', [id]);
      if (exists.length) {
        throw new LifecycleError('That person is outside the people you can see', 'forbidden');
      }
      return null;
    }

    /*
     * The employment history is the record of changes, which this schema keeps
     * as one row per state rather than one row per transition. So each row
     * carries the value it moved *to*; the previous row is the value it moved
     * from, and the screen pairs them. Synthesising a `from` here would mean
     * inventing one for the first row.
     */
    const { rows: events } = await db.query<{
      occurred_on: string; kind: string; note: string; to_value: string | null;
    }>(
      `SELECT valid_from::text AS occurred_on, reason AS kind,
              COALESCE(note, '') AS note, designation AS to_value
         FROM employment_record WHERE employee_id = $1 ORDER BY valid_from DESC`,
      [id],
    );

    const tasks = await tasksFor(db, id);

    return {
      ...toRow(rows[0]),
      events: events.map((e, i) => ({
        on: e.occurred_on,
        type: e.kind,
        note: e.note,
        /* Newest first, so the row *after* this one is what it moved from. */
        from: events[i + 1]?.to_value ?? null,
        to: e.to_value,
      })),
      tasks,
    };
  });
}

interface TaskRow {
  id: string; employee_id: string; stage: string; title: string;
  owner_team: string; assignee_id: string | null; due_on: string;
  done_on: string | null; note: string;
}

const toTask = (r: TaskRow): LifecycleTask => ({
  id: r.id,
  empId: r.employee_id,
  stage: r.stage,
  n: r.title,
  owner: r.owner_team,
  assigneeId: r.assignee_id,
  due: r.due_on,
  done: r.done_on !== null,
  doneOn: r.done_on,
  note: r.note,
});

async function tasksFor(
  db: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
  empId: string,
): Promise<LifecycleTask[]> {
  const { rows } = await db.query<TaskRow>(
    `SELECT id, employee_id, stage, title, owner_team, assignee_id,
            due_on::text, done_on::text, note
       FROM lifecycle_task WHERE employee_id = $1 ORDER BY due_on`,
    [empId],
  );
  return rows.map(toTask);
}

export interface LifecycleStats {
  newJoiners: number; preboarding: number; onboarding: number; probation: number;
  promotions: number; transfers: number; onLeave: number; exits: number;
  offboarding: number;
}

export async function lifecycleStats(caller: Caller): Promise<LifecycleStats> {
  const rows = await listLifecycle(caller);
  const at = (s: string) => rows.filter((r) => r.standing.stage === s).length;
  return {
    newJoiners: at('Joined'),
    preboarding: at('Pre-boarding'),
    onboarding: at('Onboarding'),
    probation: at('Joined'),
    promotions: at('Promotion'),
    transfers: at('Transfer'),
    onLeave: at('Leave of Absence'),
    exits: at('Exit'),
    offboarding: at('Offboarding'),
  };
}

export interface LifecycleTaskDraft {
  n: string;
  due: string;
  owner?: string | undefined;
  assigneeId?: string | null | undefined;
  note?: string | undefined;
}

export async function addLifecycleTask(
  caller: Caller,
  empId: string,
  d: LifecycleTaskDraft,
): Promise<LifecycleTask> {
  if (caller.role === 'employee') {
    throw new LifecycleError('Your role cannot assign lifecycle tasks', 'forbidden');
  }
  if (!d.n?.trim()) throw new LifecycleError('Say what the task is', 'invalid');
  if (!d.due) throw new LifecycleError('Give the task a due date', 'invalid');

  /* The stage is read at the moment the task is raised and then kept. */
  const row = await getLifecycle(caller, empId);
  if (!row) throw new LifecycleError('No such person', 'not_found');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query<TaskRow>(
      `INSERT INTO lifecycle_task
         (employee_id, stage, title, owner_team, assignee_id, due_on, note, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, employee_id, stage, title, owner_team, assignee_id,
                 due_on::text, done_on::text, note`,
      [empId, row.standing.stage, d.n.trim(), d.owner ?? 'HR',
        d.assigneeId ?? null, d.due, d.note ?? '', caller.employeeId],
    );
    return toTask(rows[0]!);
  });
}

export async function setLifecycleTaskDone(
  caller: Caller,
  taskId: string,
  done: boolean,
): Promise<LifecycleTask> {
  return withTenant(caller, async (db) => {
    const { rows: found } = await db.query<{ employee_id: string; assignee_id: string | null }>(
      'SELECT employee_id, assignee_id FROM lifecycle_task WHERE id = $1', [taskId]);
    const task = found[0];
    if (!task) throw new LifecycleError('No such task', 'not_found');

    /*
     * An employee may complete a task assigned to them, and nothing else.
     * Not "a task about them" — being the subject of a task is not the same as
     * owing it, and the person who owes it is the one who can say it is done.
     */
    if (caller.role === 'employee' && task.assignee_id !== caller.employeeId) {
      throw new LifecycleError('You can only complete a task assigned to you', 'forbidden');
    }
    if (caller.role === 'manager') {
      const params: unknown[] = [task.employee_id];
      const scope = employeeScope(caller, '$1::uuid', params);
      const { rows: ok } = await db.query(`SELECT 1 WHERE ${scope}`, params);
      if (!ok.length) {
        throw new LifecycleError('That person is outside the people you can see', 'forbidden');
      }
    }

    const { rows } = await db.query<TaskRow>(
      `UPDATE lifecycle_task SET done_on = ${done ? 'CURRENT_DATE' : 'NULL'}
        WHERE id = $1
       RETURNING id, employee_id, stage, title, owner_team, assignee_id,
                 due_on::text, done_on::text, note`,
      [taskId],
    );
    return toTask(rows[0]!);
  });
}

export async function removeLifecycleTask(
  caller: Caller,
  taskId: string,
): Promise<LifecycleTask> {
  if (caller.role !== 'admin') {
    throw new LifecycleError('Only an administrator can remove a lifecycle task', 'forbidden');
  }
  return withTenant(caller, async (db) => {
    /* RETURNING, so the deleted row comes back without a second read. */
    const { rows } = await db.query<TaskRow>(
      `DELETE FROM lifecycle_task WHERE id = $1
       RETURNING id, employee_id, stage, title, owner_team, assignee_id,
                 due_on::text, done_on::text, note`,
      [taskId]);
    if (!rows[0]) throw new LifecycleError('No such task', 'not_found');
    return toTask(rows[0]);
  });
}

/* ------------------------------------------------------------------ *
 * Explicit lifecycle operations
 * ------------------------------------------------------------------ */

/**
 * Confirming probation.
 *
 * The derivation has always had the branch: somebody with no
 * `probation_confirmed` record who joined within 180 days reads as **Joined**,
 * with "Probation review due" as the next action. The screen asked for the
 * action and there was no action to take — the stage simply expired at 180
 * days, and everybody became Active from their joining date rather than from
 * the day somebody decided they had passed.
 *
 * It is deliberately explicit. Confirmation is not "180 days elapsed", and it
 * is not implied by a title change or a new manager: it is a decision somebody
 * makes and is accountable for, which is why the record carries who made it.
 *
 * `on` lets a confirmation be recorded on the date the decision was actually
 * taken rather than the date it was typed in. It cannot precede the joining
 * date — a record of employment terms cannot begin before the employment — and
 * it cannot be in the future, because a confirmation is a record of something
 * that has happened.
 */
export async function confirmProbation(
  caller: Caller,
  empId: string,
  opts: { on?: string | null; note?: string | null } = {},
): Promise<LifecycleDetail> {
  if (caller.role === 'employee') {
    throw new LifecycleError('Your role cannot confirm probation', 'forbidden');
  }

  /* Scope, by reusing the read. Somebody outside it does not exist here. */
  const subject = await getLifecycle(caller, empId);
  if (!subject) throw new LifecycleError('No such person', 'not_found');

  await withTenant(caller, async (db) => {
    const { rows } = await db.query<{ joined_on: string; status: string }>(
      `SELECT joined_on::text AS joined_on, status FROM employee
        WHERE id = $1 FOR UPDATE`, [empId]);
    const emp = rows[0];
    if (!emp) throw new LifecycleError('No such person', 'not_found');
    if (emp.status === 'exited') {
      throw new LifecycleError('That person has left', 'invalid');
    }

    /*
     * Once. A second confirmation would put a second `probation_confirmed`
     * record on the timeline for something that happens once, and the
     * derivation reads the most recent — so the date would silently move.
     */
    const { rows: already } = await db.query<{ was: string }>(
      `SELECT valid_from::text AS was FROM employment_record
        WHERE employee_id = $1 AND reason = 'probation_confirmed'
        ORDER BY valid_from DESC LIMIT 1`, [empId]);
    if (already[0]) {
      throw new LifecycleError(
        `Probation was already confirmed on ${already[0].was}`, 'conflict');
    }

    const { rows: dateRow } = await db.query<{ d: string; ahead: boolean }>(
      `SELECT COALESCE($1::date, CURRENT_DATE)::text AS d,
              (COALESCE($1::date, CURRENT_DATE) > CURRENT_DATE) AS ahead`,
      [opts.on ?? null]);
    const on = dateRow[0]!.d;

    if (dateRow[0]!.ahead) {
      throw new LifecycleError('Probation cannot be confirmed in advance', 'invalid');
    }
    if (on < emp.joined_on) {
      throw new LifecycleError(
        `Probation cannot be confirmed before the joining date (${emp.joined_on})`,
        'invalid');
    }

    /*
     * The column and the history move together. `on_probation` is what the
     * employee record says; the employment record is what the timeline reads.
     * Letting them disagree is how somebody shows as confirmed on one screen
     * and on probation on another.
     */
    await db.query('UPDATE employee SET on_probation = false WHERE id = $1', [empId]);
    await recordEmployment(db, empId, 'probation_confirmed', {
      on, recordedBy: caller.employeeId, note: opts.note ?? null,
    });
  });

  const after = await getLifecycle(caller, empId);
  if (!after) throw new LifecycleError('No such person', 'not_found');
  return after;
}

/** What a promotion moves. At least one of these has to change. */
export interface PromotionDraft {
  /** A grade band code, as the company has defined them. */
  gradeCode?: string | null;
  designation?: string | null;
  on?: string | null;
  note?: string | null;
}

/**
 * Promoting somebody.
 *
 * Ordinary changes of title or reporting line go through `updateUser` and are
 * recorded as `role_change`, which is right: deciding that a new title is a
 * promotion rather than a lateral move is a judgement about grade and pay, and
 * inferring it would put "Promotion" on somebody's record because their team
 * was restructured.
 *
 * So a promotion is declared rather than detected. This is that declaration,
 * and the only thing in the product that writes `reason = 'promotion'`.
 *
 * The domain already supports it. `grade_band` carries a `rank`,
 * `employee.grade_id` points at one, and `employment_record.grade_id` records
 * which band the terms belonged to. A promotion is a move up that ladder, a
 * change of title, or both — no new field and no new policy.
 *
 * A move to a *lower* band is refused rather than recorded. There is no
 * `demotion` reason, and filing one as a promotion would make the record say
 * something untrue; `updateUser` records that as the role change it is.
 */
export async function promote(
  caller: Caller,
  empId: string,
  draft: PromotionDraft,
): Promise<LifecycleDetail> {
  if (caller.role === 'employee') {
    throw new LifecycleError('Your role cannot promote somebody', 'forbidden');
  }
  const wantsGrade = Boolean(draft.gradeCode?.trim());
  const wantsTitle = Boolean(draft.designation?.trim());
  if (!wantsGrade && !wantsTitle) {
    throw new LifecycleError('A promotion changes a grade, a title, or both', 'invalid');
  }

  const subject = await getLifecycle(caller, empId);
  if (!subject) throw new LifecycleError('No such person', 'not_found');

  await withTenant(caller, async (db) => {
    const { rows } = await db.query<{
      joined_on: string; status: string; designation: string | null;
      grade_id: string | null; rank: number | null;
    }>(
      `SELECT e.joined_on::text AS joined_on, e.status, e.designation, e.grade_id, g.rank
         FROM employee e LEFT JOIN grade_band g ON g.id = e.grade_id
        WHERE e.id = $1 FOR UPDATE OF e`, [empId]);
    const emp = rows[0];
    if (!emp) throw new LifecycleError('No such person', 'not_found');
    if (emp.status === 'exited') {
      throw new LifecycleError('That person has left', 'invalid');
    }

    let gradeId: string | null = null;
    if (wantsGrade) {
      const code = draft.gradeCode!.trim();
      const { rows: band } = await db.query<{ id: string; rank: number }>(
        'SELECT id, rank FROM grade_band WHERE code = $1', [code]);
      if (!band[0]) throw new LifecycleError(`No such grade: ${code}`, 'invalid');
      gradeId = band[0].id;

      if (emp.rank !== null && band[0].rank < emp.rank) {
        throw new LifecycleError(
          `${code} is below their current grade. A move down is not a promotion — `
          + 'record it as a change of role instead.',
          'invalid');
      }
      if (gradeId === emp.grade_id && !wantsTitle) {
        throw new LifecycleError('They are already on that grade', 'invalid');
      }
    }

    if (wantsTitle && !wantsGrade
      && draft.designation!.trim() === (emp.designation ?? '')) {
      throw new LifecycleError('They already hold that title', 'invalid');
    }

    const { rows: dateRow } = await db.query<{ d: string }>(
      'SELECT COALESCE($1::date, CURRENT_DATE)::text AS d', [draft.on ?? null]);
    const on = dateRow[0]!.d;
    if (on < emp.joined_on) {
      throw new LifecycleError(
        `A promotion cannot take effect before the joining date (${emp.joined_on})`,
        'invalid');
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (gradeId) { params.push(gradeId); sets.push(`grade_id = $${params.length}`); }
    if (wantsTitle) {
      params.push(draft.designation!.trim());
      sets.push(`designation = $${params.length}`);
    }
    params.push(empId);
    await db.query(`UPDATE employee SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

    await recordEmployment(db, empId, 'promotion', {
      on, recordedBy: caller.employeeId, note: draft.note ?? null,
    });
  });

  const after = await getLifecycle(caller, empId);
  if (!after) throw new LifecycleError('No such person', 'not_found');
  return after;
}
