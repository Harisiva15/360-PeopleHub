/**
 * Performance — cycles, goals, check-ins, reviews and praise.
 *
 * **A goal's status is derived from its progress, never set beside it.** The
 * schema says as much ("derived from progress by the service"), and the reason
 * is that two fields describing the same thing will disagree the first time
 * one is written without the other — and it is always the status that goes
 * stale, because it is the one nobody edits deliberately. It is stored rather
 * than computed on read only so reports do not have to know the thresholds.
 *
 * **Goal achievement is weighted, and the weights are the scorecard.** A
 * review's `goal_achievement` is the weighted mean of its goals' progress, so
 * finishing a 5%-weight goal does not move the number the way finishing a
 * 40%-weight one does. Computed in SQL from the goals themselves, because an
 * attainment figure that disagrees with the goals under it is the number
 * somebody's increment gets argued about.
 *
 * **Ratings are separate fields, not one.** Self, manager and final each have
 * their own column and their own submission date, and the schema refuses a
 * calibrated review without a final rating. Collapsing them would lose the one
 * thing a review conversation is about: who said what, and when.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class PerformanceError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'PerformanceError';
    this.code = code;
  }
}

const TO_GOAL_STATUS: Record<string, string> = {
  achieved: 'Achieved', on_track: 'On Track', at_risk: 'At Risk', behind: 'Behind',
};

/**
 * The thresholds, in one place.
 *
 * They are a policy rather than a law, and the only thing that matters is that
 * every screen reads the same set — which is why they are here and not in the
 * three places that used to derive them.
 */
const statusFor = (progress: number): string =>
  progress >= 100 ? 'achieved' : progress >= 60 ? 'on_track' : progress >= 35 ? 'at_risk' : 'behind';

export interface KeyResult { k: string; done: boolean }

export interface Goal {
  id: string;
  empId: string;
  cycleId: string;
  title: string;
  category: string;
  weight: number;
  progress: number;
  due: string;
  status: string;
  alignedTo: string | null;
  keyResults: KeyResult[];
}

export interface Cycle {
  id: string;
  name: string;
  from: string;
  to: string;
  status: string;
  hikePool: number;
}

export interface CheckIn {
  id: string;
  empId: string;
  on: string;
  by: string | null;
  wins: string;
  blockers: string;
  next: string;
}

export interface Praise {
  id: string;
  fromId: string;
  toId: string;
  value: string;
  text: string;
  on: string;
  likes: number;
}

export interface Review {
  id: string;
  empId: string;
  cycleId: string;
  status: string;
  goalAchievement: number;
  self: { rating: number | null; comments: string; on: string | null };
  manager: { rating: number | null; comments: string; on: string | null; by: string | null };
  peers: { peerId: string; rating: number | null; comments: string }[];
  potential: number;
  final: { rating: number; hike: number; promoted: boolean } | null;
  pip: boolean;
}

/** Everyone reads their own; a manager reads their tree; an admin reads all. */
function scope(caller: Caller, column: string, params: unknown[]): string {
  if (caller.role === 'admin') return '';
  params.push(caller.employeeId);
  const p = `$${params.length}`;
  if (caller.role === 'employee') return `${column} = ${p}`;
  return `(${column} = ${p} OR ${column} IN (
     WITH RECURSIVE t AS (
       SELECT id FROM employee WHERE manager_id = ${p}
       UNION ALL SELECT e.id FROM employee e JOIN t ON e.manager_id = t.id
     ) SELECT id FROM t))`;
}

const GOAL_PROJECTION = `
  SELECT g.id, g.employee_id, g.cycle_id, g.title, g.category, g.weight,
         g.progress, g.status, g.due_on, g.aligned_to,
         COALESCE(kr.results, '[]'::jsonb) AS key_results
    FROM goal g
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('k', k.title, 'done', k.done)
             ORDER BY k.display_order, k.id) AS results
        FROM key_result k WHERE k.goal_id = g.id
    ) kr ON true`;

const toGoal = (r: Record<string, unknown>): Goal => ({
  id: r.id as string,
  empId: r.employee_id as string,
  cycleId: r.cycle_id as string,
  title: r.title as string,
  category: (r.category as string) ?? '',
  weight: Number(r.weight),
  progress: Number(r.progress),
  due: (r.due_on as string) ?? '',
  status: TO_GOAL_STATUS[r.status as string] ?? 'Behind',
  alignedTo: (r.aligned_to as string | null) ?? null,
  keyResults: r.key_results as KeyResult[],
});

