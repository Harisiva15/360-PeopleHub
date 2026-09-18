-- ---------------------------------------------------------------------------
-- 0027 — permissions carry a scope, not a boolean
--
-- `role_permission` has said since 0002 that it is the authority on what each
-- role may do. It has never been read by anything, it covered nine of
-- thirty-three modules, and its three booleans cannot express the rule the
-- services actually enforce.
--
-- Almost every rule in this system is about *how much* rather than *whether*.
-- A manager reads leave for their team; an employee reads their own; an admin
-- reads all. `can_read = true` flattens those three into one answer and loses
-- precisely the part that matters — so a table claiming to be the authority
-- would have been authoritative about the wrong thing.
--
-- So each of read, write and approve becomes a scope. 'own' is the caller's
-- own records; 'team' is those plus everyone below them in the reporting tree
-- at any depth, because a skip-level manager still answers for the people two
-- levels down; 'all' is the tenant.
--
-- The booleans go rather than staying alongside. Two representations of one
-- fact is how they end up disagreeing, and nothing read these.
-- ---------------------------------------------------------------------------

ALTER TABLE role_permission
  ADD COLUMN IF NOT EXISTS read_scope    text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS write_scope   text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS approve_scope text NOT NULL DEFAULT 'none';

-- Carry the old booleans across before they go: true became 'all', which is
-- what a boolean meant when somebody wrote it.
UPDATE role_permission SET
  read_scope    = CASE WHEN can_read    THEN 'all' ELSE 'none' END,
  write_scope   = CASE WHEN can_write   THEN 'all' ELSE 'none' END,
  approve_scope = CASE WHEN can_approve THEN 'all' ELSE 'none' END;

ALTER TABLE role_permission
  DROP COLUMN IF EXISTS can_read,
  DROP COLUMN IF EXISTS can_write,
  DROP COLUMN IF EXISTS can_approve;

ALTER TABLE role_permission
  DROP CONSTRAINT IF EXISTS role_permission_scopes;
ALTER TABLE role_permission
  ADD CONSTRAINT role_permission_scopes CHECK (
    read_scope    IN ('none', 'own', 'team', 'all') AND
    write_scope   IN ('none', 'own', 'team', 'all') AND
    approve_scope IN ('none', 'own', 'team', 'all')
  );

-- ---------------------------------------------------------------------------
-- You cannot write what you cannot read, and you cannot approve it either
--
-- Not a style rule. A grant that let somebody change a record they cannot see
-- is a grant nobody can audit: there would be no screen on which the change is
-- visible to the person who made it. Made structural so a future edit to this
-- table cannot express it.
-- ---------------------------------------------------------------------------

ALTER TABLE role_permission
  DROP CONSTRAINT IF EXISTS role_permission_write_within_read;
ALTER TABLE role_permission
  ADD CONSTRAINT role_permission_write_within_read CHECK (
    CASE read_scope WHEN 'all' THEN 3 WHEN 'team' THEN 2 WHEN 'own' THEN 1 ELSE 0 END
    >=
    GREATEST(
      CASE write_scope   WHEN 'all' THEN 3 WHEN 'team' THEN 2 WHEN 'own' THEN 1 ELSE 0 END,
      CASE approve_scope WHEN 'all' THEN 3 WHEN 'team' THEN 2 WHEN 'own' THEN 1 ELSE 0 END
    )
  );

COMMENT ON TABLE role_permission IS
  'What each role may do, per module, with the reach of each grant. Seeded '
  'from server/src/auth/policy.ts, which is the definition; the services are '
  'the enforcement. See migration 0027.';
