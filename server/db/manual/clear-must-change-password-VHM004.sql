-- ---------------------------------------------------------------------------
-- Clear must_change_password for VHM004, and nothing else.
--
-- NOT A MIGRATION. It lives in db/manual because it is a one-off repair to one
-- row, it is not idempotent in any useful sense, and it must never be replayed
-- by migrate.mjs on another database. Nothing picks this file up automatically.
--
-- ## When to run it
--
-- Only if Hari is stuck on "Set a new password" on the live code and the reset
-- will not complete. If the reset completes, the application clears the flag
-- itself and writes a `user.password_changed` audit row — which is the better
-- outcome, because it proves the path works.
--
-- ## What set the flag
--
-- `user.password_reset` by the HR Administrator on 2026-10-01 20:32:16. It has
-- been true ever since, and VHM004 has not signed in since 2026-09-23. The
-- deploy did not set it and today's reset did not set it; the deploy only made
-- a pre-existing flag reachable while everything else was failing.
--
-- ## Why by code and not by id
--
-- `employee.code` is the thing a human can check against the screen in front of
-- them. The id is in the runbook, but a mistyped uuid still finds *a* row, while
-- a mistyped code finds none and the guard below stops.
--
-- ## Run it as the owner
--
--     cd server
--     node -e "..."   -- see the runbook, or psql with MIGRATE_DATABASE_URL
--
-- As app_rw this needs a tenant in the session, and the point of a one-off
-- repair is to not be arranging session variables by hand.
-- ---------------------------------------------------------------------------

BEGIN;

-- Before. Expect exactly one row: VHM004, must_change_password = true.
SELECT e.code, e.full_name, m.role, m.status, m.must_change_password
  FROM tenant_membership m
  JOIN employee e ON e.id = m.employee_id
 WHERE e.code = 'VHM004';

-- The change. Scoped by employee code, and only where the flag is actually set,
-- so running it twice is a no-op rather than a second write.
UPDATE tenant_membership m
   SET must_change_password = false
  FROM employee e
 WHERE e.id = m.employee_id
   AND e.code = 'VHM004'
   AND m.must_change_password;

-- The guard. Anything other than exactly one row changed means the WHERE did
-- not mean what it looked like, and the whole thing is rolled back.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM tenant_membership m
    JOIN employee e ON e.id = m.employee_id
   WHERE e.code = 'VHM004' AND m.must_change_password = false;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'expected exactly 1 cleared row for VHM004, found %. Nothing committed.', n;
  END IF;
END;
$$;

-- After. Expect must_change_password = false, and every other column as before.
SELECT e.code, e.full_name, m.role, m.status, m.must_change_password
  FROM tenant_membership m
  JOIN employee e ON e.id = m.employee_id
 WHERE e.code = 'VHM004';

-- Nobody else touched. Expect VHM005 false and VHM006 false, unchanged.
SELECT e.code, m.must_change_password
  FROM tenant_membership m
  JOIN employee e ON e.id = m.employee_id
 ORDER BY e.code;

-- Read the four results above, then commit. ROLLBACK costs nothing.
COMMIT;
