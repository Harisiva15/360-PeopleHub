/**
 * The project planner and action-item tracker.
 *
 * **One table, two surfaces.** A planner task and an action item are the same
 * record with different provenance — a title, an owner, a due date and a
 * state. Splitting them would give a person two queues to check and two places
 * for work to hide. `project_id` is nullable so an action item out of a
 * management meeting can exist without one; the alternative is inventing a
 * project called "General" that everything drains into.
 *
 * **Board position is a number between its neighbours.** Dragging a card
 * writes one row rather than renumbering the column, which is what makes a
 * board usable with more than a handful of items and two people moving them at
 * once. The gaps halve each time; when they run out the column is renormalised.
 *
 * **Closing sets the date, and the schema insists.**
 * `CHECK ((status IN ('done','cancelled')) = (closed_on IS NOT NULL))` means a
 * done item with no closing date is unrepresentable, so "when did this finish"
 * always has an answer.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class PlannerError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
  }
}

/** The board's columns, in the order work moves through them. */
export const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'];
const KINDS = ['epic', 'story', 'task', 'bug', 'action'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const CLOSED = new Set(['done', 'cancelled']);

export interface WorkItem {
  id: string;
  ref: string;
  projectId: string | null;
  project: string | null;
  iterationId: string | null;
  iteration: string | null;
  parentId: string | null;
  kind: string;
  title: string;
  desc: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  reporterId: string | null;
  source: string;
  due: string | null;
  estimate: number | null;
  order: number;
  closedOn: string | null;
  comments: { by: string; on: string; text: string }[];
}

export interface Iteration {
  id: string;
  name: string;
  goal: string;
  from: string;
  to: string;
  status: string;
}

const PROJECTION = `
  SELECT w.id, w.reference, w.project_id, w.iteration_id, w.parent_id, w.kind,
         w.title, w.description, w.status, w.priority, w.assignee_id, w.reporter_id,
         w.source, w.due_on, w.estimate_hours, w.board_order, w.closed_on,
         p.code AS project_code, it.name AS iteration_name,
         COALESCE(c.comments, '[]'::jsonb) AS comments
    FROM work_item w
    LEFT JOIN project p ON p.id = w.project_id
    LEFT JOIN iteration it ON it.id = w.iteration_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'by', COALESCE(a.full_name, 'System'),
               'on', to_char(wc.created_at, 'YYYY-MM-DD'),
               'text', wc.body) ORDER BY wc.created_at) AS comments
        FROM work_item_comment wc
        LEFT JOIN employee a ON a.id = wc.author_id
       WHERE wc.work_item_id = w.id
    ) c ON true`;

const toItem = (r: Record<string, unknown>): WorkItem => ({
  id: r.id as string,
  ref: r.reference as string,
  projectId: (r.project_id as string | null) ?? null,
  project: (r.project_code as string | null) ?? null,
  iterationId: (r.iteration_id as string | null) ?? null,
  iteration: (r.iteration_name as string | null) ?? null,
  parentId: (r.parent_id as string | null) ?? null,
  kind: r.kind as string,
  title: r.title as string,
  desc: (r.description as string) ?? '',
  status: r.status as string,
  priority: r.priority as string,
  assigneeId: (r.assignee_id as string | null) ?? null,
  reporterId: (r.reporter_id as string | null) ?? null,
  source: (r.source as string) ?? '',
  due: (r.due_on as string | null) ?? null,
  estimate: r.estimate_hours === null ? null : Number(r.estimate_hours),
  order: Number(r.board_order),
  closedOn: (r.closed_on as string | null) ?? null,
  comments: r.comments as { by: string; on: string; text: string }[],
});

export interface WorkItemQuery {
  projectId?: string;
  iterationId?: string;
  assigneeId?: string;
  kind?: string;
  /** Leave unset to get everything; true hides done and cancelled. */
  openOnly?: boolean;
}

export async function listItems(caller: Caller, q: WorkItemQuery = {}): Promise<WorkItem[]> {
  const params: unknown[] = [];
  const where: string[] = [];

  if (q.projectId) { params.push(q.projectId); where.push(`w.project_id = $${params.length}`); }
  if (q.iterationId) { params.push(q.iterationId); where.push(`w.iteration_id = $${params.length}`); }
  if (q.assigneeId) { params.push(q.assigneeId); where.push(`w.assignee_id = $${params.length}`); }
  if (q.kind) { params.push(q.kind); where.push(`w.kind = $${params.length}`); }
  if (q.openOnly) where.push("w.status NOT IN ('done', 'cancelled')");

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY w.board_order, w.created_at`, params);
    return rows.map(toItem);
  });
}

/** What is on one person's plate, soonest first. */
export async function myItems(caller: Caller, empId?: string): Promise<WorkItem[]> {
  const who = empId || caller.employeeId;
  if (who !== caller.employeeId && caller.role === 'employee') {
    throw new PlannerError('you can only see your own items', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION}
        WHERE w.assignee_id = $1 AND w.status NOT IN ('done', 'cancelled')
        ORDER BY w.due_on NULLS LAST,
                 array_position(ARRAY['urgent','high','medium','low'], w.priority),
                 w.created_at`, [who]);
    return rows.map(toItem);
  });
}

