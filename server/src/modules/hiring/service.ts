/**
 * Recruitment — requisitions, submissions, the pipeline and the interview
 * schedule.
 *
 * **`filled` is recomputed from the pipeline, never incremented.** A counter
 * that is bumped on each hire drifts the first time a candidate is moved out
 * of 'hired' again, and nothing ever notices — the requisition just quietly
 * claims to be full. Here every stage move recounts the hired candidates for
 * that requisition, so the number is derived rather than remembered, and the
 * schema's `CHECK (filled <= openings)` becomes a real cap: you cannot hire
 * three people into two openings.
 *
 * **A candidate is unique per (requisition, email).** That is the schema's
 * unique index, and it is what makes a submission tracker trustworthy — two
 * recruiters submitting the same person for the same role is the thing the
 * tracker exists to catch, so it is refused with an explanation rather than
 * silently creating a second row.
 *
 * **Candidate records are not a directory.** They carry current and expected
 * salary, a phone number and an email for someone who does not work here. An
 * employee sees only the interviews they are personally on the panel for; the
 * pipeline itself is for recruiters, hiring managers and admins.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class HiringError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'HiringError';
    this.code = code;
  }
}

/** The pipeline, in order. `hired` and `rejected` are terminal. */
const STAGES = ['applied', 'screen', 'tech', 'manager', 'hr', 'offer', 'hired', 'rejected'];

const TO_REQ_STATUS: Record<string, string> = {
  draft: 'Open', open: 'Open', on_hold: 'On Hold', closed: 'Closed', cancelled: 'Closed',
};
const FROM_PRIORITY: Record<string, string> = {
  Critical: 'critical', High: 'high', Medium: 'medium', Low: 'low',
};
const TO_PRIORITY: Record<string, string> = {
  critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
};
const TO_IV_STATUS: Record<string, string> = {
  scheduled: 'Scheduled', completed: 'Completed', no_show: 'No Show', cancelled: 'No Show',
};

export interface Requisition {
  id: string;
  title: string;
  dept: string;
  grade: string;
  site: string;
  openings: number;
  filled: number;
  priority: string;
  status: string;
  hiringManagerId: string;
  recruiterId: string;
  openedOn: string;
  budgetMin: number;
  budgetMax: number;
  type: string;
  desc: string;
  must: string[];
  exp: string;
}

export interface Candidate {
  id: string;
  name: string;
  reqId: string;
  stage: string;
  email: string;
  phone: string;
  source: string;
  appliedOn: string;
  exp: string;
  current: string;
  ctcCur: number;
  ctcExp: number;
  notice: string;
  rating: number;
  skills: string[];
  loc: string;
  resume: string;
  notes: { by: string; on: string; text: string }[];
  offer: null;
}

export interface Interview {
  id: string;
  candId: string;
  reqId: string;
  round: string;
  date: string;
  time: string;
  panelId: string;
  mode: string;
  status: string;
  verdict: string | null;
  feedback: string;
}

export interface RecruiterStat {
  recruiterId: string;
  name: string;
  openReqs: number;
  openings: number;
  submissions: number;
  inPipeline: number;
  interviews: number;
  offers: number;
  hires: number;
}

const REQ_PROJECTION = `
  SELECT r.id, r.title, r.openings, r.filled, r.priority, r.status,
         r.hiring_manager_id, r.recruiter_id, r.opened_on, r.budget_min, r.budget_max,
         r.employment_type, r.description, r.must_have_skills, r.experience,
         d.code AS dept_code, COALESCE(g.code, '') AS grade_code, COALESCE(s.code, '') AS site_code
    FROM requisition r
    JOIN department d ON d.id = r.department_id
    LEFT JOIN grade_band g ON g.id = r.grade_id
    LEFT JOIN site s ON s.id = r.site_id`;

