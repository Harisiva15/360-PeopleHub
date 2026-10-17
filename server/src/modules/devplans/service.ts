/**
 * Development plans.
 *
 * **The authorisation inverts here, deliberately.** A development plan is the
 * employee's document — they write it, they own it, they tick it off — and the
 * manager's part is to endorse it. So `mayEdit` is the subject and an
 * administrator, and a manager is explicitly not included. A manager rewriting
 * somebody's stated aspiration is the failure mode this document has in every
 * company that has ever run one.
 *
 * **A course action's progress is the enrolment's.** The database refuses a
 * completion date on an action naming a course (0035), and this file reads the
 * figure from `enrollment` rather than keeping one. Two copies of "how far
 * through the AWS course are you" disagree within a fortnight, and the plan is
 * the copy nobody updates.
 *
 * **Endorsement is withdrawn when the plan changes materially.** A manager who
 * signed off "move into a lead role" has not signed off whatever replaced it,
 * and carrying the signature across would make endorsement mean nothing.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';
import { employeeScope } from '../../tenancy/scope.ts';

export class DevPlanError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'DevPlanError';
    this.code = code;
  }
}

export interface DevPlan {
  id: string; empId: string; aspiration: string; targetLevel: string | null;
  horizonMonths: number; from: string; to: string; status: string;
  mentorId: string | null; focus: string[]; strengths: string;
  createdOn: string; reviewOn: string;
  endorsedOn: string | null; endorsedById: string | null; notes: string;
}

export interface DevPlanRow {
  plan: DevPlan; name: string; dept: string; designation: string;
  managerId: string | null; progress: number; actions: number; done: number;
  overdue: number; endorsed: boolean; reviewDue: boolean;
}

export interface DevActionRow {
  action: {
    id: string; planId: string; kind: string; area: string; n: string;
    courseId: string | null; due: string; doneOn: string | null; note: string;
  };
  progress: number; done: boolean; overdue: boolean;
  fromEnrolment: boolean; courseTitle: string | null;
}

export interface DevPlanDetail extends DevPlanRow {
  items: DevActionRow[];
  history: unknown[];
}

export interface DevPlanFilter {
  q?: string | undefined; status?: string | undefined; dept?: string | undefined;
  managerId?: string | undefined; mentorId?: string | undefined;
  area?: string | undefined; endorsed?: boolean | undefined;
  reviewDue?: boolean | undefined; overdueOnly?: boolean | undefined;
}

export interface DevPlanDraft {
  empId?: string | undefined;
  aspiration: string;
  targetLevel?: string | null | undefined;
  horizonMonths: number;
  focus: string[];
  mentorId?: string | null | undefined;
  strengths?: string | undefined;
  reviewOn?: string | undefined;
  notes?: string | undefined;
}

export interface DevActionDraft {
  kind: string; area: string; n: string; due: string;
  courseId?: string | null | undefined; note?: string | undefined;
}

interface PlanRow {
  id: string; employee_id: string; aspiration: string; target_level: string | null;
  horizon_months: number; starts_on: string; ends_on: string; status: string;
  mentor_id: string | null; focus_areas: string[]; strengths: string;
  created_on: string; review_on: string; endorsed_on: string | null;
  endorsed_by_id: string | null; notes: string;
  name: string; dept_code: string | null; designation: string;
  manager_id: string | null;
  actions: string; done_actions: string; overdue_actions: string; progress: string;
}

/**
 * Progress, computed where the data is.
 *
 * A course action's figure comes from `enrollment`; everything else is a tick.
 * Doing it in SQL rather than fetching every action and every enrolment means
 * a list of eighty plans is one query, and — more importantly — that the
 * screen and the export cannot disagree about the arithmetic.
 */
const ACTION_PROGRESS = `
  CASE
    WHEN a.course_id IS NOT NULL THEN
      COALESCE((SELECT CASE WHEN en.status = 'completed' THEN 100
                            ELSE en.progress END
                  FROM enrollment en
                 WHERE en.course_id = a.course_id
                   AND en.employee_id = p.employee_id
                 LIMIT 1), 0)
    WHEN a.done_on IS NOT NULL THEN 100
    ELSE 0
  END`;

