-- A note against the hours, not against the week.
--
-- `timesheet.note` already exists and is the wrong thing for this: it is one
-- line for a whole week, used by an approver returning a sheet. What a person
-- filling in a timesheet wants to record is what *these* hours were — "kickoff
-- call with client", "UI discussions" — and that belongs on the entry, beside
-- the hours it explains.
--
-- The table is already one row per project per task per day, so there is
-- somewhere for it to go. Empty string rather than NULL: every entry has a
-- note, most of them blank, and the alternative is every reader spelling out
-- COALESCE for a field whose absence means nothing.

ALTER TABLE timesheet_entry
  ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
