-- ---------------------------------------------------------------------------
-- 0049 — signing in claims an invitation, and nothing else
--
-- `auth_claim_membership` links a verified first sign-in to a membership an
-- administrator created in advance. It guarded that link with a denylist: it
-- refused an expired invitation and one still awaiting approval, and let
-- everything else through.
--
-- `tenant_membership_user_once_usable` (0047) permits exactly three statuses to
-- have no user: pending_approval, invited and deleted. The claim only ever sees
-- those three, because it looks for `user_id IS NULL`. Two were named. The
-- third was not.
--
-- So a **withdrawn invitation was revived by the person signing in** — user
-- filled in, status set to active, with the role the administrator had chosen
-- before withdrawing it. Withdrawing an invitation is an administrator deciding
-- somebody should not have access; a sign-in must not overturn that decision.
-- The fourteen-day expiry limited the window only where `invite_sent_at` was
-- set, and not at all where it was null.
--
-- **The guard becomes an allowlist.** Only `invited` is claimable. A status
-- added to the schema later — and there are seven already — is refused until
-- somebody decides it should not be, which is the safe direction for a function
-- that hands out access.
--
-- **The auto-enrolment branch goes.** The old ELSE inserted a membership for
-- any matching employee who had none, taking the role from `employee.app_role`.
-- That predates invitations (0013) and is now a second, unaudited way to obtain
-- access that bypasses the lifecycle entirely: no invitation, no approval, no
-- administrator action beyond the employee record existing. Authentication is
-- not authorisation. A person with no membership now gets no access, and the
-- session resolver's refusal stands.
--
-- Nothing else changes. The address must still be verified by the identity
-- provider, must still match exactly one employee at one active tenant, and the
-- role still comes from the membership the administrator created — never from
-- the sign-in request.
--
-- No table, column, constraint or policy is touched. This replaces one function
-- body. To roll back, re-apply the definition from 0046.
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
  match   record;
  pending record;
BEGIN
  IF p_email IS NULL OR p_email = '' THEN
    RETURN;
  END IF;

  /*
   * Deliberately unscoped by tenant — this runs before a tenant is known, and
   * finding it is the point. The exactly-one rule below is what keeps that
   * safe: an address that matches people at two customers links to neither.
   */
  SELECT e.id, e.tenant_id INTO match
    FROM employee e
    JOIN tenant t ON t.id = e.tenant_id
   WHERE e.work_email = p_email
     AND e.status <> 'exited'
     AND t.status IN ('trial', 'active')
     AND NOT EXISTS (
       -- A membership that already has a user is somebody else's, or this
       -- person already linked. Only an unclaimed one is available.
       SELECT 1 FROM tenant_membership m
        WHERE m.employee_id = e.id AND m.tenant_id = e.tenant_id
          AND m.user_id IS NOT NULL
     )
   LIMIT 2;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF (SELECT count(*) FROM employee e2 JOIN tenant t2 ON t2.id = e2.tenant_id
       WHERE e2.work_email = p_email AND e2.status <> 'exited'
         AND t2.status IN ('trial', 'active')) > 1 THEN
    RAISE WARNING 'auth_claim_membership: % matches more than one employee', p_email;
    RETURN;
  END IF;

  SELECT m.id, m.role, m.status, m.invite_sent_at INTO pending
    FROM tenant_membership m
   WHERE m.employee_id = match.id AND m.tenant_id = match.tenant_id
     AND m.user_id IS NULL
   LIMIT 1;

  /*
   * No membership at all is no longer an invitation to create one. Somebody
   * whose employee record exists but who was never given an account has not
   * been granted access, and signing in does not grant it.
   */
  IF NOT FOUND THEN
    RAISE WARNING 'auth_claim_membership: % has no invitation to claim', p_email;
    RETURN;
  END IF;

  /*
   * The allowlist. `invited` is the only status a sign-in may act on.
   *
   * `deleted` is the one this migration exists for: a withdrawn invitation
   * used to fall through here and be set active. `pending_approval` is still
   * waiting on a decision nobody has made. Every other status already carries
   * a user and cannot reach this point.
   */
  IF pending.status <> 'invited' THEN
    RAISE WARNING 'auth_claim_membership: the membership for % is %, not an open invitation',
      p_email, pending.status;
    RETURN;
  END IF;

  -- An invitation that was sent and then left too long is not a way in.
  IF pending.invite_sent_at IS NOT NULL
     AND pending.invite_sent_at < now() - interval '14 days' THEN
    RAISE WARNING 'auth_claim_membership: invitation for % has expired', p_email;
    RETURN;
  END IF;

  UPDATE tenant_membership
     SET user_id = p_user_id, status = 'active', accepted_at = now()
   WHERE id = pending.id;

  INSERT INTO audit_log (tenant_id, category, action, actor_user_id, actor_employee_id,
                         actor_label, subject_table, subject_id, detail)
  SELECT match.tenant_id, 'access', 'login_linked_to_employee', p_user_id, match.id,
         e.full_name, 'employee', match.id,
         jsonb_build_object('email', p_email::text, 'linked_invitation', true)
    FROM employee e WHERE e.id = match.id;

  RETURN QUERY SELECT * FROM auth_membership(p_user_id);
END;
$$;

COMMENT ON FUNCTION auth_claim_membership(uuid, citext) IS
  'Links a verified first sign-in to an invitation an administrator created. '
  'Claims only a membership whose status is exactly "invited" and whose '
  'invitation has not expired — a withdrawn one stays withdrawn, and an '
  'employee with no membership gets no access. Never creates a membership. '
  'The role comes from the membership, never from the request. See 0046 and 0049.';

REVOKE ALL ON FUNCTION auth_claim_membership(uuid, citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_claim_membership(uuid, citext) TO app_rw;
