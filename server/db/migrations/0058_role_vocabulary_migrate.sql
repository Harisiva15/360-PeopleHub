-- ---------------------------------------------------------------------------
-- Step B of three: move the stored role values to the new vocabulary.
--
-- Step A (0056) widened four CHECK constraints to accept both vocabularies at
-- once, so from that point a row may legally hold either name. This migration
-- is the only one of the three that touches a row:
--
--     tenant_membership.role          'admin' -> 'company_admin'
--     employee.app_role              'admin' -> 'company_admin'
--     role_permission.role           'admin' -> 'company_admin'
--     joining_request.requested_role 'admin' -> 'company_admin'
--
-- Everything else is deliberately left alone:
--
--   * `'employee'` is valid in both vocabularies and means the same thing, so
--     no employee row moves.
--
--   * `'manager'` rows in `role_permission` stay exactly as they are. The
--     manager layer is derived from `employee.manager_id` rather than held as
--     a role, but `role_permission` is a *narrowing* table and its `manager`
--     rows still narrow the derived layer. Step C keeps `'manager'` in this
--     one constraint for that reason.
--
--   * No rows are created for `hr_admin` or `finance_admin`. `role_permission`
--     only ever narrows, so an absent row means "no narrowing applied" and the
--     role gets the policy ceiling. Inserting permissive rows here would
--     invert the table's meaning.
--
--   * `audit_log.detail` holds historical JSON that may mention `admin`. Those
--     are records of what happened under the old vocabulary and are not
--     rewritten; an audit trail that edits itself is not one.
--
-- ## This migration is also a fix, not only a rename
--
-- `auth/overrides.ts` builds the override map and skips any row whose role is
-- not one of the four current names:
--
--     if (!(ROLE_NAMES as string[]).includes(r.role)) continue;
--
-- `'admin'` is not in `ROLE_NAMES`. So from the moment step A's code went live,
-- every `role_permission` row holding `'admin'` stopped being applied — and 18
-- of the 33 rows in production narrow something (11 withhold `approve`, 7
-- withhold `write`). Because this table only ever narrows, dropping those rows
-- *widens* access rather than restricting it: `company_admin` is currently
-- getting the policy ceiling on those modules instead of the configured limit.
--
-- Nothing is exposed to a lower role by this — the only two accounts affected
-- hold `company_admin`, and the lost rows were a top role's self-imposed
-- limits. But it is a live, unintended widening, and this migration is what
-- ends it: once the rows say `company_admin`, `overridesFor` applies them
-- again.
--
-- ## The collision, and why `company_admin` wins
--
-- `role_permission` carries `UNIQUE (tenant_id, role, module)`. A plain
-- `UPDATE ... SET role = 'company_admin'` therefore fails if a `company_admin`
-- row already exists for the same tenant and module. Production holds no
-- `company_admin` rows today, so the update would succeed as written — but the
-- Access settings screen is live and now writes the new vocabulary, so one save
-- before this migration runs creates exactly that conflict. A local database
-- seeded with all six values already has 46 of them.
--
-- Where both exist, the `company_admin` row is kept and the `admin` row is
-- deleted. That is not a coin toss:
--
--   * the `admin` row is already being ignored by the running code, per the
--     `ROLE_NAMES` filter above, so deleting it removes nothing that is
--     currently in effect;
--   * a `company_admin` row can only have been written *after* step A
--     deployed, so it is the more recent expression of intent.
--
-- ## Why the assertions are relative and not absolute
--
-- Production today holds 2 `admin` memberships, 2 `admin` employees and 33
-- `admin` role_permission rows. Those numbers are *not* written into the guard
-- below, because this migration also runs against a fresh local cluster and in
-- CI, where they are different or zero. The guard captures each count before
-- the update and asserts the move was exact — so it is just as strict, and it
-- is strict everywhere rather than only here.
--
-- Reversing this is a single UPDATE in the other direction, and is safe for as
-- long as step C has not narrowed the constraints. The one part that does not
-- reverse is a deleted colliding row, which is why only rows the running code
-- already ignores are ever deleted. See docs/roles-migration.md.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tm_before   int;
  emp_before  int;
  rp_before   int;
  jr_before   int;

  tm_moved    int;
  emp_moved   int;
  rp_moved    int;
  rp_dropped  int;
  jr_moved    int;

  rp_manager_before int;
  rp_manager_after  int;

  leftover    int;