const PLAN_PROJECTION = `
  SELECT p.id, p.employee_id, p.aspiration, p.target_level, p.horizon_months,
         p.starts_on::text, p.ends_on::text, p.status, p.mentor_id,
         p.focus_areas, p.strengths, p.created_on::text, p.review_on::text,
         p.endorsed_on::text, p.endorsed_by_id, p.notes,
         e.full_name AS name, d.code AS dept_code,
         COALESCE(e.designation, '') AS designation, e.manager_id,
         COALESCE(x.total, 0)::text     AS actions,
         COALESCE(x.done, 0)::text      AS done_actions,
         COALESCE(x.overdue, 0)::text   AS overdue_actions,
         COALESCE(x.progress, 0)::text  AS progress
    FROM development_plan p
    JOIN employee e ON e.id = p.employee_id
    LEFT JOIN department d ON d.id = e.department_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS total,
             count(*) FILTER (WHERE (${ACTION_PROGRESS}) >= 100) AS done,
             count(*) FILTER (
               WHERE a.due_on < CURRENT_DATE AND (${ACTION_PROGRESS}) < 100
             ) AS overdue,
             round(avg(${ACTION_PROGRESS})) AS progress
        FROM development_action a WHERE a.plan_id = p.id
    ) x ON TRUE`;

const toPlan = (r: PlanRow): DevPlanRow => ({
  plan: {
    id: r.id, empId: r.employee_id, aspiration: r.aspiration,
    targetLevel: r.target_level, horizonMonths: r.horizon_months,
    from: r.starts_on, to: r.ends_on, status: r.status, mentorId: r.mentor_id,
    focus: r.focus_areas ?? [], strengths: r.strengths, createdOn: r.created_on,
    reviewOn: r.review_on, endorsedOn: r.endorsed_on,
    endorsedById: r.endorsed_by_id, notes: r.notes,
  },
  name: r.name,
  dept: r.dept_code ?? '',
  designation: r.designation,
  managerId: r.manager_id,
  progress: Number(r.progress),
  actions: Number(r.actions),
  done: Number(r.done_actions),
  overdue: Number(r.overdue_actions),
  endorsed: r.endorsed_on !== null,
  reviewDue: r.status === 'Active' && r.review_on <= new Date().toISOString().slice(0, 10),
});

export async function listDevPlans(
  caller: Caller,
  f: DevPlanFilter = {},
): Promise<DevPlanRow[]> {
  const params: unknown[] = [];
  const where: string[] = [employeeScope(caller, 'p.employee_id', params)];
  const outer: string[] = [];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (f.status) where.push(`p.status = ${bind(f.status)}`);
  if (f.dept) where.push(`d.code = ${bind(f.dept)}`);
  if (f.managerId) where.push(`e.manager_id = ${bind(f.managerId)}`);
  if (f.mentorId) where.push(`p.mentor_id = ${bind(f.mentorId)}`);
  if (f.area) where.push(`${bind(f.area)} = ANY(p.focus_areas)`);
  if (f.endorsed !== undefined) {
    where.push(f.endorsed ? 'p.endorsed_on IS NOT NULL' : 'p.endorsed_on IS NULL');
  }
  if (f.reviewDue) where.push(`p.status = 'Active' AND p.review_on <= CURRENT_DATE`);
  if (f.q?.trim()) {
    const p = bind(`%${f.q.trim()}%`);
    where.push(`(e.full_name ILIKE ${p} OR e.designation ILIKE ${p} OR p.aspiration ILIKE ${p})`);
  }
  if (f.overdueOnly) outer.push('overdue_actions::int > 0');

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<PlanRow>(
      `SELECT * FROM (${PLAN_PROJECTION} WHERE ${where.join(' AND ')}) q
       ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
       ORDER BY name`,
      params,
    );
    return rows.map(toPlan);
  });
}

