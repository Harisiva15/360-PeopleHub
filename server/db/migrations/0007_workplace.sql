-- ---------------------------------------------------------------------------
-- 0007 — helpdesk, engagement, noticeboard, documents, assets and exits
-- ---------------------------------------------------------------------------

CREATE TABLE ticket (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  reference    text NOT NULL,
  employee_id  uuid NOT NULL,
  category_id  uuid NOT NULL,
  subject      text NOT NULL,
  body         text NOT NULL,
  priority     text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
  status       text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  assignee_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Copied from the category at creation, because changing the SLA later must
  -- not retroactively breach or unbreach existing tickets.
  sla_hours    smallint NOT NULL,
  due_at       timestamptz NOT NULL,
  resolved_at  timestamptz,
  resolution_hours numeric(8, 2),
  breached     boolean NOT NULL DEFAULT false,
  csat         smallint CHECK (csat BETWEEN 1 AND 5),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reference),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, category_id) REFERENCES ticket_category (tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_id) REFERENCES employee (tenant_id, id),
  CHECK ((status IN ('resolved', 'closed')) = (resolved_at IS NOT NULL))
);

CREATE INDEX ON ticket (tenant_id, status, assignee_id);
CREATE INDEX ON ticket (tenant_id, employee_id, created_at DESC);

CREATE TABLE ticket_comment (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  ticket_id  uuid NOT NULL,
  author_id  uuid,
  body       text NOT NULL,
  -- Internal notes are not shown to the raiser.
  internal   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES ticket (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_id) REFERENCES employee (tenant_id, id)
);

CREATE INDEX ON ticket_comment (tenant_id, ticket_id, created_at);

CREATE TABLE kb_article (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  category_id uuid,
  question    text NOT NULL,
  answer      text NOT NULL,
  helpful_yes integer NOT NULL DEFAULT 0,
  helpful_no  integer NOT NULL DEFAULT 0,
  published   boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES ticket_category (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Engagement
--
-- Responses are deliberately not linked to the employee for anonymous
-- surveys — a nullable respondent_id would be a foot-gun, so anonymity is a
-- property of the survey and the column is simply not written.
-- ---------------------------------------------------------------------------

CREATE TABLE survey (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'pulse'
    CHECK (kind IN ('pulse', 'enps', 'manager_effectiveness', 'onboarding', 'exit', 'custom')),
  anonymous   boolean NOT NULL DEFAULT true,
  -- Results are withheld until this many responses exist, so a small team
  -- cannot be de-anonymised by inspection.
  min_responses_to_show smallint NOT NULL DEFAULT 5,
  sent_on     date,
  closes_on   date,
  status      text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'live', 'closed')),
  recipients  integer NOT NULL DEFAULT 0,
  responses   integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (responses <= recipients)
);

CREATE TABLE survey_question (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  survey_id  uuid NOT NULL,
  prompt     text NOT NULL,
  kind       text NOT NULL DEFAULT 'scale'
    CHECK (kind IN ('scale', 'nps', 'text', 'choice')),
  display_order smallint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, survey_id) REFERENCES survey (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE survey_response (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  question_id uuid NOT NULL,
  -- Null on an anonymous survey. Never write it for one.
  respondent_id uuid,
  -- Department is kept even when anonymous, for the driver breakdown; the
  -- min_responses_to_show floor is what stops that identifying anyone.
  department_id uuid,
  score       smallint,
  text_answer text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, question_id) REFERENCES survey_question (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, respondent_id) REFERENCES employee (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id)
);

CREATE INDEX ON survey_response (tenant_id, question_id);

CREATE TABLE announcement (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text NOT NULL,
  category    text,
  pinned      boolean NOT NULL DEFAULT false,
  author_id   uuid,
  published_on date NOT NULL DEFAULT CURRENT_DATE,
  expires_on  date,
  -- Null audience means everyone.
  department_id uuid,
  site_id     uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, author_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id)
);

CREATE INDEX ON announcement (tenant_id, published_on DESC);

