/**
 * The helpdesk — tickets, their SLA clock, and the knowledge base.
 *
 * **The SLA is copied onto the ticket, not read through to the category.** The
 * schema says so and the reason is worth keeping in view: raising the IT SLA
 * from 8 hours to 24 next quarter must not retroactively un-breach every
 * ticket that missed 8 hours last quarter. The clock a ticket was measured
 * against is part of what happened to it.
 *
 * **Breach is stored once and derived until then.** A resolved ticket's breach
 * is a fact about the past, so it is written at resolution and never
 * recomputed. An open ticket's breach is a fact about *now* — it becomes true
 * as the due time passes with nobody touching it — so it is derived on read. A
 * stored flag on an open ticket would be a lie that gets truer every hour
 * until some job happens to run.
 *
 * **Internal notes are not shown to the raiser.** `ticket_comment.internal`
 * exists for the agent-to-agent conversation about a ticket, and that
 * conversation is filtered out in SQL rather than hidden in the browser — the
 * same argument as the announcement audience filter.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class HelpdeskError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'HelpdeskError';
    this.code = code;
  }
}

const TO_STATUS: Record<string, string> = {
  open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed',
};
const PRIORITIES = new Set(['urgent', 'high', 'medium', 'low']);

export interface TicketComment { by: string; on: string; text: string }

export interface Ticket {
  id: string;
  empId: string;
  cat: string;
  subject: string;
  desc: string;
  priority: string;
  status: string;
  createdOn: string;
  createdTime: string;
  dueOn: string;
  slaHours: number;
  assigneeId: string;
  resolvedOn: string | null;
  resolutionHrs: number | null;
  breached: boolean;
  csat: number | null;
  comments: TicketComment[];
}

/**
 * `$1` is the reader. Internal comments are dropped for the person who raised
 * the ticket, and kept for everyone else who can see it.
 */
const PROJECTION = `
  SELECT t.id, t.employee_id, t.subject, t.body, t.priority, t.status,
         t.created_at, t.due_at, t.sla_hours, t.assignee_id, t.resolved_at,
         t.resolution_hours, t.csat, c.code AS cat_code,
         -- Stored once the ticket is resolved; live while it is still open.
         (t.breached OR (t.resolved_at IS NULL AND t.due_at < now())) AS is_breached,
         COALESCE(cm.comments, '[]'::jsonb) AS comments
    FROM ticket t
    JOIN ticket_category c ON c.id = t.category_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'by', COALESCE(a.full_name, 'System'),
               'on', to_char(tc.created_at, 'YYYY-MM-DD'),
               'text', tc.body) ORDER BY tc.created_at) AS comments
        FROM ticket_comment tc
        LEFT JOIN employee a ON a.id = tc.author_id
       WHERE tc.ticket_id = t.id
         AND (NOT tc.internal OR t.employee_id <> $1)
    ) cm ON true`;

const toTicket = (r: Record<string, unknown>): Ticket => {
  const created = new Date(r.created_at as string);
  return {
    id: r.id as string,
    empId: r.employee_id as string,
    cat: r.cat_code as string,
    subject: r.subject as string,
    desc: (r.body as string) ?? '',
    priority: (r.priority as string) ?? 'medium',
    status: TO_STATUS[r.status as string] ?? 'Open',
    createdOn: created.toISOString().slice(0, 10),
    createdTime: created.toISOString().slice(11, 16),
    dueOn: new Date(r.due_at as string).toISOString().slice(0, 10),
    slaHours: Number(r.sla_hours),
    assigneeId: (r.assignee_id as string) ?? '',
    resolvedOn: r.resolved_at ? new Date(r.resolved_at as string).toISOString().slice(0, 10) : null,
    resolutionHrs: r.resolution_hours === null ? null : Number(r.resolution_hours),
    breached: Boolean(r.is_breached),
    csat: r.csat === null ? null : Number(r.csat),
    comments: r.comments as TicketComment[],
  };
};