BEGIN
  -- What is there to move, and what must not move.
  SELECT count(*) INTO tm_before  FROM tenant_membership  WHERE role = 'admin';
  SELECT count(*) INTO emp_before FROM employee           WHERE app_role = 'admin';
  SELECT count(*) INTO rp_before  FROM role_permission    WHERE role = 'admin';
  SELECT count(*) INTO jr_before  FROM joining_request    WHERE requested_role = 'admin';
  SELECT count(*) INTO rp_manager_before
    FROM role_permission WHERE role = 'manager';

  RAISE NOTICE 'step B before: tenant_membership=% employee=% role_permission=% joining_request=% (manager rows kept=%)',
    tm_before, emp_before, rp_before, jr_before, rp_manager_before;

  UPDATE tenant_membership SET role = 'company_admin' WHERE role = 'admin';
  GET DIAGNOSTICS tm_moved = ROW_COUNT;

  UPDATE employee SET app_role = 'company_admin' WHERE app_role = 'admin';
  GET DIAGNOSTICS emp_moved = ROW_COUNT;

  /*
   * The legacy row loses to the row the running code is already using. See the
   * header: an 'admin' row is skipped by overridesFor, so this deletes nothing
   * that is currently in effect.
   */
  DELETE FROM role_permission a
   WHERE a.role = 'admin'
     AND EXISTS (
       SELECT 1 FROM role_permission b
        WHERE b.tenant_id = a.tenant_id
          AND b.module    = a.module
          AND b.role      = 'company_admin');
  GET DIAGNOSTICS rp_dropped = ROW_COUNT;

  UPDATE role_permission SET role = 'company_admin' WHERE role = 'admin';
  GET DIAGNOSTICS rp_moved = ROW_COUNT;

  UPDATE joining_request SET requested_role = 'company_admin' WHERE requested_role = 'admin';
  GET DIAGNOSTICS jr_moved = ROW_COUNT;

  RAISE NOTICE 'step B moved:  tenant_membership=% employee=% role_permission=% (+% dropped as duplicates) joining_request=%',
    tm_moved, emp_moved, rp_moved, rp_dropped, jr_moved;

  -- 1. Every row that was there to move was either moved or dropped as a
  --    duplicate. Nothing was skipped and nothing was invented.
  IF tm_moved <> tm_before
     OR emp_moved <> emp_before
     OR rp_moved + rp_dropped <> rp_before
     OR jr_moved <> jr_before THEN
    RAISE EXCEPTION
      'step B did not account for every row (tm %/%, emp %/%, rp %+%/%, jr %/%)',
      tm_moved, tm_before, emp_moved, emp_before,
      rp_moved, rp_dropped, rp_before, jr_moved, jr_before;
  END IF;

  -- 2. Nothing anywhere still says 'admin'.
  SELECT (SELECT count(*) FROM tenant_membership WHERE role = 'admin')
       + (SELECT count(*) FROM employee          WHERE app_role = 'admin')
       + (SELECT count(*) FROM role_permission   WHERE role = 'admin')
       + (SELECT count(*) FROM joining_request   WHERE requested_role = 'admin')
    INTO leftover;

  IF leftover <> 0 THEN
    RAISE EXCEPTION 'step B left % row(s) holding the old value ''admin''', leftover;
  END IF;

  -- 3. The manager rows were not collateral damage.
  SELECT count(*) INTO rp_manager_after
    FROM role_permission WHERE role = 'manager';

  IF rp_manager_after <> rp_manager_before THEN
    RAISE EXCEPTION
      'step B changed the role_permission manager rows (% before, % after) — it must not',
      rp_manager_before, rp_manager_after;
  END IF;

  RAISE NOTICE 'step B complete: no row holds ''admin''; % manager rows untouched',
    rp_manager_after;
END $$;
