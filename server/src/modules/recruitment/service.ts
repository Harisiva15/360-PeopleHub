/**
 * The recruitment desk.
 *
 * The tables this reads were built by 0029 — `staffing_requirement` with its
 * SLA columns, `job_assignment`, `job_activity`. What was missing was this
 * layer, so the screens ran on the demo dataset while the schema sat there
 * empty. Nothing new is invented here.
 *
 * **Every count is derived.** Submissions, interviews, offers and hires come
 * from the rows that record them, not from counters on the order. A counter
 * would be wrong within a week — five screens move candidates and only one
 * would remember to increment — and a fill rate that is quietly wrong is the
 * number a desk is managed by.
 *
 * **The SLA is derived too, and it stops when the order does.** A filled order
 * is not overdue. That is a product decision, written once in `SLA`, rather
 * than a condition repeated at every call site.
 *
 * Commercial terms — bill rate, pay rate, margin — are omitted from the
 * projection for anybody but an administrator. Not fetched and hidden: not
 * fetched. A field that never leaves the database cannot leak through a log
 * line or a future serialisation bug.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class RecruitmentError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'RecruitmentError';
    this.code = code;
  }
}

export interface StaffingRequirement {
  id: string; clientId: string; sowId: string | null; title: string; role: string;
  skills: string[]; location: string; ccy: string; billRate: number; unit: string;
  maxSubmissions: number; positions: number; filled: number; priority: string;
  receivedOn: string; closeBy: string; recruiterId: string | null; source: string;
  vms: string | null; status: string; duration: string;
  openedOn: string | null; targetSubmitOn: string | null;
  targetInterviewOn: string | null; targetFillOn: string | null; slaDays: number | null;
}

export interface SlaStanding {
  state: string; daysOpen: number; daysRemaining: number; aging: number;
  behind: 'submission' | 'interview' | 'fill' | null;
}

export interface JobCounts {
  sourced: number; screened: number; submissions: number;
  interviews: number; offers: number; hires: number;
}

export interface JobAssignment {
  id: string; reqId: string; recruiterId: string; role: string;
  assignedOn: string; assignedById: string;
  targetSubmissions: number | null; targetInterviews: number | null;
  targetHires: number | null; dailySubmissions: number | null;
  weeklySubmissions: number | null; priority: string; notes: string;
  releasedOn: string | null;
}

export interface JobActivity {
  id: string; reqId: string; at: string; actorId: string | null;
  kind: string; summary: string; qty: number | null; refId: string | null;
}

export interface JobOrderRow { order: StaffingRequirement; sla: SlaStanding; counts: JobCounts }
export interface JobOrderDetail extends JobOrderRow {
  assignments: JobAssignment[];
  activity: JobActivity[];
}

export interface RecruitmentFilter {
  from?: string | undefined; to?: string | undefined;
  clientId?: string | undefined; recruiterId?: string | undefined;
  reqId?: string | undefined; industry?: string | undefined;
  tech?: string | undefined; location?: string | undefined;
  status?: string | undefined; priority?: string | undefined;
}

export interface JobOrderDraft {
  clientId: string; title: string; role?: string | undefined;
  skills?: string[] | undefined; location?: string | undefined;
  positions?: number | undefined; priority?: string | undefined;
  receivedOn?: string | undefined; closeBy?: string | undefined;
  billRate?: number | undefined; payRate?: number | undefined;
  maxSubmissions?: number | undefined; source?: string | undefined;
  status?: string | undefined; duration?: string | undefined;
  openedOn?: string | undefined; targetSubmitOn?: string | undefined;
  targetInterviewOn?: string | undefined; targetFillOn?: string | undefined;
  slaDays?: number | undefined;
}

export interface AssignmentDraft {
  recruiterId: string; role: string;
  targetSubmissions?: number | null | undefined;
  targetInterviews?: number | null | undefined;
  targetHires?: number | null | undefined;
  dailySubmissions?: number | null | undefined;
  weeklySubmissions?: number | null | undefined;
  priority?: string | undefined; notes?: string | undefined;
}

const title = (s: unknown) =>
  String(s ?? '').split('_').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');

const today = () => new Date().toISOString().slice(0, 10);
const days = (from: string | null, to: string) =>
  (from ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) : 0);

/** Statuses that stop the clock. A filled order is not overdue. */
const SETTLED = ['filled', 'closed', 'lost', 'cancelled'];