-- ---------------------------------------------------------------------------
-- Documents
--
-- Bytes live in object storage, not here. This table is the metadata and the
-- permission boundary; storage_key is opaque to everything but the storage
-- adapter.
-- ---------------------------------------------------------------------------

CREATE TABLE document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- Null for tenant-level documents such as a policy handbook.
  employee_id  uuid,
  kind         text NOT NULL,
  title        text NOT NULL,
  storage_key  text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  -- sha256 of the contents, so a re-upload is detectable and a tamper is not
  -- silent.
  checksum     text,
  uploaded_by  uuid,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  expires_on   date,
  -- Set by the retention job rather than a hard delete, so the audit trail
  -- keeps the fact that a document existed.
  purged_at    timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, storage_key),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES employee (tenant_id, id)
);

CREATE INDEX ON document (tenant_id, employee_id, kind);

CREATE TABLE letter_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  letter_type_id uuid NOT NULL,
  purpose       text,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'issued', 'rejected')),
  requested_on  date NOT NULL DEFAULT CURRENT_DATE,
  issued_on     date,
  issued_by     uuid,
  -- The generated letter, once issued. A letter is a legal statement, so the
  -- issued artefact is kept rather than regenerated from today's data.
  document_id   uuid,
  reference     text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, letter_type_id) REFERENCES letter_type (tenant_id, id),
  FOREIGN KEY (tenant_id, issued_by) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES document (tenant_id, id),
  CHECK ((status = 'issued') = (issued_on IS NOT NULL))
);

-- Close the document references left open in earlier migrations.
ALTER TABLE tax_declaration_item
  ADD CONSTRAINT tax_declaration_item_proof_fkey
  FOREIGN KEY (tenant_id, proof_document_id) REFERENCES document (tenant_id, id);
ALTER TABLE expense_item
  ADD CONSTRAINT expense_item_receipt_fkey
  FOREIGN KEY (tenant_id, receipt_document_id) REFERENCES document (tenant_id, id);
ALTER TABLE candidate
  ADD CONSTRAINT candidate_resume_fkey
  FOREIGN KEY (tenant_id, resume_document_id) REFERENCES document (tenant_id, id);
ALTER TABLE enrollment
  ADD CONSTRAINT enrollment_certificate_fkey
  FOREIGN KEY (tenant_id, certificate_document_id) REFERENCES document (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------------

CREATE TABLE asset_category (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  colour     text,
  -- Straight-line depreciation life, which is what book value is computed from.
  useful_life_months smallint NOT NULL DEFAULT 36 CHECK (useful_life_months > 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE asset (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  tag          text NOT NULL,
  category_id  uuid NOT NULL,
  model        text NOT NULL,
  serial_number text,
  status       text NOT NULL DEFAULT 'in_stock'
    CHECK (status IN ('in_stock', 'assigned', 'in_repair', 'retired', 'lost')),
  -- Null unless assigned. The status and this column cannot disagree.
  employee_id  uuid,
  assigned_on  date,
  site_id      uuid,
  purchase_cost numeric(14, 2),
  currency     char(3) REFERENCES currency (code),
  purchased_on date,
  warranty_ends_on date,
  condition    text,
  vendor_name  text,
  retired_on   date,
  disposal_note text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, tag),
  FOREIGN KEY (tenant_id, category_id) REFERENCES asset_category (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id),
  CHECK ((status = 'assigned') = (employee_id IS NOT NULL))
);

CREATE INDEX ON asset (tenant_id, status);
CREATE INDEX ON asset (tenant_id, employee_id) WHERE employee_id IS NOT NULL;

CREATE TABLE asset_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL,
  category_id  uuid NOT NULL,
  model        text,
  reason       text NOT NULL,
  estimated_cost numeric(14, 2),
  -- Whether the grade already entitles them to this, which decides whether
  -- finance has to approve as well as the manager.
  entitled     boolean NOT NULL DEFAULT false,
  needs_finance boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'fulfilled')),
  raised_on    date NOT NULL DEFAULT CURRENT_DATE,
  approver_id  uuid,
  approved_on  date,
  reject_reason text,
  fulfilled_on date,
  asset_id     uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, category_id) REFERENCES asset_category (tenant_id, id),
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id),
  CHECK ((status = 'fulfilled') = (asset_id IS NOT NULL))
);

