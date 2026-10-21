-- ---------------------------------------------------------------------------
-- One-off: make every membership still awaiting an invitation ask for a
-- password.
--
-- `createUser` and `inviteUser` now set `must_change_password = true`, because
-- an invitation can only ever mean "set your password". Memberships invited
-- *before* that change carry `false`, so their link would still drop them on
-- the home page with a session and no password of their own.
--
-- ## Scope, and what is deliberately left alone
--
-- `WHERE status = 'invited'` — only accounts that have not accepted yet. An
-- account that has already accepted has a session history and possibly a
-- password; flipping the flag under it would send a working user to the
-- password screen with no explanation, which is a different kind of wrong.
--
-- On production at the time of writing that is exactly one row, VHM007
-- (prem@360.technology), who has not opened his link. VHM008
-- (Karan@360.technology) accepted his and is `active`; he is **not** in scope
-- and will set a password through Forgot password instead.
--
-- Nothing else about the row is touched: not the status, not `invite_sent_at`,
-- not `invited_count`. The link already sent stays valid, and when it is opened
-- the flag is what makes the password screen appear.
--
-- ## Guards
--
-- Aborts unless, afterwards, no `invited` membership still has the flag false,
-- and unless the number of rows changed equals the number that needed changing.
-- Also asserts that no row outside `status = 'invited'` moved, which is the
-- promise this file makes about Karan's row.
--
-- Run only after a fresh `pg_dump` — docs/step-a-runbook.md §1 has the method,
-- the correct binary and the version rule.
-- ---------------------------------------------------------------------------

BEGIN;

SELECT 'before' AS stage, e.code, m.status, m.must_change_password
  FROM tenant_membership m JOIN employee e ON e.id = m.employee_id
 ORDER BY e.code;

DO $$
DECLARE
  needed         int;
  changed        int;
  others_before  int;
  others_after   int;
  still_false    int;
BEGIN
  SELECT count(*) INTO needed
    FROM tenant_membership
   WHERE status = 'invited' AND must_change_password = false;

  /* Everything not in scope, counted so it can be proved unmoved. */
  SELECT count(*) INTO others_before
    FROM tenant_membership
   WHERE status <> 'invited' AND must_change_password = true;

  RAISE NOTICE 'backfill: % invited membership(s) need the flag set', needed;

  UPDATE tenant_membership
     SET must_change_password = true
   WHERE status = 'invited' AND must_change_password = false;
  GET DIAGNOSTICS changed = ROW_COUNT;

  IF changed <> needed THEN
    RAISE EXCEPTION 'backfill changed % row(s) but % needed changing', changed, needed;
  END IF;

  SELECT count(*) INTO still_false
    FROM tenant_membership
   WHERE status = 'invited' AND must_change_password = false;
  IF still_false <> 0 THEN
    RAISE EXCEPTION 'backfill left % invited membership(s) with the flag false', still_false;
  END IF;

  SELECT count(*) INTO others_after
    FROM tenant_membership
   WHERE status <> 'invited' AND must_change_password = true;
  IF others_after <> others_before THEN
    RAISE EXCEPTION
      'backfill moved a membership outside status=invited (% before, % after) — it must not',
      others_before, others_after;
  END IF;

  RAISE NOTICE 'backfill complete: % row(s) set; nothing outside status=invited moved', changed;
END $$;

SELECT 'after' AS stage, e.code, m.status, m.must_change_password
  FROM tenant_membership m JOIN employee e ON e.id = m.employee_id
 ORDER BY e.code;

COMMIT;
