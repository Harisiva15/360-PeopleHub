-- ---------------------------------------------------------------------------
-- 0028 — a timesheet can be rejected as well as returned
--
-- The status set has been draft / submitted / approved / returned since 0004.
-- Returned means "fix this and send it back" — the week is still yours and the
-- work is still expected. Rejected means "this will not be approved": hours
-- claimed against a project that was already closed, or a week somebody
-- submitted for a period they were not employed.
--
-- They were collapsed into one because the difference did not matter while
-- nothing read it. It matters to the person whose week it is: one is a request
-- for a correction and the other is a refusal, and telling somebody to fix
-- something that will never be accepted wastes their afternoon.
--
-- Rejected is terminal in the same way approved is — recall does not reopen
-- it, and the week is raised again rather than edited.
-- ---------------------------------------------------------------------------

ALTER TABLE timesheet DROP CONSTRAINT IF EXISTS timesheet_status_check;
ALTER TABLE timesheet
  ADD CONSTRAINT timesheet_status_check
  CHECK (status IN ('draft', 'submitted', 'approved', 'returned', 'rejected'));

-- A refusal says why. Returned already carried `note` for the same reason;
-- this makes it required for both rather than conventional.
ALTER TABLE timesheet
  DROP CONSTRAINT IF EXISTS timesheet_refusal_has_reason;
ALTER TABLE timesheet
  ADD CONSTRAINT timesheet_refusal_has_reason
  CHECK (status NOT IN ('returned', 'rejected') OR COALESCE(note, '') <> '');

COMMENT ON COLUMN timesheet.status IS
  'draft -> submitted -> approved | returned | rejected. Returned goes back to '
  'the employee to correct; rejected is terminal and needs a fresh week. '
  'See migration 0028.';
