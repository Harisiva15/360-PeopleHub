-- ---------------------------------------------------------------------------
-- Step A of three: accept both role vocabularies.
--
-- The roles changed from three to four, and `manager` stopped being a role at
-- all — answering for other people is a fact about `employee.manager_id`, not a
-- title somebody holds.
--
--     admin                  ->  company_admin
--     manager                ->  employee, with the layer derived from the tree
--     employee               ->  employee
--     (new)                  ->  hr_admin, finance_admin
--
-- Four columns constrain the old vocabulary and would reject the new one:
--
--     tenant_membership.role          tenant_membership_role_check
--     role_permission.role            role_permission_role_check
--     employee.app_role               employee_app_role_check
--     joining_request.requested_role  joining_request_requested_role_check
--
-- ## Why this is three migrations and not one
--
-- The database, Render and Pages cannot switch in the same instant, and
-- whichever goes first the gap locks everybody out. Narrow the constraint to
-- the new names and the live code's `'admin'` is rejected on the next write;
-- deploy the new code first and it writes names the constraint refuses.
--
-- So: expand, migrate, contract.
--
--     A (this one)  the constraints accept BOTH vocabularies. Nothing else
--                   changes, no row is touched, and the live code carries on
--                   writing 'admin' exactly as it does today.
--     B             a data-only migration converts the rows.
--     C             the constraints narrow to the new vocabulary alone, and
--                   session.ts stops normalising. From there 'admin' is
--                   refused by the database as well as by the policy.
--
-- This one runs BEFORE the server and frontend deploy. Widening is safe for
-- the code that is live right now — it forbids nothing that was allowed — and
-- the reverse order is not: new code writing `company_admin` against the old
-- constraint fails on the first write.
--
-- ## What this migration deliberately does not do
--
-- No row is read or written. No default changes: `employee.app_role` and
-- `joining_request.requested_role` both default to 'employee', which is valid
-- in both vocabularies and stays correct throughout.
--
-- No function changes either, which is worth stating because it was checked
-- rather than assumed. `auth_membership` passes `m.role` through verbatim and
-- compares it to nothing; `auth_claim_membership` and the two functions around
-- it insert the literal 'employee', which is valid in both. No RLS policy
-- compares a role value anywhere, and the one view does not mention role. The
-- whole SQL surface is these four constraints.
--
-- Two `'manager'` literals elsewhere are different words in different domains
-- and are left alone: `assignment_task.owner` in 0006 means a team ('hr', 'it',
-- 'finance', 'candidate'), and `job_order_recruiter.role` in 0029 means a
-- recruiter's part ('primary', 'backup').
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. tenant_membership.role — which role a login holds in a tenant.
--
-- This is the one `auth_membership` returns and `Caller.role` is built from,
-- so it is the column the whole request path depends on.
-- ---------------------------------------------------------------------------

ALTER TABLE tenant_membership
  DROP CONSTRAINT IF EXISTS tenant_membership_role_check;

ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_role_check CHECK (
    role IN (
      -- the vocabulary in the table today
      'admin', 'manager', 'employee',
      -- the vocabulary the application is moving to
      'company_admin', 'hr_admin', 'finance_admin'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. role_permission.role — the per-tenant narrowing layer.
--
-- 'manager' is NOT temporary here, and this is the one column where it
-- survives step C. The layer is narrowable on purpose: a tenant that does not
-- want managers approving leave has to have somewhere to say so, and the only
-- place to say it is the row the layer grants. Dropping 'manager' from this
-- constraint later would delete that ability.
--
-- Production holds 99 rows: 33 modules times 'admin', 'manager', 'employee'.
-- The 'admin' rows are what step B maps; the other 66 are already valid.
-- ---------------------------------------------------------------------------

ALTER TABLE role_permission
  DROP CONSTRAINT IF EXISTS role_permission_role_check;

ALTER TABLE role_permission
  ADD CONSTRAINT role_permission_role_check CHECK (
    role IN (
      -- the vocabulary in the table today
      'admin', 'manager', 'employee',
      -- the vocabulary the application is moving to. 'manager' above is also
      -- part of it: the layer is narrowable and keeps its rows after step C.
      'company_admin', 'hr_admin', 'finance_admin'
    )
  );

-- ---------------------------------------------------------------------------
-- 3. employee.app_role — the role on the person's own record.
-- ---------------------------------------------------------------------------

ALTER TABLE employee
  DROP CONSTRAINT IF EXISTS employee_app_role_check;

ALTER TABLE employee
  ADD CONSTRAINT employee_app_role_check CHECK (
    app_role IN (
      -- the vocabulary in the table today
      'admin', 'manager', 'employee',
      -- the vocabulary the application is moving to
      'company_admin', 'hr_admin', 'finance_admin'
    )
  );

-- ---------------------------------------------------------------------------
-- 4. joining_request.requested_role — what an invitation asks for.
--
-- Empty in production today, so this one is purely about not blocking the new
-- code once it deploys.
-- ---------------------------------------------------------------------------

ALTER TABLE joining_request
  DROP CONSTRAINT IF EXISTS joining_request_requested_role_check;

ALTER TABLE joining_request
  ADD CONSTRAINT joining_request_requested_role_check CHECK (
    requested_role IN (
      -- the vocabulary in the table today
      'admin', 'manager', 'employee',
      -- the vocabulary the application is moving to
      'company_admin', 'hr_admin', 'finance_admin'
    )
  );

-- ---------------------------------------------------------------------------
-- A note for whoever reads this during step C
--
-- Step C narrows these four. Three of them become
--
--     'employee', 'hr_admin', 'finance_admin', 'company_admin'
--
-- and role_permission becomes those four plus 'manager'. Narrowing is only
-- safe once step B has converted every row AND the normaliser in
-- server/src/auth/session.ts has been removed, because until then the
-- application is still willing to read 'admin' and would keep writing it back.
-- ---------------------------------------------------------------------------

COMMENT ON CONSTRAINT tenant_membership_role_check ON tenant_membership IS
  'Accepts both role vocabularies during the expand-migrate-contract rollout. '
  'Narrowed to the four new names in step C. See 0056.';
