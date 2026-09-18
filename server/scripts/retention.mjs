/**
 * Apply the retention policies.
 *
 *   node scripts/retention.mjs           # report what would go, change nothing
 *   node scripts/retention.mjs --apply   # actually do it
 *
 * The register in `retention_policy` has been a list of intentions: rows saying
 * how long each kind of record is kept, with nothing reading them. This is the
 * thing that reads them.
 *
 * **Dry run by default.** A job whose first act is to delete is a job nobody
 * runs on a Friday. Print first, then pass --apply.
 *
 * **Anonymise is not delete.** `attendance_location` has a disposition of
 * anonymise: the punch is a payroll record and has to survive, so what expires
 * is the position on it — coordinates, distance and the fence verdict — leaving
 * the time, the work mode and the hours intact. Deleting the row instead would
 * quietly remove somebody's evidence that they worked that day.
 *
 * Run it from cron, or whatever the host offers, once a day. It is idempotent:
 * a second run finds nothing left to clear.
 */

import pg from 'pg';
import { loadEnv } from './env.mjs';
import { sslConfig } from './ssl.mjs';

loadEnv();

const apply = process.argv.includes('--apply');
const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Neither MIGRATE_DATABASE_URL nor DATABASE_URL is set');
  process.exit(1);
}

/**
 * What each policy actually does, by `record_kind`.
 *
 * Kinds with no handler here are reported and skipped rather than guessed at:
 * a register entry saying "candidate, 12 months, purge" is a decision somebody
 * made, and inventing the statement that carries it out is how the wrong rows
 * get deleted. Each handler takes a cutoff and returns { count, run }.
 */
const HANDLERS = {
  /* The punch survives; the position on it does not. */
  attendance_location: {
    what: 'coordinates on punches',
    count: `SELECT count(*)::int AS n FROM attendance
             WHERE work_date < $1 AND (latitude IS NOT NULL OR geo_ok IS NOT NULL)`,
    run: `UPDATE attendance
             SET latitude = NULL, longitude = NULL, distance_m = NULL, geo_ok = NULL
           WHERE work_date < $1 AND (latitude IS NOT NULL OR geo_ok IS NOT NULL)`,
  },
};

const db = new pg.Client({ connectionString: url, ssl: sslConfig() });
await db.connect();

let total = 0;
let skipped = 0;

const tenants = (await db.query('SELECT id, slug FROM tenant ORDER BY slug')).rows;

for (const t of tenants) {
  await db.query('SELECT set_config($1, $2, false)', ['app.tenant_id', t.id]);

  const policies = (await db.query(
    `SELECT id, record_kind, retain_months, disposition, last_run_at
       FROM retention_policy
      WHERE disposition <> 'retain_indefinitely'
      ORDER BY record_kind`)).rows;

  if (!policies.length) {
    console.log(`${t.slug}: no retention policies`);
    continue;
  }

  for (const p of policies) {
    const handler = HANDLERS[p.record_kind];
    if (!handler) {
      skipped += 1;
      console.log(`${t.slug}: ${p.record_kind.padEnd(22)} no handler — skipped, nothing touched`);
      continue;
    }

    /*
     * The cutoff is derived in the database, so it uses the database's clock.
     * Returned as text: this script talks to a raw client rather than the app's
     * pool, so it does not get the date parser that keeps 'YYYY-MM-DD' a
     * string — without the cast it comes back a JS Date and prints in the
     * machine's timezone, which for a retention boundary is a day of slack
     * nobody asked for.
     */
    const { rows: [{ cutoff }] } = await db.query(
      `SELECT to_char(CURRENT_DATE - ($1 || ' months')::interval, 'YYYY-MM-DD') AS cutoff`,
      [p.retain_months]);

    const { rows: [{ n }] } = await db.query(handler.count, [cutoff]);

    if (!n) {
      console.log(`${t.slug}: ${p.record_kind.padEnd(22)} nothing older than ${cutoff}`);
      continue;
    }

    total += n;
    if (!apply) {
      console.log(`${t.slug}: ${p.record_kind.padEnd(22)} would ${p.disposition} `
        + `${n} ${handler.what} older than ${cutoff}`);
      continue;
    }

    await db.query('BEGIN');
    try {
      await db.query(handler.run, [cutoff]);
      await db.query('UPDATE retention_policy SET last_run_at = now() WHERE id = $1', [p.id]);
      await db.query('COMMIT');
      console.log(`${t.slug}: ${p.record_kind.padEnd(22)} ${p.disposition}d `
        + `${n} ${handler.what} older than ${cutoff}`);
    } catch (e) {
      await db.query('ROLLBACK');
      console.error(`${t.slug}: ${p.record_kind} FAILED — ${e.message}`);
      process.exitCode = 1;
    }
  }
}

await db.end();

console.log();
if (skipped) {
  console.log(`${skipped} policy/policies have no handler in this script yet.`);
}
if (!apply && total) {
  console.log(`${total} record(s) are past retention. Re-run with --apply to act on them.`);
} else if (!total) {
  console.log('Nothing is past retention.');
}
