/**
 * Three sites outside India are recorded as being in India.
 *
 *   node db/manual/fix-site-timezones.mjs                   # dry run, rolls back
 *   node db/manual/fix-site-timezones.mjs --commit \
 *        --confirm-host=<host>                              # applies it
 *
 * ## What is wrong
 *
 * Every one of the nine sites carries `timezone = 'Asia/Kolkata'`, including
 * DXB in the United Arab Emirates, LON in the United Kingdom and NJ in the
 * United States. The six Indian sites are right; these three are not.
 *
 * ## What it is not
 *
 * It is **not** what attendance is computed from. `attendance/service.ts`
 * renders punch times, decides lateness and bounds a shift window using
 * `shift.timezone` — the shift's zone, not the site's — and production's four
 * shifts are correct: AE Asia/Dubai, IN Asia/Kolkata, UK Europe/London, US
 * America/New_York. I reported this the other way round once and it was
 * wrong; the correction is recorded here so the next reader does not have to
 * re-derive it.
 *
 * `site.timezone` is read by exactly one thing: `listSites`, which feeds
 * Company Setup → Locations. So this is a display inconsistency on one
 * screen, and the reason to fix it anyway is that the first person hired at
 * New Jersey will be onboarded against a screen that says they work in
 * Indian time.
 *
 * ## Why a script when the screen can do it
 *
 * `updateSite` accepts a timezone, is company_admin's alone, and audits as
 * `site_updated` — three edits in the product would have been the lighter
 * path. This exists because it was asked for, and because it carries the
 * assertions three hand edits cannot: that the zone names are ones Postgres
 * recognises, that the six correct sites are left byte-identical, and that no
 * site is left disagreeing with its own country.
 *
 * ## What it asserts before committing
 *
 * Exactly three rows changed, each to the named zone; every other site
 * untouched; the row count unchanged; every new name present in
 * `pg_timezone_names`, because a text column will accept `America/New York`
 * with a space and nothing will notice until `AT TIME ZONE` is used on it.
 */

import { createRequire } from 'node:module';

const pg = createRequire(new URL('../../package.json', import.meta.url))('pg');

/** The three, and what each should be. The six Indian sites are not listed. */
const FIX = {
  DXB: { country: 'AE', timezone: 'Asia/Dubai' },
  LON: { country: 'GB', timezone: 'Europe/London' },
  NJ: { country: 'US', timezone: 'America/New_York' },
};

const COMMIT = process.argv.includes('--commit');
const claimed = process.argv.find((a) => a.startsWith('--confirm-host='))?.split('=')[1];

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('  set MIGRATE_DATABASE_URL'); process.exit(2); }
const host = /@([^/]+)\//.exec(url)?.[1] ?? '?';
const isLocal = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);

if (COMMIT && !isLocal && claimed !== host) {
  console.error('');
  console.error(`  REFUSED: --confirm-host says ${claimed ?? '(nothing)'}, the target is ${host}.`);
  console.error('');
  process.exit(1);
}

