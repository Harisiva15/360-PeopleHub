/**
 * Surveys and eNPS.
 *
 * **The anonymity floor is enforced here, not described.** `survey` carries
 * `min_responses_to_show` for a reason: on a team of four, publishing the
 * breakdown identifies everybody by inspection. A survey below its floor
 * returns no score at all rather than a score somebody could work backwards
 * from, and that is a refusal in the query rather than a note on the screen.
 *
 * **eNPS is computed, never stored.** Promoters (9-10) minus detractors (0-6)
 * as a percentage of respondents, passives ignored. Storing it would let the
 * headline and the responses disagree after a late submission.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class EngagementError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'EngagementError';
    this.code = code;
  }
}

export interface SurveyQuestion {
  q: string;
  /** Mean response on the question's own scale. */
  score: number;
}

export interface Survey {
  id: string;
  name: string;
  type: string;
  status: 'Draft' | 'Live' | 'Closed';
  sentOn: string;
  closesOn: string;
  sent: number;
  responded: number;
  anonymous: boolean;
  /** Responses needed before any result is shown. */
  floor: number;
  /*
   * Whether *this* caller has answered. Their own participation, which is
   * theirs to know — it says nothing about anybody else's, and nothing about
   * what they said.
   */
  answered: boolean;
  /** Per-question means, withheld below the floor. */
  questions?: SurveyQuestion[];
  /* An eNPS survey carries the split instead of question means. */
  promoters?: number;
  passives?: number;
  detractors?: number;
}

const TO_STATUS: Record<string, Survey['status']> = {
  draft: 'Draft', live: 'Live', closed: 'Closed',
};

/**
 * The screens name three kinds; the column allows six.
 *
 * The three the screens do not name — manager effectiveness, exit, custom —
 * are pulses as far as the rendering is concerned: a set of scale questions
 * with means. Mapping them to 'Pulse' is how they get drawn at all, rather
 * than falling through to an empty branch.
 */
const TO_TYPE: Record<string, string> = {
  enps: 'eNPS', onboarding: 'Onboarding', pulse: 'Pulse',
  manager_effectiveness: 'Pulse', exit: 'Pulse', custom: 'Pulse',
};

export async function surveys(caller: Caller): Promise<Survey[]> {
  return withTenantReadOnly(caller, async (db) => {
    /*
     * `responses` on the row is a counter the send process maintains; the live
     * count is what has actually arrived. Taking the larger of the two means a
     * counter that has drifted low cannot make a survey look unanswered.
     */
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.kind, s.status, s.sent_on, s.closes_on, s.recipients,
              GREATEST(s.responses, COALESCE(r.n, 0)) AS responses,
              s.anonymous, s.min_responses_to_show,
              EXISTS (
                SELECT 1 FROM survey_participation sp
                 WHERE sp.survey_id = s.id AND sp.employee_id = $1
              ) AS answered
         FROM survey s
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT sr.id)::int AS n
             FROM survey_response sr
             JOIN survey_question q ON q.id = sr.question_id
            WHERE q.survey_id = s.id
         ) r ON true
        ORDER BY s.sent_on DESC NULLS LAST, s.name`, [caller.employeeId]);

    const out: Survey[] = [];
    for (const x of rows) {
      const id = x.id as string;
      const responded = Number(x.responses);
      const floor = Number(x.min_responses_to_show);
      const base: Survey = {
        id,
        name: x.name as string,
        type: TO_TYPE[x.kind as string] ?? 'Pulse',
        status: TO_STATUS[x.status as string] ?? 'Draft',
        sentOn: (x.sent_on as string | null) ?? '',
        closesOn: (x.closes_on as string | null) ?? '',
        sent: Number(x.recipients),
        responded,
        anonymous: Boolean(x.anonymous),
        floor,
        answered: Boolean(x.answered),
      };

      /*
       * Below the floor, nothing is attached — no question means, no split.
       * The anonymity guarantee is that results are withheld, and withholding
       * them here rather than in the screen means every reader of this API
       * gets the same protection.
       */
      if (responded < floor) { out.push(base); continue; }

      if (base.type === 'eNPS') {
        const { rows: [split] } = await db.query(
          `SELECT count(*) FILTER (WHERE sr.score >= 9)::int AS promoters,
                  count(*) FILTER (WHERE sr.score BETWEEN 7 AND 8)::int AS passives,
                  count(*) FILTER (WHERE sr.score <= 6)::int AS detractors
             FROM survey_response sr
             JOIN survey_question q ON q.id = sr.question_id
            WHERE q.survey_id = $1 AND q.kind = 'nps' AND sr.score IS NOT NULL`, [id]);
        out.push({
          ...base,
          promoters: Number(split!.promoters),
          passives: Number(split!.passives),
          detractors: Number(split!.detractors),
        });
        continue;
      }

      const { rows: qs } = await db.query(
        `SELECT q.prompt, round(avg(sr.score)::numeric, 1) AS mean
           FROM survey_question q
           LEFT JOIN survey_response sr ON sr.question_id = q.id AND sr.score IS NOT NULL
          WHERE q.survey_id = $1 AND q.kind = 'scale'
          GROUP BY q.id, q.prompt, q.display_order
          ORDER BY q.display_order`, [id]);
      out.push({
        ...base,
        questions: qs.map((q) => ({
          q: q.prompt as string,
          score: q.mean === null ? 0 : Number(q.mean),
        })),
      });
    }
    return out;
  });
}

/**
 * The eNPS for one survey, or null when too few people have answered.
 *
 * Null rather than zero: zero is a real score — as many detractors as
 * promoters — and a screen that cannot tell "nobody answered" from "opinion is
 * evenly split" will report the first as the second.
 */
export async function enpsOf(caller: Caller, surveyId: string): Promise<number | null> {
  return withTenantReadOnly(caller, async (db) => {
    const s = await db.query(
      'SELECT id, min_responses_to_show FROM survey WHERE id = $1', [surveyId]);
    if (!s.rows[0]) throw new EngagementError('no such survey', 'not_found');

    const { rows } = await db.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE sr.score >= 9)::int AS promoters,
              count(*) FILTER (WHERE sr.score <= 6)::int AS detractors
         FROM survey_response sr
         JOIN survey_question q ON q.id = sr.question_id
        WHERE q.survey_id = $1 AND q.kind = 'nps' AND sr.score IS NOT NULL`, [surveyId]);

    const r = rows[0]!;
    const n = Number(r.n);
    if (n < Number(s.rows[0].min_responses_to_show)) return null;
    if (!n) return null;
    return Math.round(((Number(r.promoters) - Number(r.detractors)) / n) * 100);
  });
}

