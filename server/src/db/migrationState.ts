/**
 * Whether this build is newer than the database it is talking to.
 *
 * ## Why this exists
 *
 * Commit de4b462 shipped migrations 0051 to 0054 and was deployed. The
 * migrations were not applied. Render served that build for nineteen days with
 * `work_schedule`, `work_schedule_day`, `employee_schedule` and `business_unit`
 * absent, so every departments, business-unit, company-name and work-schedule
 * path failed against a database that had never heard of them — and the only
 * symptom anywhere was a 500 on a screen somebody happened to open.
 *
 * Nothing in the system knew. `tenancy_gaps()` answers a different question
 * (does every table still enforce its tenant), and answered it correctly the
 * whole time. The deploy succeeded because the deploy only builds and starts a
 * process; the schema is not its business.
 *
 * ## What it does, and deliberately does not do
 *
 * It compares the migration files in this build against the `schema_migration`
 * ledger once, at startup, and says so loudly in the log. It does **not**
 * refuse to boot.
 *
 * That is a deliberate choice and the opposite of `verifyTenancy`'s. A tenancy
 * gap means this process might serve one tenant's rows to another, so not
 * serving is strictly better than serving. Being ahead of the schema is not
 * like that: most of the product still works, and refusing to start would turn
 * a partial outage into a total one — including taking down the very deployment
 * somebody needs in order to run the migrations. The honest response is to be
 * extremely visible, not to fall over.
 *
 * ## Measured at startup, then kept fresh in the background
 *
 * It was measured once, at startup, and never again. The reasoning was that
 * `/health` is polled and a health endpoint that queries the database on every
 * request is a denial-of-service lever pointed at your own database — which is
 * true, and is still the constraint this respects.
 *
 * What the reasoning missed is that applying a migration is the moment the
 * answer changes, and nothing about applying one restarts the server. 0060 was
 * applied to production on 22 October at 20:41; `/health` went on reporting
 * `applied: 59, pending: 1, behind: true` with a `checkedAt` of 20:32, and
 * only told the truth again when an unrelated deploy happened to restart the
 * process. A signal that cannot clear itself is a signal nobody trusts, and
 * `behind` is the one you most want to believe.
 *
 * So the snapshot is served from memory and refreshed in the background when
 * it goes stale: a request gets the cached answer immediately and never waits
 * for a query, and at most one query runs per `MIGRATION_STATE_TTL_MS`
 * (default one minute) however hard the endpoint is polled. The poll rate and
 * the query rate are decoupled, which is what the denial-of-service objection
 * was actually about.
 *
 * `checkedAt` still says how old the answer is, and is now never more than the
 * TTL plus one request old.
 *
 * ## Why the counts and not the names
 *
 * `/health` is unauthenticated — it is answered before the rate limiter and
 * before any token is looked at, because Render has to be able to reach it. So
 * the endpoint carries numbers and a boolean. The filenames go to the log,
 * which is private.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './pool.ts';

/** `server/db/migrations`, relative to this file rather than to the cwd. */
const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

/** What `/health` says. Counts only; see the module comment. */
export interface MigrationSummary {
  /** Migration files in this build. */
  expected: number;
  /** Rows in `schema_migration`, or null when the ledger could not be read. */
  applied: number | null;
  /** Files this build carries that the database has not applied. */
  pending: number;
  /**
   * Files whose content no longer matches the checksum recorded when they ran.
   * Never expected: it means the database and this build disagree about what
   * was already done, and no later migration reconciles that.
   */
  drifted: number;
  /** Applied migrations this build does not contain — the database is newer. */
  unknown: number;
  /**
   * Whether the ledger was readable at all. False on a database older than
   * 0055, which is the migration that grants app_rw the SELECT — so an older
   * database reports `false` rather than pretending everything is fine.
   */
  readable: boolean;
  /** True when anything above needs a human. */
  behind: boolean;
  /** When this was measured. ISO 8601. */
  checkedAt: string;
}