const toReq = (r: Record<string, unknown>): Requisition => ({
  id: r.id as string,
  title: r.title as string,
  dept: r.dept_code as string,
  grade: r.grade_code as string,
  site: r.site_code as string,
  openings: Number(r.openings),
  filled: Number(r.filled),
  priority: TO_PRIORITY[r.priority as string] ?? 'Medium',
  status: TO_REQ_STATUS[r.status as string] ?? 'Open',
  hiringManagerId: r.hiring_manager_id as string,
  recruiterId: (r.recruiter_id as string) ?? '',
  openedOn: r.opened_on as string,
  budgetMin: r.budget_min === null ? 0 : Number(r.budget_min),
  budgetMax: r.budget_max === null ? 0 : Number(r.budget_max),
  type: (r.employment_type as string) ?? 'permanent',
  desc: (r.description as string) ?? '',
  must: (r.must_have_skills as string[]) ?? [],
  exp: (r.experience as string) ?? '',
});

const CAND_PROJECTION = `
  SELECT c.id, c.full_name, c.requisition_id, c.stage, c.email, c.phone, c.source,
         c.applied_on, c.experience, c.current_employer, c.current_ctc, c.expected_ctc,
         c.notice_period, c.rating, c.skills, c.location,
         COALESCE(n.notes, '[]'::jsonb) AS notes
    FROM candidate c
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'by', COALESCE(a.full_name, 'System'),
               'on', cn.created_at::date,
               'text', cn.body) ORDER BY cn.created_at DESC) AS notes
        FROM candidate_note cn
        LEFT JOIN employee a ON a.id = cn.author_id
       WHERE cn.candidate_id = c.id
    ) n ON true`;

const toCand = (r: Record<string, unknown>): Candidate => ({
  id: r.id as string,
  name: r.full_name as string,
  reqId: r.requisition_id as string,
  stage: r.stage as string,
  email: r.email as string,
  phone: (r.phone as string) ?? '',
  source: (r.source as string) ?? '',
  appliedOn: r.applied_on as string,
  exp: (r.experience as string) ?? '',
  current: (r.current_employer as string) ?? '',
  ctcCur: r.current_ctc === null ? 0 : Number(r.current_ctc),
  ctcExp: r.expected_ctc === null ? 0 : Number(r.expected_ctc),
  notice: (r.notice_period as string) ?? '',
  rating: r.rating === null ? 0 : Number(r.rating),
  skills: (r.skills as string[]) ?? [],
  loc: (r.location as string) ?? '',
  resume: '',
  notes: r.notes as { by: string; on: string; text: string }[],
  offer: null,
});

const IV_PROJECTION = `
  SELECT i.id, i.candidate_id, i.requisition_id, i.round, i.panel_member_id,
         i.mode, i.status, i.verdict, i.feedback,
         to_char(i.scheduled_at, 'YYYY-MM-DD') AS iv_date,
         to_char(i.scheduled_at, 'HH24:MI') AS iv_time
    FROM interview i`;

const toInterview = (r: Record<string, unknown>): Interview => ({
  id: r.id as string,
  candId: r.candidate_id as string,
  reqId: r.requisition_id as string,
  round: r.round as string,
  date: r.iv_date as string,
  time: r.iv_time as string,
  panelId: r.panel_member_id as string,
  mode: (r.mode as string) ?? 'video',
  status: TO_IV_STATUS[r.status as string] ?? 'Scheduled',
  verdict: (r.verdict as string | null) ?? null,
  feedback: (r.feedback as string) ?? '',
});

/** Recruiters, hiring managers and admins see the pipeline; nobody else does. */
function mayRecruit(caller: Caller): boolean {
  return caller.role === 'admin' || caller.role === 'manager';
}

export async function listRequisitions(caller: Caller): Promise<Requisition[]> {
  if (!mayRecruit(caller)) return [];
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${REQ_PROJECTION} ORDER BY r.opened_on DESC`);
    return rows.map(toReq);
  });
}

export async function listCandidates(caller: Caller): Promise<Candidate[]> {
  if (!mayRecruit(caller)) return [];
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${CAND_PROJECTION} ORDER BY c.applied_on DESC`);
    return rows.map(toCand);
  });
}

