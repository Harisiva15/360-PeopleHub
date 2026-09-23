-- ---------------------------------------------------------------------------
-- 0047 — an invitation that was never accepted can still be withdrawn
--
-- 0046 required a user on any membership that is not pending_approval or
-- invited, on the grounds that no usable account exists without a person
-- behind it. That is right about usable states and wrong about one more:
-- `deleted`.
--
-- Inviting the wrong person is ordinary. Withdrawing that invitation is the
-- obvious remedy, and `removeUser` implements it as a soft delete — the row
-- stays so the audit trail keeps its subject. But the row has no user, because
-- nobody ever accepted it, so the constraint refused the update and the only
-- way to undo a mistaken invitation was to leave it standing.
--
-- `deleted` joins the list. The rule it was written to enforce is unchanged:
-- there is still no state in which an account somebody can *sign into* has no
-- person behind it. Withdrawn is not such a state — it is the opposite.
-- ---------------------------------------------------------------------------

ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_user_once_usable;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_user_once_usable
  CHECK (user_id IS NOT NULL OR status IN ('pending_approval', 'invited', 'deleted'));

COMMENT ON CONSTRAINT tenant_membership_user_once_usable ON tenant_membership IS
  'A membership with no auth user may only be awaiting approval, awaiting '
  'acceptance, or withdrawn. Every state an account can actually be used in '
  'requires a user. See 0046 and 0047.';
