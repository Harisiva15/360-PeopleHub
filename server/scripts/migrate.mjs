/**
 * Migration runner.
 *
 * Applies every file in db/migrations in name order, once, inside a
 * transaction, recording what it applied. Runs as the *owning* role — not
 * app_rw — because it creates policies that app_rw must not be able to drop.
 *
 *   node scripts/migrate.mjs                 # a local database, nothing else
 *   node scripts/migrate.mjs --production    # asks first, by host name
 *
 * ## Why production needs a flag
 *
 * The credential used to live in .env, where it was loaded by anything that
 * called loadEnv — including every database-backed suite, all of which write.
 * It now lives in .env.migrate, which nothing loads on its own. Without
 * --production this script sees whatever is already in the environment and
 * refuses any host that is not local; with it, the credential is loaded, the
 * host is printed, and the operator has to type that host back.
 *
 * Nothing here prints a connection string, a user or a password — only a host.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv, loadMigrateEnv } from './env.mjs';
import { hostOf, isLocal } from './local-only.mjs';
import { sslConfig, sslVerified } from './ssl.mjs';

loadEnv();

const PRODUCTION = process.argv.includes('--production');

if (PRODUCTION && !loadMigrateEnv()) {
  console.error('');
  console.error('  --production needs server/.env.migrate, and there is no such file.');
  console.error('  It holds MIGRATE_DATABASE_URL and is deliberately git-ignored.');
  console.error('');
  process.exit(1);
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
// Migrations run as the OWNING role, not app_rw: they create policies that
// app_rw must not be able to drop.
const url = process.env.MIGRATE_DATABASE_URL;
if (!url) {
  console.error('');
  console.error('  MIGRATE_DATABASE_URL is not set (see server/.env.example).');
  console.error(PRODUCTION
    ? '  Expected it in server/.env.migrate.'
    : '  For a local run, set it to the local cluster. For production, pass --production.');
  console.error('');
  process.exit(1);
}

const host = hostOf(url) ?? '(unparseable)';

/*
 * A host that cannot be parsed is refused rather than handed to pg, which
 * would quote the whole string — password included — back in its error. Both
 * URLs in this project's .env were truncated to `user:password` with no host,
 * and that is exactly how the credential would have surfaced in a log.
 */
if (hostOf(url) === null) {
  console.error('');
  console.error('  MIGRATE_DATABASE_URL has no host in it, so this would not connect.');
  console.error('  Expected postgresql://USER:PASSWORD@HOST:PORT/DATABASE.');
  console.error('');
  process.exit(1);
}

if (!PRODUCTION && !isLocal(url)) {
  console.error('');
  console.error('  REFUSED: this would migrate a database that is not local.');
  console.error('');
  console.error(`    MIGRATE_DATABASE_URL -> host ${host}`);
  console.error('');
  console.error('  Pass --production if that is genuinely what you intend.');
  console.error('');
  process.exit(1);
}

if (PRODUCTION) {
  console.log('');
  console.log('  This will apply migrations to:');
  console.log('');
  console.log(`    host ${host}`);
  console.log('');
  if (isLocal(url)) {
    console.log('  That host is local, so --production is doing nothing here: a value');
    console.log('  already in the environment takes precedence over .env.migrate.');
    console.log('');
  }
  /*
   * The confirmation may be given as an argument instead of typed.
   *
   * `--confirm-host=<host>` exists for an attended run that has no terminal —
   * an agent session, or a script somebody is watching. It is not a `--yes`:
   * the operator still has to name the exact host, so the thing the prompt was
   * really protecting (that somebody knows where this is pointed) still holds,
   * and it is recorded in shell history rather than vanishing into a prompt.
   *
   * A wrong or absent value refuses exactly as a mistyped prompt does.
   */
  const claimed = process.argv
    .find((a) => a.startsWith('--confirm-host='))?.slice('--confirm-host='.length);

  if (claimed !== undefined) {
    if (claimed !== host) {
      console.error(`  --confirm-host says ${claimed}, but the target is ${host}.`);
      console.error('  Nothing was applied.');
      console.error('');
      process.exit(1);
    }
    console.log('  confirmed by --confirm-host');
    console.log('');
  } else {
    if (!process.stdin.isTTY) {
      console.error('  Refusing to continue: there is nobody here to confirm it.');
      console.error('  Run it in a terminal, or pass --confirm-host=<host> if you are');
      console.error('  watching a session that has none.');
      console.error('');
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await new Promise((resolve) => {
      rl.question(`  Type the host to confirm (${host}): `, (a) => { rl.close(); resolve(a.trim()); });
    });
    if (typed !== host) {
      console.error('');
      console.error('  That does not match. Nothing was applied.');
      console.error('');
      process.exit(1);
    }
    console.log('');
  }
}

const client = new pg.Client({ connectionString: url, ssl: sslConfig() });
if (process.env.PGSSLMODE !== 'disable' && !sslVerified()) {
  console.log('note: TLS certificate is not verified (set PGSSLROOTCERT to verify)');
}
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migration (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`);

const applied = new Map(
  (await client.query('SELECT filename, checksum FROM schema_migration')).rows
    .map((r) => [r.filename, r.checksum]),
);

let count = 0;
for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');

  const seen = applied.get(file);
  if (seen) {
    // An edited migration that has already run is a deployment hazard: the
    // database and the repository now disagree and no later migration will
    // reconcile them.
    if (seen !== checksum) {
      console.error(`${file} has changed since it was applied. Write a new migration instead.`);
      process.exit(1);
    }
    continue;
  }

  process.stdout.write(`applying ${file} ... `);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)',
      [file, checksum],
    );
    await client.query('COMMIT');
    console.log('ok');
    count += 1;
  } catch (error) {
    await client.query('ROLLBACK');
    console.log('failed');
    console.error(error.message);
    process.exit(1);
  }
}

const gaps = await client.query('SELECT table_name, problem FROM tenancy_gaps()')
  .catch(() => ({ rows: [] }));
if (gaps.rows.length) {
  console.error('\ntenancy gaps after migrating:');
  for (const r of gaps.rows) console.error(`  ${r.table_name}: ${r.problem}`);
  await client.end();
  process.exit(1);
}

/*
 * The other half of the same question.
 *
 * tenancy_gaps() asks whether a table can tell one tenant from another.
 * public_write_exposure() asks whether anybody at all has to be a tenant to
 * write to it — which is what nobody asked for five tables, including `tenant`
 * itself, whose 130 cascading foreign keys made a public key enough to delete
 * the lot. Caught by reading catalogues rather than by any suite, because the
 * test cluster has no Supabase default privileges to reproduce it with.
 *
 * Both are tolerated as absent, for a database older than the migration that
 * introduces them.
 */
const exposure = await client
  .query('SELECT object_kind, object_name, grantee, problem FROM public_write_exposure()')
  .catch(() => ({ rows: [] }));
if (exposure.rows.length) {
  console.error('\npublic-role exposure after migrating:');
  for (const r of exposure.rows) {
    console.error(`  ${r.object_kind} ${r.object_name} → ${r.grantee}: ${r.problem}`);
  }
  console.error(
    '\nGrant it deliberately in a migration, or revoke it. A table reachable by '
    + 'anon is reachable by anybody holding the publishable key.');
  await client.end();
  process.exit(1);
}

console.log(count ? `\n${count} migration(s) applied` : '\nalready up to date');
await client.end();