/**
 * eNPS by quarter, oldest first.
 *
 * Grouped by the quarter a survey was sent rather than by survey, because the
 * question the chart answers is "is this getting better", and two surveys in
 * one quarter are one data point about that quarter.
 */
export async function enpsHistory(caller: Caller): Promise<{ k: string; v: number }[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `WITH scored AS (
         SELECT s.id, s.sent_on, s.min_responses_to_show,
                count(*)::int AS n,
                count(*) FILTER (WHERE sr.score >= 9)::int AS promoters,
                count(*) FILTER (WHERE sr.score <= 6)::int AS detractors
           FROM survey s
           JOIN survey_question q ON q.survey_id = s.id AND q.kind = 'nps'
           JOIN survey_response sr ON sr.question_id = q.id AND sr.score IS NOT NULL
          WHERE s.sent_on IS NOT NULL
          GROUP BY s.id, s.sent_on, s.min_responses_to_show
       )
       SELECT to_char(sent_on, 'YYYY') || ' Q' || to_char(sent_on, 'Q') AS k,
              round(avg(((promoters - detractors)::numeric / n) * 100))::int AS v
         FROM scored
        WHERE n >= min_responses_to_show
        GROUP BY 1, date_trunc('quarter', sent_on)
        ORDER BY date_trunc('quarter', sent_on)`);
    return rows.map((r) => ({ k: r.k as string, v: Number(r.v) }));
  });
}

/* ------------------------------------------------------------------ *
 * Answering a survey
 * ------------------------------------------------------------------ */

/**
 * A question as it is asked, rather than as it is reported.
 *
 * `Survey.questions` carries *means* — the aggregate, withheld below the
 * floor — which is the wrong thing to render a form from twice over: it has no
 * question id to answer against, and a survey nobody has answered yet has no
 * entries at all. That is why the form used to be hard-coded and the Submit
 * button did nothing: there was no id to submit to.
 */
export interface SurveyFormQuestion {
  id: string;
  prompt: string;
  kind: 'scale' | 'nps' | 'text' | 'choice';
}

/** One person's answer to one question. */
export interface SurveyAnswer {
  questionId: string;
  score?: number | null;
  text?: string | null;
}

