/**
 * A production migration run applies what it named, and nothing else.
 *
 *   node --experimental-strip-types scripts/migrate-only.test.mjs
 *
 * ## The incident this exists for
 *
 * On 27 October a window authorised to apply `0061_legal_entity_logo.sql`
 * applied `0062_project_member.sql` to production as well. The command was
 * not wrong — `npm run migrate` applies everything pending, and 0062 was
 * pending because it had been committed locally the day before. The plan
 * named one migration; the tool had no way to be told one.
 *
 * `--only=<file>` is that way, and `--production` now refuses unless every
 * pending migration is named. This file proves the refusal, because a guard
 * nothing exercises is a guard that quietly stops working — the lesson
 * `hostOf()` and the unread `LAUNCH_LETTERS` already taught here.
 *
 * ## How it is driven
 *
 * The real `scripts/migrate.mjs`, as a child process, against the local
 * database — not by importing a function. What is under test is the behaviour
 * of the command somebody types at the moment they are most able to do
 * damage: its exit code, and what it prints.
 *
 * The throwaway migrations create properly tenant-scoped tables, because the
 * migrator runs `tenancy_gaps()` after applying and exits non-zero on a table
 * with no `tenant_id` — so a trivial `CREATE TABLE t (id int)` made the run
 * fail for a reason that had nothing to do with `--only`.
 *
 * Two throwaway migrations numbered `999x` are written into
 * `db/migrations` so they sort last and cannot collide, and the local
 * database is already up to date — so the pending list is exactly these two
 * and "pending" means what it means in production.
 *
 * A first attempt built a fresh scratch database instead, and every one of
 * the 62 real migrations was pending in it; bringing it up to date is not
 * possible either, because the early migrations need Supabase's `auth`
 * schema. Borrowing the real ledger and adding to it is both simpler and
 * closer to the thing being tested.
 *
 * Teardown removes the files, their ledger rows and the tables they made,
 * and the last assertion checks the directory came back as it was.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
  if (!cond) failed += 1;
};

const { assertLocalDatabase } = await import('./local-only.mjs');
if (!process.env.MIGRATE_DATABASE_URL) {
  console.log('SKIPPED: set MIGRATE_DATABASE_URL to a local database.');
  process.exit(0);
}
assertLocalDatabase();

const { default: pg } = await import('pg');

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', 'db', 'migrations');
const url = process.env.MIGRATE_DATABASE_URL;
const host = /@([^:/]+)/.exec(url)[1];

const A = '9990_zz_only_a.sql';
const B = '9991_zz_only_b.sql';
const C = '9992_zz_only_c.sql';
const ALL = [A, B, C];

const db = new pg.Client({ connectionString: url, ssl: false });
await db.connect();

/*
 * The local database has to be up to date for the pending list to be ours
 * alone. If it is not, say so and stop rather than assert against a list
 * that happens to contain somebody's half-finished migration.
 */
const onDisk = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && !f.startsWith('999'));
const already = (await db.query(
  'SELECT filename FROM schema_migration')).rows.map((r) => r.filename);
const behind = onDisk.filter((f) => !already.includes(f));
if (behind.length) {
  console.log(`SKIPPED: the local database is behind by ${behind.length} migration(s) `
    + `(${behind[0]} …). Run npm run migrate first.`);
  await db.end();
  process.exit(0);
}

/**
 * A throwaway migration, and a properly tenant-scoped one.
 *
 * `CREATE TABLE t (id int)` was the first attempt, and the migrator applied
 * it and then exited 1: it runs `tenancy_gaps()` afterwards, which reports a
 * table with no `tenant_id`. That is the guard working, and it made this file
 * fail for a reason that had nothing to do with `--only`. A test fixture has
 * to satisfy the rules the real thing satisfies.
 */
const throwaway = (table) => `CREATE TABLE ${table} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT current_tenant_id()
    REFERENCES tenant (id) ON DELETE CASCADE
);
SELECT apply_tenant_isolation('${table}');
`;

const run = (...args) => spawnSync(
  process.execPath, [join(here, 'migrate.mjs'), ...args],
  { encoding: 'utf8', env: { ...process.env, PGSSLMODE: 'disable' } },
);

const tables = async () => (await db.query(
  "SELECT tablename FROM pg_tables WHERE tablename LIKE 'zz_only_%' ORDER BY 1"))
  .rows.map((r) => r.tablename);

const ledger = async () => (await db.query(
  "SELECT filename FROM schema_migration WHERE filename LIKE '999%' ORDER BY 1"))
  .rows.map((r) => r.filename);

