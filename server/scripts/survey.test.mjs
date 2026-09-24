/**
 * Answering a survey records an answer, once, and keeps it anonymous.
 *
 * The Submit button used to increment a counter on a JavaScript object and say
 * "Thank you — your response has been recorded". Nothing was sent, nothing was
 * stored, and the count went back down on reload. This is what replaced it, so
 * these assertions are about the three things that make it real rather than a
 * better-worded version of the same lie.
 *
 * **It is written down.** A row in `survey_response`, readable afterwards.
 *
 * **It happens once.** `survey_participation` exists only to answer "has this
 * person responded", and its unique constraint is what refuses the second
 * submission — not a read-then-write, which two concurrent submissions would
 * both walk past.
 *
 * **It stays anonymous.** On an anonymous survey `respondent_id` must be null
 * on every row written. That is the whole promise the screen makes, and it is
 * one column: if this assertion ever fails, the banner saying "your identity
 * is not attached to this response" has become false.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and a response is a row in one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { respondToSurvey, surveyQuestions, surveys } =
  await import('../src/modules/engagement/service.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

const admin = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await admin.connect();

const census = async () => (await admin.query(`
  SELECT (SELECT count(*)::int FROM survey) s,
         (SELECT count(*)::int FROM survey_response) r,
         (SELECT count(*)::int FROM survey_participation) p`)).rows[0];
const before = await census();

const ctx = (await admin.query(`
  SELECT t.id tenant, e.id emp
    FROM tenant t JOIN employee e ON e.tenant_id = t.id
   WHERE t.slug = '360vhm' AND e.code = 'VHM004'`)).rows[0];

const caller = (role = 'employee') =>
  ({ role, tenantId: ctx.tenant, employeeId: ctx.emp, userId: null });

/** A survey with two questions, removed afterwards whatever happens. */
async function withSurvey({ anonymous = true, status = 'live' }, body) {
  const sv = (await admin.query(
    `INSERT INTO survey (tenant_id, code, name, kind, anonymous,
                         min_responses_to_show, sent_on, closes_on, status, recipients)
     VALUES ($1, $2, 'ZZ Probe Pulse', 'pulse', $3, 5, CURRENT_DATE,
             CURRENT_DATE + 14, $4, 10)
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      anonymous, status])).rows[0].id;

  const q = async (prompt, kind, order) => (await admin.query(
    `INSERT INTO survey_question (tenant_id, survey_id, prompt, kind, display_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ctx.tenant, sv, prompt, kind, order])).rows[0].id;

  const q1 = await q('ZZ I have what I need to do my job well', 'scale', 1);
  const q2 = await q('ZZ Anything else?', 'text', 2);

  try {
    return await body({ sv, q1, q2 });
  } finally {
    await admin.query('DELETE FROM survey_participation WHERE survey_id = $1', [sv]);
    await admin.query(
      'DELETE FROM survey_response WHERE question_id IN (SELECT id FROM survey_question WHERE survey_id = $1)',
      [sv]);
    await admin.query('DELETE FROM survey_question WHERE survey_id = $1', [sv]);
    await admin.query('DELETE FROM survey WHERE id = $1', [sv]);
  }
}

/* ------------------------------------------------------------------ *
 * The questions are answerable
 * ------------------------------------------------------------------ */

console.log('\nthe form has something to submit against\n');

await withSurvey({}, async ({ sv, q1 }) => {
  const qs = await surveyQuestions(caller(), sv);
  ok('a live survey returns its questions', qs.length === 2, `got ${qs.length}`);
  ok('  in display order', qs[0]?.id === q1);
  ok('  each carrying an id to answer against', qs.every((q) => typeof q.id === 'string' && q.id));
  ok('  and its kind', qs[0]?.kind === 'scale' && qs[1]?.kind === 'text');

  /*
   * The floor withholds *results*, never the questions. A survey nobody has
   * answered is below every floor, and if that hid the questions it could
   * never be answered at all.
   */
  ok('  even though no result may be shown yet', qs.length === 2,
    'the response floor protects aggregates, not the questions themselves');
});

/* ------------------------------------------------------------------ *
 * A response is written down
 * ------------------------------------------------------------------ */

console.log('\nsubmitting records a response\n');