async function actionsFor(
  db: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
  planId: string,
): Promise<DevActionRow[]> {
  const { rows } = await db.query<{
    id: string; plan_id: string; kind: string; area: string; title: string;
    course_id: string | null; due_on: string; done_on: string | null; note: string;
    progress: string; course_title: string | null;
  }>(
    `SELECT a.id, a.plan_id, a.kind, a.area, a.title, a.course_id,
            a.due_on::text, a.done_on::text, a.note,
            (${ACTION_PROGRESS})::text AS progress,
            c.title AS course_title
       FROM development_action a
       JOIN development_plan p ON p.id = a.plan_id
       LEFT JOIN course c ON c.id = a.course_id
      WHERE a.plan_id = $1
      ORDER BY a.due_on`,
    [planId],
  );
  return rows.map((r) => {
    const progress = Number(r.progress);
    return {
      action: {
        id: r.id, planId: r.plan_id, kind: r.kind, area: r.area, n: r.title,
        courseId: r.course_id, due: r.due_on, doneOn: r.done_on, note: r.note,
      },
      progress,
      done: progress >= 100,
      overdue: r.due_on < new Date().toISOString().slice(0, 10) && progress < 100,
      fromEnrolment: r.course_id !== null,
      courseTitle: r.course_title,
    };
  });
}

export async function getDevPlan(caller: Caller, id: string): Promise<DevPlanDetail | null> {
  const params: unknown[] = [id];
  const scope = employeeScope(caller, 'p.employee_id', params);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<PlanRow>(
      `${PLAN_PROJECTION} WHERE p.id = $1 AND (${scope})`, params);
    if (!rows[0]) {
      const { rows: exists } = await db.query('SELECT 1 FROM development_plan WHERE id = $1', [id]);
      if (exists.length) {
        throw new DevPlanError('That plan belongs to somebody you cannot see', 'forbidden');
      }
      return null;
    }
    return { ...toPlan(rows[0]), items: await actionsFor(db, id), history: [] };
  });
}

export async function myDevPlan(caller: Caller): Promise<DevPlanDetail | null> {
  if (!caller.employeeId) return null;
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<PlanRow>(
      `${PLAN_PROJECTION} WHERE p.employee_id = $1 AND p.status <> 'Cancelled'
       ORDER BY p.created_on DESC LIMIT 1`,
      [caller.employeeId],
    );
    if (!rows[0]) return null;
    return { ...toPlan(rows[0]), items: await actionsFor(db, rows[0].id), history: [] };
  });
}