async function load(db: TenantClient, id: string): Promise<WorkItem> {
  const { rows } = await db.query(`${PROJECTION} WHERE w.id = $1`, [id]);
  if (!rows[0]) throw new PlannerError('no such work item', 'not_found');
  return toItem(rows[0]);
}

export interface NewWorkItem {
  title: string;
  kind?: string;
  projectId?: string | null;
  iterationId?: string | null;
  parentId?: string | null;
  desc?: string;
  priority?: string;
  assigneeId?: string | null;
  source?: string;
  due?: string | null;
  estimate?: number | null;
  status?: string;
}

/**
 * Raise a work item or an action.
 *
 * The reference continues the PLAN series server-side, because a
 * client-generated one is a collision waiting for two people to create an item
 * in the same second.
 */
export async function createItem(caller: Caller, draft: NewWorkItem): Promise<WorkItem> {
  if (!draft.title?.trim()) throw new PlannerError('a work item needs a title', 'invalid');
  const kind = draft.kind ?? 'task';
  if (!KINDS.includes(kind)) throw new PlannerError(`unknown kind: ${kind}`, 'invalid');
  const priority = draft.priority ?? 'medium';
  if (!PRIORITIES.includes(priority)) {
    throw new PlannerError(`unknown priority: ${priority}`, 'invalid');
  }
  const status = draft.status ?? 'backlog';
  if (!STATUSES.includes(status)) throw new PlannerError(`unknown status: ${status}`, 'invalid');
  if (CLOSED.has(status)) {
    throw new PlannerError('a new item cannot start closed', 'invalid');
  }

  return withTenant(caller, async (db) => {
    if (draft.projectId) {
      const p = await db.query('SELECT id FROM project WHERE id = $1', [draft.projectId]);
      if (!p.rows[0]) throw new PlannerError('no such project', 'invalid');
    }
    if (draft.parentId) {
      const p = await db.query('SELECT id FROM work_item WHERE id = $1', [draft.parentId]);
      if (!p.rows[0]) throw new PlannerError('no such parent item', 'invalid');
    }

    const reference = (await db.query(
      `SELECT 'PLAN-' || (COALESCE(max(substring(reference from '[0-9]+$')::int), 0) + 1)::text
              AS next FROM work_item WHERE reference ~ '^PLAN-[0-9]+$'`)).rows[0].next as string;

    /* New cards land at the end of their column. */
    const tail = await db.query(
      'SELECT COALESCE(max(board_order), 0) + 1024 AS next FROM work_item WHERE status = $1',
      [status]);

    const { rows } = await db.query(
      `INSERT INTO work_item
         (reference, project_id, iteration_id, parent_id, kind, title, description,
          status, priority, assignee_id, reporter_id, source, due_on, estimate_hours,
          board_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [reference, draft.projectId ?? null, draft.iterationId ?? null, draft.parentId ?? null,
        kind, draft.title.trim(), draft.desc ?? null, status, priority,
        draft.assigneeId ?? null, caller.employeeId, draft.source ?? null,
        draft.due ?? null, draft.estimate ?? null, Number(tail.rows[0].next)]);

    return load(db, rows[0].id);
  });
}

/**
 * Move a card: a new column, and a position within it.
 *
 * `afterId` names the card it should sit behind, so the caller says where it
 * was dropped rather than computing an index. The new order is the midpoint
 * between that card and the next, which touches one row.
 */
export async function moveItem(
  caller: Caller,
  id: string,
  status: string,
  afterId?: string | null,
): Promise<WorkItem> {
  if (!STATUSES.includes(status)) throw new PlannerError(`unknown status: ${status}`, 'invalid');

  return withTenant(caller, async (db) => {
    const cur = await db.query(
      'SELECT status, closed_on FROM work_item WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw new PlannerError('no such work item', 'not_found');

    let order: number;
    if (afterId) {
      const after = await db.query(
        'SELECT board_order FROM work_item WHERE id = $1 AND status = $2', [afterId, status]);
      if (!after.rows[0]) {
        throw new PlannerError('the item it should follow is not in that column', 'invalid');
      }
      const prev = Number(after.rows[0].board_order);
      const next = await db.query(
        `SELECT min(board_order) AS n FROM work_item
          WHERE status = $1 AND board_order > $2 AND id <> $3`, [status, prev, id]);
      order = next.rows[0].n === null ? prev + 1024 : (prev + Number(next.rows[0].n)) / 2;
    } else {
      /* No anchor means the top of the column. */
      const head = await db.query(
        'SELECT min(board_order) AS n FROM work_item WHERE status = $1 AND id <> $2', [status, id]);
      order = head.rows[0].n === null ? 1024 : Number(head.rows[0].n) / 2;
    }

    await db.query(
      `UPDATE work_item
          SET status = $2, board_order = $3, updated_at = now(),
              closed_on = CASE WHEN $2 IN ('done','cancelled')
                               THEN COALESCE(closed_on, CURRENT_DATE) ELSE NULL END
        WHERE id = $1`, [id, status, order]);

    /*
     * Halving forever runs out of precision. When two neighbours get close
     * enough that the midpoint stops separating them, the column is spread
     * back out — rare, and cheap when it happens.
     */
    const tight = await db.query(
      `SELECT count(*)::int n FROM (
         SELECT board_order - lag(board_order) OVER (ORDER BY board_order) AS gap
           FROM work_item WHERE status = $1) g
        WHERE gap IS NOT NULL AND gap < 0.001`, [status]);
    if (tight.rows[0].n > 0) await renormalise(db, status);

    return load(db, id);
  });
}

/** Spread one column's positions back onto whole numbers. */
async function renormalise(db: TenantClient, status: string): Promise<void> {
  await db.query(
    `UPDATE work_item w
        SET board_order = r.seq * 1024
       FROM (SELECT id, row_number() OVER (ORDER BY board_order, created_at) AS seq
               FROM work_item WHERE status = $1) r
      WHERE w.id = r.id`, [status]);
}

export interface WorkItemPatch {
  title?: string;
  desc?: string;
  priority?: string;
  assigneeId?: string | null;
  due?: string | null;
  estimate?: number | null;
  iterationId?: string | null;
  projectId?: string | null;
  source?: string;
}

/** Edit the fields that are not the board position. */
export async function updateItem(
  caller: Caller,
  id: string,
  patch: WorkItemPatch,
): Promise<WorkItem> {
  if (patch.title !== undefined && !patch.title.trim()) {
    throw new PlannerError('a work item needs a title', 'invalid');
  }
  if (patch.priority !== undefined && !PRIORITIES.includes(patch.priority)) {
    throw new PlannerError(`unknown priority: ${patch.priority}`, 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cur = await db.query('SELECT id FROM work_item WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw new PlannerError('no such work item', 'not_found');

    await db.query(
      `UPDATE work_item SET
         title = COALESCE($2, title),
         description = COALESCE($3, description),
         priority = COALESCE($4, priority),
         assignee_id = CASE WHEN $5::boolean THEN $6::uuid ELSE assignee_id END,
         due_on = CASE WHEN $7::boolean THEN $8::date ELSE due_on END,
         estimate_hours = CASE WHEN $9::boolean THEN $10::numeric ELSE estimate_hours END,
         iteration_id = CASE WHEN $11::boolean THEN $12::uuid ELSE iteration_id END,
         project_id = CASE WHEN $13::boolean THEN $14::uuid ELSE project_id END,
         source = COALESCE($15, source),
         updated_at = now()
       WHERE id = $1`,
      [id, patch.title?.trim() ?? null, patch.desc ?? null, patch.priority ?? null,
        patch.assigneeId !== undefined, patch.assigneeId ?? null,
        patch.due !== undefined, patch.due ?? null,
        patch.estimate !== undefined, patch.estimate ?? null,
        patch.iterationId !== undefined, patch.iterationId ?? null,
        patch.projectId !== undefined, patch.projectId ?? null,
        patch.source ?? null]);

    return load(db, id);
  });
}

export async function commentOnItem(
  caller: Caller,
  id: string,
  text: string,
): Promise<WorkItem> {
  if (!text?.trim()) throw new PlannerError('a comment needs some text', 'invalid');
  return withTenant(caller, async (db) => {
    const cur = await db.query('SELECT id FROM work_item WHERE id = $1', [id]);
    if (!cur.rows[0]) throw new PlannerError('no such work item', 'not_found');
    await db.query(
      'INSERT INTO work_item_comment (work_item_id, author_id, body) VALUES ($1,$2,$3)',
      [id, caller.employeeId, text.trim()]);
    return load(db, id);
  });
}

/* ---------- iterations ---------- */

export async function listIterations(caller: Caller): Promise<Iteration[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT id, name, goal, starts_on, ends_on, status FROM iteration ORDER BY starts_on DESC');
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      goal: (r.goal as string) ?? '',
      from: r.starts_on as string,
      to: r.ends_on as string,
      status: r.status as string,
    }));
  });
}

export async function createIteration(
  caller: Caller,
  draft: { name: string; goal?: string; from: string; to: string },
): Promise<Iteration[]> {
  if (caller.role === 'employee') {
    throw new PlannerError('only a manager or admin may plan an iteration', 'forbidden');
  }
  if (!draft.name?.trim()) throw new PlannerError('an iteration needs a name', 'invalid');
  if (!draft.from || !draft.to) throw new PlannerError('an iteration needs its dates', 'invalid');
  if (draft.to < draft.from) throw new PlannerError('it cannot end before it starts', 'invalid');

  return withTenant(caller, async (db) => {
    try {
      await db.query(
        'INSERT INTO iteration (name, goal, starts_on, ends_on) VALUES ($1,$2,$3::date,$4::date)',
        [draft.name.trim(), draft.goal ?? null, draft.from, draft.to]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new PlannerError('an iteration with that name already exists', 'duplicate');
      }
      throw e;
    }
    return listIterationsIn(db);
  });
}

async function listIterationsIn(db: TenantClient): Promise<Iteration[]> {
  const { rows } = await db.query(
    'SELECT id, name, goal, starts_on, ends_on, status FROM iteration ORDER BY starts_on DESC');
  return rows.map((r) => ({
    id: r.id as string, name: r.name as string, goal: (r.goal as string) ?? '',
    from: r.starts_on as string, to: r.ends_on as string, status: r.status as string,
  }));
}

export interface BoardStats {
  status: string;
  count: number;
  estimate: number;
}

/** Column counts and effort, for the board header. */
export async function boardStats(caller: Caller, projectId?: string): Promise<BoardStats[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT s.status,
              count(w.id)::int AS count,
              COALESCE(sum(w.estimate_hours), 0)::float8 AS estimate
         FROM unnest($1::text[]) AS s(status)
         LEFT JOIN work_item w ON w.status = s.status
              AND ($2::uuid IS NULL OR w.project_id = $2::uuid)
        GROUP BY s.status
        ORDER BY array_position($1::text[], s.status)`,
      [STATUSES, projectId ?? null]);
    return rows.map((r) => ({
      status: r.status as string,
      count: Number(r.count),
      estimate: Number(r.estimate),
    }));
  });
}
