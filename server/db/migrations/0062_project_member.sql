-- ---------------------------------------------------------------------------
-- Who is on a project.
--
-- `timesheet_entry.project_id` has been NOT NULL since the timesheet tables
-- existed, so the database could always say who *booked time* to a project.
-- It could never say who is *on* one. That absence is three missing features
-- rather than one: no "my projects", no way to scope a project view to its
-- own team, and no way to refuse time booked against a project somebody was
-- never put on.
--
-- ## This is step one of three, and deliberately does not enforce anything
--
-- Booking time will require membership. It cannot start requiring it today:
-- production holds timesheet entries for projects nobody is formally on, and
-- a constraint added now would reject the next edit to any of them. So:
--
--   1. this table, and the service over it           <- here
--   2. backfill membership from historical entries
--   3. then refuse a booking without one
--
-- Step 3 is where the refusal message lands — it tells the person to ask
-- their manager or HR to add them, because "not a member of this project" is
-- a fact they cannot act on alone.
--
-- ## `role` is not an app role
--
-- 'member' or 'lead'. A lead is who the project page lists first and who a
-- later option may route approvals to. It grants nothing on its own, and it
-- must not become a fifth value in the role vocabulary that 0060 just spent a
-- migration narrowing to four.
--
-- Timesheet approval stays on the reporting line. Lead approval is a separate
-- decision, taken later and explicitly, because an approval that follows two
-- rules at once is an approval that sometimes reaches nobody.
--
-- ## `allocation_pct` is nullable, and oversubscription is a warning
--
-- Being on the project is the fact; a percentage is a plan, and a tenant that
-- never capacity-plans should not be made to invent one. Where it is filled
-- in, the sum of one person's live allocations may exceed 100 — the service
-- says so rather than refusing, because somebody genuinely over-committed is
-- a thing to see, not a write to block. A CHECK could not express it anyway:
-- it spans rows.
--
-- ## One live membership per person per project
--
-- Partial unique index rather than a plain one, so somebody who left a
-- project and rejoined keeps both rows and the history reads correctly.
-- `left_on` is what makes a row historical.
-- ---------------------------------------------------------------------------

CREATE TABLE project_member (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL DEFAULT current_tenant_id()
                    REFERENCES tenant (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL,
  employee_id     uuid NOT NULL,
  role            text NOT NULL DEFAULT 'member'
                    CHECK (role = ANY (ARRAY['member', 'lead'])),
  allocation_pct  smallint CHECK (allocation_pct BETWEEN 1 AND 100),
  joined_on       date NOT NULL DEFAULT CURRENT_DATE,
  left_on         date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CHECK (left_on IS NULL OR left_on >= joined_on),

  -- Composite, for the reason 0059 and 0061 give: a single-column reference
  -- would let one tenant put another tenant's employee on a project, and the
  -- database would be satisfied.
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES project (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id)
    REFERENCES employee (tenant_id, id) ON DELETE CASCADE,

  -- So a later table can reference a membership the same tenant-safe way this
  -- one references a project and an employee. `check:schema` requires it of
  -- every tenant-scoped table, and the reason is the one above: without it the
  -- only available reference is the bare id, and a bare id crosses tenants.
  UNIQUE (tenant_id, id)
);

-- One live membership per person per project. Historical rows are exempt, so
-- leaving and rejoining is two rows rather than a lost fact.
CREATE UNIQUE INDEX project_member_live_once
  ON project_member (tenant_id, project_id, employee_id)
  WHERE left_on IS NULL;

-- The two reads this table exists for: a project's team, and a person's
-- projects. Both are filtered on `left_on IS NULL` in every service path.
CREATE INDEX project_member_by_project
  ON project_member (tenant_id, project_id) WHERE left_on IS NULL;
CREATE INDEX project_member_by_employee
  ON project_member (tenant_id, employee_id) WHERE left_on IS NULL;

-- One call, not six statements of my own.
--
-- `apply_tenant_isolation` (0014) enables and forces row-level security,
-- creates the `tenant_isolation` policy, grants `app_rw` and `authenticated`,
-- and revokes from `anon` — which matters because Supabase's default
-- privileges can hand a new table to `anon`, and `anon` is the role the
-- publishable key in the frontend bundle maps to. 0055 exists because five
-- tables missed exactly that.
--
-- Its own COMMENT says "call once for every table a migration adds", and the
-- first draft of this migration wrote the statements out by hand instead. It
-- got the grants wrong — `app_rw` had no privileges at all, so the service
-- could not read its own table — which is the argument for the helper rather
-- than against it.
SELECT apply_tenant_isolation('project_member');

COMMENT ON TABLE project_member IS
  'Who is on a project. One live row per person per project; `left_on` makes '
  'a row historical. `role` is ''member'' or ''lead'' and grants nothing — it '
  'is not an app role. Booking time will require a live row here, from step '
  '3 of the rollout.';

COMMENT ON COLUMN project_member.allocation_pct IS
  'Planned share of the person''s time, 1-100, or null where nobody plans. '
  'The sum across one person''s live rows may exceed 100: the service warns '
  'rather than refusing, because being over-committed is a thing to see.';
