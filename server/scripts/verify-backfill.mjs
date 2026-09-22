/**
 * Validate the 0032 job-title backfill before anybody trusts a headcount.
 *
 * 0032 builds the catalogue from `employee.designation` and points each person
 * at their entry. That is a text match, and text written by hand over several
 * years does not match cleanly: "Senior Software Engineer", "Sr. Software
 * Engineer" and "Senior  Software Engineer" are one job and three strings.
 *
 * This reports what actually happened rather than assuming it worked. Run it
 * BEFORE the migration to see what will happen, and AFTER to see what did.
 *
 *   node scripts/verify-backfill.mjs
 *
 * It only reads. It prints no credentials and changes nothing.
 */

import pg from 'pg';
import { loadEnv } from './env.mjs';
import { sslConfig } from './ssl.mjs';

loadEnv();

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Neither MIGRATE_DATABASE_URL nor DATABASE_URL is set (see server/.env.example)');
  process.exit(1);
}

/* Host and database only — never the credential. */
function safeTarget(u) {
  try {
    const p = new URL(u);
    return `${p.hostname}${p.port ? `:${p.port}` : ''}${p.pathname}`;
  } catch { return 'an unparseable connection string'; }
}

const client = new pg.Client({ connectionString: url, ssl: sslConfig() });
await client.connect();
console.log(`\nreading ${safeTarget(url)}\n`);

const one = async (sql, params = []) => (await client.query(sql, params)).rows;

/* Has 0032 run? The report means different things either way. */
const [{ applied }] = await one(
  `SELECT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_name = 'employee' AND column_name = 'job_title_id'
   ) AS applied`);

const total = Number((await one('SELECT count(*)::text AS n FROM employee'))[0].n);
const withDesignation = Number((await one(
  `SELECT count(*)::text AS n FROM employee
    WHERE designation IS NOT NULL AND btrim(designation) <> ''`))[0].n);
const nullDesignation = total - withDesignation;

console.log(`0032 applied:            ${applied ? 'yes' : 'no (this is a forecast)'}`);
console.log(`Total employees:         ${total}`);
console.log(`With a designation:      ${withDesignation}`);
console.log(`Null or blank:           ${nullDesignation}`);

/*
 * The three ways a text match goes wrong, counted separately because they need
 * different answers: case and whitespace are safe to fold, genuine duplicates
 * are a decision somebody has to make.
 */
const caseVariants = await one(
  `SELECT lower(btrim(designation)) AS folded,
          count(DISTINCT designation)::int AS spellings,
          array_agg(DISTINCT designation) AS variants,
          count(*)::int AS people
     FROM employee
    WHERE designation IS NOT NULL AND btrim(designation) <> ''
    GROUP BY lower(btrim(designation))
   HAVING count(DISTINCT designation) > 1
    ORDER BY count(*) DESC`);

const whitespace = await one(
  `SELECT count(*)::text AS n FROM employee
    WHERE designation <> btrim(designation)
       OR designation ~ '\\s{2,}'`);

console.log(`Case/spacing variants:   ${caseVariants.length} title(s) written more than one way`);
console.log(`Untrimmed or doubled:    ${whitespace[0].n} row(s)`);

if (caseVariants.length) {
  console.log('\n  These are one job written several ways — 0032 folds on lower(name),');
  console.log('  so they will collapse to one catalogue entry. Listed so you can');
  console.log('  confirm that is what you want:\n');
  for (const v of caseVariants.slice(0, 20)) {
    console.log(`    ${v.people.toString().padStart(4)} people · ${v.variants.join(' | ')}`);
  }
  if (caseVariants.length > 20) console.log(`    … and ${caseVariants.length - 20} more`);
}

if (!applied) {
  /*
   * The forecast. The same DISTINCT ON the migration uses, so the number here
   * is the number of rows it will create.
   */
  const [{ n: willCreate }] = await one(
    `SELECT count(*)::text AS n FROM (
       SELECT DISTINCT ON (tenant_id, lower(designation)) 1
         FROM employee
        WHERE designation IS NOT NULL AND btrim(designation) <> ''
        ORDER BY tenant_id, lower(designation), joined_on
     ) q`);
  console.log(`\nForecast: ${willCreate} catalogue entries, `
    + `${withDesignation} employees mapped, ${nullDesignation} left unmapped.`);
  console.log('Re-run this after the migration to confirm.\n');
  await client.end();
  process.exit(0);
}

/* ---- after the migration: what actually landed ---- */

const [{ n: mapped }] = await one(
  'SELECT count(*)::text AS n FROM employee WHERE job_title_id IS NOT NULL');
const unmatched = await one(
  `SELECT designation, count(*)::int AS people
     FROM employee
    WHERE job_title_id IS NULL
      AND designation IS NOT NULL AND btrim(designation) <> ''
    GROUP BY designation ORDER BY count(*) DESC`);

console.log(`\nSuccessfully mapped:     ${mapped}`);
console.log(`Unmatched:               ${unmatched.reduce((n, r) => n + r.people, 0)}`);
console.log(`Ambiguous:               ${caseVariants.length}`);

if (unmatched.length) {
  console.log('\n  Designations with no catalogue entry. These are NOT silently');
  console.log('  assigned — the text is kept and job_title_id is null, so the');
  console.log('  person still has a job. Each needs a catalogue entry or a\n'
    + '  correction:\n');
  for (const r of unmatched) console.log(`    ${r.people.toString().padStart(4)} · ${r.designation}`);
}

/*
 * The integrity check that decides whether headcount-by-title is trustworthy:
 * every mapped person's title text must equal the catalogue entry they point
 * at, case-folded. A mismatch means somebody is counted under the wrong job.
 */
const drift = await one(
  `SELECT e.code, e.designation, t.name AS title
     FROM employee e JOIN job_title t ON t.id = e.job_title_id
    WHERE lower(btrim(e.designation)) <> lower(btrim(t.name))`);

console.log(`\nMapped to a different title: ${drift.length}`);
if (drift.length) {
  console.log('\n  *** These are wrong. Headcount by title is NOT trustworthy. ***\n');
  for (const d of drift.slice(0, 20)) {
    console.log(`    ${d.code}: "${d.designation}" -> "${d.title}"`);
  }
}

const [{ n: orphanTitles }] = await one(
  `SELECT count(*)::text AS n FROM job_title t
    WHERE NOT EXISTS (SELECT 1 FROM employee e WHERE e.job_title_id = t.id)`);
console.log(`Catalogue entries nobody holds: ${orphanTitles}`);

const [{ n: dupCodes }] = await one(
  `SELECT count(*)::text AS n FROM (
     SELECT code FROM job_title GROUP BY tenant_id, code HAVING count(*) > 1
   ) q`);
console.log(`Duplicate codes:               ${dupCodes}`);

await client.end();

const bad = drift.length > 0 || Number(dupCodes) > 0;
console.log(bad
  ? '\nFAILED: headcount by title cannot be trusted until the rows above are fixed.\n'
  : '\nheadcount by title reconciles with the designations it was built from\n');
process.exit(bad ? 1 : 0);
