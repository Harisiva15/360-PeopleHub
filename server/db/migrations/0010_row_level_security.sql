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
-- The application role
--
-- Migrations run as the owner. The API connects as this role, which
-- deliberately cannot bypass RLS. Two separate roles is the point: a policy
-- that the connecting role can switch off is decoration.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    -- No password here; the deploy assigns one, or the role authenticates by
    -- IAM token where the platform supports it.
    CREATE ROLE app_rw NOLOGIN NOBYPASSRLS;
  END IF;
END;
$$;

-- Nothing is granted by default, and PUBLIC gets nothing at all.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_rw;

-- ---------------------------------------------------------------------------
-- Tables that carry a tenant_id but are read before a tenant context exists.
-- The auth module queries these deliberately, as the owner, and they are not
-- policy-scoped. Keep this list identical to PLATFORM_TABLES in
-- scripts/check-schema.mjs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION is_platform_table(p_table text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_table IN ('tenant_membership', 'user_session');
$$;

-- ---------------------------------------------------------------------------
-- Apply the policy
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t record;
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
    -- anything connecting as the owner — a migration, a console session, a
    -- misconfigured pool — sees every tenant at once.
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
  END LOOP;
END;
$$;

-- Append-only tables: the application may add but never rewrite history.
REVOKE UPDATE, DELETE ON audit_log FROM app_rw;
REVOKE UPDATE, DELETE ON consent_event FROM app_rw;
REVOKE DELETE ON leave_ledger FROM app_rw;

-- Reference data is readable by everyone and written only by migrations.
GRANT SELECT ON country, currency, fx_rate TO app_rw;

-- The auth module needs these, and they are not policy-scoped, so the grants
-- are explicit rather than swept up by the loop above.
GRANT SELECT ON tenant TO app_rw;
GRANT SELECT, INSERT, UPDATE ON app_user TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_membership TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_session TO app_rw;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- ---------------------------------------------------------------------------
-- A future table that forgets tenant_id is the failure mode this model has.
--
-- The build catches it: scripts/check-schema.mjs parses every migration and
-- fails when a new table is neither tenant-scoped nor explicitly listed as
-- global. Belt and braces, this function lets an operator confirm the live
-- database matches — useful after a hotfix applied by hand.
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
      AND c.relname NOT IN ('tenant', 'app_user', 'country', 'currency', 'fx_rate')
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
