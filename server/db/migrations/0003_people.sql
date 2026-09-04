-- ---------------------------------------------------------------------------
-- 0003 — people
--
-- The frontend's Employee is one flat object because a screen renders one
-- moment. A payroll system has to answer "what was their grade in August",
-- so employment terms are effective-dated here and `employee` keeps only the
-- current pointers, maintained from the dated rows.
--
-- Identifiers that are regulated — PAN, national insurance numbers, bank
-- accounts — live in their own tables rather than as columns on `employee`.
-- That is not tidiness: it lets a redacting read simply not join them, and it
-- gives one place to encrypt and one place to honour a deletion request.
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
-- Regulated identifiers and bank details
-- ---------------------------------------------------------------------------

CREATE TABLE employee_identifier (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  -- 'pan', 'uan', 'pf', 'esi', 'aadhaar', 'ssn', 'sin', 'nino', 'eid',
  -- 'passport', 'work_authorisation'. Open rather than an enum, because the
  -- list grows with every country onboarded.
  kind        text NOT NULL,
  country     char(2) REFERENCES country (code),
  -- Encrypted at the application layer before it reaches here. The column is
  -- bytea to make that non-optional: you cannot accidentally write plaintext
  -- into it and have it look right.
  value_encrypted bytea NOT NULL,
  -- Last four characters, in clear, so a screen can show ****1234 without
  -- decrypting anything.
  value_hint  text,
  verified    boolean NOT NULL DEFAULT false,
  verified_on date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, kind),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE employee_identifier IS
  'National and statutory identifiers. Never returned to a caller without an '
  'explicit payroll or HR-admin permission, and never in a list response.';

CREATE TABLE employee_bank_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  bank_name     text NOT NULL,
  account_number_encrypted bytea NOT NULL,
  account_number_hint text,
  -- IFSC in India, sort code in the UK, routing number in the US.
  routing_code  text,
  currency      char(3) NOT NULL REFERENCES currency (code),
  -- Salary goes to exactly one account at a time; the rest are history.
  is_primary    boolean NOT NULL DEFAULT true,
  valid_from    date NOT NULL DEFAULT CURRENT_DATE,
  valid_to      date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX employee_bank_one_primary
  ON employee_bank_account (tenant_id, employee_id) WHERE is_primary AND valid_to IS NULL;

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

-- Close the membership link now that employees exist. Deliberately not a
-- composite key: tenant_membership is a platform table read before any tenant
-- context exists, so its tenant_id is an ordinary column.
ALTER TABLE tenant_membership
  ADD CONSTRAINT tenant_membership_employee_fkey
  FOREIGN KEY (employee_id) REFERENCES employee (id) ON DELETE SET NULL;
