/**
 * Will the database connection actually be verified in production?
 *
 * The server refuses to start with NODE_ENV=production and no PGSSLROOTCERT,
 * which is the right refusal and a terrible way to find out — it happens on
 * the host, at boot, after a deploy. This answers the same question from a
 * laptop, before.
 *
 * Supabase's pooler presents a self-signed chain, so the system trust store
 * cannot verify it and a CA file is genuinely required. Download it from
 * Project Settings -> Database -> SSL Configuration and point PGSSLROOTCERT at
 * it.
 *
 *   node scripts/check-tls.mjs
 *   PGSSLROOTCERT=./prod-ca-2021.crt node scripts/check-tls.mjs
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadEnv } from './env.mjs';

loadEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const host = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://')).hostname;
const certPath = process.env.PGSSLROOTCERT ?? '';

console.log(`\ndatabase host: ${host}`);

/** Connect with a given ssl option and report what happened. */
async function attempt(label, ssl) {
  const client = new pg.Client({ connectionString: url, ssl });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return { ok: true, label };
  } catch (e) {
    try { await client.end(); } catch { /* already closed */ }
    return { ok: false, label, why: e.message.split('\n')[0] };
  }
}

const unverified = await attempt('encrypted, certificate not checked', { rejectUnauthorized: false });
console.log(`  ${unverified.ok ? 'ok  ' : 'FAIL'}  ${unverified.label}`
  + (unverified.ok ? '' : ` — ${unverified.why}`));

if (!unverified.ok) {
  console.error('\nThe database is not reachable at all. Fix that before worrying about TLS.');
  process.exit(1);
}

const systemStore = await attempt('verified against the system CA store', { rejectUnauthorized: true });
console.log(`  ${systemStore.ok ? 'ok  ' : 'note'}  ${systemStore.label}`
  + (systemStore.ok ? '' : ` — ${systemStore.why}`));

if (!certPath) {
  console.log('\nPGSSLROOTCERT is not set.');
  if (systemStore.ok) {
    console.log('The system store verifies this host, so production would be safe without one.');
    console.log('Set PGSSLROOTCERT anyway if you want to pin a specific CA.');
    process.exit(0);
  }
  console.error(
    '\nProduction will refuse to start, and it is right to:\n'
    + '  the connection would be encrypted but the server not authenticated.\n\n'
    + 'To fix:\n'
    + '  1. Supabase -> Project Settings -> Database -> SSL Configuration\n'
    + '  2. Download the certificate (prod-ca-2021.crt)\n'
    + '  3. Put it somewhere the host can read, and set PGSSLROOTCERT to that path\n'
    + '  4. Re-run this script to confirm\n');
  process.exit(1);
}

/* A path was given — does it actually work? */
let ca;
try {
  ca = readFileSync(certPath, 'utf8');
} catch (e) {
  console.error(`\nPGSSLROOTCERT is set to ${certPath} but it cannot be read: ${e.message}`);
  process.exit(1);
}

if (!ca.includes('BEGIN CERTIFICATE')) {
  console.error(`\n${certPath} does not look like a PEM certificate.`);
  console.error('It should start with -----BEGIN CERTIFICATE-----');
  process.exit(1);
}

const pinned = await attempt(`verified against ${certPath}`, { ca, rejectUnauthorized: true });
console.log(`  ${pinned.ok ? 'ok  ' : 'FAIL'}  ${pinned.label}`
  + (pinned.ok ? '' : ` — ${pinned.why}`));

if (!pinned.ok) {
  console.error(
    '\nThat certificate does not verify this host. The usual causes:\n'
    + '  - it is the CA for a different Supabase project or region\n'
    + '  - it is an old certificate and the project has been rotated\n'
    + '  - the file is truncated\n');
  process.exit(1);
}

console.log('\nproduction will connect with the certificate verified');