/**
 * Where an order stands against its targets.
 *
 * Written once here rather than as a condition at each call site, because the
 * rule — a settled order is never behind — is the kind that gets forgotten in
 * one place and produces a dashboard nobody trusts.
 */
function slaOf(r: Record<string, unknown>, counts: JobCounts): SlaStanding {
  const status = String(r.status ?? '');
  const openedOn = (r.opened_on as string | null) ?? (r.received_on as string | null);
  const daysOpen = days(openedOn, today());

  if (SETTLED.includes(status)) {
    return { state: 'Settled', daysOpen, daysRemaining: 0, aging: 0, behind: null };
  }

  const fillTarget = (r.target_fill_on as string | null) ?? (r.close_by as string | null);
  const daysRemaining = fillTarget ? days(today(), fillTarget) : 0;
  const aging = fillTarget && fillTarget < today() ? days(fillTarget, today()) : 0;

  /*
   * The earliest target that has passed with nothing to show for it. Ordered,
   * because an order behind on submissions is behind on submissions — saying
   * it is behind on fill tells nobody what to do about it.
   */
  let behind: SlaStanding['behind'] = null;
  const submitTarget = r.target_submit_on as string | null;
  const interviewTarget = r.target_interview_on as string | null;
  if (submitTarget && submitTarget < today() && counts.submissions === 0) behind = 'submission';
  else if (interviewTarget && interviewTarget < today() && counts.interviews === 0) behind = 'interview';
  else if (aging > 0) behind = 'fill';

  const state = behind ? 'Behind' : daysRemaining <= 7 ? 'At risk' : 'On track';
  return { state, daysOpen, daysRemaining, aging, behind };
}

/**
 * Counts, from the rows that record them.
 *
 * `job_activity` carries the sourcing and screening numbers, which nothing
 * else records; submissions, interviews, offers and hires are counted from
 * the candidate pipeline itself so they cannot drift from it.
 */
const COUNTS = `
  LEFT JOIN LATERAL (
    SELECT
      COALESCE((SELECT sum(a.qty) FROM job_activity a
                 WHERE a.requirement_id = r.id AND a.kind = 'sourced'), 0)::int  AS sourced,
      COALESCE((SELECT sum(a.qty) FROM job_activity a
                 WHERE a.requirement_id = r.id AND a.kind = 'screened'), 0)::int AS screened,
      (SELECT count(*) FROM submission s WHERE s.requirement_id = r.id)::int     AS submissions,
      (SELECT count(*) FROM submission s
        WHERE s.requirement_id = r.id
          AND s.stage IN ('interview_scheduled', 'interviewed', 'offered', 'placed'))::int AS interviews,
      (SELECT count(*) FROM submission s
        WHERE s.requirement_id = r.id AND s.stage IN ('offered', 'placed'))::int AS offers,
      (SELECT count(*) FROM submission s
        WHERE s.requirement_id = r.id AND s.stage = 'placed')::int               AS hires
  ) c ON TRUE`;

/**
 * Commercial columns are selected only for an administrator.
 *
 * Bill rate, pay rate and the margin between them are the commercial terms of
 * a client contract. A recruiter needs the order; they do not need the markup,
 * and the safest way to keep it from them is not to fetch it.
 */
const projection = (caller: Caller) => `
  SELECT r.id, r.client_id, r.sow_id, r.title, r.role, r.skills, r.location,
         r.currency, r.unit, r.max_submissions, r.positions, r.filled,
         r.priority, r.received_on::text, r.close_by::text, r.recruiter_id,
         r.source, r.vms, r.status, r.duration,
         r.opened_on::text, r.target_submit_on::text, r.target_interview_on::text,
         r.target_fill_on::text, r.sla_days,
         ${caller.role === 'admin' ? 'r.bill_rate, r.pay_rate' : 'NULL::numeric AS bill_rate, NULL::numeric AS pay_rate'},
         c.sourced, c.screened, c.submissions, c.interviews, c.offers, c.hires
    FROM staffing_requirement r
    ${COUNTS}`;

