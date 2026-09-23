/**
 * Locations a form can offer but the server will not accept.
 *
 * Two lists name this company's offices. `src/data/org.ts` holds `SITES`, which
 * the demo draws charts from; the `site` table holds the real ones, which every
 * write is validated against. They drifted, and the drift was invisible:
 *
 *   - `SITES` offered Dallas and Toronto. The company operates neither, so
 *     choosing one produced a refusal from an API the form did not explain.
 *   - `SITES` had no Pune. The office a joiner was most likely to be posted to
 *     was the one no dropdown could name.
 *   - Two rows were renamed in the database — "Chennai HQ" became Chennai when
 *     Bangalore became head office — and the static list kept calling Chennai
 *     the HQ, which is now somewhere else.
 *
 * Nothing failed. A dropdown simply listed places that did not exist and
 * omitted one that did.
 *
 * Two assurances, then:
 *
 *   1. The two lists hold the same codes. `0045_indian_locations.sql` is read
 *      for what the migrations actually create, rather than trusting a comment.
 *   2. No form builds a location dropdown from the static table. A form chooses
 *      a value the server must accept, so it reads `useSites()`. A screen that
 *      only prints a city may keep using `siteOf`, which is why this looks for
 *      `SITES` inside JSX rather than banning the import outright.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITES } from '../src/data/org';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * 1. The codes the migrations create
 * ------------------------------------------------------------------ */

console.log('\nthe two location lists agree\n');

/*
 * Sites arrive from three places: the seed creates the original set, 0045
 * inserts Pune, and 0044 backfills kinds. Read the codes out of the SQL rather
 * than restating them here — a list written twice is a list that disagrees.
 */
const seed = read('server/scripts/seed.mjs');
const m0045 = read('server/db/migrations/0045_indian_locations.sql');

const fromSeed = new Set<string>();

/* The seed's own `const SITES = [...]` block, one row per site, code first. */
const block = seed.match(/const SITES = \[([\s\S]*?)\n\];/)?.[1] ?? '';
for (const m of block.matchAll(/^\s*\['([A-Z]+)',/gm)) fromSeed.add(m[1]!);

/* 0045's INSERT, which adds Pune to a schema the seed already populated. */
for (const m of m0045.matchAll(/SELECT s\.tenant_id, '([A-Z]+)'/g)) fromSeed.add(m[1]!);

const inCode = new Set(SITES.map((s) => s.id));

ok('the migrations name at least one site', fromSeed.size > 0,
  'nothing was parsed out of the seed — the pattern this reads has moved');

const onlyStatic = [...inCode].filter((c) => !fromSeed.has(c));
const onlyDb = [...fromSeed].filter((c) => !inCode.has(c));

ok('every static site exists in the schema', onlyStatic.length === 0,
  `SITES offers ${onlyStatic.join(', ')}, which no migration creates — a form `
  + 'listing one of these sends a code the server will refuse');
ok('every schema site is in the static list', onlyDb.length === 0,
  `the schema creates ${onlyDb.join(', ')}, which SITES omits — the demo cannot `
  + 'show an office the company actually has');

/* The mistake that started this, named so it cannot come back quietly. */
ok('Dallas is gone', !inCode.has('DAL'), 'the company does not operate a Dallas office');
ok('Toronto is gone', !inCode.has('TOR'), 'the company does not operate a Toronto office');
ok('Pune is present', inCode.has('PNQ'), 'PNQ is in the schema (0045) and must be offerable');

/* One head office, and it agrees with its own kind — the rule 0044 enforces. */
const hq = SITES.filter((s) => s.headquarters);
ok('exactly one head office', hq.length === 1,
  `${hq.length} sites are flagged as headquarters; the schema permits one`);
ok('head office says so in its kind', hq.every((s) => s.kind === 'headquarters'),
  'site_headquarters_is_consistent refuses the two columns disagreeing');
ok('no other site claims the headquarters kind',
  SITES.filter((s) => s.kind === 'headquarters').length === hq.length);

/* ------------------------------------------------------------------ *
 * 2. No form offers the static list
 * ------------------------------------------------------------------ */

console.log('\nno form builds its locations from the static table\n');

const files = execSync('git ls-files src', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.tsx$/.test(f));

/*
 * A dropdown built from SITES. `{SITES.map(...)}` inside JSX is the shape —
 * every one of these was a <select> whose <option>s came from the static list.
 * A filter over data already on screen is a different thing and is allowed; it
 * is caught here too, and the exemptions below say which ones and why.
 */
const FILTERS_ONLY = new Set([
  /* These narrow rows already fetched. They send nothing, so a stale code
     shows an empty result rather than a refusal from the server. */
  'src/modules/attendance/index.tsx',
  'src/modules/employees/index.tsx',
  'src/modules/events/index.tsx',
  'src/modules/lifecycle/index.tsx',
  'src/modules/shifts/Roster.tsx',
  'src/modules/users/index.tsx',
  /* Dashboard charts the static book side by side; it is not a form. */
  'src/modules/dashboard/index.tsx',
]);

const offenders: string[] = [];
const staleExemptions = new Set(FILTERS_ONLY);

for (const rel of files) {
  const src = read(rel);
  const uses = /\{SITES[.\s]/.test(src) || /\{SITES\.filter/.test(src);
  if (!uses) continue;
  if (FILTERS_ONLY.has(rel)) { staleExemptions.delete(rel); continue; }
  offenders.push(rel);
}

ok('no unexempted screen builds options from SITES', offenders.length === 0,
  `${offenders.join(', ')} lists locations from the static table. A form must `
  + 'use useSites() so it offers what the server will accept.');

ok('every exemption still uses SITES', staleExemptions.size === 0,
  `${[...staleExemptions].join(', ')} no longer reads SITES — drop the exemption, `
  + 'or this list quietly stops meaning anything');

/* The four forms that send a location, named so a regression is obvious. */
const LIVE_FORMS = [
  'src/modules/users/Drawers.tsx',
  'src/modules/employees/AddJoiner.tsx',
  'src/modules/hiring/Intake.tsx',
  'src/modules/onboarding/StartForm.tsx',
];
for (const rel of LIVE_FORMS) {
  const src = read(rel);
  ok(`${rel.split('/').slice(-1)[0]} reads locations from the service`,
    /useSites\(\)/.test(src) && !/\{SITES[.\s]/.test(src),
    'this form sends its location to an API that validates it');
}

console.log(failed ? `\n${failed} failed\n` : '\nboth lists agree, and every form asks the server\n');
process.exit(failed ? 1 : 0);