const db = new pg.Client({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
await db.connect();

const NL = String.fromCharCode(10);
let problems = 0;
const check = (label, ok, detail = '') => {
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `   ${detail}`}`);
  if (!ok) problems += 1;
};

const snapshot = async () => (await db.query(
  `SELECT code, country, timezone FROM site ORDER BY code`)).rows;

console.log('');
console.log(`  target : ${host}`);
console.log(`  mode   : ${COMMIT ? 'COMMIT' : 'dry run (rolls back)'}`);
console.log('');

const before = await snapshot();
console.log('  before:');
for (const r of before) {
  const want = FIX[r.code];
  const flag = want && r.timezone !== want.timezone ? '   <-- to change' : '';
  console.log(`    ${r.code.padEnd(8)}${String(r.country).padEnd(4)}${String(r.timezone).padEnd(20)}${flag}`);
}

/*
 * Already right is not a failure.
 *
 * The assertions below require exactly three rows to change, which is correct
 * for the one run that fixes this and wrong for every run after it. This
 * script will be run again — after a restore, or by somebody checking — and
 * "nothing to do" has to read as nothing to do rather than as three
 * assertions failing.
 */
const pending = before.filter((r) => {
  const want = FIX[r.code];
  return want !== undefined && r.country === want.country && r.timezone !== want.timezone;
});

if (pending.length === 0) {
  console.log(`${NL}  every site already carries its own country's zone — nothing to do.${NL}`);
  await db.end();
  process.exit(0);
}

if (pending.length !== Object.keys(FIX).length) {
  console.error('');
  console.error(`  REFUSED: ${pending.length} of ${Object.keys(FIX).length} sites need changing`
    + ` (${pending.map((r) => r.code).join(', ')}).`);
  console.error('  This script fixes three together or not at all: a partial state means'
    + ' somebody has');
  console.error('  already edited one, and guessing which half to finish is how two people'
    + ' disagree.');
  console.error('');
  await db.end();
  process.exit(1);
}

try {
  await db.query('BEGIN');

  /*
   * The zone names, checked against the server's own list before anything is
   * written. `timezone` is a text column: it will take a typo and keep it.
   */
  const names = Object.values(FIX).map((f) => f.timezone);
  const known = (await db.query(
    'SELECT name FROM pg_timezone_names WHERE name = ANY($1::text[])', [names])).rows
    .map((r) => r.name);

  console.log(`${NL}  assertions:`);
  check('every new zone is one Postgres recognises', known.length === names.length,
    `recognised ${JSON.stringify(known)} of ${JSON.stringify(names)}`);

  const changed = [];
  for (const [code, want] of Object.entries(FIX)) {
    const { rows } = await db.query(
      `UPDATE site SET timezone = $2
        WHERE code = $1 AND country = $3 AND timezone <> $2
        RETURNING code, country, timezone`,
      [code, want.timezone, want.country]);
    changed.push(...rows);
  }

  check('exactly three rows changed', changed.length === 3,
    `${changed.length}: ${JSON.stringify(changed)}`);

  for (const [code, want] of Object.entries(FIX)) {
    const row = changed.find((r) => r.code === code);
    check(`  ${code} is now ${want.timezone}`, row?.timezone === want.timezone,
      JSON.stringify(row ?? null));
  }

  const after = await snapshot();
  const others = (rows) => rows
    .filter((r) => !(r.code in FIX))
    .map((r) => JSON.stringify(r)).join('|');
  const untouched = before.filter((r) => !(r.code in FIX)).length;
  check(`the other ${untouched} site(s) are byte-identical`,
    others(before) === others(after));
  check('the row count is unchanged', before.length === after.length,
    `${before.length} -> ${after.length}`);

  /*
   * The invariant worth leaving behind: no site claims a country whose zone it
   * does not carry. Stated over the whole table rather than the three, so a
   * tenth site added in Singapore and left on Indian time fails this too.
   */
  const EXPECTED_BY_COUNTRY = {
    IN: 'Asia/Kolkata', AE: 'Asia/Dubai', GB: 'Europe/London', US: 'America/New_York',
  };
  const wrong = after.filter((r) => {
    const want = EXPECTED_BY_COUNTRY[r.country];
    return want !== undefined && r.timezone !== want;
  });
  check('no site disagrees with its own country', wrong.length === 0,
    JSON.stringify(wrong));

  if (problems) throw new Error(`${problems} assertion(s) failed`);

  if (COMMIT) {
    await db.query('COMMIT');
    console.log(`${NL}  COMMITTED`);
  } else {
    await db.query('ROLLBACK');
    console.log(`${NL}  rolled back — nothing was written`);
  }
} catch (e) {
  try { await db.query('ROLLBACK'); } catch { /* nothing open */ }
  console.error(`${NL}  REFUSED / ROLLED BACK: ${e.message}${NL}`);
  await db.end();
  process.exit(1);
}

/* Read back on a fresh statement, outside the transaction that wrote it. */
console.log('');
console.log('  read back:');
for (const r of await snapshot()) {
  console.log(`    ${r.code.padEnd(8)}${String(r.country).padEnd(4)}${r.timezone}`);
}
console.log('');
await db.end();