function toRow(r: Record<string, unknown>): JobOrderRow {
  const counts: JobCounts = {
    sourced: Number(r.sourced ?? 0),
    screened: Number(r.screened ?? 0),
    submissions: Number(r.submissions ?? 0),
    interviews: Number(r.interviews ?? 0),
    offers: Number(r.offers ?? 0),
    hires: Number(r.hires ?? 0),
  };
  return {
    order: {
      id: r.id as string,
      clientId: r.client_id as string,
      sowId: (r.sow_id as string | null) ?? null,
      title: String(r.title ?? ''),
      role: String(r.role ?? ''),
      skills: (r.skills as string[] | null) ?? [],
      location: String(r.location ?? ''),
      ccy: String(r.currency ?? ''),
      billRate: Number(r.bill_rate ?? 0),
      unit: String(r.unit ?? ''),
      maxSubmissions: Number(r.max_submissions ?? 0),
      positions: Number(r.positions ?? 0),
      filled: Number(r.filled ?? 0),
      priority: title(r.priority),
      receivedOn: String(r.received_on ?? ''),
      closeBy: String(r.close_by ?? ''),
      recruiterId: (r.recruiter_id as string | null) ?? null,
      source: String(r.source ?? ''),
      vms: (r.vms as string | null) ?? null,
      status: title(r.status),
      duration: String(r.duration ?? ''),
      openedOn: (r.opened_on as string | null) ?? null,
      targetSubmitOn: (r.target_submit_on as string | null) ?? null,
      targetInterviewOn: (r.target_interview_on as string | null) ?? null,
      targetFillOn: (r.target_fill_on as string | null) ?? null,
      slaDays: r.sla_days === null || r.sla_days === undefined ? null : Number(r.sla_days),
    },
    sla: slaOf(r, counts),
    counts,
  };
}

/**
 * The recruitment desk is administrators only.
 *
 * Every order carries a bill rate, a markup and a client contract behind it.
 * This is not a decision taken lightly and it matches `policy.ts`, which has
 * said so since the module was built — it is restated here because the API is
 * the boundary and the policy table is documentation of it, not the thing that
 * enforces it.
 */
const deskOnly = (caller: Caller) => {
  if (caller.role !== 'admin') {
    throw new RecruitmentError('Your role cannot reach the recruitment desk', 'forbidden');
  }
};

function where(f: RecruitmentFilter, params: unknown[]): string {
  const parts: string[] = [];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.clientId) parts.push(`r.client_id = ${bind(f.clientId)}`);
  if (f.reqId) parts.push(`r.id = ${bind(f.reqId)}`);
  if (f.status) parts.push(`r.status = ${bind(f.status.toLowerCase().replace(/ /g, '_'))}`);
  if (f.priority) parts.push(`r.priority = ${bind(f.priority.toLowerCase())}`);
  if (f.location) parts.push(`r.location ILIKE ${bind(`%${f.location}%`)}`);
  if (f.tech) parts.push(`${bind(f.tech)} = ANY(r.skills)`);
  if (f.from) parts.push(`COALESCE(r.opened_on, r.received_on) >= ${bind(f.from)}`);
  if (f.to) parts.push(`COALESCE(r.opened_on, r.received_on) <= ${bind(f.to)}`);
  if (f.industry) {
    parts.push(`r.client_id IN (SELECT id FROM client WHERE industry = ${bind(f.industry)})`);
  }
  if (f.recruiterId) {
    parts.push(`EXISTS (SELECT 1 FROM job_assignment a
                         WHERE a.requirement_id = r.id
                           AND a.recruiter_id = ${bind(f.recruiterId)}
                           AND a.released_on IS NULL)`);
  }
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