export async function listInterviews(caller: Caller): Promise<Interview[]> {
  if (!mayRecruit(caller)) return [];
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${IV_PROJECTION} ORDER BY i.scheduled_at DESC`);
    return rows.map(toInterview);
  });
}

/**
 * A panel member's own interviews.
 *
 * This is the one hiring read an ordinary employee gets, and only for
 * themselves: being asked to interview someone is not a reason to see the rest
 * of the pipeline.
 */
export async function interviewsFor(
  caller: Caller,
  panelId: string,
  status?: string,
): Promise<{ interview: Interview; candidate: Candidate | null; requisitionTitle: string }[]> {
  if (panelId !== caller.employeeId && !mayRecruit(caller)) {
    throw new HiringError("you can only see your own interviews", 'forbidden');
  }

  const dbStatus = status
    ? Object.entries(TO_IV_STATUS).find(([, v]) => v === status)?.[0]
    : undefined;

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${IV_PROJECTION}
        WHERE i.panel_member_id = $1 ${dbStatus ? 'AND i.status = $2' : ''}
        ORDER BY i.scheduled_at`,
      dbStatus ? [panelId, dbStatus] : [panelId]);

    const out = [];
    for (const r of rows) {
      const interview = toInterview(r);
      const cand = await db.query(`${CAND_PROJECTION} WHERE c.id = $1`, [interview.candId]);
      const req = await db.query('SELECT title FROM requisition WHERE id = $1', [interview.reqId]);
      out.push({
        interview,
        candidate: cand.rows[0] ? toCand(cand.rows[0]) : null,
        requisitionTitle: (req.rows[0]?.title as string) ?? '—',
      });
    }
    return out;
  });
}

export interface NewRequisition {
  title: string;
  dept: string;
  grade?: string;
  site?: string;
  openings: number;
  priority?: string;
  hiringManagerId: string;
  recruiterId?: string;
  budgetMin?: number;
  budgetMax?: number;
  type?: string;
  desc?: string;
  must?: string[];
  exp?: string;
}

