-- ---------------------------------------------------------------------------
-- 0010 — row-level security
--
-- This is the migration that makes the tenancy real. Everything before it is
-- a convention; this is the enforcement.
--
-- The policy is applied in a loop over every table that has a tenant_id rather
-- than written out 105 times. That is not laziness — a hand-written list is
-- exactly the kind of thing that acquires a gap when someone adds a table in a
-- hurry, and a gap here is a cross-tenant read. The loop cannot have a gap,
-- and scripts/check-schema.mjs fails the build if a new table has no tenant_id
-- for the loop to find.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Roles
--
-- On Supabase, three roles already exist and matter here:
--
--   anon           unauthenticated PostgREST requests
--   authenticated  a signed-in Supabase Auth user
--   service_role   the server-side key, which BYPASSES RLS entirely
--
-- app_rw is added for the Node API's direct connection. It is created
-- NOBYPASSRLS on purpose: a policy the connecting role can switch off is
-- decoration. Never point the API at service_role — that key exists to skip
-- every policy in this file.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    -- NOLOGIN until the deploy assigns a password:
    --   ALTER ROLE app_rw LOGIN PASSWORD '...';
    CREATE ROLE app_rw NOLOGIN NOBYPASSRLS;
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT USAGE ON SCHEMA public TO authenticated;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO app_rw;

-- Deliberately NOT "REVOKE ALL ON SCHEMA public FROM PUBLIC". On a plain
-- PostgreSQL that is good hygiene; on Supabase it also strips the grants the
-- dashboard and PostgREST rely on, and the failure is confusing. The tables
-- below are locked down individually instead, which is narrower and reversible.

-- ---------------------------------------------------------------------------
-- Tables that carry a tenant_id but are outside the isolation policy, because
-- they are read to discover which tenant a session belongs to. Keep this
-- identical to PLATFORM_TABLES in scripts/check-schema.mjs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION is_platform_table(p_table text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_table IN ('tenant_membership');
$$;

-- ---------------------------------------------------------------------------
-- Apply the isolation policy
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t record;
  has_authenticated boolean :=
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
  has_anon boolean :=
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
BEGIN
  FOR t IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'tenant_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND NOT is_platform_table(c.relname)
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.table_name);

    -- FORCE makes the policy apply to the table's owner as well. Without it,
    -- anything connecting as the owner — a migration, the Supabase SQL editor,
    -- a misconfigured pool — sees every tenant at once.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.table_name);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t.table_name);

    -- USING filters what can be read, updated and deleted. WITH CHECK is the
    -- other half and is easy to forget: without it a caller can INSERT a row
    -- stamped with somebody else's tenant_id, which they then cannot see but
    -- the other tenant can.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING (tenant_id = current_tenant_id()) '
      'WITH CHECK (tenant_id = current_tenant_id())', t.table_name);

    -- Writing the tenant becomes automatic, so application code physically
    -- cannot put a row in the wrong one by omission.
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT current_tenant_id()',
      t.table_name);

    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_rw', t.table_name);

    IF has_authenticated THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t.table_name);
    END IF;

    -- Nothing here is public. Supabase sets default privileges that can grant
    -- new tables to anon; this takes that back explicitly rather than trusting
    -- the project's current defaults.
    IF has_anon THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t.table_name);
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- tenant_membership: its own policy, not the isolation one
--
-- A signed-in user may see which tenants they belong to — that is how the
-- tenant picker works — and nothing about anyone else's membership. Writes are
-- server-side only.
-- ---------------------------------------------------------------------------

ALTER TABLE tenant_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_membership FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS membership_self_read ON tenant_membership;
CREATE POLICY membership_self_read ON tenant_membership
  FOR SELECT
  USING (
    -- Through PostgREST: only your own rows.
    user_id = auth.uid()
    -- Through the Node API, which has already authenticated the caller and
    -- set the tenant for this transaction.
    OR current_setting('app.tenant_id', true) IS NOT NULL
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_membership TO app_rw;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON tenant_membership TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON tenant_membership FROM anon;
  END IF;
END;
$$;

-- Append-only tables: the application may add but never rewrite history.
REVOKE UPDATE, DELETE ON audit_log FROM app_rw;
REVOKE UPDATE, DELETE ON consent_event FROM app_rw;
REVOKE DELETE ON leave_ledger FROM app_rw;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE UPDATE, DELETE ON audit_log FROM authenticated;
    REVOKE UPDATE, DELETE ON consent_event FROM authenticated;
    REVOKE DELETE ON leave_ledger FROM authenticated;
  END IF;
END;
$$;

-- Reference data is readable by everyone signed in and written only by
-- migrations. `tenant` is readable so a session can resolve its own name.
GRANT SELECT ON country, currency, fx_rate, tenant TO app_rw;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON country, currency, fx_rate, tenant TO authenticated;
  END IF;
END;
$$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- ---------------------------------------------------------------------------
-- A future table that forgets tenant_id is the failure mode this model has.
--
-- The build catches it: scripts/check-schema.mjs parses every migration and
-- fails when a new table is neither tenant-scoped nor explicitly listed as
-- global. This function checks the *live* database, which is what catches a
-- table created by hand in the Supabase SQL editor.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION tenancy_gaps()
RETURNS TABLE (table_name text, problem text)
LANGUAGE sql STABLE AS $$
  WITH business AS (
    SELECT c.oid, c.relname::text AS name, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT IN ('tenant', 'country', 'currency', 'fx_rate', 'schema_migration')
      AND NOT is_platform_table(c.relname)
  )
  SELECT b.name, 'no tenant_id column'
  FROM business b
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = b.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
  )
  UNION ALL
  SELECT b.name, 'row-level security is not enabled'
  FROM business b WHERE NOT b.relrowsecurity
  UNION ALL
  SELECT b.name, 'row-level security is not forced, so the owner bypasses it'
  FROM business b WHERE b.relrowsecurity AND NOT b.relforcerowsecurity
  UNION ALL
  SELECT b.name, 'no tenant_isolation policy'
  FROM business b
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy p WHERE p.polrelid = b.oid AND p.polname = 'tenant_isolation'
  );
$$;

COMMENT ON FUNCTION tenancy_gaps() IS
  'Should return zero rows. Run it after every deploy; alert if it does not.';