/** A ticket can carry a salary complaint, so it is not public reading. */
function scope(caller: Caller, params: unknown[]): string {
  if (caller.role === 'admin') return '';
  params.push(caller.employeeId);
  const p = `$${params.length}`;
  // A manager sees their team's, and anything assigned to them.
  if (caller.role === 'manager') {
    return `(t.employee_id = ${p} OR t.assignee_id = ${p} OR t.employee_id IN (
       WITH RECURSIVE r AS (
         SELECT id FROM employee WHERE manager_id = ${p}
         UNION ALL SELECT e.id FROM employee e JOIN r ON e.manager_id = r.id
       ) SELECT id FROM r))`;
  }
  return `(t.employee_id = ${p} OR t.assignee_id = ${p})`;
}

async function load(db: TenantClient, caller: Caller, id: string): Promise<Ticket> {
  const { rows } = await db.query(`${PROJECTION} WHERE t.id = $2`, [caller.employeeId, id]);
  if (!rows[0]) throw new HelpdeskError('no such ticket', 'not_found');
  return toTicket(rows[0]);
}

export async function listTickets(caller: Caller, empIds?: string[]): Promise<Ticket[]> {
  const params: unknown[] = [caller.employeeId];
  const where: string[] = [];
  const scoped = scope(caller, params);
  if (scoped) where.push(scoped);
  if (empIds?.length) {
    params.push(empIds);
    where.push(`t.employee_id = ANY($${params.length}::uuid[])`);
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.created_at DESC`, params);
    return rows.map(toTicket);
  });
}

export interface NewTicket {
  empId: string;
  cat: string;
  subject: string;
  desc: string;
  priority: string;
}

/**
 * Raise a ticket.
 *
 * The SLA and the due time are set here from the category, and the reference
 * continues the TKT series. None of the three is accepted from the caller: a
 * client-chosen deadline is not a deadline.
 */
export async function raiseTicket(caller: Caller, draft: NewTicket): Promise<Ticket> {
  if (draft.empId && draft.empId !== caller.employeeId && caller.role !== 'admin') {
    throw new HelpdeskError('you can only raise a ticket for yourself', 'forbidden');
  }
  if (!draft.subject?.trim()) throw new HelpdeskError('a ticket needs a subject', 'invalid');
  if (!draft.desc?.trim()) throw new HelpdeskError('describe what you need', 'invalid');

  const priority = (draft.priority ?? 'medium').toLowerCase();
  if (!PRIORITIES.has(priority)) {
    throw new HelpdeskError(`unknown priority: ${draft.priority}`, 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cat = await db.query(
      `SELECT c.id, c.sla_hours, c.owning_department_id
         FROM ticket_category c WHERE c.code = $1 AND c.active`, [draft.cat]);
    if (!cat.rows[0]) throw new HelpdeskError(`no such ticket category: ${draft.cat}`, 'invalid');

    const reference = (await db.query(
      `SELECT 'TKT-' || lpad((COALESCE(max(substring(reference from '[0-9]+$')::int), 0) + 1)::text, 5, '0')
              AS next FROM ticket WHERE reference ~ '^TKT-[0-9]+$'`)).rows[0].next as string;

    // Assigned to whoever heads the owning team, when there is one. An
    // unassigned ticket is still a real ticket; it just has nobody to chase.
    const assignee = await db.query(
      `SELECT e.id FROM employee e
        WHERE e.department_id = $1 AND e.status <> 'exited'
        ORDER BY (e.app_role = 'admin') DESC, e.joined_on LIMIT 1`,
      [cat.rows[0].owning_department_id]);

    const { rows } = await db.query(
      `INSERT INTO ticket
         (reference, employee_id, category_id, subject, body, priority, sla_hours,
          due_at, assignee_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::smallint,
               now() + ($7::int || ' hours')::interval, $8)
       RETURNING id`,
      [reference, draft.empId || caller.employeeId, cat.rows[0].id, draft.subject.trim(),
        draft.desc.trim(), priority, cat.rows[0].sla_hours, assignee.rows[0]?.id ?? null]);

    return load(db, caller, rows[0].id);
  });
}

/**
 * Add a comment. An open ticket moves into progress on the first one.
 *
 * That transition is the SLA's answer to "has anyone looked at this yet",
 * which is why it happens here rather than being a separate call somebody has
 * to remember to make.
 */
export async function comment(
  caller: Caller,
  id: string,
  text: string,
  internal = false,
): Promise<Ticket> {
  if (!text?.trim()) throw new HelpdeskError('a comment needs some text', 'invalid');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT employee_id, status FROM ticket WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new HelpdeskError('no such ticket', 'not_found');
    if (['resolved', 'closed'].includes(rows[0].status as string)) {
      throw new HelpdeskError('that ticket is already resolved', 'resolved');
    }
    // The raiser cannot leave an internal note on their own ticket — internal
    // means "not visible to them", which would be nonsense.
    const isRaiser = rows[0].employee_id === caller.employeeId;

    await db.query(
      'INSERT INTO ticket_comment (ticket_id, author_id, body, internal) VALUES ($1,$2,$3,$4)',
      [id, caller.employeeId, text.trim(), internal && !isRaiser]);

    await db.query(
      "UPDATE ticket SET status = 'in_progress' WHERE id = $1 AND status = 'open'", [id]);

    return load(db, caller, id);
  });
}

/**
 * Resolve a ticket, freezing whether it breached.
 *
 * `resolution_hours` and `breached` are computed from the stored times rather
 * than passed in, and once written they stop moving — which is the point of
 * writing them.
 */
export async function resolveTicket(
  caller: Caller,
  id: string,
  csat?: number,
): Promise<Ticket> {
  if (csat !== undefined && (!Number.isInteger(csat) || csat < 1 || csat > 5)) {
    throw new HelpdeskError('a satisfaction rating is 1 to 5', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT employee_id, assignee_id, status FROM ticket WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new HelpdeskError('no such ticket', 'not_found');
    if (['resolved', 'closed'].includes(rows[0].status as string)) {
      throw new HelpdeskError('that ticket is already resolved', 'already_resolved');
    }
    if (caller.role === 'employee'
        && rows[0].assignee_id !== caller.employeeId
        && rows[0].employee_id !== caller.employeeId) {
      throw new HelpdeskError('that ticket is not yours to resolve', 'forbidden');
    }

    await db.query(
      `UPDATE ticket
          SET status = 'resolved',
              resolved_at = now(),
              resolution_hours = round(EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0, 2),
              breached = (now() > due_at),
              csat = COALESCE($2, csat)
        WHERE id = $1`, [id, csat ?? null]);

    return load(db, caller, id);
  });
}

/**
 * The knowledge base — the company's policies and how-to answers.
 *
 * This returned a literal empty list, with a comment saying the deployment had
 * no table for it. The table has existed since 0007: `kb_article`, with a
 * category, a question, an answer and a published flag. The comment was
 * written when that was true and was never revisited, so the screen showed
 * nothing and there was no way to add anything — a policy library that could
 * not hold a policy.
 *
 * Unpublished drafts are visible to the people who may edit them and to nobody
 * else. An employee reading the knowledge base sees published articles only.
 */
export interface KbArticle {
  id: string;
  /** Category *code* — ATT, PAY, IT. The screens resolve it to a name. */
  cat: string;
  q: string;
  a: string;
  published: boolean;
  updatedAt: string;
}

export interface KbDraft {
  /** Category *code* — ATT, PAY, IT and so on. Optional. */
  cat?: string | null;
  q: string;
  a: string;
  published?: boolean;
}

/**
 * Who may write an article.
 *
 * The helpdesk module grants an employee `write: 'own'` so they can raise and
 * comment on their own ticket. An article is not their own anything — it is
 * what the company tells everybody — so authoring is narrowed here to the two
 * roles that speak for the company. Narrowing inside a service is always
 * allowed; widening would not be.
 */
function mayAuthor(caller: Caller) {
  if (caller.role !== 'admin' && caller.role !== 'manager') {
    throw new HelpdeskError('only an administrator or a manager may edit the knowledge base', 'forbidden');
  }
}

const KB_PROJECTION = `
  SELECT k.id, COALESCE(c.code, '') AS cat, k.question, k.answer,
         k.published, k.updated_at
    FROM kb_article k
    LEFT JOIN ticket_category c ON c.id = k.category_id`;

const toArticle = (r: Record<string, unknown>): KbArticle => ({
  id: r.id as string,
  cat: r.cat as string,
  q: r.question as string,
  a: r.answer as string,
  published: Boolean(r.published),
  updatedAt: (r.updated_at as Date | null)?.toISOString() ?? '',
});

export async function knowledgeBase(caller: Caller): Promise<KbArticle[]> {
  const editor = caller.role === 'admin' || caller.role === 'manager';
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${KB_PROJECTION}
        ${editor ? '' : 'WHERE k.published'}
        ORDER BY COALESCE(c.name, ''), k.question`);
    return rows.map(toArticle);
  });
}