-- Custody history. Who held what, when, and why it moved.
CREATE TABLE asset_movement (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  asset_id    uuid NOT NULL,
  kind        text NOT NULL
    CHECK (kind IN ('allocated', 'returned', 'transferred', 'sent_for_repair',
                    'back_from_repair', 'retired', 'reported_lost')),
  from_employee_id uuid,
  to_employee_id   uuid,
  moved_on    date NOT NULL DEFAULT CURRENT_DATE,
  condition   text,
  note        text,
  recorded_by uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, from_employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, to_employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES employee (tenant_id, id)
);

CREATE INDEX ON asset_movement (tenant_id, asset_id, moved_on DESC);

-- ---------------------------------------------------------------------------
-- Exits
-- ---------------------------------------------------------------------------

CREATE TABLE exit_record (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  kind          text NOT NULL DEFAULT 'resignation'
    CHECK (kind IN ('resignation', 'termination', 'retirement', 'end_of_contract',
                    'abandonment', 'redundancy')),
  resigned_on   date NOT NULL,
  notice_days   smallint NOT NULL DEFAULT 30,
  last_working_day date NOT NULL,
  reason        text,
  destination   text,
  status        text NOT NULL DEFAULT 'notice_period'
    CHECK (status IN ('notice_period', 'in_clearance', 'settled', 'withdrawn')),
  -- Days of notice bought out, which shortens the last working day.
  buyout_days   smallint NOT NULL DEFAULT 0,
  rehire_eligible boolean,
  settled_on    date,
  UNIQUE (tenant_id, id),
  -- One live exit per person.
  UNIQUE (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  CHECK (last_working_day >= resigned_on),
  CHECK ((status = 'settled') = (settled_on IS NOT NULL))
);

CREATE TABLE exit_clearance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  exit_id      uuid NOT NULL,
  department   text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'cleared', 'blocked')),
  note         text,
  cleared_by   uuid,
  cleared_on   date,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, exit_id, department),
  FOREIGN KEY (tenant_id, exit_id) REFERENCES exit_record (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, cleared_by) REFERENCES employee (tenant_id, id)
);

COMMENT ON TABLE exit_clearance IS
  'An exit cannot settle while any row here is pending or blocked. Enforced in '
  'the service, because a CHECK cannot see sibling rows.';

CREATE TABLE exit_settlement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  exit_id       uuid NOT NULL,
  currency      char(3) NOT NULL REFERENCES currency (code),
  -- Positive components
  salary_payable numeric(14, 2) NOT NULL DEFAULT 0,
  leave_encashment numeric(14, 2) NOT NULL DEFAULT 0,
  gratuity      numeric(14, 2) NOT NULL DEFAULT 0,
  bonus_payable numeric(14, 2) NOT NULL DEFAULT 0,
  -- Negative components
  notice_recovery numeric(14, 2) NOT NULL DEFAULT 0,
  loan_recovery  numeric(14, 2) NOT NULL DEFAULT 0,
  asset_recovery numeric(14, 2) NOT NULL DEFAULT 0,
  tax_deducted   numeric(14, 2) NOT NULL DEFAULT 0,
  net_payable   numeric(14, 2) NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  paid_on       date,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, exit_id),
  FOREIGN KEY (tenant_id, exit_id) REFERENCES exit_record (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE exit_interview (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  exit_id      uuid NOT NULL,
  held_on      date,
  conducted_by uuid,
  overall_rating smallint CHECK (overall_rating BETWEEN 1 AND 5),
  would_recommend boolean,
  reason_given text,
  feedback     text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, exit_id),
  FOREIGN KEY (tenant_id, exit_id) REFERENCES exit_record (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conducted_by) REFERENCES employee (tenant_id, id)
);
