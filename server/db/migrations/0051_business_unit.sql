-- Business units: the level above a department.
--
-- The organisation already has departments, and a department can nest through
-- `parent_id`, so a business unit could in principle have been a department with
-- no parent. It is not modelled that way on purpose. Ten tables carry a
-- `department_id` and all of them mean "the team somebody works in"; a business
-- unit is the P&L the team belongs to, and overloading one table with both would
-- make every one of those joins ambiguous.
--
-- Create-only. Nothing existing is altered, so no table that production already
-- depends on can be broken by applying this.
--
-- Nothing references it yet. Linking `department.business_unit_id` is a separate
-- migration, because that one does alter a table in use and deserves its own
-- review.

CREATE TABLE business_unit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- The identity people type and quote. Upper-cased by the service, and stable:
  -- renaming is a `name` change, never a `code` change.
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  -- Deactivated rather than deleted, so a unit that is no longer trading stops
  -- being offered while everything recorded against it stays readable.
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Lets another tenant-scoped table reference this one through the tenant, so a
  -- foreign key can never point across tenants. Required by check-schema's
  -- second invariant for every scoped table, whether or not anything points here
  -- yet.
  UNIQUE (tenant_id, id),
  -- One code per tenant, and the reason the service does not need to check for a
  -- duplicate in a transaction: the database refuses it.
  UNIQUE (tenant_id, code),
  CONSTRAINT business_unit_code_shape CHECK (code = upper(btrim(code)) AND length(btrim(code)) BETWEEN 2 AND 16),
  CONSTRAINT business_unit_name_present CHECK (length(btrim(name)) > 0)
);

-- `UNIQUE (tenant_id, code)` already leads with tenant_id, which satisfies the
-- index invariant. This one is for the list screen's own ordering: every read is
-- "this tenant's units, actives first, by name", and without it that is a sort
-- on every page load.
CREATE INDEX business_unit_tenant_active_name_idx
  ON business_unit (tenant_id, active DESC, name);

-- ENABLE + FORCE row level security, the tenant_isolation policy with both
-- USING and WITH CHECK, tenant_id defaulting to current_tenant_id(), and the
-- app_rw grants. Without this line the table would have a tenant_id column and
-- no policy, and app_rw — which is NOBYPASSRLS precisely so the policy is the
-- boundary — would read and write every tenant's rows in it. check-schema's
-- sixth invariant fails the build if it is missing.
SELECT apply_tenant_isolation('business_unit');

COMMENT ON TABLE business_unit IS
  'A P&L or operating division within a tenant. The level above department; '
  'deactivated rather than deleted so historical references stay readable.';
