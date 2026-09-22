-- ---------------------------------------------------------------------------
-- 0040 — an account that must carry a second factor
--
-- The user-creation form has an "OTP Enabled" field in its System Access
-- section, and there has been nothing behind it. This is the column.
--
-- **It requires enrolment; it cannot perform one.** Enrolling means holding
-- the TOTP secret, and the only party that should ever hold it is the person
-- whose account it protects. An administrator who could enrol on somebody's
-- behalf would, for a moment, be able to sign in as them. So this flag says
-- "this account may not be used until a factor exists", and the person does
-- the enrolling — which also means no service key is needed, and none is
-- present (see server/.env.example).
--
-- **Distinct from `must_change_password`, and enforced beside it.** Both are
-- obligations an administrator places on an account and both block the
-- application until met. Kept as two columns rather than a status, because an
-- account can owe neither, either or both, and a status column would have to
-- enumerate the combinations.
--
-- **No column for "has a factor".** That lives in auth.mfa_factors, which is
-- Supabase's, and copying it here would create a second answer to a question
-- that already has one — the copy would go stale the moment somebody enrolled
-- and nothing would notice. Migration 0039 reads the real thing.
-- ---------------------------------------------------------------------------

ALTER TABLE tenant_membership
  ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenant_membership.mfa_required IS
  'The account may not be used until its holder has enrolled a second factor. '
  'Set by an administrator; satisfied only by the person themselves. See 0040.';

-- Administrators are the accounts worth attacking, so the list of those
-- without a factor is a list somebody will want. Partial, because the rows
-- that matter are the ones still owing.
CREATE INDEX IF NOT EXISTS tenant_membership_mfa_owed_idx
  ON tenant_membership (tenant_id, role)
  WHERE mfa_required;