export async function devPlanStats(caller: Caller) {
  const rows = await listDevPlans(caller);
  const live = rows.filter((r) => r.plan.status === 'Active');
  const headcount = await withTenantReadOnly(caller, async (db) => {
    const { rows: h } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM employee WHERE status <> 'exited'`);
    return Number(h[0]?.n ?? 0);
  });
  return {
    plans: rows.length,
    active: live.length,
    drafts: rows.filter((r) => r.plan.status === 'Draft').length,
    completed: rows.filter((r) => r.plan.status === 'Completed').length,
    endorsed: rows.filter((r) => r.endorsed).length,
    reviewsDue: live.filter((r) => r.reviewDue).length,
    actions: rows.reduce((n, r) => n + r.actions, 0),
    actionsDone: rows.reduce((n, r) => n + r.done, 0),
    overdue: live.reduce((n, r) => n + r.overdue, 0),
    withMentor: live.filter((r) => r.plan.mentorId).length,
    /* Endorsed live plans over headcount. Drafts are not coverage. */
    coverage: headcount
      ? Math.round((live.filter((r) => r.endorsed).length / headcount) * 100)
      : 0,
  };
}

const AREAS = [
  'Technical skills', 'Leadership', 'Communication', 'Domain knowledge',
  'Process & delivery', 'Commercial',
];

export async function devFocus(caller: Caller) {
  const rows = await listDevPlans(caller, { status: 'Active' });
  return AREAS
    .map((area) => ({ area, plans: rows.filter((r) => r.plan.focus.includes(area)).length }))
    .filter((r) => r.plans > 0);
}

export async function mentorLoad(caller: Caller) {
  if (caller.role === 'employee') {
    throw new DevPlanError('Your role cannot see who is mentoring whom', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<{ mentor_id: string; name: string; mentees: string }>(
      `SELECT p.mentor_id, e.full_name AS name, count(*)::text AS mentees
         FROM development_plan p JOIN employee e ON e.id = p.mentor_id
        WHERE p.status = 'Active' AND p.mentor_id IS NOT NULL
        GROUP BY p.mentor_id, e.full_name
        ORDER BY count(*) DESC`);
    return rows.map((r) => ({ mentorId: r.mentor_id, name: r.name, mentees: Number(r.mentees) }));
  });
}

/**
 * Who is available to mentor.
 *
 * Open to everybody, because an employee writing their own plan has to pick
 * somebody from it — names and designations are already public in the org
 * chart, so the list itself gives nothing away.
 *
 * **The mentee count is not.** How many people somebody is already mentoring
 * is a workload figure, and `mentorLoad` above restricts exactly that to a
 * manager. Returning it here to an employee would have made that restriction
 * decorative, which is what an audit of unguarded functions turned up.
 */
export async function mentorOptions(caller: Caller) {
  const showLoad = caller.role !== 'employee';
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<{
      id: string; name: string; designation: string; mentees: string;
    }>(
      `SELECT e.id, e.full_name AS name, COALESCE(e.designation, '') AS designation,
              (SELECT count(*) FROM development_plan p
                WHERE p.mentor_id = e.id AND p.status = 'Active')::text AS mentees
         FROM employee e
        WHERE e.status <> 'exited'
          AND e.designation ~* '(Manager|Head|Lead|Director|Chief|VP)'
          AND ($1::uuid IS NULL OR e.id <> $1::uuid)
        ORDER BY e.full_name`,
      [caller.employeeId],
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, designation: r.designation,
      mentees: showLoad ? Number(r.mentees) : 0,
    }));
  });
}

/** The person whose plan it is, and an administrator. Not their manager. */
const mayEdit = (caller: Caller, empId: string) =>
  caller.role === 'admin' || caller.employeeId === empId;

const validate = (d: Partial<DevPlanDraft>) => {
  if (d.aspiration !== undefined && !d.aspiration.trim()) {
    throw new DevPlanError('Say what you are aiming at', 'invalid');
  }
  if (d.focus !== undefined) {
    if (!d.focus.length) throw new DevPlanError('Choose at least one focus area', 'invalid');
    const bad = d.focus.find((a) => !AREAS.includes(a));
    if (bad) throw new DevPlanError(`Not a focus area: ${bad}`, 'invalid');
  }
  if (d.horizonMonths !== undefined && ![6, 12, 24].includes(d.horizonMonths)) {
    throw new DevPlanError('Choose a horizon of 6, 12 or 24 months', 'invalid');
  }
};

export async function createDevPlan(caller: Caller, d: DevPlanDraft): Promise<DevPlan> {
  const empId = d.empId ?? caller.employeeId;
  if (!empId) throw new DevPlanError('No employee to raise a plan for', 'invalid');
  /*
   * An employee writes their own plan and nobody else's. A manager raising one
   * on somebody's behalf sounds helpful and produces a document the person has
   * never read.
   */
  if (empId !== caller.employeeId && caller.role !== 'admin') {
    throw new DevPlanError('A development plan is written by the person it is about', 'forbidden');
  }
  validate(d);
  if (d.mentorId && d.mentorId === empId) {
    throw new DevPlanError('You cannot mentor yourself', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO development_plan
         (employee_id, aspiration, target_level, horizon_months, starts_on, ends_on,
          status, mentor_id, focus_areas, strengths, review_on, notes)
       VALUES ($1,$2,$3,$4,CURRENT_DATE, CURRENT_DATE + ($4 * 30),
               'Draft',$5,$6,$7,
               COALESCE($8::date, CURRENT_DATE + 90), $9)
       RETURNING id`,
      [empId, d.aspiration.trim(), d.targetLevel ?? null, d.horizonMonths,
        d.mentorId ?? null, d.focus, d.strengths ?? '', d.reviewOn ?? null, d.notes ?? ''],
    ).catch((e: { constraint?: string }) => {
      if (e.constraint === 'development_plan_one_live') {
        throw new DevPlanError('There is already a live plan — complete or cancel it first', 'duplicate');
      }
      if (e.constraint === 'development_plan_no_self_mentor') {
        throw new DevPlanError('You cannot mentor yourself', 'invalid');
      }
      throw e;
    });
    const made = await getDevPlan(caller, rows[0]!.id);
    if (!made) throw new DevPlanError('The plan was not created', 'invalid');
    return made.plan;
  });
}

