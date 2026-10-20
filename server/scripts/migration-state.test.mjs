/**
 * The startup check that would have noticed de4b462.
 *
 * `src/db/migrationState.ts` compares the migrations in the build against the
 * `schema_migration` ledger and says so loudly. The thing worth ratcheting is
 * not that it reports — it is *what* it reports, because the three ways a build
 * and a database can disagree are different problems with different fixes:
 *
 *   pending   the build is ahead. Run the migrations.
 *   drifted   a file changed after it ran. No later migration reconciles that.
 *   unknown   the database is ahead. Most likely code rolled back, schema not.
 *
 * Collapsing those into one boolean would make the log say "something is
 * wrong" to somebody at eleven at night, which is the situation this whole
 * mechanism exists because of.
 *
 * Also asserted: it does not refuse to boot, and `/health` carries counts
 * without filenames. That endpoint answers before authentication and before the
 * rate limiter, so its payload is public.
 *
 * ## How the states are produced
 *
 * By editing the ledger on the throwaway cluster and putting it back in a
 * `finally`. Not by stubbing: the question is whether a real query against a
 * real `schema_migration` yields the right verdict, and a stub that returns
 * rows proves only that the arithmetic works on rows a test invented.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { loadEnv } from './env.mjs';

import { assertLocalDatabase } from './local-only.mjs';

/* This suite writes. It refuses anything but a local database. */
assertLocalDatabase();

loadEnv();

const here = dirname(fileURLToPath(import.meta.url));

/*
 * Skip rather than fail without a database, which is the convention every
 * other suite here follows and this one did not.
 *
 * `npm run check` is the developer's chain and CI's static job runs the same
 * script with no database at all, relying on each database suite to stand
 * aside. Exiting 1 instead turned the whole server workflow red on a commit
 * whose only sin was adding a suite — which is a worse failure than the one
 * the suite exists to catch, because a red CI nobody can explain gets ignored.
 *
 * The cost of a skip is that it reads exactly like a pass. `server.yml` closes
 * that by asserting the absence of this message in the job that does have a
 * database, so the exit-0 cannot hide there.
 */
const url = process.env.MIGRATE_DATABASE_URL;
if (!url || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and the ledger this reads is a table in one.\n');
  process.exit(0);
}

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const admin = new pg.Client({ connectionString: url });
await admin.connect();

const { readMigrationState, reportMigrationState, migrationSummary } =
  await import('../src/db/migrationState.ts');
const { closePool } = await import('../src/db/pool.ts');

/** The ledger, so every perturbation below can be undone exactly. */
const original = (await admin.query(
  'SELECT filename, checksum, applied_at FROM schema_migration ORDER BY filename')).rows;

const restore = async () => {
  await admin.query('DELETE FROM schema_migration');
  for (const r of original) {
    await admin.query(
      'INSERT INTO schema_migration (filename, checksum, applied_at) VALUES ($1, $2, $3)',
      [r.filename, r.checksum, r.applied_at]);
  }
};

