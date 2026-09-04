/**
 * The connection pool.
 *
 * Not exported for direct use anywhere else: every query goes through
 * `withTenant`, which is what sets the tenant for the transaction. A handler
 * that reached for the pool itself would run with no tenant set, and the RLS
 * policies would raise — noisily, which is the intended outcome.
 */

import pg from 'pg';
import { config } from '../config.ts';

const { Pool, types } = pg;

// DATE columns come back as 'YYYY-MM-DD' strings rather than JS Dates. A Date
// is a timestamp, and turning a joining date into one silently shifts it
// across a timezone boundary.
types.setTypeParser(1082, (value: string) => value);

// NUMERIC as string, not float. Money in a double is how a payroll total ends
// up a cent out and nobody can explain why.
types.setTypeParser(1700, (value: string) => value);

export const pool = new Pool({
  connectionString: config.databaseUrl,
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
