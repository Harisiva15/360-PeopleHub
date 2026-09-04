/**
 * TLS settings for a Postgres connection.
 *
 * Supabase requires TLS and refuses a plaintext connection, so this is not
 * optional. What *is* a choice is whether the server's certificate is
 * verified:
 *
 *   PGSSLROOTCERT=/path/to/prod-ca.crt   verify against Supabase's CA
 *   (unset)                              encrypt, but do not verify
 *
 * Unverified means the traffic is encrypted but an attacker who can redirect
 * the connection could present their own certificate. That is acceptable for
 * a migration run from a laptop and is not acceptable for a deployed API.
 * Download the CA from Project Settings -> Database -> SSL Configuration and
 * set PGSSLROOTCERT before this serves anyone.
 */

import { readFileSync } from 'node:fs';

export function sslConfig() {
  // PGSSLMODE=disable is for a database on the same host as the client — a CI
  // service container, or a local docker compose. There is no network for
  // anyone to sit in the middle of, and a stock postgres image does not offer
  // TLS at all, so insisting on it just fails to connect.
  if (process.env.PGSSLMODE === 'disable') return false;

  const caPath = process.env.PGSSLROOTCERT;
  if (caPath) {
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

/** True when the certificate is actually being verified. */
export const sslVerified = () => Boolean(process.env.PGSSLROOTCERT);
