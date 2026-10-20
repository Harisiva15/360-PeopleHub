/**
 * Loads server/.env if it exists.
 *
 * Node can do this natively, so there is no dotenv dependency. Values already
 * in the environment win, which is what makes CI and container deployments
 * work without a file.
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = () => dirname(fileURLToPath(import.meta.url));

export function loadEnv() {
  const file = join(here(), '..', '.env');
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

/**
 * Loads server/.env.migrate, which holds the production migration credential.
 *
 * Separate from `loadEnv` on purpose, and never called by it. Every
 * database-backed suite reads MIGRATE_DATABASE_URL, so while that variable sat
 * in .env every one of those suites — all of which write — was one forgotten
 * override away from the live tenant. Keeping the credential in a file that
 * nothing loads automatically means reaching production has to be asked for by
 * name: only `migrate.mjs --production` calls this.
 *
 * Note that a value already in the environment still wins, as it does for
 * .env — so whatever host gets printed for confirmation is the one that will
 * actually be used, which is the point of printing it.
 */
export function loadMigrateEnv() {
  const file = join(here(), '..', '.env.migrate');
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}
