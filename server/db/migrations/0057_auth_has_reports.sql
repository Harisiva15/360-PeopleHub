-- ---------------------------------------------------------------------------
-- 0057 — does this person have reports, asked before any tenant exists
--
-- The same circularity 0011 fixed, in a new place, for the same reason.
--
-- The four-role model derives the manager layer from the reporting tree rather
-- than from a role name, so `callerFromToken` has to answer "does anybody
-- report to this person" while it is building the caller — which is *before* a
-- tenant context exists, because establishing one is what it is in the middle
-- of doing. `hasReportsFor` asked by querying `employee` directly, and the
-- policy on that table calls `current_tenant_id()`, which raises:
--
--     42501  no tenant in this session: set app.tenant_id, or sign in with a
--            tenant claim
--
-- `callerFromToken` therefore threw on every authenticated request. The
-- frontend's password gate fails closed, so what people actually saw was
-- "Set a new password" on a loop, with no clue that the cause was an
-- authorisation query two layers down.
--
-- 0011's header already explained why nothing caught it:
--
--     "This was invisible until the first end-to-end test, because every
--      earlier check ran as the owner, and the owner bypasses row-level
--      security. A test that runs as a more privileged role than production
--      does is a test that proves the wrong thing."
--
-- This time the gap was narrower and worse: the suites *do* run the services as
-- app_rw, but they build `Caller` objects by hand and so never call
-- `callerFromToken` at all. 203 files of green checks, and not one of them had
-- ever executed the function that broke.
--
-- The fix is 0011's fix: one narrow SECURITY DEFINER function. It takes a user
-- id, walks that user's own reporting line, and returns a boolean. It cannot be
-- coaxed into returning anything about anybody else, and it is the only route
-- app_rw has to that answer without a tenant.
--
-- Deliberately keyed on `user_id` rather than `employee_id`: a caller supplies
-- a token, and the subject of a token is a user. Taking an employee id would
-- let anybody holding app_rw ask the question about an arbitrary employee,
-- which is a different and wider function than the one needed here.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_has_reports(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Pinned so the function cannot be redirected at a shadowed table by a caller
-- who controls their own search_path. Mandatory on SECURITY DEFINER.
SET search_path = public, pg_temp
AS $$
  WITH RECURSIVE me AS (
    -- The employee this login is, within their active membership. Both the
    -- tenant and the employee come from the membership rather than from an
    -- argument, so there is nothing for a caller to point elsewhere.
    SELECT m.tenant_id, m.employee_id
      FROM tenant_membership m
     WHERE m.user_id = p_user_id
       AND m.status = 'active'
       AND m.employee_id IS NOT NULL
     LIMIT 1
  ),
  line AS (
    SELECT e.id, e.tenant_id
      FROM employee e
      JOIN me ON e.manager_id = me.employee_id AND e.tenant_id = me.tenant_id
     UNION
    SELECT c.id, c.tenant_id
      FROM employee c
      JOIN line l ON c.manager_id = l.id AND c.tenant_id = l.tenant_id
  )
  SELECT EXISTS (SELECT 1 FROM line);
$$;

COMMENT ON FUNCTION auth_has_reports(uuid) IS
  'Whether anybody reports to this login''s employee, at any depth. The only '
  'way the API reads the reporting tree without a tenant context. Answers '
  'about the given user and nobody else.';

-- Not for anyone who happens to be connected.
REVOKE ALL ON FUNCTION auth_has_reports(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_has_reports(uuid) TO app_rw;

-- Deliberately NOT granted to `authenticated`, unlike auth_membership.
--
-- 0011 granted that one so a tenant picker could use a single call from a
-- PostgREST client. Nothing needs this function that way: only the API, as
-- app_rw, asks it. 0055's public-role exposure check refuses a SECURITY
-- DEFINER function reachable by a public role, and it refused this one when
-- the grant was copied across — correctly, because anything `authenticated`
-- can execute is reachable by anybody holding the publishable key.
