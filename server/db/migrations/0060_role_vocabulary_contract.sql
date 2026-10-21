-- ---------------------------------------------------------------------------
-- Step C: the old vocabulary stops being legal.
--
-- Step A (0056) taught the schema the new role names while keeping the old
-- ones. Step B (0058) moved every row onto them. This removes the old names
-- from the CHECK constraints, so a row carrying one can no longer be written
-- at all. After this, the vocabulary is enforced by the database rather than
-- by everything that writes to it remembering.
--
-- ## The four constraints are NOT the same constraint
--
-- They look identical today — all four admit the same six values — and
-- narrowing them identically is wrong. Three of them hold a *role* somebody
-- was assigned. The fourth holds a *policy layer*, which is a different set.
--
--   tenant_membership.role          role    -> employee, hr_admin,
--   employee.app_role               role       finance_admin, company_admin
--   joining_request.requested_role  role
--
--   role_permission.role            layer   -> the four roles AND manager
--
-- `manager` is not a role: nobody is given it, and `src/modules/settings/
-- access.tsx` says so where an administrator might look for it. It is derived
-- from `employee.manager_id` — `effective = max(employee, hasReports ?
-- manager : none, assignedRole)`. But it *is* a layer that per-tenant
-- overrides can be written against: `POLICY_LAYERS` in auth/policy.ts is
-- ['employee', 'manager', 'hr_admin', 'finance_admin', 'company_admin'], and
-- `auth/overrides.ts` keeps exactly the rows whose role is in that list.
--
-- Production holds 33 `manager` rows in role_permission and 24 of them carry
-- a scope other than 'none'. Those rows are live: they narrow what a manager
-- reaches, module by module. Narrowing this constraint to the four roles
-- would fail on them, which is the good outcome — and "fixing" that failure by
-- deleting them would widen every manager's access across two dozen modules
-- without a word, because an override only ever narrows. So `manager` stays
-- legal here and nowhere else.
--
-- `admin` is a different matter: step B moved every one of those rows, and a
-- count below proves it before anything is dropped.
--
-- ## Guards before changes
--
-- Each constraint is replaced only after counting the rows that would violate
-- it. A failed count raises and rolls the whole migration back, naming the
-- table and the value, because the alternative — ALTER failing with
-- "violates check constraint" and a constraint name — does not say which row
-- or which value, and that is the first thing anybody will ask.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  roles       text[] := ARRAY['employee', 'hr_admin', 'finance_admin', 'company_admin'];
  layers      text[] := ARRAY['employee', 'manager', 'hr_admin', 'finance_admin', 'company_admin'];
  offending   bigint;
  detail      text;
BEGIN
  /* The three that hold an assigned role. */
  SELECT count(*), string_agg(DISTINCT role, ', ')
    INTO offending, detail
    FROM tenant_membership WHERE NOT (role = ANY (roles));
  IF offending > 0 THEN
    RAISE EXCEPTION 'tenant_membership.role still holds % row(s) outside the new vocabulary: %',
      offending, detail;
  END IF;

  SELECT count(*), string_agg(DISTINCT app_role, ', ')
    INTO offending, detail
    FROM employee WHERE NOT (app_role = ANY (roles));
  IF offending > 0 THEN
    RAISE EXCEPTION 'employee.app_role still holds % row(s) outside the new vocabulary: %',
      offending, detail;
  END IF;

  SELECT count(*), string_agg(DISTINCT requested_role, ', ')
    INTO offending, detail
    FROM joining_request WHERE NOT (requested_role = ANY (roles));
  IF offending > 0 THEN
    RAISE EXCEPTION 'joining_request.requested_role still holds % row(s) outside the new vocabulary: %',
      offending, detail;
  END IF;

  /* And the one that holds a policy layer, where manager is legitimate. */
  SELECT count(*), string_agg(DISTINCT role, ', ')
    INTO offending, detail
    FROM role_permission WHERE NOT (role = ANY (layers));
  IF offending > 0 THEN
    RAISE EXCEPTION 'role_permission.role still holds % row(s) outside the policy layers: %',
      offending, detail;
  END IF;
END $$;

ALTER TABLE tenant_membership DROP CONSTRAINT tenant_membership_role_check;
ALTER TABLE tenant_membership ADD CONSTRAINT tenant_membership_role_check
  CHECK (role = ANY (ARRAY['employee', 'hr_admin', 'finance_admin', 'company_admin']));

ALTER TABLE employee DROP CONSTRAINT employee_app_role_check;
ALTER TABLE employee ADD CONSTRAINT employee_app_role_check
  CHECK (app_role = ANY (ARRAY['employee', 'hr_admin', 'finance_admin', 'company_admin']));

ALTER TABLE joining_request DROP CONSTRAINT joining_request_requested_role_check;
ALTER TABLE joining_request ADD CONSTRAINT joining_request_requested_role_check
  CHECK (requested_role = ANY (ARRAY['employee', 'hr_admin', 'finance_admin', 'company_admin']));

-- Keeps manager. See the header: it is a layer here, not a role.
ALTER TABLE role_permission DROP CONSTRAINT role_permission_role_check;
ALTER TABLE role_permission ADD CONSTRAINT role_permission_role_check
  CHECK (role = ANY (ARRAY['employee', 'manager', 'hr_admin', 'finance_admin', 'company_admin']));

/*
 * `current_app_role()` came in with 0001 and nothing has ever called it —
 * not a policy, not a view, not a line of application code. It reads a role
 * out of the session for a model the union policy replaced: a single current
 * role is not what decides anything any more. Left in place it is a function
 * that looks authoritative and answers in the old vocabulary.
 */
DROP FUNCTION IF EXISTS current_app_role();

COMMENT ON CONSTRAINT role_permission_role_check ON role_permission IS
  'Policy layers, not assignable roles: manager belongs here because an '
  'override may be written against the derived manager layer, and nowhere '
  'else because nobody is assigned it.';
