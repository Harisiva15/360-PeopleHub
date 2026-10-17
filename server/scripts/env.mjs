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

export function loadEnv() {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}
