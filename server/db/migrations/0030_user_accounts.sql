-- ---------------------------------------------------------------------------
-- 0030 — the user account gets a lifecycle
--
-- `tenant_membership` has been the user account since 0001: it holds the login
-- (a Supabase auth user), the role, the employee the login acts as, and a
-- status of invited / active / suspended. What it has never held is the rest
-- of the lifecycle an administrator actually works with.
--
-- **Deactivated is not suspended.** Suspended is a sanction — somebody is
-- being investigated, and the account is held. Inactive is an ordinary
-- administrative state: a leaver, a contractor between engagements, an account
-- parked until someone comes back. Collapsing them means an audit cannot tell
-- a disciplinary hold from a routine offboarding, which is exactly the
-- distinction an audit is asked about.
--
-- **Pending approval is not invited.** A manager-raised account waits on an
-- administrator; an invited account waits on the person themselves. Both look
-- "not active yet" and neither is actionable in the same way.
--
-- **Deleted is a status, not a DELETE.** Removing the row would take the
-- audit trail's subject with it and orphan every historical reference. The
-- employment record is not identity and must outlive the login, which is why
-- 0001 made the login's removal cascade to the membership and stop there.
--
-- Two things an administrator is always asked and the schema could not answer:
-- when this account last signed in, and how many times its invitation has been
-- sent. Both live here rather than being inferred from the audit log, because
-- a log is a history and these are current facts about the row.
-- ---------------------------------------------------------------------------

ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_status_check;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_status_check
  CHECK (status IN (
    'pending_approval',  -- raised by a manager, waiting on an administrator
    'invited',           -- invitation sent, not yet accepted
    'active',
    'inactive',          -- deactivated administratively; may be reactivated
    'suspended',         -- held as a sanction
    'deleted'            -- soft-deleted; login revoked, history retained
  ));

ALTER TABLE tenant_membership
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  -- How many times the invitation has gone out, and when it last did. A
  -- resend is a fact about the account, not an event to reconstruct.
  ADD COLUMN IF NOT EXISTS invited_count smallint NOT NULL DEFAULT 1
    CHECK (invited_count >= 0),
  ADD COLUMN IF NOT EXISTS invite_sent_at timestamptz,
  -- Set when an administrator resets a password out of band.
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  -- Who moved it out of active, and when. Null while the account is live.
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivated_by uuid,
  ADD COLUMN IF NOT EXISTS deactivation_reason text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid,
  -- Who raised it, for an account that came in through a manager's request.
  ADD COLUMN IF NOT EXISTS requested_by uuid,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_deactivated_by_fk;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_deactivated_by_fk
  FOREIGN KEY (tenant_id, deactivated_by) REFERENCES employee (tenant_id, id);

ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_deleted_by_fk;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_deleted_by_fk
  FOREIGN KEY (tenant_id, deleted_by) REFERENCES employee (tenant_id, id);

ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_requested_by_fk;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_requested_by_fk
  FOREIGN KEY (tenant_id, requested_by) REFERENCES employee (tenant_id, id);

ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_approved_by_fk;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_approved_by_fk
  FOREIGN KEY (tenant_id, approved_by) REFERENCES employee (tenant_id, id);

-- A state that names an actor has to have one. Without this the columns are
-- documentation rather than a guarantee, and the first bug is an account that
-- is deleted with nobody accountable for it.
ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_deletion_is_attributed;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_deletion_is_attributed
  CHECK (status <> 'deleted' OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL));

ALTER TABLE tenant_membership DROP CONSTRAINT IF EXISTS tenant_membership_approval_is_attributed;
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_approval_is_attributed
  CHECK (approved_at IS NULL OR approved_by IS NOT NULL);

-- The list is always "the accounts that are not gone", ordered by status.
CREATE INDEX IF NOT EXISTS tenant_membership_live_idx
  ON tenant_membership (tenant_id, status)
  WHERE status <> 'deleted';

-- ---------------------------------------------------------------------------
-- bulk upload runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_import (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  uploaded_by   uuid NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  file_name     text NOT NULL,
  file_size     integer NOT NULL CHECK (file_size >= 0),
  -- What the file contained and what became of it. Kept as counts rather than
  -- recomputed from the rows, because rows are pruned and a run's outcome is
  -- the thing an administrator is answering for months later.
  total_rows    integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  created_rows  integer NOT NULL DEFAULT 0 CHECK (created_rows >= 0),
  updated_rows  integer NOT NULL DEFAULT 0 CHECK (updated_rows >= 0),
  skipped_rows  integer NOT NULL DEFAULT 0 CHECK (skipped_rows >= 0),
  failed_rows   integer NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
  status        text NOT NULL DEFAULT 'validating'
    CHECK (status IN ('validating', 'reviewing', 'importing', 'completed', 'failed', 'cancelled')),
  -- The per-row verdicts, so the error report can be downloaded afterwards
  -- rather than regenerated from a file nobody kept.
  rows          jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES employee (tenant_id, id),
  -- The parts have to add up to the whole, or the summary is fiction.
  CHECK (created_rows + updated_rows + skipped_rows + failed_rows <= total_rows)
);

CREATE INDEX IF NOT EXISTS user_import_recent_idx
  ON user_import (tenant_id, uploaded_at DESC);

SELECT apply_tenant_isolation('user_import');