export async function updateDevPlan(
  caller: Caller,
  id: string,
  patch: Partial<DevPlanDraft>,
): Promise<DevPlan> {
  validate(patch);
  return withTenant(caller, async (db) => {
    const { rows: found } = await db.query<{
      employee_id: string; status: string; endorsed_on: string | null;
      aspiration: string; target_level: string | null; horizon_months: number;
      focus_areas: string[];
    }>(
      `SELECT employee_id, status, endorsed_on::text, aspiration, target_level,
              horizon_months, focus_areas
         FROM development_plan WHERE id = $1`, [id]);
    const plan = found[0];
    if (!plan) throw new DevPlanError('No such plan', 'not_found');
    if (!mayEdit(caller, plan.employee_id)) {
      throw new DevPlanError('Only the person a plan is about can change it', 'forbidden');
    }
    if (plan.status === 'Completed' || plan.status === 'Cancelled') {
      throw new DevPlanError(`A ${plan.status.toLowerCase()} plan cannot be changed`, 'invalid');
    }

    /*
     * A change to what the plan is *for* withdraws the endorsement. Anything
     * else — a note, a mentor, the review date — leaves it standing.
     */
    const material =
      (patch.aspiration !== undefined && patch.aspiration.trim() !== plan.aspiration)
      || (patch.targetLevel !== undefined && (patch.targetLevel ?? null) !== plan.target_level)
      || (patch.horizonMonths !== undefined && patch.horizonMonths !== plan.horizon_months)
      || (patch.focus !== undefined
        && JSON.stringify([...patch.focus].sort()) !== JSON.stringify([...plan.focus_areas].sort()));

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (patch.aspiration !== undefined) set('aspiration', patch.aspiration.trim());
    if (patch.targetLevel !== undefined) set('target_level', patch.targetLevel);
    if (patch.horizonMonths !== undefined) {
      set('horizon_months', patch.horizonMonths);
      sets.push('ends_on = starts_on + (horizon_months * 30)');
    }
    if (patch.focus !== undefined) set('focus_areas', patch.focus);
    if (patch.mentorId !== undefined) set('mentor_id', patch.mentorId);
    if (patch.strengths !== undefined) set('strengths', patch.strengths);
    if (patch.reviewOn !== undefined) set('review_on', patch.reviewOn);
    if (patch.notes !== undefined) set('notes', patch.notes);

    if (material && plan.endorsed_on) {
      sets.push(`endorsed_on = NULL`, `endorsed_by_id = NULL`, `status = 'Draft'`);
    }

    if (sets.length) {
      params.push(id);
      await db.query(
        `UPDATE development_plan SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    const after = await getDevPlan(caller, id);
    if (!after) throw new DevPlanError('No such plan', 'not_found');
    return after.plan;
  });
}

export async function endorseDevPlan(caller: Caller, id: string): Promise<DevPlan> {
  return withTenant(caller, async (db) => {
    const { rows: found } = await db.query<{ employee_id: string; status: string; actions: string }>(
      `SELECT p.employee_id, p.status,
              (SELECT count(*) FROM development_action a WHERE a.plan_id = p.id)::text AS actions
         FROM development_plan p WHERE p.id = $1`, [id]);
    const plan = found[0];
    if (!plan) throw new DevPlanError('No such plan', 'not_found');
    if (plan.employee_id === caller.employeeId) {
      throw new DevPlanError('You cannot endorse your own plan', 'forbidden');
    }
    if (caller.role === 'employee') {
      throw new DevPlanError('Only their manager can endorse this plan', 'forbidden');
    }
    if (caller.role === 'manager') {
      const { rows: ok } = await db.query(
        `WITH RECURSIVE line AS (
           SELECT id FROM employee WHERE manager_id = $1
           UNION ALL SELECT c.id FROM employee c JOIN line ON c.manager_id = line.id
         ) SELECT 1 FROM line WHERE id = $2`,
        [caller.employeeId, plan.employee_id]);
      if (!ok.length) throw new DevPlanError('Only their manager can endorse this plan', 'forbidden');
    }
    if (plan.status === 'Cancelled') throw new DevPlanError('That plan was cancelled', 'invalid');
    /*
     * A plan with no actions is an intention. Endorsing one would let coverage
     * count documents that commit nobody to anything.
     */
    if (Number(plan.actions) === 0) {
      throw new DevPlanError('A plan with no actions is an intention — add at least one first', 'invalid');
    }

    await db.query(
      `UPDATE development_plan
          SET endorsed_on = CURRENT_DATE, endorsed_by_id = $1,
              status = CASE WHEN status = 'Draft' THEN 'Active' ELSE status END
        WHERE id = $2`,
      [caller.employeeId, id]);

    const after = await getDevPlan(caller, id);
    if (!after) throw new DevPlanError('No such plan', 'not_found');
    return after.plan;
  });
}

export async function setDevPlanStatus(
  caller: Caller,
  id: string,
  status: string,
): Promise<DevPlan> {
  return withTenant(caller, async (db) => {
    const { rows: found } = await db.query<{ employee_id: string; endorsed_on: string | null }>(
      'SELECT employee_id, endorsed_on::text FROM development_plan WHERE id = $1', [id]);
    const plan = found[0];
    if (!plan) throw new DevPlanError('No such plan', 'not_found');
    if (!mayEdit(caller, plan.employee_id)) {
      throw new DevPlanError('Only the person a plan is about can close it', 'forbidden');
    }
    if (status === 'Active' && !plan.endorsed_on) {
      throw new DevPlanError('A plan becomes active when it is endorsed, not before', 'invalid');
    }
    await db.query('UPDATE development_plan SET status = $1 WHERE id = $2', [status, id]);
    const after = await getDevPlan(caller, id);
    if (!after) throw new DevPlanError('No such plan', 'not_found');
    return after.plan;
  });
}

export async function setDevPlanReview(
  caller: Caller,
  id: string,
  on: string,
): Promise<DevPlan> {
  if (!on) throw new DevPlanError('Give the review a date', 'invalid');
  return withTenant(caller, async (db) => {
    const params: unknown[] = [id];
    const scope = employeeScope(caller, 'employee_id', params);
    const { rowCount } = await db.query(
      `UPDATE development_plan SET review_on = $${params.push(on)}
        WHERE id = $1 AND (${scope})`, params);
    if (!rowCount) throw new DevPlanError('That plan belongs to somebody you cannot see', 'forbidden');
    const after = await getDevPlan(caller, id);
    if (!after) throw new DevPlanError('No such plan', 'not_found');
    return after.plan;
  });
}

export async function addDevAction(
  caller: Caller,
  planId: string,
  d: DevActionDraft,
): Promise<DevActionRow['action']> {
  if (!d.n?.trim()) throw new DevPlanError('Say what the action is', 'invalid');
  if (!d.due) throw new DevPlanError('Give the action a date', 'invalid');

  return withTenant(caller, async (db) => {
    const { rows: found } = await db.query<{ employee_id: string }>(
      'SELECT employee_id FROM development_plan WHERE id = $1', [planId]);
    const plan = found[0];
    if (!plan) throw new DevPlanError('No such plan', 'not_found');
    if (!mayEdit(caller, plan.employee_id)) {
      throw new DevPlanError('Only the person a plan is about can add to it', 'forbidden');
    }

    const { rows } = await db.query<{
      id: string; kind: string; area: string; title: string;
      course_id: string | null; due_on: string; done_on: string | null; note: string;
    }>(
      `INSERT INTO development_action (plan_id, kind, area, title, course_id, due_on, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, kind, area, title, course_id, due_on::text, done_on::text, note`,
      [planId, d.kind, d.area, d.n.trim(), d.courseId ?? null, d.due, d.note ?? ''],
    ).catch((e: { code?: string }) => {
      if (e.code === '23503') throw new DevPlanError('No such course', 'invalid');
      throw e;
    });
    const r = rows[0]!;
    return {
      id: r.id, planId, kind: r.kind, area: r.area, n: r.title,
      courseId: r.course_id, due: r.due_on, doneOn: r.done_on, note: r.note,
    };
  });
}

export async function setDevActionDone(
  caller: Caller,
  actionId: string,
  done: boolean,
): Promise<DevActionRow['action']> {
  return withTenant(caller, async (db) => {
    const { rows: found } = await db.query<{
      plan_id: string; employee_id: string; course_id: string | null;
    }>(
      `SELECT a.plan_id, p.employee_id, a.course_id
         FROM development_action a JOIN development_plan p ON p.id = a.plan_id
        WHERE a.id = $1`, [actionId]);
    const row = found[0];
    if (!row) throw new DevPlanError('No such action', 'not_found');
    if (!mayEdit(caller, row.employee_id)) {
      throw new DevPlanError('Only the person a plan is about can tick this off', 'forbidden');
    }
    /*
     * The one thing this module will not do. A course action's state lives in
     * the enrolment, and 0035 makes writing a second copy impossible — this
     * catches it before the database does, so the message says where to go.
     */
    if (row.course_id) {
      throw new DevPlanError(
        'This tracks a course — complete it in Learning and it updates here', 'invalid');
    }

    const { rows } = await db.query<{
      id: string; plan_id: string; kind: string; area: string; title: string;
      course_id: string | null; due_on: string; done_on: string | null; note: string;
    }>(
      `UPDATE development_action SET done_on = ${done ? 'CURRENT_DATE' : 'NULL'}
        WHERE id = $1
       RETURNING id, plan_id, kind, area, title, course_id,
                 due_on::text, done_on::text, note`,
      [actionId]);
    const r = rows[0]!;
    return {
      id: r.id, planId: r.plan_id, kind: r.kind, area: r.area, n: r.title,
      courseId: r.course_id, due: r.due_on, doneOn: r.done_on, note: r.note,
    };
  });
}

export async function removeDevAction(
  caller: Caller,
  actionId: string,
): Promise<DevActionRow['action']> {
  return withTenant(caller, async (db) => {
    const { rows: found } = await db.query<{ employee_id: string }>(
      `SELECT p.employee_id FROM development_action a
         JOIN development_plan p ON p.id = a.plan_id WHERE a.id = $1`, [actionId]);
    const row = found[0];
    if (!row) throw new DevPlanError('No such action', 'not_found');
    if (!mayEdit(caller, row.employee_id)) {
      throw new DevPlanError('Only the person a plan is about can remove this', 'forbidden');
    }
    const { rows } = await db.query<{
      id: string; plan_id: string; kind: string; area: string; title: string;
      course_id: string | null; due_on: string; done_on: string | null; note: string;
    }>(
      `DELETE FROM development_action WHERE id = $1
       RETURNING id, plan_id, kind, area, title, course_id,
                 due_on::text, done_on::text, note`,
      [actionId]);
    const r = rows[0]!;
    return {
      id: r.id, planId: r.plan_id, kind: r.kind, area: r.area, n: r.title,
      courseId: r.course_id, due: r.due_on, doneOn: r.done_on, note: r.note,
    };
  });
}