export async function jobOrders(
  caller: Caller,
  f: RecruitmentFilter = {},
): Promise<JobOrderRow[]> {
  deskOnly(caller);
  const params: unknown[] = [];
  const sql = where(f, params);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${projection(caller)} ${sql} ORDER BY COALESCE(r.opened_on, r.received_on) DESC`, params);
    return rows.map(toRow);
  });
}

async function assignmentsFor(db: TenantClient, reqId: string): Promise<JobAssignment[]> {
  const { rows } = await db.query(
    `SELECT id, requirement_id, recruiter_id, role, assigned_on::text, assigned_by_id,
            target_submissions, target_interviews, target_hires,
            daily_submissions, weekly_submissions, priority, notes, released_on::text
       FROM job_assignment WHERE requirement_id = $1
      ORDER BY released_on NULLS FIRST, assigned_on DESC`,
    [reqId]);
  return rows.map((a: Record<string, unknown>) => ({
    id: a.id as string,
    reqId: a.requirement_id as string,
    recruiterId: a.recruiter_id as string,
    role: title(a.role),
    assignedOn: String(a.assigned_on ?? ''),
    assignedById: (a.assigned_by_id as string) ?? '',
    targetSubmissions: a.target_submissions === null ? null : Number(a.target_submissions),
    targetInterviews: a.target_interviews === null ? null : Number(a.target_interviews),
    targetHires: a.target_hires === null ? null : Number(a.target_hires),
    dailySubmissions: a.daily_submissions === null ? null : Number(a.daily_submissions),
    weeklySubmissions: a.weekly_submissions === null ? null : Number(a.weekly_submissions),
    priority: title(a.priority),
    notes: String(a.notes ?? ''),
    releasedOn: (a.released_on as string | null) ?? null,
  }));
}

async function activityFor(db: TenantClient, reqId: string): Promise<JobActivity[]> {
  const { rows } = await db.query(
    `SELECT id, requirement_id, at::text AS at, actor_id, kind,
            summary, qty, ref_id
       FROM job_activity WHERE requirement_id = $1 ORDER BY at DESC`,
    [reqId]);
  return rows.map((a: Record<string, unknown>) => ({
    id: a.id as string,
    reqId: a.requirement_id as string,
    at: String(a.at ?? ''),
    actorId: (a.actor_id as string | null) ?? null,
    kind: String(a.kind ?? ''),
    summary: String(a.summary ?? ''),
    qty: a.qty === null ? null : Number(a.qty),
    refId: (a.ref_id as string | null) ?? null,
  }));
}

export async function jobOrder(caller: Caller, id: string): Promise<JobOrderDetail | null> {
  deskOnly(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${projection(caller)} WHERE r.id = $1`, [id]);
    if (!rows[0]) return null;
    return {
      ...toRow(rows[0]),
      assignments: await assignmentsFor(db, id),
      activity: await activityFor(db, id),
    };
  });
}

export async function myJobs(caller: Caller, recruiterId: string): Promise<JobOrderRow[]> {
  return jobOrders(caller, { recruiterId });
}

const validate = (d: Partial<JobOrderDraft>) => {
  if (d.title !== undefined && !d.title.trim()) {
    throw new RecruitmentError('Give the order a title', 'invalid');
  }
  if (d.positions !== undefined && d.positions < 1) {
    throw new RecruitmentError('An order is for one position or more', 'invalid');
  }
  /*
   * The pay rate is what we pay; the bill rate is what the client pays. A pay
   * rate at or above the bill rate is a loss, and 0029 refuses it at the
   * schema level — caught here so the message says why.
   */
  if (d.payRate != null && d.billRate != null && d.payRate >= d.billRate) {
    throw new RecruitmentError('The pay rate must be below the bill rate', 'invalid');
  }
  const seq = [d.targetSubmitOn, d.targetInterviewOn, d.targetFillOn].filter(Boolean) as string[];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i]! < seq[i - 1]!) {
      throw new RecruitmentError(
        'The targets are a sequence — interview cannot come before submission', 'invalid');
    }
  }
};

