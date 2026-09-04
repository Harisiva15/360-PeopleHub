-- ---------------------------------------------------------------------------
-- 0008 — the staffing business: clients, demand, bench, placements, billing
--
-- This is the revenue side, and it has a different shape from the HR side: a
-- consultant may be an employee on our payroll or a vendor's contractor, and
-- the same person can be both over time. So `consultant` is its own table with
-- an optional employee link rather than a flag on employee.
-- ---------------------------------------------------------------------------

CREATE TABLE client (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code          text NOT NULL,
  name          text NOT NULL,
  country       char(2) NOT NULL REFERENCES country (code),
  currency      char(3) NOT NULL REFERENCES currency (code),
  industry      text,
  tier          text CHECK (tier IN ('platinum', 'gold', 'silver', 'bronze')),
  status        text NOT NULL DEFAULT 'prospect'
    CHECK (status IN ('prospect', 'active', 'dormant', 'lost')),
  -- Net payment terms in days; drives receivables ageing.
  payment_terms_days smallint NOT NULL DEFAULT 30,
  credit_limit  numeric(16, 2),
  client_since  date,
  msa_signed_on date,
  msa_expires_on date,
  owner_id      uuid,
  delivery_head_id uuid,
  engagement_model text,
  -- Vendor management system the client requires submissions through.
  vms           text,
  nps           smallint,
  risk_flag     boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, delivery_head_id) REFERENCES employee (tenant_id, id)
);

CREATE INDEX ON client (tenant_id, status);

ALTER TABLE project
  ADD CONSTRAINT project_client_fkey
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id);

CREATE TABLE client_contact (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  client_id  uuid NOT NULL,
  full_name  text NOT NULL,
  title      text,
  email      citext,
  phone      text,
  is_primary boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX ON client_contact (tenant_id, client_id);

CREATE TABLE sow (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  client_id     uuid NOT NULL,
  code          text NOT NULL,
  title         text NOT NULL,
  kind          text,
  currency      char(3) NOT NULL REFERENCES currency (code),
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  contract_value numeric(16, 2) NOT NULL DEFAULT 0,
  burned_value  numeric(16, 2) NOT NULL DEFAULT 0,
  headcount     smallint NOT NULL DEFAULT 0,
  filled        smallint NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'renewal_due', 'expired', 'terminated')),
  purchase_order text,
  signed_by     text,
  owner_id      uuid,
  billing_cycle text NOT NULL DEFAULT 'monthly',
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_id) REFERENCES employee (tenant_id, id),
  CHECK (ends_on > starts_on),
  CHECK (filled <= headcount)
);

CREATE INDEX ON sow (tenant_id, client_id, status);

CREATE TABLE rate_card (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  client_id  uuid NOT NULL,
  role       text NOT NULL,
  seniority  text,
  currency   char(3) NOT NULL REFERENCES currency (code),
  bill_rate  numeric(12, 2) NOT NULL CHECK (bill_rate > 0),
  unit       text NOT NULL DEFAULT 'per_day' CHECK (unit IN ('per_day', 'per_hour')),
  valid_from date NOT NULL,
  valid_to   date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id) ON DELETE CASCADE,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX ON rate_card (tenant_id, client_id, role);

CREATE TABLE vendor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  country      char(2) NOT NULL REFERENCES country (code),
  currency     char(3) NOT NULL REFERENCES currency (code),
  kind         text,
  tier         text,
  contact_name text,
  contact_email citext,
  payment_terms_days smallint NOT NULL DEFAULT 45,
  -- Markup the vendor adds over the consultant's pay rate.
  markup_percent numeric(5, 2),
  msa_signed_on date,
  msa_expires_on date,
  insurance_expires_on date,
  w9_on_file   boolean NOT NULL DEFAULT false,
  coi_on_file  boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'probation', 'suspended', 'offboarded')),
  onboarded_on date,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE INDEX ON vendor (tenant_id, status);