/** Resolve a category code to its id, refusing one that does not exist. */
async function categoryId(db: TenantClient, code: string | null | undefined) {
  if (!code) return null;
  const { rows } = await db.query(
    'SELECT id FROM ticket_category WHERE code = $1', [code]);
  if (!rows[0]) throw new HelpdeskError(`no such category: ${code}`, 'invalid');
  return rows[0].id as string;
}

/** The rules an article must satisfy, in one place so create and edit agree. */
function validate(d: Partial<KbDraft>) {
  if (d.q !== undefined) {
    if (!d.q.trim()) throw new HelpdeskError('an article needs a question', 'invalid');
    if (d.q.trim().length > 300) {
      throw new HelpdeskError('the question is too long — keep it under 300 characters', 'invalid');
    }
  }
  if (d.a !== undefined && !d.a.trim()) {
    throw new HelpdeskError('an article needs an answer', 'invalid');
  }
}

export async function createArticle(caller: Caller, draft: KbDraft): Promise<KbArticle> {
  mayAuthor(caller);
  validate(draft);
  if (!draft.q?.trim() || !draft.a?.trim()) {
    throw new HelpdeskError('an article needs a question and an answer', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cat = await categoryId(db, draft.cat);
    const { rows } = await db.query(
      `INSERT INTO kb_article (category_id, question, answer, published)
       VALUES ($1, $2, $3, COALESCE($4, true)) RETURNING id`,
      [cat, draft.q.trim(), draft.a.trim(), draft.published ?? null]);

    const { rows: [back] } = await db.query(
      `${KB_PROJECTION} WHERE k.id = $1`, [rows[0]!.id]);
    return toArticle(back!);
  });
}

