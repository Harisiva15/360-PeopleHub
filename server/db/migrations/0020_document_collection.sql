-- ---------------------------------------------------------------------------
-- 0020 — document collection, and offers that are drafted before they go out
--
-- `document` holds stored bytes: storage_key is NOT NULL, because a row there
-- means a file exists. That makes it the wrong table for "we have asked this
-- joiner for their degree certificate and it has not arrived" -- which is the
-- question document collection is actually about, and the one that has an
-- answer long before any bytes do.
--
-- So a request is its own record. It can exist with nothing attached, carries
-- its own state, and points at a `document` row once a file lands. This
-- deployment has no object storage, so today every request lives its whole
-- life without one -- and tracking is still the useful half: HR needs to know
-- what is outstanding, not to hold the PDF.
-- ---------------------------------------------------------------------------

CREATE TABLE document_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- A joiner is asked for documents before they are an employee, so the
  -- request hangs off the onboarding journey until there is an employee to
  -- move it to. Exactly one of these is set.
  journey_id   uuid,
  employee_id  uuid,
  kind         text NOT NULL,
  label        text NOT NULL,
  mandatory    boolean NOT NULL DEFAULT true,
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'received', 'verified', 'rejected', 'waived')),
  due_on       date,
  received_on  date,
  verified_by  uuid,
  verified_on  date,
  note         text,
  -- Set when a file is actually attached, which needs object storage.
  document_id  uuid,
  display_order smallint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  -- One request per document type per person.
  UNIQUE (tenant_id, journey_id, employee_id, kind),
  FOREIGN KEY (tenant_id, journey_id) REFERENCES onboarding_journey (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, verified_by) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES document (tenant_id, id) ON DELETE SET NULL,
  -- It belongs to a joiner or to an employee, never both and never neither.
  CHECK ((journey_id IS NULL) <> (employee_id IS NULL)),
  -- A verified document says who checked it and when.
  CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_on IS NOT NULL)),
  -- Anything past 'pending' says when it arrived.
  CHECK (status IN ('pending', 'waived') OR received_on IS NOT NULL)
);

CREATE INDEX ON document_request (tenant_id, journey_id, status);
CREATE INDEX ON document_request (tenant_id, employee_id, status);

-- The letter sent with an offer, kept so "what exactly did we promise" has an
-- answer after the salary has been renegotiated twice.
ALTER TABLE offer
  ADD COLUMN IF NOT EXISTS letter_body text,
  ADD COLUMN IF NOT EXISTS released_by uuid,
  ADD COLUMN IF NOT EXISTS released_on date;

ALTER TABLE offer
  DROP CONSTRAINT IF EXISTS offer_released_by_fk;
ALTER TABLE offer
  ADD CONSTRAINT offer_released_by_fk
  FOREIGN KEY (tenant_id, released_by) REFERENCES employee (tenant_id, id);

SELECT apply_tenant_isolation('document_request');