console.log('');
let fatal = null;
try {
  writeFileSync(join(MIGRATIONS, A), throwaway('zz_only_a'), 'utf8');
  writeFileSync(join(MIGRATIONS, B), throwaway('zz_only_b'), 'utf8');

  /* ------------------------------------------------------------------ *
   * A production run that names nothing
   * ------------------------------------------------------------------ */

  console.log('a production run that names nothing applies nothing\n');

  const bare = run('--production', `--confirm-host=${host}`);
  ok('1. it refuses', bare.status === 1, `exit ${bare.status}`);
  ok('2.  and says how many it would not have named',
    /REFUSED: 2 pending migration\(s\)/.test(bare.stderr),
    bare.stderr.split(NL).slice(0, 4).join(' | '));
  ok('3.  and names them, so the operator sees what they were about to do',
    bare.stderr.includes(A) && bare.stderr.includes(B));
  ok('4.  and applied nothing', (await tables()).length === 0, JSON.stringify(await tables()));

  /* ------------------------------------------------------------------ *
   * Naming one of two
   * ------------------------------------------------------------------ */

  console.log('\nnaming one of two still refuses: the other is unaccounted for\n');

  const half = run('--production', `--confirm-host=${host}`, `--only=${A}`);
  ok('5. it refuses', half.status === 1, `exit ${half.status}`);
  ok('6.  reporting one unnamed, not two',
    /REFUSED: 1 pending migration\(s\)/.test(half.stderr) && half.stderr.includes(B),
    half.stderr.split(NL).slice(0, 4).join(' | '));
  ok('7.  and applied nothing — not even the one it did name',
    (await tables()).length === 0, JSON.stringify(await tables()));

  /* ------------------------------------------------------------------ *
   * Naming both
   * ------------------------------------------------------------------ */

  console.log('\nnaming every pending migration applies exactly those\n');

  const both = run('--production', `--confirm-host=${host}`, `--only=${A}`, `--only=${B}`);
  ok('8. it applies', both.status === 0,
    `exit ${both.status}: ${both.stderr.split(NL).slice(0, 3).join(' | ')}`);
  ok('9.  and both tables exist', (await tables()).length === 2, JSON.stringify(await tables()));
  ok('10.  and both are in the ledger', (await ledger()).length === 2, JSON.stringify(await ledger()));

  /* ------------------------------------------------------------------ *
   * A name that is not pending
   * ------------------------------------------------------------------ */

  console.log('\na name that is not pending is a typo, not a no-op\n');

  writeFileSync(join(MIGRATIONS, C), throwaway('zz_only_c'), 'utf8');

  const typo = run('--production', `--confirm-host=${host}`, '--only=9992_zz_only_typo.sql');
  ok('11. a misspelt name does not read as nothing to do', typo.status === 1, `exit ${typo.status}`);
  ok('12.  and the real pending one is reported as unnamed',
    /REFUSED: 1 pending migration\(s\)/.test(typo.stderr) && typo.stderr.includes(C),
    typo.stderr.split(NL).slice(0, 4).join(' | '));

  const done = run('--production', `--confirm-host=${host}`, `--only=${C}`, `--only=${A}`);
  ok('13. naming one already applied is refused, and says which',
    done.status === 1 && /already applied/.test(done.stderr) && done.stderr.includes(A),
    done.stderr.split(NL).slice(0, 6).join(' | '));
  ok('14.  and C was not applied either, because the run refused as a whole',
    (await tables()).length === 2, JSON.stringify(await tables()));

  /* ------------------------------------------------------------------ *
   * Local runs are unchanged
   * ------------------------------------------------------------------ */

  console.log('\na local run still applies everything pending, with no ceremony\n');

  const local = run();
  ok('15. no flags against a local target applies the rest',
    local.status === 0, `exit ${local.status}: ${local.stderr.split(NL).slice(0, 3).join(' | ')}`);
  ok('16.  so all three are there', (await tables()).length === 3, JSON.stringify(await tables()));
} catch (e) {
  fatal = e;
} finally {
  await db.query("DELETE FROM schema_migration WHERE filename LIKE '999%'");
  for (const t of ['zz_only_a', 'zz_only_b', 'zz_only_c']) {
    await db.query(`DROP TABLE IF EXISTS ${t}`);
  }
  for (const f of ALL) {
    try { rmSync(join(MIGRATIONS, f)); } catch { /* already gone */ }
  }
}

const leftovers = readdirSync(MIGRATIONS).filter((f) => f.startsWith('999'));
ok('17. the throwaway migrations are gone from db/migrations',
  leftovers.length === 0, JSON.stringify(leftovers));
ok('18.  and out of the ledger', (await ledger()).length === 0, JSON.stringify(await ledger()));
ok('19.  and their tables dropped', (await tables()).length === 0, JSON.stringify(await tables()));
await db.end();

if (fatal) { console.error(`${NL}the run did not finish: ${fatal.message}${NL}`); process.exit(1); }
console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`a production run applies what it named, and nothing else${NL}`);
process.exit(0);
