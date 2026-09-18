-- ---------------------------------------------------------------------------
-- 0024 — an issued letter keeps its own words
--
-- `letter_request.document_id` was the plan: render the letter to a PDF, store
-- the bytes, point at them. That needs object storage, which this deployment
-- does not have, and until it does an "issued" letter is a status with nothing
-- behind it.
--
-- The offer flow already solved this in 0020 by adding `offer.letter_body`,
-- with the reasoning that applies here word for word: the letter is kept "so
-- 'what exactly did we promise' has an answer after the salary has been
-- renegotiated twice". An experience letter states a designation and a tenure;
-- a salary certificate states a number. Regenerating either from today's data
-- answers a different question from the one the letter answered when it went
-- out, and the difference is exactly what somebody will later dispute.
--
-- So the rendered text is frozen on issue. `document_id` stays for the PDF,
-- once there is somewhere to put one — the text is the record either way, and
-- the PDF becomes a rendering of it rather than the only copy.
-- ---------------------------------------------------------------------------

ALTER TABLE letter_request
  ADD COLUMN IF NOT EXISTS letter_body text,
  -- A refused request says why. Without this the employee sees a status change
  -- and has to ask HR what happened.
  ADD COLUMN IF NOT EXISTS decline_reason text;

COMMENT ON COLUMN letter_request.letter_body IS
  'The letter as issued, frozen. Not regenerated from live data — see 0024.';

-- An issued letter has words; a rejected one has a reason. Both were
-- representable as neither before this.
ALTER TABLE letter_request
  DROP CONSTRAINT IF EXISTS letter_request_issued_has_body;
ALTER TABLE letter_request
  ADD CONSTRAINT letter_request_issued_has_body
  CHECK (status <> 'issued' OR letter_body IS NOT NULL);

ALTER TABLE letter_request
  DROP CONSTRAINT IF EXISTS letter_request_rejected_has_reason;
ALTER TABLE letter_request
  ADD CONSTRAINT letter_request_rejected_has_reason
  CHECK (status <> 'rejected' OR decline_reason IS NOT NULL);

CREATE INDEX IF NOT EXISTS letter_request_open_idx
  ON letter_request (tenant_id, status, requested_on DESC);