export async function updateArticle(
  caller: Caller,
  id: string,
  patch: Partial<KbDraft>,
): Promise<KbArticle> {
  mayAuthor(caller);
  validate(patch);

  return withTenant(caller, async (db) => {
    const { rows: [exists] } = await db.query('SELECT id FROM kb_article WHERE id = $1', [id]);
    if (!exists) throw new HelpdeskError('no such article', 'not_found');

    const cat = patch.cat === undefined ? undefined : await categoryId(db, patch.cat);
    const updated = await db.query(
      `UPDATE kb_article
          SET question   = COALESCE($2, question),
              answer     = COALESCE($3, answer),
              published  = COALESCE($4, published),
              category_id = CASE WHEN $6::boolean THEN $5 ELSE category_id END,
              updated_at = now()
        WHERE id = $1`,
      [id, patch.q?.trim() ?? null, patch.a?.trim() ?? null,
        patch.published ?? null, cat ?? null, patch.cat !== undefined]);
    if (updated.rowCount === 0) throw new HelpdeskError('no such article', 'not_found');

    const { rows: [back] } = await db.query(`${KB_PROJECTION} WHERE k.id = $1`, [id]);
    return toArticle(back!);
  });
}

/**
 * Remove an article.
 *
 * A hard delete, because nothing references `kb_article` — no ticket, no
 * comment, no audit subject. Unpublishing is the softer option and is one
 * `published: false` away, which is why it is not done here as well.
 */
export async function removeArticle(caller: Caller, id: string): Promise<KbArticle> {
  mayAuthor(caller);
  return withTenant(caller, async (db) => {
    const { rows: [gone] } = await db.query(`${KB_PROJECTION} WHERE k.id = $1`, [id]);
    if (!gone) throw new HelpdeskError('no such article', 'not_found');
    await db.query('DELETE FROM kb_article WHERE id = $1', [id]);
    return toArticle(gone);
  });
}
