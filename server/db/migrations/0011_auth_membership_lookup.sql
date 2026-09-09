-- ---------------------------------------------------------------------------
-- 0011 — the authentication lookup
--
-- Fixes a circularity that only shows up when the API connects as app_rw.
--
-- callerFromToken has to read tenant_membership to find out which tenant a
-- login belongs to. But that read happens *before* any tenant is established —
-- that is its whole purpose — so the membership_self_read policy denies it:
-- there is no app.tenant_id set, and auth.uid() is null on a direct Postgres
-- connection because there is no JWT. The API therefore sees no membership for
-- a user that plainly has one.
--
-- This was invisible until the first end-to-end test, because every earlier
-- check ran as the owner, and the owner bypasses row-level security. A test
-- that runs as a more privileged role than production does is a test that
-- proves the wrong thing.
--
-- The fix is one narrow SECURITY DEFINER function rather than a wider policy.
-- It takes a user id and returns only that user's active memberships — it
-- cannot be coaxed into returning anything else, and it is the only route
-- app_rw has into that table without a tenant.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_membership(p_user_id uuid)
RETURNS TABLE (
  tenant_id         uuid,
  role              text,
  employee_id       uuid,
  membership_status text,
  tenant_status     text,
  tenant_slug       citext,
  tenant_name       text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Pinned so the function cannot be redirected at a shadowed table by a caller
-- who controls their own search_path. Mandatory on SECURITY DEFINER.
SET search_path = public, pg_temp
AS $$
  SELECT m.tenant_id, m.role, m.employee_id, m.status, t.status, t.slug, t.display_name
    FROM tenant_membership m
    JOIN tenant t ON t.id = m.tenant_id
   WHERE m.user_id = p_user_id
     AND m.status = 'active'
   ORDER BY t.display_name;
$$;

COMMENT ON FUNCTION auth_membership(uuid) IS
  'The only way the API reads tenant_membership without a tenant context. '
  'Returns one user''s active memberships and nothing else.';

-- Not for anyone who happens to be connected.
REVOKE ALL ON FUNCTION auth_membership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_membership(uuid) TO app_rw;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- PostgREST callers already carry a JWT, so auth.uid() works for them and
    -- the policy suffices. Granted anyway so a tenant picker can use one call.
    GRANT EXECUTE ON FUNCTION auth_membership(uuid) TO authenticated;
  END IF;
END;
$$;
