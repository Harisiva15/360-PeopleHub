-- ---------------------------------------------------------------------------
-- 0041 — the application role may read the export register
--
-- `apply_tenant_isolation` (0014) grants SELECT, INSERT, UPDATE and DELETE on
-- a *table*. `export_run` is a view, so it was never covered, and nothing
-- noticed: every check that reads it ran as the owner, which needs no grant.
--
-- The moment DATABASE_URL was pointed at app_rw — which is the whole point of
-- that role, since a role that can switch off row-level security makes the
-- policies decoration — verify-isolation stopped at:
--
--     permission denied for view export_run
--
-- In production this is the export register screen answering 500.
--
-- **This does not widen anything.** The view carries `security_invoker = true`
-- (0031), so it executes with the privileges and the tenant setting of whoever
-- selects from it: app_rw reading it sees exactly the rows its own policies
-- allow on `audit_log` underneath, and no others. Without the grant it sees
-- nothing at all and errors; with it, it sees its own tenant. The grant
-- restores intended access rather than creating new reach.
--
-- SELECT only. The view is derived from audit_log and there is nothing to
-- write through it.
-- ---------------------------------------------------------------------------

GRANT SELECT ON public.export_run TO app_rw;

-- Kept in step with apply_tenant_isolation, which grants to `authenticated`
-- wherever that role exists — it does on Supabase and does not on a bare
-- PostgreSQL used for the checks, so the guard is the same one 0010 uses.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.export_run TO authenticated;
  END IF;
END;
$$;

COMMENT ON VIEW export_run IS
  'Export records, derived from audit_log. security_invoker = true, so it '
  'reads as the caller and their tenant rather than as its owner. Granted to '
  'app_rw by 0041 — apply_tenant_isolation covers tables only, and a view it '
  'does not cover is a screen that answers 500. See 0031 for why exports are '
  'audit rows rather than a table of their own.';
