/**
 * Migration runner.
 *
 * Applies every file in db/migrations in name order, once, inside a
 * transaction, recording what it applied. Runs as the *owning* role — not
 * app_rw — because it creates policies that app_rw must not be able to drop.
 *
 *   DATABASE_URL=postgres://owner@host/db node scripts/migrate.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from './env.mjs';
import { sslConfig, sslVerified } from './ssl.mjs';

loadEnv();

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
// Migrations run as the OWNING role, not app_rw: they create policies that
// app_rw must not be able to drop.
const url = process.env.MIGRATE_DATABASE_URL;
if (!url) {
  console.error('MIGRATE_DATABASE_URL is not set (see server/.env.example)');
  process.exit(1);
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

console.log(count ? `\n${count} migration(s) applied` : '\nalready up to date');
await client.end();