CREATE TABLE consultant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- Set when this consultant is our own employee; null for a subcontractor.
  employee_id   uuid,
  vendor_id     uuid,
  full_name     text NOT NULL,
  email         citext,
  country       char(2) REFERENCES country (code),
  currency      char(3) REFERENCES currency (code),
  role          text NOT NULL,
  skills        text[] NOT NULL DEFAULT '{}',
  years_experience numeric(4, 1),
  work_authorisation text,
  cost_per_day  numeric(12, 2),
  status        text NOT NULL DEFAULT 'bench'
    CHECK (status IN ('internal', 'bench', 'submitted', 'placed', 'assigned', 'exited')),
  available_from date,
  -- When they landed on the bench. Bench ageing and carrying cost read this.
  bench_since   date,
  rolled_off_from uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendor (tenant_id, id),
  -- Either ours or a vendor's, never both and never neither.
  CHECK ((employee_id IS NOT NULL) <> (vendor_id IS NOT NULL))
);

CREATE INDEX ON consultant (tenant_id, status);
CREATE INDEX ON consultant (tenant_id, bench_since) WHERE status = 'bench';

CREATE TABLE staffing_requirement (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code         text NOT NULL,
  client_id    uuid NOT NULL,
  sow_id       uuid,
  title        text NOT NULL,
  role         text NOT NULL,
  skills       text[] NOT NULL DEFAULT '{}',
  location     text,
  currency     char(3) NOT NULL REFERENCES currency (code),
  bill_rate    numeric(12, 2) NOT NULL CHECK (bill_rate > 0),
  unit         text NOT NULL DEFAULT 'per_day' CHECK (unit IN ('per_day', 'per_hour')),
  positions    smallint NOT NULL DEFAULT 1 CHECK (positions > 0),
  filled       smallint NOT NULL DEFAULT 0 CHECK (filled >= 0),
  -- Clients cap how many candidates we may put forward.
  max_submissions smallint,
  priority     text,
  duration     text,
  received_on  date NOT NULL DEFAULT CURRENT_DATE,
  close_by     date,
  recruiter_id uuid,
  source       text,
  vms          text,
  status       text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'filled', 'closed', 'lost', 'on_hold')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sow_id) REFERENCES sow (tenant_id, id),
  FOREIGN KEY (tenant_id, recruiter_id) REFERENCES employee (tenant_id, id),
  CHECK (filled <= positions)
);

CREATE INDEX ON staffing_requirement (tenant_id, status, client_id);

CREATE TABLE submission (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  requirement_id uuid NOT NULL,
  consultant_id uuid NOT NULL,
  vendor_id     uuid,
  submitted_by  uuid,
  submitted_on  date NOT NULL DEFAULT CURRENT_DATE,
  currency      char(3) NOT NULL REFERENCES currency (code),
  unit          text NOT NULL DEFAULT 'per_day' CHECK (unit IN ('per_day', 'per_hour')),
  bill_rate     numeric(12, 2) NOT NULL CHECK (bill_rate > 0),
  pay_rate      numeric(12, 2) NOT NULL CHECK (pay_rate >= 0),
  -- Stored rather than computed: the rates can be renegotiated later and the
  -- margin at submission is what the pipeline report means.
  margin_percent numeric(5, 2),
  stage         text NOT NULL DEFAULT 'submitted',
  -- Right-to-represent: without a signed RTR the client can reject on process.
  rtr_signed    boolean NOT NULL DEFAULT false,
  rtr_signed_on date,
  rtr_valid_days smallint,
  -- Recruiter ownership expires, after which anyone may resubmit the person.
  owning_recruiter_id uuid,
  ownership_until date,
  interview_on  date,
  feedback      text,
  UNIQUE (tenant_id, id),
  -- The same person is not submitted to the same requirement twice.
  UNIQUE (tenant_id, requirement_id, consultant_id),
  FOREIGN KEY (tenant_id, requirement_id) REFERENCES staffing_requirement (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, consultant_id) REFERENCES consultant (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendor (tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, owning_recruiter_id) REFERENCES employee (tenant_id, id),
  CHECK (bill_rate >= pay_rate)
);

CREATE INDEX ON submission (tenant_id, requirement_id, stage);

CREATE TABLE placement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  submission_id uuid,
  consultant_id uuid NOT NULL,
  client_id     uuid NOT NULL,
  sow_id        uuid,
  requirement_id uuid,
  vendor_id     uuid,
  role          text NOT NULL,
  location      text,
  currency      char(3) NOT NULL REFERENCES currency (code),
  unit          text NOT NULL DEFAULT 'per_day' CHECK (unit IN ('per_day', 'per_hour')),
  bill_rate     numeric(12, 2) NOT NULL CHECK (bill_rate > 0),
  pay_rate      numeric(12, 2) NOT NULL CHECK (pay_rate >= 0),
  margin_percent numeric(5, 2),
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  actual_end_on date,
  extensions    smallint NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'active', 'ending_soon', 'completed', 'terminated')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, submission_id),
  FOREIGN KEY (tenant_id, submission_id) REFERENCES submission (tenant_id, id),
  FOREIGN KEY (tenant_id, consultant_id) REFERENCES consultant (tenant_id, id),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id),
  FOREIGN KEY (tenant_id, sow_id) REFERENCES sow (tenant_id, id),
  FOREIGN KEY (tenant_id, requirement_id) REFERENCES staffing_requirement (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendor (tenant_id, id),
  CHECK (ends_on >= starts_on),
  CHECK (bill_rate >= pay_rate)
);