export async function listGoals(caller: Caller, empIds?: string[]): Promise<Goal[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  const scoped = scope(caller, 'g.employee_id', params);
  if (scoped) where.push(scoped);
  if (empIds?.length) {
    params.push(empIds);
    where.push(`g.employee_id = ANY($${params.length}::uuid[])`);
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${GOAL_PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY g.due_on NULLS LAST, g.id`, params);
    return rows.map(toGoal);
  });
}

/**
 * The cycle everyone is being measured in.
 *
 * Created on demand for the current financial year if none exists, because a
 * performance screen with no cycle is a screen nothing can be logged against.
 */
export async function currentCycle(caller: Caller): Promise<Cycle> {
  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT id, code, name, starts_on, ends_on, status, hike_pool_percent
         FROM review_cycle
        WHERE status IN ('active', 'calibration')
        ORDER BY starts_on DESC LIMIT 1`);
    if (rows[0]) {
      return {
        id: rows[0].id as string,
        name: rows[0].name as string,
        from: rows[0].starts_on as string,
        to: rows[0].ends_on as string,
        status: rows[0].status as string,
        hikePool: Number(rows[0].hike_pool_percent ?? 0),
      };
    }

    // The Indian financial year, which is what this tenant reviews against.
    const made = await db.query(
      `INSERT INTO review_cycle (code, name, starts_on, ends_on, status, hike_pool_percent)
       SELECT 'FY' || y.fy, 'FY ' || y.fy || '-' || ((y.fy::int + 1) % 100),
              make_date(y.fy::int, 4, 1), make_date(y.fy::int + 1, 3, 31), 'active', 8
         FROM (SELECT CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 4
                           THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
                           ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END AS fy) y
       ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, starts_on, ends_on, status, hike_pool_percent`);
    const c = made.rows[0]!;
    return {
      id: c.id as string, name: c.name as string,
      from: c.starts_on as string, to: c.ends_on as string,
      status: c.status as string, hikePool: Number(c.hike_pool_percent ?? 0),
    };
  });
}

export interface NewGoal {
  empId: string;
  title: string;
  category?: string;
  weight?: number;
  due?: string;
  alignedTo?: string;
  keyResults?: string[];
}

/**
 * Set a goal.
 *
 * A manager sets goals for their team and an employee for themselves; the
 * weights are not policed against summing to 100, because half-written
 * scorecards are a normal state during planning and a system that refuses them
 * just gets worked around in a spreadsheet.
 */
export async function addGoal(caller: Caller, draft: NewGoal): Promise<Goal> {
  if (!draft.title?.trim()) throw new PerformanceError('a goal needs a title', 'invalid');
  const weight = Number(draft.weight ?? 0);
  if (weight < 0 || weight > 100) {
    throw new PerformanceError('a weight runs from 0 to 100', 'invalid');
  }
  const empId = draft.empId || caller.employeeId;

  return withTenant(caller, async (db) => {
    if (empId !== caller.employeeId && caller.role === 'employee') {
      throw new PerformanceError('you can only set your own goals', 'forbidden');
    }
    const cycle = await currentCycleIn(db);

    const { rows } = await db.query(
      `INSERT INTO goal (employee_id, cycle_id, title, category, weight, due_on, aligned_to, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'behind')
       RETURNING id`,
      [empId, cycle, draft.title.trim(), draft.category ?? null, weight,
        draft.due ?? null, draft.alignedTo ?? null]);
    const id = rows[0].id as string;

    for (const [i, title] of (draft.keyResults ?? []).entries()) {
      if (!title.trim()) continue;
      await db.query(
        'INSERT INTO key_result (goal_id, title, display_order) VALUES ($1,$2,$3)',
        [id, title.trim(), i]);
    }

    const back = await db.query(`${GOAL_PROJECTION} WHERE g.id = $1`, [id]);
    return toGoal(back.rows[0]!);
  });
}

/** The active cycle's id inside an open transaction. */
async function currentCycleIn(db: TenantClient): Promise<string> {
  const { rows } = await db.query(
    `SELECT id FROM review_cycle WHERE status IN ('active', 'calibration')
      ORDER BY starts_on DESC LIMIT 1`);
  if (rows[0]) return rows[0].id as string;
  const made = await db.query(
    `INSERT INTO review_cycle (code, name, starts_on, ends_on, status, hike_pool_percent)
     SELECT 'FY' || y.fy, 'FY ' || y.fy || '-' || ((y.fy::int + 1) % 100),
            make_date(y.fy::int, 4, 1), make_date(y.fy::int + 1, 3, 31), 'active', 8
       FROM (SELECT CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 4
                         THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
                         ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END AS fy) y
     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`);
  return made.rows[0].id as string;
}

