/**
 * Connects to the database and reports what is actually there.
 *
 * The first thing to run against a new Supabase project: it confirms the
 * credentials work, which pooler you reached, and whether the schema has been
 * applied — before any migration touches anything.
 *
 *   node scripts/inspect.mjs
 */

import pg from 'pg';
import { loadEnv } from './env.mjs';
import { sslConfig } from './ssl.mjs';

loadEnv();

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Neither MIGRATE_DATABASE_URL nor DATABASE_URL is set (see .env.example)');
  process.exit(1);
}

/* Report where we are connecting without ever printing the password. */
const safe = (() => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}@${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
})();
console.log(`connecting to ${safe}`);

const client = new pg.Client({
  connectionString: url,
  ssl: sslConfig(),
  connectionTimeoutMillis: 15_000,
});

try {
  await client.connect();
} catch (e) {
  console.error(`\nconnection failed: ${e.message}`);
  if (/ENETUNREACH|ENOTFOUND/.test(e.message)) {
    console.error('Direct db.<ref>.supabase.co is IPv6-only on newer projects.');
    console.error('Use the session pooler string (aws-0-<region>.pooler.supabase.com:5432).');
  }
  if (/password authentication failed/i.test(e.message)) {
    console.error('Check the password in server/.env — reset it in Project Settings -> Database.');
  }
  process.exit(1);
}

const one = async (sql, params = []) => (await client.query(sql, params)).rows;

const [{ version }] = await one('SELECT version()');
console.log(`\n${version.split(',')[0]}`);

const [{ db, usr }] = await one('SELECT current_database() AS db, current_user AS usr');
console.log(`database ${db}, connected as ${usr}`);

const schemas = await one(
  `SELECT nspname FROM pg_namespace
    WHERE nspname IN ('public','auth','storage','extensions') ORDER BY nspname`);
console.log(`schemas present: ${schemas.map((r) => r.nspname).join(', ') || 'none'}`);

const supabase = schemas.some((r) => r.nspname === 'auth');
console.log(`Supabase Auth: ${supabase ? 'yes (auth schema found)' : 'NO — auth.users will not resolve'}`);

const roles = await one(
  `SELECT rolname, rolbypassrls FROM pg_roles
    WHERE rolname IN ('postgres','anon','authenticated','service_role','app_rw')
    ORDER BY rolname`);
console.log('\nroles:');
for (const r of roles) console.log(`  ${r.rolname}${r.rolbypassrls ? '  (BYPASSRLS)' : ''}`);

const exts = await one(
  `SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','citext') ORDER BY extname`);
console.log(`extensions: ${exts.map((r) => r.extname).join(', ') || 'neither pgcrypto nor citext'}`);

const tables = await one(
  `SELECT c.relname, c.relrowsecurity
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`);
console.log(`\npublic tables: ${tables.length}`);
if (tables.length) {
  const withRls = tables.filter((t) => t.relrowsecurity).length;
  console.log(`  with row-level security: ${withRls} of ${tables.length}`);
  console.log(`  ${tables.slice(0, 12).map((t) => t.relname).join(', ')}${tables.length > 12 ? ', ...' : ''}`);
}

const migrated = await one(
  `SELECT filename FROM schema_migration ORDER BY filename`).catch(() => null);
console.log(migrated
  ? `\nmigrations applied: ${migrated.length}\n  ${migrated.map((r) => r.filename).join('\n  ')}`
  : '\nmigrations applied: none (no schema_migration table yet)');

if (migrated?.length) {
  const gaps = await one('SELECT table_name, problem FROM tenancy_gaps()').catch(() => null);
  if (gaps) {
    console.log(gaps.length ? `\nTENANCY GAPS (${gaps.length}):` : '\ntenancy_gaps(): clean');
    for (const g of gaps) console.log(`  ${g.table_name}: ${g.problem}`);
  }
}

await client.end();
