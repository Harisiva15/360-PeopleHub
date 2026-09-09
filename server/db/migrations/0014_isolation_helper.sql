-- ---------------------------------------------------------------------------
-- 0014 — make the isolation policy reusable, and apply it to joining_request
--
-- Migration 0010 loops over every table that exists *at the time it runs* and
-- gives each one the tenant_isolation policy. Any table created afterwards
-- gets nothing — which is what happened to joining_request in 0012, and what
-- tenancy_gaps() reported on the very next migrate.
--
-- That backstop worked, and it is the wrong place to rely on. So the body of
-- that loop becomes a function any migration can call, and the rule for adding
-- a table is one line rather than a paragraph to remember:
--
--   SELECT apply_tenant_isolation('my_new_table');
--
-- tenancy_gaps() stays as the check of last resort, and the migration runner
-- still refuses to finish while it returns rows.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_tenant_isolation(p_table text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = p_table
      AND a.attname = 'tenant_id' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION '% has no tenant_id, so it cannot be tenant-isolated', p_table;
  END IF;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', p_table);
  -- Without FORCE the owner bypasses its own policy, and migrations run as
  -- the owner.
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', p_table);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON public.%I '
    'USING (tenant_id = current_tenant_id()) '
    'WITH CHECK (tenant_id = current_tenant_id())', p_table);
  EXECUTE format(
    'ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT current_tenant_id()', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_rw', p_table);

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', p_table);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', p_table);
  END IF;
END;
$$;

COMMENT ON FUNCTION apply_tenant_isolation(text) IS
  'Call once for every table a migration adds. tenancy_gaps() catches the '
  'omission, but catching it is not the same as preventing it.';

SELECT apply_tenant_isolation('joining_request');