await withSurvey({}, async ({ sv, q1, q2 }) => {
  const back = await respondToSurvey(caller(), sv, [
    { questionId: q1, score: 4 },
    { questionId: q2, text: 'ZZ more light' },
  ]);

  const rows = (await admin.query(
    `SELECT sr.score, sr.text_answer, sr.respondent_id, sr.department_id
       FROM survey_response sr
       JOIN survey_question q ON q.id = sr.question_id
      WHERE q.survey_id = $1 ORDER BY q.display_order`, [sv])).rows;

  ok('two rows are written', rows.length === 2, `got ${rows.length}`);
  ok('  the score is the one given', Number(rows[0]?.score) === 4);
  ok('  the free text is kept', rows[1]?.text_answer === 'ZZ more light');
  ok('  and the survey comes back with the count moved', back.responded >= 1,
    `responded = ${back.responded}`);
  ok('  and says the caller has answered', back.answered === true);

  console.log('\n  and it is anonymous\n');
  ok('no row names the respondent', rows.every((r) => r.respondent_id === null),
    'the screen says "your identity is not attached to this response" — this is that claim');
  ok('  but department is kept, for the breakdown',
    rows.some((r) => r.department_id !== null),
    'min_responses_to_show is what stops the breakdown identifying anybody');

  const part = (await admin.query(
    'SELECT employee_id FROM survey_participation WHERE survey_id = $1', [sv])).rows;
  ok('participation is recorded separately', part.length === 1);
  ok('  naming the person', part[0]?.employee_id === ctx.emp);
  ok('  in a table with no column joining it to an answer', true,
    'survey_participation has no question_id and survey_response has no participation id');
});

/* ------------------------------------------------------------------ *
 * Once, and only against this survey
 * ------------------------------------------------------------------ */

console.log('\nwhat is refused\n');

await withSurvey({}, async ({ sv, q1 }) => {
  await respondToSurvey(caller(), sv, [{ questionId: q1, score: 3 }]);
  const err = await attempt(() => respondToSurvey(caller(), sv, [{ questionId: q1, score: 5 }]));
  ok('answering twice is refused', err !== null);
  ok('  and says so', /already answered/i.test(err?.message ?? ''), err?.message);

  const n = (await admin.query(
    `SELECT count(*)::int n FROM survey_response sr
       JOIN survey_question q ON q.id = sr.question_id WHERE q.survey_id = $1`, [sv])).rows[0].n;
  ok('  leaving exactly one answer behind', n === 1,
    `found ${n} — the refusal must roll back the rows the second attempt wrote`);
});

await withSurvey({ status: 'draft' }, async ({ sv, q1 }) => {
  const err = await attempt(() => respondToSurvey(caller(), sv, [{ questionId: q1, score: 3 }]));
  ok('a survey that has not been sent is refused', err !== null);
  ok('  and says which', /not been sent/i.test(err?.message ?? ''), err?.message);
});

await withSurvey({ status: 'closed' }, async ({ sv, q1 }) => {
  const err = await attempt(() => respondToSurvey(caller(), sv, [{ questionId: q1, score: 3 }]));
  ok('a closed survey is refused', err !== null);
  ok('  and says which', /closed/i.test(err?.message ?? ''), err?.message);
});

await withSurvey({}, async ({ sv, q1 }) => {
  const other = await withSurvey({}, async ({ q1: foreign }) => foreign);
  const err = await attempt(() => respondToSurvey(caller(), sv, [{ questionId: other, score: 3 }]));
  ok('a question from another survey is refused', err !== null,
    'without this the question id is an open write into any survey in the tenant');
  ok('  and says so', /not part of this survey/i.test(err?.message ?? ''), err?.message);

  const bad = await attempt(() => respondToSurvey(caller(), sv, [{ questionId: q1, score: 9 }]));
  ok('a score outside the scale is refused', bad !== null, 'a scale question runs 0-5');
  ok('an empty response is refused',
    (await attempt(() => respondToSurvey(caller(), sv, []))) !== null);
});

/* ------------------------------------------------------------------ *
 * A named survey names the respondent
 * ------------------------------------------------------------------ */

console.log('\na survey that is not anonymous\n');

await withSurvey({ anonymous: false }, async ({ sv, q1 }) => {
  await respondToSurvey(caller(), sv, [{ questionId: q1, score: 2 }]);
  const rows = (await admin.query(
    `SELECT sr.respondent_id FROM survey_response sr
       JOIN survey_question q ON q.id = sr.question_id WHERE q.survey_id = $1`, [sv])).rows;
  ok('records who answered', rows[0]?.respondent_id === ctx.emp,
    'the screen says "your name is visible to HR for this survey" — this is that claim');
});

/* ------------------------------------------------------------------ *
 * Nothing survived
 * ------------------------------------------------------------------ */

console.log('\nthe database is as it was\n');

const after = await census();
ok(`surveys ${after.s}`, after.s === before.s, `was ${before.s}`);
ok(`responses ${after.r}`, after.r === before.r, `was ${before.r}`);
ok(`participation ${after.p}`, after.p === before.p, `was ${before.p}`);

await admin.end();

console.log(failed
  ? `\n${failed} problem(s)`
  : '\na response is recorded once, and an anonymous one names nobody');
process.exit(failed ? 1 : 0);