/**
 * Move a goal's progress.
 *
 * Status follows, and so do the mid and final key results — a goal reported
 * complete with its last key result unticked is a contradiction somebody has
 * to reconcile by hand, so the two move together.
 */
export async function setGoalProgress(
  caller: Caller,
  goalId: string,
  progress: number,
): Promise<Goal> {
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    throw new PerformanceError('progress runs from 0 to 100', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT employee_id FROM goal WHERE id = $1 FOR UPDATE', [goalId]);
    if (!rows[0]) throw new PerformanceError('no such goal', 'not_found');
    if (rows[0].employee_id !== caller.employeeId && caller.role === 'employee') {
      throw new PerformanceError('that goal is not yours', 'forbidden');
    }

    await db.query(
      'UPDATE goal SET progress = $2, status = $3 WHERE id = $1',
      [goalId, Math.round(progress), statusFor(progress)]);

    // The mid and final key results mirror the same thresholds.
    await db.query(
      `UPDATE key_result k SET done = CASE
            WHEN k.display_order = 1 THEN $2::int >= 50
            WHEN k.display_order = 2 THEN $2::int >= 100
            ELSE k.done END
        WHERE k.goal_id = $1 AND k.display_order IN (1, 2)`,
      [goalId, Math.round(progress)]);

    const back = await db.query(`${GOAL_PROJECTION} WHERE g.id = $1`, [goalId]);
    return toGoal(back.rows[0]!);
  });
}

/* ---------- check-ins ---------- */

export async function listCheckins(caller: Caller, empIds?: string[]): Promise<CheckIn[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  const scoped = scope(caller, 'c.employee_id', params);
  if (scoped) where.push(scoped);
  if (empIds?.length) {
    params.push(empIds);
    where.push(`c.employee_id = ANY($${params.length}::uuid[])`);
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT c.id, c.employee_id, c.held_on, c.held_with, c.wins, c.blockers, c.next_steps
         FROM check_in c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.held_on DESC`, params);
    return rows.map((r) => ({
      id: r.id as string,
      empId: r.employee_id as string,
      on: r.held_on as string,
      by: (r.held_with as string | null) ?? null,
      wins: (r.wins as string) ?? '',
      blockers: (r.blockers as string) ?? '',
      next: (r.next_steps as string) ?? '',
    }));
  });
}

export interface NewCheckIn {
  empId: string;
  wins?: string;
  blockers?: string;
  next?: string;
  on?: string;
}

/** Log a 1:1. The other party is the session, not a name in the body. */
export async function logCheckin(caller: Caller, draft: NewCheckIn): Promise<CheckIn> {
  if (!draft.empId) throw new PerformanceError('say who the check-in was with', 'invalid');
  if (!draft.wins?.trim() && !draft.blockers?.trim() && !draft.next?.trim()) {
    throw new PerformanceError('a check-in needs something written in it', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cycle = await currentCycleIn(db);
    const { rows } = await db.query(
      `INSERT INTO check_in (employee_id, cycle_id, held_on, held_with, wins, blockers, next_steps)
       VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4,$5,$6,$7)
       RETURNING id, employee_id, held_on, held_with, wins, blockers, next_steps`,
      [draft.empId, cycle, draft.on ?? null, caller.employeeId,
        draft.wins ?? '', draft.blockers ?? '', draft.next ?? '']);
    const r = rows[0]!;
    return {
      id: r.id as string, empId: r.employee_id as string, on: r.held_on as string,
      by: (r.held_with as string | null) ?? null,
      wins: (r.wins as string) ?? '', blockers: (r.blockers as string) ?? '',
      next: (r.next_steps as string) ?? '',
    };
  });
}

/* ---------- praise ---------- */

export async function listPraise(caller: Caller): Promise<Praise[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT id, from_employee_id, to_employee_id, company_value, message, given_on
         FROM praise ORDER BY given_on DESC, id LIMIT 200`);
    return rows.map((r) => ({
      id: r.id as string,
      fromId: r.from_employee_id as string,
      toId: r.to_employee_id as string,
      value: (r.company_value as string) ?? '',
      text: r.message as string,
      on: r.given_on as string,
      likes: 0,
    }));
  });
}

