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

/*
 * auth.mfa_factors, for 0039's auth_has_verified_factor().
 *
 * PostgreSQL parses the body of a LANGUAGE sql function when it is created, so
 * a reference to a table that is not there fails the migration outright with
 * 42P01 rather than at first call. Without this, 0039 stops the whole run and
 * the step reports only "exit code 1".
 *
 * The columns are the ones the function reads plus enough shape to be
 * recognisable. This is a stand-in for CI, not a copy of Supabase's table —
 * the real one carries the TOTP secret, which nothing here should imitate even
 * in a throwaway container.
 */
await c.query(`
  CREATE TABLE IF NOT EXISTS auth.mfa_factors (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    friendly_name text,
    factor_type   text NOT NULL DEFAULT 'totp',
    status        text NOT NULL DEFAULT 'unverified',
    created_at    timestamptz NOT NULL DEFAULT now()
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

console.log('CI bootstrap: auth schema, auth.users, auth.mfa_factors, PostgREST roles');
await c.end();
