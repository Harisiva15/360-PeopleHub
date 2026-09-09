/**
 * Works out a Supabase project's connection strings and writes them to .env.
 *
 * Supabase shows the session pooler string in the dashboard, but it contains
 * the database password — so copying it means pasting a secret into whatever
 * channel you are talking through. This asks for the two non-secret parts
 * (project ref, and the password kept locally in .env) and derives the rest.
 *
 * The region is discovered rather than asked for: Supavisor answers "Tenant or
 * user not found" for a project it does not host, and gets as far as checking
 * the password for one it does. A deliberately wrong password is enough to
 * tell those apart and authenticates nothing.
 *
 * Put these two lines in server/.env, then run it:
 *
 *   SUPABASE_REF=abcdefghijklmnopqrst
 *   SUPABASE_DB_PASSWORD=the-database-password
 *
 *   node scripts/connect.mjs
 */

import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from './env.mjs';

loadEnv();

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

const ref = process.env.SUPABASE_REF;
const password = process.env.SUPABASE_DB_PASSWORD;

if (!ref || !password) {
  console.error('Set both in server/.env, then re-run:\n');
  console.error('  SUPABASE_REF=<your project ref>');
  console.error('  SUPABASE_DB_PASSWORD=<database password>\n');
  console.error('The password stays in .env, which is gitignored. It is never printed.');
  process.exit(1);
}

/* Ordered by likelihood for this deployment; the scan stops at the first hit. */
const REGIONS = [
  'ap-south-1', 'ap-southeast-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-2',
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'sa-east-1', 'ca-central-1',
];

/** Try one pooler host. Returns 'hosted' | 'elsewhere' | 'unreachable'. */
async function probe(host, user, pass) {
  const c = new pg.Client({
    host, port: 5432, database: 'postgres', user, password: pass,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 6000,
  });
  try {
    await c.connect();
    await c.end();
    return 'hosted';
  } catch (e) {
    const m = e.message || '';
    if (/Tenant or user not found/i.test(m)) return 'elsewhere';
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/i.test(m)) return 'unreachable';
    // Anything else means the pooler recognised the tenant and got as far as
    // the password — which is what we are looking for.
    return 'hosted';
  }
}

console.log(`finding the region for ${ref} ...`);

let found = null;
outer:
for (const prefix of ['aws-0', 'aws-1']) {
  for (const region of REGIONS) {
    const host = `${prefix}-${region}.pooler.supabase.com`;
    const result = await probe(host, `postgres.${ref}`, password);
    if (result === 'hosted') {
      found = { host, region, prefix };
      break outer;
    }
  }
}

if (!found) {
  console.error('\nNo pooler region recognised that project ref.');
  console.error('Check SUPABASE_REF, or copy the session pooler string from');
  console.error('Settings -> Database -> Connection string -> Session pooler.');
  process.exit(1);
}

console.log(`  region: ${found.region}  (${found.host})`);
if (!found.region.startsWith('ap-south')) {
  console.log(`  note: data for an India-based tenant would live in ${found.region}.`);
}

/* ---- verify before writing, so .env is never left holding a broken URL ---- */
const ownerUrl = `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${found.host}:5432/postgres`;

const check = new pg.Client({ connectionString: ownerUrl, ssl: { rejectUnauthorized: false } });
try {
  await check.connect();
  const { rows } = await check.query(
    `SELECT current_user AS u,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r') AS tables,
            (SELECT count(*)::int FROM pg_namespace WHERE nspname = 'auth') AS has_auth`);
  const r = rows[0];
  console.log(`  connected as ${r.u} — ${r.tables} public tables, `
    + `auth schema ${r.has_auth ? 'present' : 'MISSING'}`);
  await check.end();
} catch (e) {
  console.error(`\nThe region matched but the connection failed: ${e.message}`);
  console.error('Most likely the password is wrong. Reset it in Settings -> Database.');
  process.exit(1);
}

/* ---- write .env ---- */
let env = fs.readFileSync(ENV_PATH, 'utf8');
const setLine = (key, value) => {
  const line = `${key}=${value}`;
  env = new RegExp(`^${key}=.*$`, 'm').test(env)
    ? env.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${env.trimEnd()}\n${line}\n`;
};

setLine('MIGRATE_DATABASE_URL', ownerUrl);
// app_rw has no password until the migration creates it and one is assigned;
// until then the owner URL gets things moving. verify-isolation fails loudly
// if the API is still pointed at a role that can bypass RLS.
if (!/^DATABASE_URL=postgresql:\/\/app_rw:/m.test(env)) setLine('DATABASE_URL', ownerUrl);
setLine('SUPABASE_URL', `https://${ref}.supabase.co`);
setLine('SUPABASE_JWKS_URL', `https://${ref}.supabase.co/auth/v1/.well-known/jwks.json`);
fs.writeFileSync(ENV_PATH, env);

console.log('\n.env updated. Next:');
console.log('  npm run migrate');
console.log('  npm run seed -- --admin <your email>');