/**
 * The questions of a live survey, in display order.
 *
 * No floor applies: a floor protects *results*, and a question is not a
 * result. Withholding these would make an unanswered survey unanswerable.
 */
export async function surveyQuestions(
  caller: Caller,
  surveyId: string,
): Promise<SurveyFormQuestion[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT q.id, q.prompt, q.kind
         FROM survey_question q
        WHERE q.survey_id = $1
        ORDER BY q.display_order, q.prompt`, [surveyId]);
    return rows.map((r) => ({
      id: r.id as string,
      prompt: r.prompt as string,
      kind: r.kind as SurveyFormQuestion['kind'],
    }));
  });
}

/**
 * Record one person's answers.
 *
 * Three rules, in the order they are enforced:
 *
 *   A survey must be live. Answering a draft would move a mean nobody has
 *   published yet; answering a closed one would change a figure already
 *   reported.
 *
 *   Every question answered must belong to *this* survey. Without that check
 *   the question id is an open write into any survey in the tenant, including
 *   one the caller cannot see.
 *
 *   One submission per person. `survey_participation` carries that, and the
 *   primary key is what refuses the second — not a read-then-write, which two
 *   concurrent submissions would both pass.
 *
 * Anonymity is honoured by never writing `respondent_id` on an anonymous
 * survey. Department is written either way: it is what the driver breakdown
 * groups by, and `min_responses_to_show` is what stops that identifying
 * anybody.
 */
export async function respondToSurvey(
  caller: Caller,
  surveyId: string,
  answers: SurveyAnswer[],
): Promise<Survey> {
  if (!caller.employeeId) {
    throw new EngagementError('this login has no employee record', 'forbidden');
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new EngagementError('a response needs at least one answer', 'invalid');
  }

  await withTenant(caller, async (db) => {
    const { rows: [survey] } = await db.query(
      'SELECT id, status, anonymous FROM survey WHERE id = $1', [surveyId]);
    if (!survey) throw new EngagementError('no such survey', 'not_found');
    if (survey.status !== 'live') {
      throw new EngagementError(
        survey.status === 'closed'
          ? 'that survey has closed'
          : 'that survey has not been sent yet',
        'invalid');
    }

    /* Every id, checked against this survey in one query rather than per row. */
    const ids = answers.map((a) => a.questionId);
    const { rows: valid } = await db.query(
      'SELECT id, kind FROM survey_question WHERE survey_id = $1 AND id = ANY($2::uuid[])',
      [surveyId, ids]);
    if (valid.length !== new Set(ids).size) {
      throw new EngagementError('a question in that response is not part of this survey', 'invalid');
    }
    const kindOf = new Map(valid.map((q) => [q.id as string, q.kind as string]));

    for (const a of answers) {
      const kind = kindOf.get(a.questionId);
      const score = a.score ?? null;
      if (score !== null) {
        if (!Number.isInteger(score)) {
          throw new EngagementError('a score must be a whole number', 'invalid');
        }
        /* The two scales the schema allows, kept apart. */
        const max = kind === 'nps' ? 10 : 5;
        if (score < 0 || score > max) {
          throw new EngagementError(`a ${kind} answer must be between 0 and ${max}`, 'invalid');
        }
      }
      if (score === null && !(a.text ?? '').trim()) continue;

      await db.query(
        `INSERT INTO survey_response
           (question_id, respondent_id, department_id, score, text_answer)
         SELECT $1, $2, e.department_id, $3, $4
           FROM employee e WHERE e.id = $5`,
        [a.questionId, survey.anonymous ? null : caller.employeeId,
          score, (a.text ?? '').trim() || null, caller.employeeId]);
    }

    /*
     * Participation last, so a duplicate is refused only after the answers
     * would otherwise have been written — the insert and the refusal are in
     * one transaction, so a second submission leaves nothing behind.
     */
    const dup = await db.query(
      `INSERT INTO survey_participation (survey_id, employee_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`, [surveyId, caller.employeeId]);
    if (dup.rowCount === 0) {
      throw new EngagementError('you have already answered this survey', 'duplicate');
    }

    /* The counter the send process maintains, kept in step. */
    await db.query(
      `UPDATE survey SET responses = LEAST(responses + 1, recipients) WHERE id = $1`,
      [surveyId]);
  });

  const all = await surveys(caller);
  const mine = all.find((s) => s.id === surveyId);
  if (!mine) throw new EngagementError('no such survey', 'not_found');
  return mine;
}
