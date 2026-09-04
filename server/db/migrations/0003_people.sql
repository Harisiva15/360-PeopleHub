-- ---------------------------------------------------------------------------
-- 0003 — people
--
-- The frontend's Employee is one flat object because a screen renders one
-- moment. A payroll system has to answer "what was their grade in August",
-- so employment terms are effective-dated here and `employee` keeps only the
-- current pointers, maintained from the dated rows.
--
-- Regulated identifiers — PAN, national insurance numbers, bank accounts —
-- are deliberately not stored at all yet. See the note further down for what
-- that costs and what has to arrive with them when they come back.
-- ---------------------------------------------------------------------------

CREATE TABLE employee (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- Payroll code, e.g. TT1042. Unique within the tenant, and the thing humans
  -- quote at each other.
  code          text NOT NULL,
  full_name     text NOT NULL,
  preferred_name text,
  work_email    citext NOT NULL,
  personal_email citext,
  phone         text,
  gender        text CHECK (gender IN ('M', 'F', 'X', 'undisclosed')),
  date_of_birth date,
  blood_group   text,
  address       text,
  emergency_contact text,

  -- Employment
  legal_entity_id uuid NOT NULL,
  joined_on     date NOT NULL,
  -- Date of leaving. Null while active; set when an exit settles.
  left_on       date,
  status        text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'on_notice', 'exited', 'suspended')),
  employment_type text NOT NULL DEFAULT 'permanent'
    CHECK (employment_type IN ('permanent', 'contract', 'intern', 'consultant')),
  on_probation  boolean NOT NULL DEFAULT false,
  probation_ends_on date,
  notice_days   smallint NOT NULL DEFAULT 30,

  -- Current position. Derived from employment_record; kept here because every
  -- directory screen reads it and a lateral join per row is not worth it.
  department_id uuid,
  site_id       uuid,
  grade_id      uuid,
  shift_id      uuid,
  designation   text,
  manager_id    uuid,
  -- Annual cost to company in the employee's own currency.
  ctc           numeric(14, 2),
  currency      char(3) REFERENCES currency (code),

  -- What this person may do in the product. Mirrors AppRole; the authoritative
  -- copy for a login is tenant_membership.role.
  app_role      text NOT NULL DEFAULT 'employee'
    CHECK (app_role IN ('admin', 'manager', 'employee')),

  exit_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, work_email),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id),
  FOREIGN KEY (tenant_id, grade_id) REFERENCES grade_band (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shift (tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id) REFERENCES employee (tenant_id, id),
  CHECK (left_on IS NULL OR left_on >= joined_on),
  -- Nobody reports to themselves.
  CHECK (manager_id IS NULL OR manager_id <> id)
);

COMMENT ON COLUMN employee.ctc IS
  'Compensation. Redact for callers without payroll permission — do not send and hide.';

-- The directory reads are "everyone in my scope", so the manager tree and the
-- active filter are what need covering.
CREATE INDEX ON employee (tenant_id, manager_id) WHERE status <> 'exited';
CREATE INDEX ON employee (tenant_id, department_id);
CREATE INDEX ON employee (tenant_id, status);

-- Now that employee exists, close the two forward references from 0002.
ALTER TABLE department
  ADD CONSTRAINT department_head_fkey
  FOREIGN KEY (tenant_id, head_employee_id) REFERENCES employee (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Effective-dated employment terms
--
-- One row per change. `valid_to` null means current. An increment, a transfer
-- and a promotion are all the same shape, which is why they are one table.
-- ---------------------------------------------------------------------------

CREATE TABLE employment_record (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  valid_from    date NOT NULL,
  valid_to      date,
  reason        text NOT NULL
    CHECK (reason IN ('hire', 'promotion', 'increment', 'transfer', 'role_change',
                      'probation_confirmed', 'correction', 'exit')),
  department_id uuid,
  site_id       uuid,
  grade_id      uuid,
  designation   text,
  manager_id    uuid,
  ctc           numeric(14, 2),
  currency      char(3) REFERENCES currency (code),
  note          text,
  recorded_by   uuid,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id),
  FOREIGN KEY (tenant_id, grade_id) REFERENCES grade_band (tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES employee (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX ON employment_record (tenant_id, employee_id, valid_from DESC);

-- Exactly one open record per person: two "current" grades is how payroll
-- starts paying the wrong number.
CREATE UNIQUE INDEX employment_record_one_current
  ON employment_record (tenant_id, employee_id) WHERE valid_to IS NULL;

-- ---------------------------------------------------------------------------
-- Regulated identifiers and bank details: deliberately NOT stored
--
-- PAN, national insurance numbers, Aadhaar and bank accounts are out of scope
-- for now. Not storing them is the strongest control available: there is no
-- encryption to get wrong, no key to rotate, no field to redact, and nothing
-- to disclose if this database is ever breached.
--
-- What that costs, so nobody discovers it during a go-live:
--
--   * Payroll can compute a payslip but cannot pay anyone. Disbursement needs
--     a bank account, so bank_batch has nothing to generate from.
--   * Indian TDS filing needs PAN. Form 16 and the 24Q return cannot be
--     produced, and tax_declaration can hold the investment amounts but not
--     the landlord PAN that a rent claim over ₹1,00,000 legally requires.
--   * PF and ESI registration need UAN and ESI numbers.
--
-- In other words: everything except actually moving money and filing returns.
--
-- When these come back, they belong in their own tables rather than as columns
-- on employee — so a redacting read simply does not join them — with values in
-- bytea columns encrypted before they reach the database, and a hint column
-- holding the last four characters for ****1234 display. Add them in a new
-- migration alongside the encryption code, in one commit, so the schema and
-- the protection arrive together.
-- ---------------------------------------------------------------------------

CREATE TABLE employee_skill (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  skill       text NOT NULL,
  -- Self-assessed 1-5, used by the staffing match engine.
  proficiency smallint CHECK (proficiency BETWEEN 1 AND 5),
  years       numeric(4, 1),
  primary_skill boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, skill),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX ON employee_skill (tenant_id, skill);

-- The employee timeline: joined, confirmed, promoted, transferred, resigned.
CREATE TABLE lifecycle_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  occurred_on date NOT NULL,
  kind        text NOT NULL,
  title       text NOT NULL,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX ON lifecycle_event (tenant_id, employee_id, occurred_on DESC);

-- Close the membership link now that employees exist.
--
-- Composite, like every other reference between tenant-scoped rows. The
-- checker exempts tenant_membership because it sits outside the isolation
-- policy, but the exemption is about *policies*, not about referential
-- integrity: a membership in one tenant pointing at another tenant's employee
-- is exactly the leak the composite key exists to prevent, and this one
-- decides whose payslips a login can open.
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_employee_fkey
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE SET NULL;