/** Praise someone. The schema refuses praising yourself; so does this, clearly. */
export async function givePraise(
  caller: Caller,
  toId: string,
  value: string,
  text: string,
): Promise<Praise[]> {
  if (!text?.trim()) throw new PerformanceError('say what they did', 'invalid');
  if (toId === caller.employeeId) {
    throw new PerformanceError('praise is for other people', 'self_praise');
  }

  return withTenant(caller, async (db) => {
    const to = await db.query("SELECT id FROM employee WHERE id = $1 AND status <> 'exited'", [toId]);
    if (!to.rows[0]) throw new PerformanceError('no such colleague', 'not_found');

    await db.query(
      `INSERT INTO praise (from_employee_id, to_employee_id, company_value, message)
       VALUES ($1,$2,$3,$4)`,
      [caller.employeeId, toId, value ?? null, text.trim()]);

    return listPraiseIn(db);
  });
}

async function listPraiseIn(db: TenantClient): Promise<Praise[]> {
  const { rows } = await db.query(
    `SELECT id, from_employee_id, to_employee_id, company_value, message, given_on
       FROM praise ORDER BY given_on DESC, id LIMIT 200`);
  return rows.map((r) => ({
    id: r.id as string, fromId: r.from_employee_id as string,
    toId: r.to_employee_id as string, value: (r.company_value as string) ?? '',
    text: r.message as string, on: r.given_on as string, likes: 0,
  }));
}

/* ---------- reviews ---------- */

const REVIEW_PROJECTION = `
  SELECT r.id, r.employee_id, r.cycle_id, r.status, r.goal_achievement,
         r.self_rating, r.self_comments, r.self_submitted_on,
         r.manager_rating, r.manager_comments, r.manager_submitted_on, r.manager_id,
         r.potential, r.final_rating, r.final_hike_percent, r.promoted, r.on_pip,
         COALESCE(pf.peers, '[]'::jsonb) AS peers
    FROM review r
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'peerId', p.peer_id, 'rating', p.rating,
               'comments', COALESCE(p.comments, ''))) AS peers
        FROM peer_feedback p WHERE p.review_id = r.id
    ) pf ON true`;

const toReview = (r: Record<string, unknown>): Review => ({
  id: r.id as string,
  empId: r.employee_id as string,
  cycleId: r.cycle_id as string,
  status: r.status as string,
  goalAchievement: Number(r.goal_achievement ?? 0),
  self: {
    rating: r.self_rating === null ? null : Number(r.self_rating),
    comments: (r.self_comments as string) ?? '',
    on: (r.self_submitted_on as string | null) ?? null,
  },
  manager: {
    rating: r.manager_rating === null ? null : Number(r.manager_rating),
    comments: (r.manager_comments as string) ?? '',
    on: (r.manager_submitted_on as string | null) ?? null,
    by: (r.manager_id as string | null) ?? null,
  },
  peers: r.peers as { peerId: string; rating: number | null; comments: string }[],
  potential: Number(r.potential ?? 0),
  final: r.final_rating === null ? null : {
    rating: Number(r.final_rating),
    hike: Number(r.final_hike_percent ?? 0),
    promoted: Boolean(r.promoted),
  },
  pip: Boolean(r.on_pip),
});

