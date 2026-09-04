/**
 * Makes a plain PostgreSQL look enough like Supabase to run the migrations.
 *
 * The schema references auth.users, which Supabase provides and a stock
 * PostgreSQL does not. Rather than make the migrations conditional — and so
 * test something different from what is deployed — CI creates the one table
 * they depend on, and everything after that is the real thing.
 *
 *   node scripts/ci-bootstrap.mjs
 */

import pg from 'pg';

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) {
  console.error('MIGRATE_DATABASE_URL is not set');
  process.exit(1);
}

const c = new pg.Client({ connectionString: url });
await c.connect();

await c.query('CREATE SCHEMA IF NOT EXISTS auth');
await c.query(`
  CREATE TABLE IF NOT EXISTS auth.users (
    id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text
  )`);

// Supabase's PostgREST roles. The migrations grant to them when they exist, so
// creating them here exercises that path rather than skipping it.
for (const role of ['anon', 'authenticated', 'service_role']) {
  await c.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
      CREATE ROLE ${role} NOLOGIN;
    END IF;
  END $$`);
}

// auth.uid() is referenced by the tenant_membership policy.
await c.query(`
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$`);

console.log('CI bootstrap: auth schema, auth.users, PostgREST roles');
await c.end();
