-- A department belongs to a business unit.
--
-- 0051 created `business_unit`; this is the first thing to point at it, and the
-- reason it was given `UNIQUE (tenant_id, id)` on the day it was created.
--
-- ## Why this is safe to run against a live table
--
-- `department` has been altered once in fifty-one migrations — 0003, closing a
-- forward reference — and ten tables carry a composite foreign key to it. So the
-- bar for touching it is high, and these three statements clear it:
--
--   * `ADD COLUMN` with no default and no NOT NULL is a catalogue change in
--     PostgreSQL 11 and later. No table rewrite, no rewrite-length lock, and the
--     cost does not grow with the number of rows.
--   * Adding the foreign key validates the existing rows, and every one of them
--     is NULL, which a foreign key does not constrain. There is nothing to fail.
--   * Nothing is backfilled. No code, name, parent or head changes.
--
-- ## Why the column is nullable, and stays nullable
--
-- Departments exist already and none of them has a business unit. Making the
-- column NOT NULL would mean inventing an answer for each — a data decision
-- dressed up as a schema decision. Unassigned is a real state and the product
-- reads it as one: the selector offers "unassigned", the list shows a dash.
--
-- A later migration may tighten this once every department has been assigned
-- deliberately. That is a separate decision with its own review.
--
-- ## Why the key is composite
--
-- `business_unit` is tenant-scoped and so is `department`, so a plain
-- `REFERENCES business_unit (id)` would be satisfied by *any* tenant's unit — a
-- department in one tenant could name a business unit in another. Carrying
-- tenant_id through the key makes that unrepresentable rather than merely
-- discouraged, which is the convention every other reference in this schema
-- follows and what check-schema's third invariant enforces.

ALTER TABLE department
  ADD COLUMN business_unit_id uuid;

ALTER TABLE department
  ADD CONSTRAINT department_business_unit_fkey
  FOREIGN KEY (tenant_id, business_unit_id)
  REFERENCES business_unit (tenant_id, id);

-- Reads go the other way — "the departments in this unit" — so the index leads
-- with tenant_id and carries the unit. Without it, resolving a unit's departments
-- is a scan of every department in the tenant.
CREATE INDEX department_tenant_business_unit_idx
  ON department (tenant_id, business_unit_id);

COMMENT ON COLUMN department.business_unit_id IS
  'The business unit this department belongs to, or null where none has been '
  'assigned. Nullable on purpose: departments predate business units and are '
  'never assigned one implicitly.';