CREATE INDEX ON placement (tenant_id, status, client_id);
CREATE INDEX ON placement (tenant_id, consultant_id);

ALTER TABLE consultant
  ADD CONSTRAINT consultant_rolled_off_fkey
  FOREIGN KEY (tenant_id, rolled_off_from) REFERENCES placement (tenant_id, id);

-- Hours a placed consultant billed, which is what an invoice line sums.
CREATE TABLE placement_timesheet (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  placement_id  uuid NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  units         numeric(8, 2) NOT NULL CHECK (units >= 0),
  approved_by_client boolean NOT NULL DEFAULT false,
  approved_on   date,
  invoice_id    uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, placement_id, period_start),
  FOREIGN KEY (tenant_id, placement_id) REFERENCES placement (tenant_id, id) ON DELETE CASCADE,
  CHECK (period_end >= period_start)
);

CREATE TABLE invoice (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  number        text NOT NULL,
  client_id     uuid NOT NULL,
  sow_id        uuid,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  currency      char(3) NOT NULL REFERENCES currency (code),
  subtotal      numeric(16, 2) NOT NULL DEFAULT 0,
  tax_rate      numeric(5, 2) NOT NULL DEFAULT 0,
  tax_amount    numeric(16, 2) NOT NULL DEFAULT 0,
  total         numeric(16, 2) NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'disputed', 'written_off')),
  issued_on     date,
  due_on        date,
  paid_on       date,
  submitted_via text,
  dispute_note  text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, id),
  FOREIGN KEY (tenant_id, sow_id) REFERENCES sow (tenant_id, id),
  CHECK (period_end >= period_start),
  CHECK (total = subtotal + tax_amount),
  CHECK ((status = 'paid') = (paid_on IS NOT NULL))
);

CREATE INDEX ON invoice (tenant_id, status, due_on);
CREATE INDEX ON invoice (tenant_id, client_id, issued_on DESC);

CREATE TABLE invoice_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  invoice_id   uuid NOT NULL,
  placement_id uuid,
  description  text NOT NULL,
  units        numeric(8, 2) NOT NULL,
  unit_rate    numeric(12, 2) NOT NULL,
  amount       numeric(16, 2) NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, placement_id) REFERENCES placement (tenant_id, id)
);

CREATE INDEX ON invoice_line (tenant_id, invoice_id);

ALTER TABLE placement_timesheet
  ADD CONSTRAINT placement_timesheet_invoice_fkey
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice (tenant_id, id);