export async function createJobOrder(
  caller: Caller,
  d: JobOrderDraft,
): Promise<StaffingRequirement> {
  deskOnly(caller);
  validate(d);
  if (!d.clientId) throw new RecruitmentError('An order belongs to a client', 'invalid');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO staffing_requirement
         (client_id, title, role, skills, location, positions, priority,
          received_on, close_by, bill_rate, pay_rate, max_submissions, source,
          status, duration, opened_on, target_submit_on, target_interview_on,
          target_fill_on, sla_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               COALESCE($8::date, CURRENT_DATE), $9,$10,$11,$12,$13,
               COALESCE($14,'draft'),$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [d.clientId, d.title.trim(), d.role ?? '', d.skills ?? [], d.location ?? '',
        d.positions ?? 1, (d.priority ?? 'medium').toLowerCase(), d.receivedOn ?? null,
        d.closeBy ?? null, d.billRate ?? null, d.payRate ?? null,
        d.maxSubmissions ?? 0, d.source ?? '', d.status?.toLowerCase(), d.duration ?? '',
        d.openedOn ?? null, d.targetSubmitOn ?? null, d.targetInterviewOn ?? null,
        d.targetFillOn ?? null, d.slaDays ?? null],
    );
    await log(db, caller, rows[0]!.id, 'created', `${d.title.trim()} raised`, null);
    const made = await jobOrder(caller, rows[0]!.id);
    if (!made) throw new RecruitmentError('The order was not created', 'invalid');
    return made.order;
  });
}

export async function updateJobOrder(
  caller: Caller,
  id: string,
  patch: Partial<JobOrderDraft>,
): Promise<StaffingRequirement> {
  deskOnly(caller);
  validate(patch);

  return withTenant(caller, async (db) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (patch.title !== undefined) set('title', patch.title.trim());
    if (patch.role !== undefined) set('role', patch.role);
    if (patch.skills !== undefined) set('skills', patch.skills);
    if (patch.location !== undefined) set('location', patch.location);
    if (patch.positions !== undefined) set('positions', patch.positions);
    if (patch.priority !== undefined) set('priority', patch.priority.toLowerCase());
    if (patch.closeBy !== undefined) set('close_by', patch.closeBy);
    if (patch.billRate !== undefined) set('bill_rate', patch.billRate);
    if (patch.payRate !== undefined) set('pay_rate', patch.payRate);
    if (patch.maxSubmissions !== undefined) set('max_submissions', patch.maxSubmissions);
    if (patch.source !== undefined) set('source', patch.source);
    if (patch.duration !== undefined) set('duration', patch.duration);
    if (patch.openedOn !== undefined) set('opened_on', patch.openedOn);
    if (patch.targetSubmitOn !== undefined) set('target_submit_on', patch.targetSubmitOn);
    if (patch.targetInterviewOn !== undefined) set('target_interview_on', patch.targetInterviewOn);
    if (patch.targetFillOn !== undefined) set('target_fill_on', patch.targetFillOn);
    if (patch.slaDays !== undefined) set('sla_days', patch.slaDays);
    if (patch.status !== undefined) {
      set('status', patch.status.toLowerCase().replace(/ /g, '_'));
      /* Opening an order starts the clock, and it starts now, not when it arrived. */
      if (patch.status.toLowerCase() === 'open') {
        sets.push('opened_on = COALESCE(opened_on, CURRENT_DATE)');
      }
    }

    if (sets.length) {
      params.push(id);
      const { rowCount } = await db.query(
        `UPDATE staffing_requirement SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      if (!rowCount) throw new RecruitmentError('No such order', 'not_found');
      if (patch.status !== undefined) {
        await log(db, caller, id, 'status_changed', `Status set to ${patch.status}`, null);
      }
    }
    const after = await jobOrder(caller, id);
    if (!after) throw new RecruitmentError('No such order', 'not_found');
    return after.order;
  });
}

export async function assign(
  caller: Caller,
  id: string,
  d: AssignmentDraft,
): Promise<JobOrderDetail> {
  deskOnly(caller);
  if (!d.recruiterId) throw new RecruitmentError('Name the recruiter', 'invalid');
  if (!['primary', 'backup', 'manager'].includes(d.role?.toLowerCase())) {
    throw new RecruitmentError('A recruiter is primary, backup or manager on an order', 'invalid');
  }

  return withTenant(caller, async (db) => {
    /*
     * One live holder of each role. 0029 enforces it with a partial unique
     * index; releasing the incumbent first is what makes reassignment work
     * rather than fail.
     */
    await db.query(
      `UPDATE job_assignment SET released_on = CURRENT_DATE
        WHERE requirement_id = $1 AND role = $2 AND released_on IS NULL`,
      [id, d.role.toLowerCase()]);

    await db.query(
      `INSERT INTO job_assignment
         (requirement_id, recruiter_id, role, assigned_by_id, target_submissions,
          target_interviews, target_hires, daily_submissions, weekly_submissions,
          priority, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, d.recruiterId, d.role.toLowerCase(), caller.employeeId,
        d.targetSubmissions ?? null, d.targetInterviews ?? null, d.targetHires ?? null,
        d.dailySubmissions ?? null, d.weeklySubmissions ?? null,
        (d.priority ?? 'medium').toLowerCase(), d.notes ?? ''],
    ).catch((e: { code?: string }) => {
      if (e.code === '23503') throw new RecruitmentError('No such recruiter or order', 'invalid');
      throw e;
    });

    /* The order's own recruiter column tracks whoever is primary. */
    if (d.role.toLowerCase() === 'primary') {
      await db.query('UPDATE staffing_requirement SET recruiter_id = $1 WHERE id = $2',
        [d.recruiterId, id]);
    }

    await log(db, caller, id, 'assigned', `Assigned as ${d.role.toLowerCase()}`, null);
    const after = await jobOrder(caller, id);
    if (!after) throw new RecruitmentError('No such order', 'not_found');
    return after;
  });
}