try {

/* ------------------------------------------------------------------ *
 * Agreement
 * ------------------------------------------------------------------ */

console.log('\na build that matches its database\n');

{
  const s = await readMigrationState();
  ok('1. the ledger is readable', s.readable, JSON.stringify(s));
  ok('2. nothing is pending, drifted or unknown',
    s.pending === 0 && s.drifted === 0 && s.unknown === 0,
    `pending ${s.pending} drifted ${s.drifted} unknown ${s.unknown}`);
  ok('3. so it is not behind', s.behind === false);
  ok('4. and the counts agree', s.expected === s.applied && s.expected > 0,
    `${s.expected} files, ${s.applied} applied`);
  ok('5. checkedAt is a timestamp from this run',
    Date.now() - Date.parse(s.checkedAt) < 60_000, s.checkedAt);
}

/* ------------------------------------------------------------------ *
 * The build is ahead — the de4b462 case
 * ------------------------------------------------------------------ */

console.log('\na build carrying a migration the database has not applied\n');

{
  const last = original.at(-1).filename;
  await admin.query('DELETE FROM schema_migration WHERE filename = $1', [last]);
  const s = await readMigrationState();
  ok('6. it is pending, and counted', s.pending === 1, `${s.pending}`);
  ok('7. named, so the log can say which', s.pendingNames.includes(last),
    JSON.stringify(s.pendingNames));
  ok('8. reported as behind', s.behind === true);
  ok('9. and not confused with drift or a newer database',
    s.drifted === 0 && s.unknown === 0,
    `drifted ${s.drifted} unknown ${s.unknown}`);
  ok('10. applied is one fewer than expected',
    s.applied === s.expected - 1, `${s.applied} of ${s.expected}`);
  await restore();
}

/* ------------------------------------------------------------------ *
 * A migration edited after it ran
 * ------------------------------------------------------------------ */

console.log('\na migration whose content changed after it was applied\n');

{
  const victim = original.at(-1).filename;
  await admin.query(
    'UPDATE schema_migration SET checksum = $2 WHERE filename = $1',
    [victim, 'deadbeef'.repeat(8)]);
  const s = await readMigrationState();
  ok('11. counted as drift, not as pending', s.drifted === 1 && s.pending === 0,
    `drifted ${s.drifted} pending ${s.pending}`);
  ok('12. named', s.driftedNames.includes(victim), JSON.stringify(s.driftedNames));
  ok('13. reported as behind', s.behind === true);
  ok('14. applied still equals expected — the count alone would hide this',
    s.applied === s.expected,
    'which is exactly why the checksum is compared and not just the number of rows');
  await restore();
}

/* ------------------------------------------------------------------ *
 * The database is ahead
 * ------------------------------------------------------------------ */

console.log('\na database holding a migration this build does not have\n');

{
  await admin.query(
    'INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)',
    ['9999_from_a_future_branch.sql', 'f'.repeat(64)]);
  const s = await readMigrationState();
  ok('15. counted as unknown', s.unknown === 1, `${s.unknown}`);
  ok('16. named', s.unknownNames.includes('9999_from_a_future_branch.sql'),
    JSON.stringify(s.unknownNames));
  ok('17. reported as behind', s.behind === true);
  ok('18. and not as pending — the fix is the opposite one', s.pending === 0,
    'running migrate.mjs would not help; the code is the thing that is old');
  await restore();
}

/* ------------------------------------------------------------------ *
 * The unreadable case, which must not read as healthy
 * ------------------------------------------------------------------ */

console.log('\na ledger that cannot be read at all\n');

{
  await admin.query('ALTER TABLE schema_migration RENAME TO schema_migration_hidden');
  try {
    const s = await readMigrationState();
    ok('19. readable is false', s.readable === false);
    ok('20. and that counts as behind, not as fine', s.behind === true,
      'an unanswerable question is not a yes');
    ok('21. applied is null rather than zero', s.applied === null, String(s.applied));
    ok('22. it did not throw', true);
  } finally {
    await admin.query('ALTER TABLE schema_migration_hidden RENAME TO schema_migration');
  }
}

/* ------------------------------------------------------------------ *
 * What /health is allowed to say
 * ------------------------------------------------------------------ */

console.log('\nthe public health payload\n');

{
  await reportMigrationState();
  const s = migrationSummary();
  const keys = Object.keys(s).sort();
  ok('23. the summary carries no filenames',
    !keys.some((k) => /Names$/.test(k)),
    `/health is answered before auth and before the rate limiter: ${keys.join(', ')}`);
  ok('24. and carries the counts somebody needs',
    ['applied', 'behind', 'checkedAt', 'drifted', 'expected', 'pending', 'readable', 'unknown']
      .every((k) => keys.includes(k)),
    keys.join(', '));
  ok('25. serialises to JSON with nothing surprising in it',
    !/[a-z0-9_]+\.sql/i.test(JSON.stringify(s)), JSON.stringify(s));
  ok('26. reportMigrationState resolved rather than exiting',
    s.behind === false,
    'the process is still here, which is the point: being ahead of the schema '
    + 'must not stop the deployment somebody needs in order to fix it');
}

/* ------------------------------------------------------------------ *
 * And that the entry point treats it as non-fatal
 * ------------------------------------------------------------------ */

console.log('\nthe entry point\n');

{
  const index = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok('27. verifyTenancy still refuses to serve on a tenancy gap',
    /refusing to start/.test(index) && /shutdown\(1\)/.test(index),
    'that one is fatal and must stay fatal');
  ok('28. the migration check is not',
    /reportMigrationState\(\)/.test(index)
    && !/reportMigrationState[\s\S]{0,200}shutdown\(1\)/.test(index),
    'a build ahead of its schema serves what it can');
  ok('29. and a failure in the check cannot take the process down',
    /reportMigrationState\(\)[\s\S]{0,120}\.catch\(/.test(index),
    'the diagnostic must not become the outage');
}

} finally {
  await restore();
  await admin.end();
  await closePool();
}

console.log();
if (failed) {
  console.error(`${failed} migration-state checks failed`);
  process.exit(1);
}
console.log('a build newer than its database says so, says which, and keeps serving');
