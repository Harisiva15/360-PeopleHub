-- ---------------------------------------------------------------------------
-- 0043 — the API may write memberships for its own tenant
--
-- 0010 enabled and FORCED row-level security on `tenant_membership`, gave it a
-- single policy `membership_self_read` FOR SELECT, granted SELECT, INSERT,
-- UPDATE and DELETE to app_rw, and noted "Writes are server-side only".
--
-- With FORCE RLS and no policy covering INSERT, writes were server-side only in
-- the sense that they were nobody-side: a table with row-level security enabled
-- denies every command no policy permits, so the grant had nothing behind it.
-- Creating a user failed with
--
--     new row violates row-level security policy for table "tenant_membership"
--
-- for every role that cannot bypass RLS — which is every role the API should
-- ever use. It appeared to work only while DATABASE_URL pointed at `postgres`,
-- which has BYPASSRLS and skipped the policy entirely. User creation, approval,
-- deactivation and role changes have therefore never run as the application.
--
-- **This does not widen access; it applies the rule every other table has.**
-- `apply_tenant_isolation` (0014) gives each tenant table a policy of
-- `USING (tenant_id = current_tenant_id()) WITH CHECK (...)` and a default on
-- tenant_id. `tenant_membership` was deliberately left out of that helper —
-- it is read to *discover* the tenant, before one is set, so it needs its own
-- read rule. That reasoning applies to reads. It never applied to writes.
--
-- The existing read policy is untouched. Policies combine permissively, so the
-- tenant picker and the pre-tenant auth lookup keep working exactly as before;
-- what changes is that a write is now possible, and only ever stamped with the
-- caller's own tenant. Cross-tenant writes remain impossible — WITH CHECK is
-- what makes that true rather than a promise in a comment.
-- ---------------------------------------------------------------------------

-- Without this the INSERT would have to name tenant_id explicitly, and the one
-- place that forgot is how this was found.
ALTER TABLE tenant_membership
  ALTER COLUMN tenant_id SET DEFAULT current_tenant_id();

DROP POLICY IF EXISTS membership_tenant_write ON tenant_membership;
CREATE POLICY membership_tenant_write ON tenant_membership
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

COMMENT ON TABLE tenant_membership IS
  'The account: which user acts as which employee, in which tenant, with what '
  'role. Read through membership_self_read, which also answers before a tenant '
  'is set so the auth lookup can find one. Written through '
  'membership_tenant_write, which cannot stamp a row with any tenant but the '
  'caller''s own. See 0010 and 0043.';