/** The same thing with the names, for the log. */
interface MigrationDetail extends MigrationSummary {
  pendingNames: string[];
  driftedNames: string[];
  unknownNames: string[];
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/**
 * Measure it.
 *
 * Reads the directory and one query. Every failure path returns a summary
 * saying the ledger was unreadable rather than throwing, because a startup
 * diagnostic that can take the process down is worse than no diagnostic.
 */
export async function readMigrationState(): Promise<MigrationDetail> {
  const checkedAt = new Date().toISOString();

  let files: string[] = [];
  try {
    files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    /* No migrations directory in the image is itself worth reporting. */
    return {
      expected: 0, applied: null, pending: 0, drifted: 0, unknown: 0,
      readable: false, behind: true, checkedAt,
      pendingNames: [], driftedNames: [], unknownNames: [],
    };
  }

  let recorded: Map<string, string>;
  try {
    const { rows } = await pool.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migration');
    recorded = new Map(rows.map((r) => [r.filename, r.checksum]));
  } catch {
    /*
     * Either the table does not exist or this role may not read it. Both mean
     * the same thing here: the question cannot be answered, which is not the
     * same as the answer being yes.
     */
    return {
      expected: files.length, applied: null, pending: 0, drifted: 0, unknown: 0,
      readable: false, behind: true, checkedAt,
      pendingNames: [], driftedNames: [], unknownNames: [],
    };
  }

  const pendingNames: string[] = [];
  const driftedNames: string[] = [];
  for (const f of files) {
    const seen = recorded.get(f);
    if (seen === undefined) { pendingNames.push(f); continue; }
    let mine: string;
    try {
      mine = sha256(readFileSync(join(MIGRATIONS, f), 'utf8'));
    } catch {
      /* Listed a moment ago and unreadable now: report it, do not throw. */
      driftedNames.push(f);
      continue;
    }
    if (mine !== seen) driftedNames.push(f);
  }
  const unknownNames = [...recorded.keys()].filter((f) => !files.includes(f)).sort();

  return {
    expected: files.length,
    applied: recorded.size,
    pending: pendingNames.length,
    drifted: driftedNames.length,
    unknown: unknownNames.length,
    readable: true,
    behind: pendingNames.length > 0 || driftedNames.length > 0 || unknownNames.length > 0,
    checkedAt,
    pendingNames,
    driftedNames,
    unknownNames,
  };
}

/*
 * The snapshot `/health` reports.
 *
 * Starts as "not measured yet", so a request arriving before the check
 * finishes gets an honest answer rather than an optimistic one. `/health`
 * answers before auth and before the rate limiter, so it can genuinely be hit
 * in that window.
 */
let snapshot: MigrationSummary = {
  expected: 0, applied: null, pending: 0, drifted: 0, unknown: 0,
  readable: false, behind: true, checkedAt: new Date(0).toISOString(),
};

/**
 * How long a snapshot is served before a refresh is started behind it.
 *
 * Read per call rather than captured at import, so a suite can shorten it
 * without reloading the module. A missing, malformed or non-positive value
 * falls back to the default rather than disabling the refresh — a typo in an
 * environment variable must not quietly restore the old behaviour.
 */
const DEFAULT_TTL_MS = 60_000;
const ttlMs = (): number => {
  const raw = Number(process.env.MIGRATION_STATE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
};

/**
 * The TTL in force, resolved. Exported so the suite can assert that a
 * malformed value falls back rather than disabling the refresh — which it
 * cannot tell apart from a long TTL by observing behaviour alone, since both
 * leave a fresh snapshot alone.
 */
export const migrationStateTtlMs = (): number => ttlMs();

/** The refresh currently running, if any. One at a time, by construction. */
let inFlight: Promise<void> | null = null;

/** Completed refreshes. Exported for the suite, which counts them. */
let refreshes = 0;

/**
 * Measure again and replace the snapshot. Never throws, never awaited by a
 * request.
 *
 * The result is published whatever it says, including `readable: false`. A
 * transient failure therefore shows as unreadable until the next refresh,
 * which is the honest reading: the question could not be answered just now.
 * Keeping the previous answer would be inventing continuity.
 */
function refreshSnapshot(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const state = await readMigrationState();
      const { pendingNames, driftedNames, unknownNames, ...summary } = state;
      const was = snapshot.behind;
      snapshot = summary;
      refreshes += 1;
      /*
       * Logged only when the verdict changes. A line a minute saying the same
       * thing is how a log stops being read, and this one has to be read.
       */
      if (was !== summary.behind) {
        console.log(summary.behind
          ? `[server] schema state changed: now behind (pending ${summary.pending}, `
            + `drifted ${summary.drifted}, unknown ${summary.unknown})`
          : `[server] schema state changed: now up to date `
            + `(${summary.applied} migrations applied)`);
      }
    } catch (e) {
      /* readMigrationState does not throw; this is belt and braces. */
      console.error('[server] migration state refresh failed: '
        + (e instanceof Error ? e.message : String(e)));
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The refresh in progress, or null. For the suite, which awaits it. */
export const migrationRefreshInFlight = (): Promise<void> | null => inFlight;

/** How many refreshes have completed. For the suite, which counts them. */
export const migrationRefreshes = (): number => refreshes;

/**
 * What `/health` includes. Never the filenames.
 *
 * Returns the snapshot as it stands, always synchronously. When that snapshot
 * has gone stale a refresh is started behind the answer, so the *next* caller
 * sees the new state — nobody waits on a query, and the request path cannot
 * be made slow or made to fail by the database.
 */
export const migrationSummary = (): MigrationSummary => {
  const age = Date.now() - Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(age) || age >= ttlMs()) void refreshSnapshot();
  return snapshot;
};

/**
 * Measure, store, and say so in the log.
 *
 * Called once from the entry point. Never throws and never exits: the whole
 * point is that a build ahead of its schema still serves what it can.
 */
export async function reportMigrationState(): Promise<void> {
  const state = await readMigrationState();
  const { pendingNames, driftedNames, unknownNames, ...summary } = state;
  snapshot = summary;

  if (!state.readable) {
    console.error(
      '[server] MIGRATION STATE UNKNOWN — could not read schema_migration. '
      + 'On a database older than 0055 this is expected: that migration grants '
      + 'app_rw the SELECT. Otherwise the ledger or the grant is missing.');
    return;
  }

  if (!state.behind) {
    console.log(
      `[server] schema up to date (${state.applied} migrations applied, `
      + 'checksums match)');
    return;
  }

  /*
   * Loud, repeated, and specific. This is the message whose absence cost
   * nineteen days, so it names the files and says what to run.
   */
  console.error('[server] ======================================================');
  console.error('[server] THIS BUILD IS NEWER THAN THIS DATABASE.');
  console.error(`[server]   ${state.expected} migration(s) in this build, `
    + `${state.applied} applied.`);
  if (pendingNames.length) {
    console.error(`[server]   ${pendingNames.length} NOT APPLIED:`);
    for (const f of pendingNames) console.error(`[server]     ${f}`);
    console.error('[server]   Every code path depending on these will fail '
      + 'against this database.');
    console.error('[server]   Fix: MIGRATE_DATABASE_URL=... node scripts/migrate.mjs');
  }
  if (driftedNames.length) {
    console.error(`[server]   ${driftedNames.length} CHANGED SINCE THEY WERE APPLIED:`);
    for (const f of driftedNames) console.error(`[server]     ${f}`);
    console.error('[server]   The database and this build disagree about what '
      + 'has already run. No later migration reconciles that.');
  }
  if (unknownNames.length) {
    console.error(`[server]   ${unknownNames.length} APPLIED BUT NOT IN THIS BUILD:`);
    for (const f of unknownNames) console.error(`[server]     ${f}`);
    console.error('[server]   The database is ahead of this build — most likely '
      + 'a rollback of code without a rollback of schema.');
  }
  console.error('[server] Serving anyway: a partial outage is better than '
    + 'refusing to start the deployment you need in order to fix it.');
  console.error('[server] ======================================================');
}
