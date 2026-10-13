/** Entry point. */

import { createApp } from './http/app.ts';
import { config } from './config.ts';
import { closePool, pool } from './db/pool.ts';
import { reportMigrationState } from './db/migrationState.ts';

const server = createApp();

server.listen(config.port, () => {
  console.log(`[server] listening on :${config.port} (${config.nodeEnv})`);
});

/**
 * Confirm the deployed database still enforces what it should.
 *
 * tenancy_gaps() returns a row for every table that lost its policy or its
 * tenant_id. It should always be empty; if it is not, refuse to serve rather
 * than serve a database that might cross tenants.
 */
const verifyTenancy = async (): Promise<void> => {
  const { rows } = await pool.query('SELECT table_name, problem FROM tenancy_gaps()');
  if (rows.length) {
    console.error('[server] tenancy gaps detected, refusing to start:');
    for (const r of rows) console.error(`  ${r.table_name}: ${r.problem}`);
    await shutdown(1);
  }
};

const shutdown = async (code = 0): Promise<never> => {
  server.close();
  await closePool();
  process.exit(code);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

void verifyTenancy();

/*
 * Whether this build is newer than this database.
 *
 * Deliberately not fatal, unlike verifyTenancy above — see the comment on
 * reportMigrationState. It logs, stores what /health reports, and returns;
 * a `.catch` guards the one thing it must never do, which is take the process
 * down while complaining that the process is serving.
 */
void reportMigrationState().catch((e: unknown) => {
  console.error('[server] migration state check failed to run:',
    e instanceof Error ? e.message : e);
});
