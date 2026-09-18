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

import { withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class EngagementError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'EngagementError';
    this.code = code;
  }
}

export interface Survey {
  id: string;
  name: string;
  kind: string;
  status: 'Draft' | 'Live' | 'Closed';
  sentOn: string | null;
  closesOn: string | null;
  recipients: number;
  responses: number;
  anonymous: boolean;
  /** Responses needed before any result is shown. */
  floor: number;
}

const TO_STATUS: Record<string, Survey['status']> = {
  draft: 'Draft', live: 'Live', closed: 'Closed',
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
              s.anonymous, s.min_responses_to_show
         FROM survey s
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT sr.id)::int AS n
             FROM survey_response sr
             JOIN survey_question q ON q.id = sr.question_id
            WHERE q.survey_id = s.id
         ) r ON true
        ORDER BY s.sent_on DESC NULLS LAST, s.name`);

    return rows.map((x) => ({
      id: x.id as string,
      name: x.name as string,
      kind: x.kind as string,
      status: TO_STATUS[x.status as string] ?? 'Draft',
      sentOn: (x.sent_on as string | null) ?? null,
      closesOn: (x.closes_on as string | null) ?? null,
      recipients: Number(x.recipients),
      responses: Number(x.responses),
      anonymous: Boolean(x.anonymous),
      floor: Number(x.min_responses_to_show),
    }));
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
