-- ---------------------------------------------------------------------------
-- Roll step B back: return the stored role values to the old vocabulary.
--
-- The reverse of 0058. Safe for exactly as long as step C has not narrowed the
-- four CHECK constraints — while they accept both vocabularies, a row may hold
-- either name, which is the whole point of the expand phase. **After step C
-- this file stops working** and the constraint will refuse it; rolling back
-- then means reverting step C's migration first.
--
--     tenant_membership.role          'company_admin' -> 'admin'
--     employee.app_role              'company_admin' -> 'admin'
--     role_permission.role           'company_admin' -> 'admin'
--     joining_request.requested_role 'company_admin' -> 'admin'
--
-- ## What this cannot restore
--
-- 0058 deletes a `role_permission` row where an `admin` row and a
-- `company_admin` row existed for the same tenant and module, because
-- `UNIQUE (tenant_id, role, module)` cannot hold both. On the production run
-- it deleted **nothing** — the notice read `+0 dropped as duplicates`, since no
-- `company_admin` rows existed yet — so this rollback is complete for that run.
-- If it is ever used after a run that dropped rows, those rows are in the
-- `pg_dump` taken beforehand and nowhere else.
--
-- ## What it deliberately does not touch
--
-- `hr_admin` and `finance_admin` rows, if any exist by then: they have no
-- counterpart in the old vocabulary and are not step B's doing.
--
-- `manager` rows in `role_permission` — 0058 left them alone and asserted so.
--
-- Running it reinstates the defect step B fixed: `auth/overrides.ts` skips any
-- role outside `ROLE_NAMES`, so `admin` rows stop being applied and the 18
-- narrowings on production stop narrowing. That widens `company_admin` rather
-- than restricting anybody, but it is the reason not to leave this applied.
--
-- Run it the same way as any manual file — from `server/`, against the host you
-- have named, after a fresh dump:
--
--     node -e "..." < db/manual/rollback-step-b.sql     (see the runbook)
--
-- ---------------------------------------------------------------------------

BEGIN;

SELECT 'before' AS when, role, count(*)::int AS n
  FROM tenant_membership GROUP BY role ORDER BY role;

DO $$
DECLARE
  tm int; emp int; rp int; jr int;
  rp_manager_before int; rp_manager_after int;
  leftover int;
BEGIN
  SELECT count(*) INTO rp_manager_before FROM role_permission WHERE role = 'manager';

  UPDATE tenant_membership SET role = 'admin' WHERE role = 'company_admin';
  GET DIAGNOSTICS tm = ROW_COUNT;

  UPDATE employee SET app_role = 'admin' WHERE app_role = 'company_admin';
  GET DIAGNOSTICS emp = ROW_COUNT;

  UPDATE role_permission SET role = 'admin' WHERE role = 'company_admin';
  GET DIAGNOSTICS rp = ROW_COUNT;

  UPDATE joining_request SET requested_role = 'admin' WHERE requested_role = 'company_admin';
  GET DIAGNOSTICS jr = ROW_COUNT;

  RAISE NOTICE 'rolled back: tenant_membership=% employee=% role_permission=% joining_request=%',
    tm, emp, rp, jr;

  -- Nothing may still hold the new name.
  SELECT (SELECT count(*) FROM tenant_membership WHERE role = 'company_admin')
       + (SELECT count(*) FROM employee          WHERE app_role = 'company_admin')
       + (SELECT count(*) FROM role_permission   WHERE role = 'company_admin')
       + (SELECT count(*) FROM joining_request   WHERE requested_role = 'company_admin')
    INTO leftover;
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'rollback left % row(s) holding ''company_admin''', leftover;
  END IF;

  -- And the manager rows are still not collateral damage.
  SELECT count(*) INTO rp_manager_after FROM role_permission WHERE role = 'manager';
  IF rp_manager_after <> rp_manager_before THEN
    RAISE EXCEPTION 'rollback changed the manager rows (% before, % after)',
      rp_manager_before, rp_manager_after;
  END IF;

  RAISE NOTICE 'rollback complete: % manager rows untouched', rp_manager_after;
END $$;

SELECT 'after' AS when, role, count(*)::int AS n
  FROM tenant_membership GROUP BY role ORDER BY role;

SELECT e.code, m.role AS membership_role, e.app_role
  FROM tenant_membership m JOIN employee e ON e.id = m.employee_id
 ORDER BY e.code;

COMMIT;