export async function listReviews(caller: Caller, empIds?: string[]): Promise<Review[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  const scoped = scope(caller, 'r.employee_id', params);
  if (scoped) where.push(scoped);
  if (empIds?.length) {
    params.push(empIds);
    where.push(`r.employee_id = ANY($${params.length}::uuid[])`);
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${REVIEW_PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.id`, params);
    return rows.map(toReview);
  });
}

/** Weighted goal attainment for a cycle, recomputed onto the review. */
async function refreshAttainment(db: TenantClient, reviewId: string): Promise<void> {
  await db.query(
    `UPDATE review r
        SET goal_achievement = COALESCE((
              SELECT CASE WHEN sum(g.weight) > 0
                          THEN round(sum(g.progress * g.weight)::numeric / sum(g.weight), 2)
                          ELSE round(avg(g.progress)::numeric, 2) END
                FROM goal g
               WHERE g.employee_id = r.employee_id AND g.cycle_id = r.cycle_id), 0)
      WHERE r.id = $1`, [reviewId]);
}

/**
 * Submit the self-assessment.
 *
 * Opens the review if it does not exist yet: a cycle in which nobody has
 * written anything has no rows, and making the employee's first action create
 * one is simpler than a job that pre-creates a review for everybody.
 */
export async function submitSelfReview(
  caller: Caller,
  rating: number,
  comments: string,
): Promise<Review> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new PerformanceError('a rating is 1 to 5', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cycle = await currentCycleIn(db);
    const { rows } = await db.query(
      `INSERT INTO review (employee_id, cycle_id, status, manager_id)
       SELECT $1, $2, 'self_review', e.manager_id FROM employee e WHERE e.id = $1
       ON CONFLICT (tenant_id, employee_id, cycle_id) DO UPDATE SET status = review.status
       RETURNING id, status`, [caller.employeeId, cycle]);
    const id = rows[0].id as string;

    if (['calibrated', 'completed'].includes(rows[0].status as string)) {
      throw new PerformanceError('that review is already closed', 'closed');
    }

    await db.query(
      `UPDATE review
          SET self_rating = $2, self_comments = $3, self_submitted_on = CURRENT_DATE,
              status = CASE WHEN status = 'not_started' THEN 'self_review' ELSE status END
        WHERE id = $1`, [id, rating, comments ?? '']);

    await refreshAttainment(db, id);
    const back = await db.query(`${REVIEW_PROJECTION} WHERE r.id = $1`, [id]);
    return toReview(back.rows[0]!);
  });
}

/**
 * The manager's assessment.
 *
 * Refused before the employee has written theirs: a manager rating that lands
 * first is the one the self-assessment then gets written to match, which is
 * the opposite of what the exercise is for.
 */
export async function submitManagerReview(
  caller: Caller,
  empId: string,
  rating: number,
  comments: string,
): Promise<Review> {
  if (caller.role === 'employee') {
    throw new PerformanceError('only a manager or admin may review someone', 'forbidden');
  }
  if (empId === caller.employeeId) {
    throw new PerformanceError('you cannot review yourself', 'self_review');
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new PerformanceError('a rating is 1 to 5', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cycle = await currentCycleIn(db);
    const { rows } = await db.query(
      'SELECT id, status, self_submitted_on FROM review WHERE employee_id = $1 AND cycle_id = $2 FOR UPDATE',
      [empId, cycle]);
    if (!rows[0]) {
      throw new PerformanceError('that person has not started their review', 'no_self_review');
    }
    if (!rows[0].self_submitted_on) {
      throw new PerformanceError('their self-assessment is not in yet', 'no_self_review');
    }
    if (['calibrated', 'completed'].includes(rows[0].status as string)) {
      throw new PerformanceError('that review is already closed', 'closed');
    }

    await db.query(
      `UPDATE review
          SET manager_rating = $2, manager_comments = $3,
              manager_submitted_on = CURRENT_DATE, manager_id = $4,
              status = 'manager_review'
        WHERE id = $1`, [rows[0].id, rating, comments ?? '', caller.employeeId]);

    await refreshAttainment(db, rows[0].id as string);
    const back = await db.query(`${REVIEW_PROJECTION} WHERE r.id = $1`, [rows[0].id]);
    return toReview(back.rows[0]!);
  });
}

/**
 * Close a review with its final rating and increment.
 *
 * The schema refuses a calibrated review without a final rating, so this is
 * where the outcome and the status are written together or not at all.
 */
export async function calibrateReview(
  caller: Caller,
  empId: string,
  outcome: { rating: number; hike?: number; promoted?: boolean; potential?: number; pip?: boolean },
): Promise<Review> {
  if (caller.role !== 'admin') {
    throw new PerformanceError('only an admin may calibrate a review', 'forbidden');
  }
  if (!Number.isInteger(outcome.rating) || outcome.rating < 1 || outcome.rating > 5) {
    throw new PerformanceError('a final rating is 1 to 5', 'invalid');
  }
  if (outcome.potential !== undefined
      && (!Number.isInteger(outcome.potential) || outcome.potential < 1 || outcome.potential > 3)) {
    throw new PerformanceError('potential is 1 to 3', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cycle = await currentCycleIn(db);
    const { rows } = await db.query(
      'SELECT id, manager_submitted_on FROM review WHERE employee_id = $1 AND cycle_id = $2 FOR UPDATE',
      [empId, cycle]);
    if (!rows[0]) throw new PerformanceError('no review to calibrate', 'not_found');
    if (!rows[0].manager_submitted_on) {
      throw new PerformanceError('the manager review is not in yet', 'no_manager_review');
    }

    await db.query(
      `UPDATE review
          SET status = 'calibrated', final_rating = $2, final_hike_percent = $3,
              promoted = $4, potential = COALESCE($5, potential), on_pip = $6
        WHERE id = $1`,
      [rows[0].id, outcome.rating, outcome.hike ?? 0, Boolean(outcome.promoted),
        outcome.potential ?? null, Boolean(outcome.pip)]);

    await refreshAttainment(db, rows[0].id as string);
    const back = await db.query(`${REVIEW_PROJECTION} WHERE r.id = $1`, [rows[0].id]);
    return toReview(back.rows[0]!);
  });
}
