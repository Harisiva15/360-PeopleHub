-- ---------------------------------------------------------------------------
-- 0046 — an invitation may exist before the person does
--
-- Two parts of this schema have disagreed since 0030, and creating a user has
-- failed for the whole of that time.
--
--   0030 gave accounts a lifecycle — pending_approval, invited, active — which
--   only makes sense if a row can exist before its holder has ever signed in.
--
--   0001 declared `user_id uuid NOT NULL REFERENCES auth.users`, which makes
--   exactly that row impossible.
--
--   0013's auth_claim_membership resolves it the other way: it *creates* the
--   membership at first sign-in, guarded by NOT EXISTS, so an administrator
--   creating one in advance is not merely unsupported but actively rejected.
--
-- This migration takes the lifecycle's side, because that is what the screens,
-- the invitation counters and the approval workflow all already assume.
--
-- **The column becomes nullable; the requirement does not go away.** A CHECK
-- makes `user_id` mandatory from the moment an account can be used: a row may
-- lack one only while it is pending_approval or invited. There is no state in
-- which an active, locked or suspended account has no person behind it, and
-- there is no path that quietly leaves one.
--
-- **Duplicate invitations become impossible rather than discouraged.** The
-- existing UNIQUE (tenant_id, user_id) does not constrain pending rows at all,
-- because PostgreSQL permits any number of NULLs in a unique index. One
-- membership per employee, excluding soft-deleted history, is the rule that
-- actually prevents inviting the same person twice.
--
-- **Expiry is enforced where it is read, not stored twice.** `invite_sent_at`
-- is already recorded; the claim function below refuses an invitation older
-- than the window rather than a separate column drifting out of step with it.
-- ---------------------------------------------------------------------------

ALTER TABLE tenant_membership ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_user_once_usable;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_user_once_usable
  CHECK (user_id IS NOT NULL OR status IN ('pending_approval', 'invited'));

-- One live membership per employee. Soft-deleted rows are history and excluded.
DROP INDEX IF EXISTS tenant_membership_one_per_employee;
CREATE UNIQUE INDEX tenant_membership_one_per_employee
  ON tenant_membership (tenant_id, employee_id)
  WHERE status <> 'deleted' AND employee_id IS NOT NULL;

COMMENT ON COLUMN tenant_membership.user_id IS
  'The Supabase auth user, once there is one. Null only while the account is '
  'pending_approval or invited — tenant_membership_user_once_usable refuses '
  'every other state without it. Filled in by auth_claim_membership at first '
  'sign-in. See 0046.';

-- ---------------------------------------------------------------------------
-- auth_claim_membership: link a waiting invitation, or create one as before
--
-- The rewrite is small and the security argument is unchanged: an address is
-- only ever matched when Supabase has verified it, and only when it identifies
-- exactly one employee at one active tenant. Two customers with the same
-- address still link to neither.
--
-- What changes is the two cases it now distinguishes.
--
--   A membership already waiting, with no user: an administrator created it,
--   chose the role and the employee, and the person has now proved the address.
--   The row is *linked* — user filled in, status active, accepted_at stamped.
--   The role is the one the administrator chose, not employee.app_role, so a
--   manager invited as a manager does not silently become whatever the
--   employee record happens to say.
--
--   No membership at all: unchanged from 0013 — insert one, taking the role
--   from the employee record, for the tenant that signed people up before
--   invitations existed.
--
-- An expired invitation is refused. The window is fourteen days from
-- invite_sent_at; an invitation that was never sent (created without one) does
-- not expire, because nothing has started running.
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
  SELECT e.id, e.tenant_id, e.app_role INTO match
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

  IF FOUND THEN
    -- An invitation that was sent and then left too long is not a way in.
    IF pending.invite_sent_at IS NOT NULL
       AND pending.invite_sent_at < now() - interval '14 days' THEN
      RAISE WARNING 'auth_claim_membership: invitation for % has expired', p_email;
      RETURN;
    END IF;

    -- Still waiting on an administrator's decision; signing in does not grant it.
    IF pending.status = 'pending_approval' THEN
      RAISE WARNING 'auth_claim_membership: % is awaiting approval', p_email;
      RETURN;
    END IF;

    UPDATE tenant_membership
       SET user_id = p_user_id, status = 'active', accepted_at = now()
     WHERE id = pending.id;
  ELSE
    INSERT INTO tenant_membership (tenant_id, user_id, role, employee_id, status, accepted_at)
    VALUES (match.tenant_id, p_user_id, match.app_role, match.id, 'active', now())
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
  END IF;

  INSERT INTO audit_log (tenant_id, category, action, actor_user_id, actor_employee_id,
                         actor_label, subject_table, subject_id, detail)
  SELECT match.tenant_id, 'access', 'login_linked_to_employee', p_user_id, match.id,
         e.full_name, 'employee', match.id,
         jsonb_build_object('email', p_email::text,
                            'linked_invitation', pending.id IS NOT NULL)
    FROM employee e WHERE e.id = match.id;

  RETURN QUERY SELECT * FROM auth_membership(p_user_id);
END;
$$;

COMMENT ON FUNCTION auth_claim_membership(uuid, citext) IS
  'Links a verified sign-in to exactly one employee — filling in a waiting '
  'invitation where an administrator created one, otherwise creating the '
  'membership. Refuses an expired invitation, one awaiting approval, and any '
  'address matching more than one employee. See 0013 and 0046.';

REVOKE ALL ON FUNCTION auth_claim_membership(uuid, citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_claim_membership(uuid, citext) TO app_rw;
