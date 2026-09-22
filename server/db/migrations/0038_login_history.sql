-- ---------------------------------------------------------------------------
-- 0038 — locked accounts, and a record of who signed in
--
-- **Why a refusal needs a reason.** `auth_membership` returns only active
-- memberships, which is what makes deactivation take effect on the very next
-- request rather than at token expiry. The gate is deliberately in the SQL,
-- where it fails closed whatever the application forgets. The cost was the
-- wording: every non-active status produced one flat "no active membership",
-- so a suspended person and a person waiting on an approval read the same
-- sentence and both concluded the software was broken. `auth_membership_status`
-- exists only to name the status on a request that has *already* been refused.
-- It returns a status and nothing else — no tenant, no role, no employee — so
-- it cannot widen anything it is called from.
--
-- **Locked is set by a person, not by a counter.** The obvious feature here is
-- "lock the account after five failed passwords", and the obvious way to build
-- it is to have the login page report its failures to the API. That endpoint
-- is unauthenticated by necessity, which makes it a way to lock any account
-- whose email address you can guess. Automatic lockout driven by a value the
-- attacker supplies is a denial-of-service with an admin panel. Supabase Auth
-- rate-limits the password attempt itself, where the attempt is actually
-- observed; `locked` here is an administrative state, and it becomes automatic
-- when — and only when — the failures are counted somewhere the client cannot
-- reach.
--
-- **The history records sign-ins, not attempts on unknown addresses.** A row
-- needs a tenant, and an address that matches no employee has none. Storing
-- those would mean a table of strangers' email addresses, keyed to nobody,
-- growing under exactly the traffic it is meant to protect against. What is
-- recorded is an attempt against an account that exists, which is the one an
-- administrator can act on.
--
-- **No token, no session id, no user agent string longer than it needs to be.**
-- The history answers "was that me?" — it is not a device fingerprint.
-- ---------------------------------------------------------------------------

ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_status_check;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_status_check
  CHECK (status IN (
    'pending_approval',  -- raised by a manager, waiting on an administrator
    'invited',           -- invitation sent, not yet accepted
    'active',
    'inactive',          -- deactivated administratively; may be reactivated
    'locked',            -- barred after repeated failed sign-ins; see above
    'suspended',         -- held as a sanction
    'deleted'            -- soft-deleted; login revoked, history retained
  ));

ALTER TABLE tenant_membership
  -- When the lock went on, so "locked since Tuesday" can be said out loud.
  -- Null while the account is not locked; cleared on unlock.
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS lock_reason text;

ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_lock_is_dated;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_lock_is_dated
  CHECK ((status = 'locked') = (locked_at IS NOT NULL));

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS login_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- The auth user, where there is one. A failed attempt against a known
  -- address may have no authenticated identity behind it.
  user_id     uuid,
  employee_id uuid,
  at          timestamptz NOT NULL DEFAULT now(),
  outcome     text NOT NULL
    CHECK (outcome IN ('success', 'failed', 'refused', 'locked_out', 'signed_out')),
  -- How they proved it. 'password' covers the Supabase password grant;
  -- 'mfa' is the second factor; 'recovery_code' is the escape hatch, and is
  -- worth being able to count separately.
  method      text NOT NULL DEFAULT 'password'
    CHECK (method IN ('password', 'mfa', 'recovery_code', 'sso', 'magic_link')),
  -- Why it did not work, in the words the person was shown. Null on success.
  reason      text,
  -- inet rather than text: a malformed address is then impossible rather than
  -- merely unexpected, and 'unknown' cannot masquerade as one.
  ip          inet,
  -- Trimmed on the way in. Enough to tell a phone from a laptop, and no more.
  user_agent  text CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  CHECK ((outcome = 'success') = (reason IS NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id)
    ON DELETE SET NULL
);

-- Both readings of this table: one person's own history, newest first, and
-- the tenant's, newest first. The second index carries the first for an
-- administrator scanning everything.
CREATE INDEX IF NOT EXISTS login_history_person_idx
  ON login_history (tenant_id, employee_id, at DESC);
CREATE INDEX IF NOT EXISTS login_history_recent_idx
  ON login_history (tenant_id, at DESC);

SELECT apply_tenant_isolation('login_history');

COMMENT ON TABLE login_history IS
  'Sign-ins and refusals against accounts that exist. Attempts on addresses '
  'matching no employee are deliberately not recorded — they have no tenant, '
  'and the table would grow under the traffic it exists to expose. See 0038.';

COMMENT ON COLUMN tenant_membership.locked_at IS
  'Set while status = ''locked''. The lock is applied by an administrator, not '
  'by a failure counter the client controls. See 0038.';

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_membership_status(p_user_id uuid)
RETURNS TABLE (status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Pinned so the function cannot be redirected at a shadowed table by a caller
-- who controls their own search_path. Mandatory on SECURITY DEFINER.
SET search_path = public, pg_temp
AS $$
  SELECT m.status
    FROM tenant_membership m
   WHERE m.user_id = p_user_id
   -- Worst first, so a person who is suspended in one tenant and merely
   -- awaiting approval in another is told about the suspension.
   ORDER BY array_position(
     ARRAY['deleted', 'suspended', 'locked', 'inactive',
           'pending_approval', 'invited', 'active'], m.status)
   LIMIT 1;
$$;

COMMENT ON FUNCTION auth_membership_status(uuid) IS
  'The status alone, for wording a refusal that has already happened. Returns '
  'no tenant, no role and no employee, so it cannot grant anything. See 0038.';

REVOKE ALL ON FUNCTION auth_membership_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_membership_status(uuid) TO app_rw;
