/**
 * The connection pool.
 *
 * Not exported for direct use anywhere else: every query goes through
 * `withTenant`, which is what sets the tenant for the transaction. A handler
 * that reached for the pool itself would run with no tenant set, and the RLS
 * policies would raise — noisily, which is the intended outcome.
 */

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { config } from '../config.ts';

const { Pool, types } = pg;

// DATE columns come back as 'YYYY-MM-DD' strings rather than JS Dates. A Date
// is a timestamp, and turning a joining date into one silently shifts it
// across a timezone boundary.
types.setTypeParser(1082, (value: string) => value);

// NUMERIC as string, not float. Money in a double is how a payroll total ends
// up a cent out and nobody can explain why.
types.setTypeParser(1700, (value: string) => value);

/*
 * The production guard comes first, so nothing below can weaken it.
 */
if (!config.sslRootCert && config.nodeEnv === 'production') {
  throw new Error(
    'PGSSLROOTCERT must be set in production: refusing to talk to the database '
    + 'over a connection whose certificate is not verified',
  );
}

/**
 * A database on the same host as the client, offering no TLS at all.
 *
 * `scripts/ssl.mjs` has honoured `PGSSLMODE=disable` since the CI job was
 * written — that is how `migrate`, `seed` and `verify:isolation` talk to a
 * `postgres:17` service container, which is built without TLS support. This pool
 * did not, so it attempted TLS regardless and the server answered that it does
 * not support SSL connections.
 *
 * That is why the behavioural suites could run only against Supabase. They
 * connect through the services, the services connect through this pool, and the
 * pool could not reach a container. The suites' own admin connection was already
 * fine; this is the other half.
 *
 * **Never honoured in production.** The guard above has already thrown by this
 * point if the CA is missing there, and this flag additionally requires a
 * non-production environment — so setting `PGSSLMODE=disable` on a deployed API
 * cannot turn its TLS off. It is a local and CI affordance only.
 */
const plaintextLocal = process.env.PGSSLMODE === 'disable' && config.nodeEnv !== 'production';

/**
 * Supabase requires TLS. Verification needs its CA, which is downloaded from
 * Project Settings -> Database -> SSL Configuration; without it the connection
 * is encrypted but the server is not authenticated, which is fine on a laptop
 * and not fine in production — see the guard above.
 */
const ssl = plaintextLocal
  ? false
  : config.sslRootCert
    ? { ca: readFileSync(config.sslRootCert, 'utf8'), rejectUnauthorized: true }
    : { rejectUnauthorized: false };

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // A statement that runs longer than this is a bug or an attack, not a slow
  // report. Reports go through the job queue.
  statement_timeout: 15_000,
});

pool.on('error', (err: Error) => {
  console.error('[db] idle client error', err);
});

export const closePool = (): Promise<void> => pool.end();