export async function release(
  caller: Caller,
  id: string,
  assignmentId: string,
): Promise<JobOrderDetail> {
  deskOnly(caller);
  return withTenant(caller, async (db) => {
    /*
     * Released, not deleted. Who was on this order in March is a question the
     * desk asks when a placement falls through.
     */
    const { rowCount } = await db.query(
      `UPDATE job_assignment SET released_on = CURRENT_DATE
        WHERE id = $1 AND requirement_id = $2 AND released_on IS NULL`,
      [assignmentId, id]);
    if (!rowCount) throw new RecruitmentError('No such live assignment', 'not_found');
    await log(db, caller, id, 'reassigned', 'Recruiter released from the order', null);
    const after = await jobOrder(caller, id);
    if (!after) throw new RecruitmentError('No such order', 'not_found');
    return after;
  });
}

async function log(
  db: TenantClient,
  caller: Caller,
  reqId: string,
  kind: string,
  summary: string,
  qty: number | null,
) {
  await db.query(
    `INSERT INTO job_activity (requirement_id, actor_id, kind, summary, qty)
     VALUES ($1,$2,$3,$4,$5)`,
    [reqId, caller.employeeId, kind, summary, qty]);
}

export async function logActivity(
  caller: Caller,
  id: string,
  kind: string,
  summary: string,
  qty?: number,
): Promise<JobActivity> {
  deskOnly(caller);
  if (!summary?.trim()) throw new RecruitmentError('Say what happened', 'invalid');
  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO job_activity (requirement_id, actor_id, kind, summary, qty)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, requirement_id, at::text AS at, actor_id, kind,
                 summary, qty, ref_id`,
      [id, caller.employeeId, kind, summary.trim(), qty ?? null],
    ).catch((e: { code?: string }) => {
      if (e.code === '23503') throw new RecruitmentError('No such order', 'not_found');
      throw e;
    });
    const a = rows[0] as Record<string, unknown>;
    return {
      id: a.id as string, reqId: a.requirement_id as string, at: String(a.at),
      actorId: (a.actor_id as string | null) ?? null, kind: String(a.kind),
      summary: String(a.summary), qty: a.qty === null ? null : Number(a.qty),
      refId: (a.ref_id as string | null) ?? null,
    };
  });
}

export async function kpi(caller: Caller, f: RecruitmentFilter = {}) {
  const rows = await jobOrders(caller, f);
  const open = rows.filter((r) => r.order.status === 'Open');
  return {
    openJobs: open.length,
    assignedJobs: open.filter((r) => r.order.recruiterId).length,
    submissions: rows.reduce((n, r) => n + r.counts.submissions, 0),
    interviews: rows.reduce((n, r) => n + r.counts.interviews, 0),
    offers: rows.reduce((n, r) => n + r.counts.offers, 0),
    hires: rows.reduce((n, r) => n + r.counts.hires, 0),
    closingSoon: open.filter((r) => r.sla.daysRemaining >= 0 && r.sla.daysRemaining <= 7).length,
    aging: open.filter((r) => r.sla.aging > 0).length,
  };
}

export async function funnel(caller: Caller, f: RecruitmentFilter = {}) {
  const rows = await jobOrders(caller, f);
  return {
    openRequirements: rows.filter((r) => r.order.status === 'Open').length,
    sourced: rows.reduce((n, r) => n + r.counts.sourced, 0),
    screened: rows.reduce((n, r) => n + r.counts.screened, 0),
    submitted: rows.reduce((n, r) => n + r.counts.submissions, 0),
    /* Client review is a submission that has left the desk and not yet been
       given an interview slot — derived rather than a status of its own. */
    clientReview: rows.reduce((n, r) => n + Math.max(0, r.counts.submissions - r.counts.interviews), 0),
    interview: rows.reduce((n, r) => n + r.counts.interviews, 0),
    offer: rows.reduce((n, r) => n + r.counts.offers, 0),
    hired: rows.reduce((n, r) => n + r.counts.hires, 0),
  };
}

/** Open orders with nobody on them — the first thing a desk manager looks at. */
export async function unassignedJobs(caller: Caller): Promise<JobOrderRow[]> {
  const rows = await jobOrders(caller, { status: 'Open' });
  return rows.filter((r) => !r.order.recruiterId);
}

/** How each recruiter's live orders are going. */
export async function recruiterPerformance(caller: Caller) {
  deskOnly(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT a.recruiter_id, e.full_name AS name,
              count(DISTINCT a.requirement_id)::int AS orders,
              COALESCE(sum(c.submissions), 0)::int  AS submissions,
              COALESCE(sum(c.interviews), 0)::int   AS interviews,
              COALESCE(sum(c.offers), 0)::int       AS offers,
              COALESCE(sum(c.hires), 0)::int        AS hires
         FROM job_assignment a
         JOIN employee e ON e.id = a.recruiter_id
         JOIN staffing_requirement r ON r.id = a.requirement_id
         ${COUNTS}
        WHERE a.released_on IS NULL
        GROUP BY a.recruiter_id, e.full_name
        ORDER BY hires DESC, submissions DESC`);
    return rows.map((r: Record<string, unknown>) => ({
      recruiterId: r.recruiter_id as string,
      name: String(r.name),
      orders: Number(r.orders),
      submissions: Number(r.submissions),
      interviews: Number(r.interviews),
      offers: Number(r.offers),
      hires: Number(r.hires),
      /* Conversion is a ratio and reads as one; zero submissions is null, not
         a zero per cent that looks like failure rather than absence. */
      submitToInterview: Number(r.submissions)
        ? Math.round((Number(r.interviews) / Number(r.submissions)) * 100) : null,
      interviewToHire: Number(r.interviews)
        ? Math.round((Number(r.hires) / Number(r.interviews)) * 100) : null,
    }));
  });
}

/** Open orders by how long they have been open — the aging report. */
export async function jobAging(caller: Caller) {
  const rows = await jobOrders(caller, { status: 'Open' });
  return rows
    .map((r) => ({
      order: r.order, sla: r.sla, counts: r.counts,
      breached: r.sla.behind !== null,
    }))
    .sort((a, b) => b.sla.daysOpen - a.sla.daysOpen);
}