/** Open a new role. The code continues the REQ series. */
export async function openRequisition(
  caller: Caller,
  draft: NewRequisition,
): Promise<Requisition[]> {
  if (!mayRecruit(caller)) {
    throw new HiringError('only a manager or admin may open a requisition', 'forbidden');
  }
  if (!draft.title?.trim()) throw new HiringError('a requisition needs a title', 'invalid');
  const openings = Number(draft.openings);
  if (!Number.isInteger(openings) || openings < 1) {
    throw new HiringError('a requisition needs at least one opening', 'invalid');
  }
  if (draft.budgetMin != null && draft.budgetMax != null
      && Number(draft.budgetMax) < Number(draft.budgetMin)) {
    throw new HiringError('the budget maximum is below the minimum', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const dept = await db.query('SELECT id FROM department WHERE code = $1', [draft.dept]);
    if (!dept.rows[0]) throw new HiringError(`no such department: ${draft.dept}`, 'invalid');

    const grade = draft.grade
      ? (await db.query('SELECT id FROM grade_band WHERE code = $1', [draft.grade])).rows[0]?.id
      : null;
    const site = draft.site
      ? (await db.query('SELECT id FROM site WHERE code = $1', [draft.site])).rows[0]?.id
      : null;

    const manager = await db.query('SELECT id FROM employee WHERE id = $1', [draft.hiringManagerId]);
    if (!manager.rows[0]) throw new HiringError('no such hiring manager', 'invalid');

    // The code continues the series rather than being sent: a client-chosen
    // code is a client-chosen collision.
    const next = await db.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) + 1 AS n
         FROM requisition WHERE code ~ '^REQ'`);
    const code = `REQ${String(next.rows[0].n).padStart(3, '0')}`;

    await db.query(
      `INSERT INTO requisition
         (code, title, department_id, site_id, grade_id, openings, priority,
          employment_type, hiring_manager_id, recruiter_id, budget_min, budget_max,
          currency, experience, description, must_have_skills)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               (SELECT base_currency FROM tenant WHERE id = current_tenant_id()),
               $13,$14,$15)`,
      [code, draft.title.trim(), dept.rows[0].id, site ?? null, grade ?? null, openings,
        FROM_PRIORITY[draft.priority ?? 'Medium'] ?? 'medium', draft.type ?? 'permanent',
        draft.hiringManagerId, draft.recruiterId || caller.employeeId,
        draft.budgetMin ?? null, draft.budgetMax ?? null,
        draft.exp ?? '', draft.desc ?? '', draft.must ?? []]);

    const { rows } = await db.query(`${REQ_PROJECTION} ORDER BY r.opened_on DESC`);
    return rows.map(toReq);
  });
}

export interface NewSubmission {
  reqId: string;
  name: string;
  email: string;
  phone?: string;
  source?: string;
  exp?: string;
  current?: string;
  ctcCur?: number;
  ctcExp?: number;
  notice?: string;
  skills?: string[];
  loc?: string;
}

/**
 * Submit a candidate against a requisition.
 *
 * Refused if the role is closed — a submission against a filled req is the
 * thing agencies do and the thing the tracker exists to stop counting.
 */
export async function submitCandidate(
  caller: Caller,
  draft: NewSubmission,
): Promise<Candidate> {
  if (!mayRecruit(caller)) {
    throw new HiringError('only a manager or admin may submit a candidate', 'forbidden');
  }
  if (!draft.name?.trim()) throw new HiringError('a submission needs a name', 'invalid');
  if (!draft.email?.trim()) throw new HiringError('a submission needs an email address', 'invalid');

  return withTenant(caller, async (db) => {
    const req = await db.query(
      'SELECT status, openings, filled FROM requisition WHERE id = $1', [draft.reqId]);
    if (!req.rows[0]) throw new HiringError('no such requisition', 'not_found');
    if (['closed', 'cancelled'].includes(req.rows[0].status)) {
      throw new HiringError('that role is closed', 'closed');
    }

    let id: string;
    try {
      const ins = await db.query(
        `INSERT INTO candidate
           (requisition_id, full_name, email, phone, source, location, current_employer,
            experience, current_ctc, expected_ctc, notice_period, skills, stage,
            currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'applied',
                 (SELECT base_currency FROM tenant WHERE id = current_tenant_id()))
         RETURNING id`,
        [draft.reqId, draft.name.trim(), draft.email.trim(), draft.phone ?? '',
          draft.source ?? '', draft.loc ?? '', draft.current ?? '', draft.exp ?? '',
          draft.ctcCur ?? null, draft.ctcExp ?? null, draft.notice ?? '', draft.skills ?? []]);
      id = ins.rows[0].id;
    } catch (e) {
      // The unique index is the authority on a duplicate submission; this turns
      // it into something a recruiter can act on rather than a 500.
      if ((e as { code?: string }).code === '23505') {
        throw new HiringError(
          'that candidate has already been submitted for this role', 'duplicate');
      }
      throw e;
    }

    const { rows } = await db.query(`${CAND_PROJECTION} WHERE c.id = $1`, [id]);
    return toCand(rows[0]!);
  });
}

/**
 * Move a candidate to another stage, and recount the requisition.
 *
 * The recount is the point. `filled` is derived from the pipeline every time it
 * could have changed, so it cannot drift out of step with reality — and the
 * schema's CHECK then refuses the move that would overfill the role.
 */
export async function moveCandidate(
  caller: Caller,
  candId: string,
  stage: string,
): Promise<Candidate> {
  if (!mayRecruit(caller)) {
    throw new HiringError('only a manager or admin may move a candidate', 'forbidden');
  }
  if (!STAGES.includes(stage)) {
    throw new HiringError(`that is not a pipeline stage: ${stage}`, 'invalid');
  }

  return withTenant(caller, (db) => moveCandidateIn(db, candId, stage));
}

/**
 * The stage move itself, inside a caller's transaction.
 *
 * Extracted so an accepted offer travels the same path as a manual move — the
 * recount and the openings cap apply either way, rather than the offer route
 * quietly skipping them.
 */
async function moveCandidateIn(
  db: TenantClient,
  candId: string,
  stage: string,
): Promise<Candidate> {
  {
    const cand = await db.query(
      'SELECT requisition_id, stage FROM candidate WHERE id = $1 FOR UPDATE', [candId]);
    if (!cand.rows[0]) throw new HiringError('that candidate is not on file', 'not_found');
    const reqId = cand.rows[0].requisition_id as string;

    await db.query('UPDATE candidate SET stage = $2 WHERE id = $1', [candId, stage]);

    const counted = await db.query(
      `SELECT (SELECT count(*) FROM candidate
                WHERE requisition_id = $1 AND stage = 'hired')::int AS hired,
              openings
         FROM requisition WHERE id = $1`, [reqId]);
    if (counted.rows[0].hired > counted.rows[0].openings) {
      throw new HiringError(
        `that would fill ${counted.rows[0].hired} of ${counted.rows[0].openings} openings`,
        'overfilled');
    }

    /*
     * Closing follows from the count, and so does re-opening.
     *
     * An earlier version only closed. That made the automatic close a one-way
     * door: a hire that fell through freed the opening but left the role shut,
     * so the seat existed and nothing could be submitted against it. If filled
     * is derived, the status derived from filled has to be derived too.
     *
     * Only 'closed' is reversed. A cancelled requisition was cancelled for a
     * reason that has nothing to do with the headcount, and re-opening it
     * would be this function overruling a decision it knows nothing about.
     */
    await db.query(
      `UPDATE requisition
          SET filled = $2,
              status = CASE
                WHEN $2 >= openings AND status IN ('draft', 'open', 'on_hold') THEN 'closed'
                WHEN $2 < openings AND status = 'closed' THEN 'open'
                ELSE status END,
              closed_on = CASE
                WHEN $2 >= openings AND status IN ('draft', 'open', 'on_hold') THEN CURRENT_DATE
                WHEN $2 < openings AND status = 'closed' THEN NULL
                ELSE closed_on END
        WHERE id = $1`, [reqId, counted.rows[0].hired]);

    const { rows } = await db.query(`${CAND_PROJECTION} WHERE c.id = $1`, [candId]);
    return toCand(rows[0]!);
  }
}

export interface NewInterview {
  candId: string;
  round: string;
  panelId: string;
  at: string;
  mode?: string;
}

const MODES = new Set(['video', 'phone', 'onsite', 'take_home']);
const VERDICTS = new Set(['strong_hire', 'hire', 'hold', 'no_hire']);

/**
 * Book a round.
 *
 * A double-booking is refused. An interviewer cannot be in two places at once,
 * and the person who finds out otherwise is a candidate sitting in an empty
 * call — so the clash is caught here rather than left for a calendar to notice.
 * The window is the scheduled hour, which is what a round occupies in practice.
 */
export async function scheduleInterview(
  caller: Caller,
  draft: NewInterview,
): Promise<Interview> {
  if (!mayRecruit(caller)) {
    throw new HiringError('only a manager or admin may schedule an interview', 'forbidden');
  }
  if (!draft.round?.trim()) throw new HiringError('name the round', 'invalid');
  const when = new Date(draft.at);
  if (Number.isNaN(when.getTime())) {
    throw new HiringError('that is not a valid date and time', 'invalid');
  }
  const mode = draft.mode ?? 'video';
  if (!MODES.has(mode)) throw new HiringError(`unknown interview mode: ${mode}`, 'invalid');

  return withTenant(caller, async (db) => {
    const cand = await db.query(
      'SELECT requisition_id, stage FROM candidate WHERE id = $1', [draft.candId]);
    if (!cand.rows[0]) throw new HiringError('that candidate is not on file', 'not_found');
    if (['hired', 'rejected'].includes(cand.rows[0].stage as string)) {
      throw new HiringError('that candidate is no longer in the pipeline', 'closed');
    }

    const panel = await db.query(
      "SELECT id FROM employee WHERE id = $1 AND status <> 'exited'", [draft.panelId]);
    if (!panel.rows[0]) throw new HiringError('no such panel member', 'invalid');

    const clash = await db.query(
      `SELECT 1 FROM interview
        WHERE panel_member_id = $1 AND status = 'scheduled'
          AND scheduled_at < $2::timestamptz + interval '1 hour'
          AND scheduled_at + interval '1 hour' > $2::timestamptz`,
      [draft.panelId, draft.at]);
    if ((clash.rowCount ?? 0) > 0) {
      throw new HiringError('that panel member is already booked then', 'clash');
    }

    const { rows } = await db.query(
      `INSERT INTO interview
         (candidate_id, requisition_id, round, panel_member_id, scheduled_at, mode)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$6)
       RETURNING id`,
      [draft.candId, cand.rows[0].requisition_id, draft.round.trim(),
        draft.panelId, draft.at, mode]);

    const back = await db.query(`${IV_PROJECTION} WHERE i.id = $1`, [rows[0].id]);
    return toInterview(back.rows[0]!);
  });
}

/**
 * Record the outcome.
 *
 * Status and verdict move together, which the schema also insists on:
 * `CHECK (verdict IS NULL OR status = 'completed')` makes a verdict on an
 * interview that never happened unrepresentable. A completed round with no
 * verdict stays representable on purpose — that is the state the dashboard
 * chases.
 */
export async function submitFeedback(
  caller: Caller,
  id: string,
  verdict: string,
  feedback: string,
): Promise<Interview> {
  if (!VERDICTS.has(verdict)) throw new HiringError(`unknown verdict: ${verdict}`, 'invalid');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT panel_member_id, status FROM interview WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new HiringError('no such interview', 'not_found');

    // The panel member writes their own feedback; an admin can record it for
    // them, because somebody has to when a contractor leaves mid-loop.
    if (rows[0].panel_member_id !== caller.employeeId && caller.role !== 'admin') {
      throw new HiringError('only the panel member may submit this feedback', 'forbidden');
    }
    if (rows[0].status === 'completed') {
      throw new HiringError('that interview already has a verdict', 'already_done');
    }

    await db.query(
      `UPDATE interview
          SET status = 'completed', verdict = $2, feedback = $3, submitted_at = now()
        WHERE id = $1`, [id, verdict, feedback ?? '']);

    const back = await db.query(`${IV_PROJECTION} WHERE i.id = $1`, [id]);
    return toInterview(back.rows[0]!);
  });
}

export interface NewOffer {
  candId: string;
  designation: string;
  ctc: number;
  grade?: string;
  doj: string;
}

/**
 * Make an offer.
 *
 * One live offer per candidate — the schema's unique index on candidate_id
 * says so, and it is right: two open offers at different salaries is a
 * negotiating position nobody chose to take.
 */
export async function makeOffer(caller: Caller, draft: NewOffer): Promise<Candidate> {
  if (!mayRecruit(caller)) {
    throw new HiringError('only a manager or admin may make an offer', 'forbidden');
  }
  const ctc = Number(draft.ctc);
  if (!Number.isFinite(ctc) || ctc <= 0) {
    throw new HiringError('an offer needs a salary above zero', 'invalid');
  }
  if (!draft.doj) throw new HiringError('an offer needs a joining date', 'invalid');
  if (!draft.designation?.trim()) throw new HiringError('an offer needs a designation', 'invalid');

  return withTenant(caller, async (db) => {
    const cand = await db.query('SELECT stage FROM candidate WHERE id = $1', [draft.candId]);
    if (!cand.rows[0]) throw new HiringError('that candidate is not on file', 'not_found');
    if (cand.rows[0].stage === 'rejected') {
      throw new HiringError('that candidate was rejected', 'closed');
    }

    const grade = draft.grade
      ? (await db.query('SELECT id FROM grade_band WHERE code = $1', [draft.grade])).rows[0]?.id
      : null;

    try {
      await db.query(
        `INSERT INTO offer
           (candidate_id, grade_id, designation, annual_ctc, currency, joining_on,
            status, sent_on, approved_by)
         SELECT $1, $2, $3, $4, t.base_currency, $5::date, 'sent', CURRENT_DATE, $6
           FROM tenant t WHERE t.id = current_tenant_id()`,
        [draft.candId, grade ?? null, draft.designation.trim(), ctc, draft.doj,
          caller.employeeId]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new HiringError('that candidate already has a live offer', 'duplicate');
      }
      throw e;
    }

    await db.query("UPDATE candidate SET stage = 'offer' WHERE id = $1", [draft.candId]);

    const { rows } = await db.query(`${CAND_PROJECTION} WHERE c.id = $1`, [draft.candId]);
    return toCand(rows[0]!);
  });
}

/**
 * Record the candidate's answer.
 *
 * Accepting moves them to hired, which recounts the requisition through the
 * same path a manual stage move takes — so the openings cap applies to an
 * accepted offer exactly as it does to anything else.
 */
export async function respondToOffer(
  caller: Caller,
  candId: string,
  response: string,
): Promise<Candidate> {
  if (!mayRecruit(caller)) {
    throw new HiringError('only a manager or admin may record a response', 'forbidden');
  }
  if (!['accepted', 'declined', 'negotiating'].includes(response)) {
    throw new HiringError(`unknown response: ${response}`, 'invalid');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT id, status FROM offer WHERE candidate_id = $1 FOR UPDATE', [candId]);
    if (!rows[0]) throw new HiringError('that candidate has no offer', 'not_found');
    if (rows[0].status === 'accepted') {
      throw new HiringError('that offer is already accepted', 'already_accepted');
    }

    await db.query(
      'UPDATE offer SET status = $2, responded_on = CURRENT_DATE WHERE id = $1',
      [rows[0].id, response]);

    if (response === 'accepted') return moveCandidateIn(db, candId, 'hired');
    if (response === 'declined') return moveCandidateIn(db, candId, 'rejected');

    const back = await db.query(`${CAND_PROJECTION} WHERE c.id = $1`, [candId]);
    return toCand(back.rows[0]!);
  });
}

/**
 * Per-recruiter activity — the tracker.
 *
 * One pass over the pipeline rather than a query per recruiter, because the
 * screen shows every recruiter at once and N+1 is how a tracker becomes the
 * slowest page in the product.
 */
export async function recruiterTracker(caller: Caller): Promise<RecruiterStat[]> {
  if (!mayRecruit(caller)) {
    throw new HiringError('only a manager or admin may see the tracker', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT e.id AS recruiter_id, e.full_name,
              count(DISTINCT r.id) FILTER (WHERE r.status = 'open')::int AS open_reqs,
              COALESCE(sum(r.openings) FILTER (WHERE r.status = 'open'), 0)::int AS openings,
              count(DISTINCT c.id)::int AS submissions,
              count(DISTINCT c.id) FILTER (
                WHERE c.stage NOT IN ('hired', 'rejected'))::int AS in_pipeline,
              count(DISTINCT iv.id)::int AS interviews,
              count(DISTINCT c.id) FILTER (WHERE c.stage = 'offer')::int AS offers,
              count(DISTINCT c.id) FILTER (WHERE c.stage = 'hired')::int AS hires
         FROM employee e
         JOIN requisition r ON r.recruiter_id = e.id
         LEFT JOIN candidate c ON c.requisition_id = r.id
         LEFT JOIN interview iv ON iv.candidate_id = c.id
        GROUP BY e.id, e.full_name
        ORDER BY hires DESC, submissions DESC, e.full_name`);

    return rows.map((r) => ({
      recruiterId: r.recruiter_id as string,
      name: r.full_name as string,
      openReqs: Number(r.open_reqs),
      openings: Number(r.openings),
      submissions: Number(r.submissions),
      inPipeline: Number(r.in_pipeline),
      interviews: Number(r.interviews),
      offers: Number(r.offers),
      hires: Number(r.hires),
    }));
  });
}
