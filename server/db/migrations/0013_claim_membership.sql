-- ---------------------------------------------------------------------------
-- 0013 — linking a login to an employee, on first sign-in
--
-- Approving a joining request creates an `employee`. It cannot create a login:
-- Supabase owns those, and writing auth.users by hand is how the first admin
-- account produced a 500 at sign-in — GoTrue reads columns this schema knows
-- nothing about.
--
-- So the link is made the other way round. HR creates the person; the person
-- signs in with SSO or a magic link; and if their *verified* address matches
-- exactly one active employee who has no login yet, the membership is created
-- then and there. No invitation emails to chase, no tokens to expire.
--
-- Three conditions, each load-bearing:
--
--   * The address must be verified by the identity provider. An unverified
--     one is a claim, not a fact, and anyone can claim an address.
--   * Exactly one employee may match. Zero means they are not staff. More than
--     one means the directory is ambiguous, and guessing which person someone
--     is entitles them to the wrong records.
--   * The employee must be active and unlinked. A leaver does not get a login
--     back by signing in, and an existing link is never silently repointed.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_claim_membership(p_user_id uuid, p_email citext)
RETURNS TABLE (
  tenant_id         uuid,
  role              text,
  employee_id       uuid,
  membership_status text,
  tenant_status     text,
  tenant_slug       citext,
  tenant_name       text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  match record;
BEGIN
  IF p_email IS NULL OR p_email = '' THEN
    RETURN;
  END IF;

  /*
   * Deliberately unscoped by tenant — this runs before a tenant is known, and
   * finding it is the point. The exactly-one rule below is what keeps that
   * safe: an address that matches people at two customers links to neither.
   */
  SELECT e.id, e.tenant_id, e.app_role INTO match
    FROM employee e
    JOIN tenant t ON t.id = e.tenant_id
   WHERE e.work_email = p_email
     AND e.status <> 'exited'
     AND t.status IN ('trial', 'active')
     AND NOT EXISTS (
       SELECT 1 FROM tenant_membership m
        WHERE m.employee_id = e.id AND m.tenant_id = e.tenant_id
     )
   LIMIT 2;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- A second row means ambiguity; LIMIT 2 above makes that detectable.
  IF (SELECT count(*) FROM employee e2 JOIN tenant t2 ON t2.id = e2.tenant_id
       WHERE e2.work_email = p_email AND e2.status <> 'exited'
         AND t2.status IN ('trial', 'active')) > 1 THEN
    RAISE WARNING 'auth_claim_membership: % matches more than one employee', p_email;
    RETURN;
  END IF;

  INSERT INTO tenant_membership (tenant_id, user_id, role, employee_id, status, accepted_at)
  VALUES (match.tenant_id, p_user_id, match.app_role, match.id, 'active', now())
  ON CONFLICT (tenant_id, user_id) DO NOTHING;

  INSERT INTO audit_log (tenant_id, category, action, actor_user_id, actor_employee_id,
                         actor_label, subject_table, subject_id, detail)
  SELECT match.tenant_id, 'access', 'login_linked_to_employee', p_user_id, match.id,
         e.full_name, 'employee', match.id,
         jsonb_build_object('email', p_email::text, 'role', match.app_role)
    FROM employee e WHERE e.id = match.id;

  RETURN QUERY SELECT * FROM auth_membership(p_user_id);
END;
$$;

COMMENT ON FUNCTION auth_claim_membership(uuid, citext) IS
  'Links a verified sign-in to exactly one unlinked active employee. Returns '
  'nothing when there is no match or more than one.';

REVOKE ALL ON FUNCTION auth_claim_membership(uuid, citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_claim_membership(uuid, citext) TO app_rw;
