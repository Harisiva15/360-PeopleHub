-- ---------------------------------------------------------------------------
-- 0005 — salary, payroll, tax, expenses, loans and benefits
--
-- The rule throughout: a payslip is a *stored* document, not a query. Once a
-- cycle is paid, its numbers must never move because a config table changed
-- afterwards. So salary structures are effective-dated, payslip lines are
-- written at run time, and a locked run is immutable.
-- ---------------------------------------------------------------------------

-- Effective-dated salary structure. An increment closes the current row and
-- opens a new one, which is what lets a rerun of an old cycle reproduce it.
CREATE TABLE salary_structure (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL,
  valid_from   date NOT NULL,
  valid_to     date,
  currency     char(3) NOT NULL REFERENCES currency (code),
  annual_ctc   numeric(14, 2) NOT NULL CHECK (annual_ctc >= 0),
  annual_gross numeric(14, 2) NOT NULL CHECK (annual_gross >= 0),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX salary_structure_one_current
  ON salary_structure (tenant_id, employee_id) WHERE valid_to IS NULL;
CREATE INDEX ON salary_structure (tenant_id, employee_id, valid_from DESC);

CREATE TABLE salary_structure_line (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  salary_structure_id uuid NOT NULL,
  component_id        uuid NOT NULL,
  monthly_amount      numeric(14, 2) NOT NULL,
  annual_amount       numeric(14, 2) NOT NULL,
  display_order       smallint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, salary_structure_id, component_id),
  FOREIGN KEY (tenant_id, salary_structure_id)
    REFERENCES salary_structure (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, component_id) REFERENCES salary_component (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Payroll cycles
-- ---------------------------------------------------------------------------

CREATE TABLE pay_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL,
  -- Month key, always the first of the month. A cycle is per entity because
  -- India and the UK do not close on the same day.
  period_month date NOT NULL,
  status       text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'processing', 'paid', 'cancelled')),
  -- Once locked, no payslip in this run may be written again.
  locked       boolean NOT NULL DEFAULT false,
  run_on       date,
  paid_on      date,
  processed_by uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, legal_entity_id, period_month),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, processed_by) REFERENCES employee (tenant_id, id),
  CHECK (period_month = date_trunc('month', period_month)::date),
  -- A paid run has to say when it was paid, and is always locked.
  CHECK (status <> 'paid' OR (paid_on IS NOT NULL AND locked))
);

CREATE INDEX ON pay_run (tenant_id, period_month DESC);

CREATE TABLE payslip (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  pay_run_id   uuid NOT NULL,
  employee_id  uuid NOT NULL,
  currency     char(3) NOT NULL REFERENCES currency (code),
  days_in_month smallint NOT NULL,
  paid_days    numeric(5, 2) NOT NULL,
  loss_of_pay_days numeric(5, 2) NOT NULL DEFAULT 0,
  gross        numeric(14, 2) NOT NULL,
  total_deductions numeric(14, 2) NOT NULL,
  reimbursements numeric(14, 2) NOT NULL DEFAULT 0,
  net_pay      numeric(14, 2) NOT NULL,
  employer_pf  numeric(14, 2) NOT NULL DEFAULT 0,
  employer_esi numeric(14, 2) NOT NULL DEFAULT 0,
  -- The regime in force when this slip was cut, not the current one.
  tax_regime   text,
  annual_tax   numeric(14, 2) NOT NULL DEFAULT 0,
  monthly_ctc  numeric(14, 2) NOT NULL DEFAULT 0,
  country      char(2) NOT NULL REFERENCES country (code),
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, pay_run_id, employee_id),
  FOREIGN KEY (tenant_id, pay_run_id) REFERENCES pay_run (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  CHECK (net_pay = gross - total_deductions + reimbursements)
);

CREATE INDEX ON payslip (tenant_id, employee_id, generated_at DESC);

-- Every line as printed. Stored rather than recomputed, so reopening a March
-- payslip in December shows March's numbers.
CREATE TABLE payslip_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  payslip_id  uuid NOT NULL,
  kind        text NOT NULL
    CHECK (kind IN ('earning', 'deduction', 'employer_contribution', 'reimbursement')),
  label       text NOT NULL,
  amount      numeric(14, 2) NOT NULL,
  -- 'statutory' marks PF/ESI/PT/TDS for the compliance reports.
  tag         text,
  display_order smallint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, payslip_id) REFERENCES payslip (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX ON payslip_line (tenant_id, payslip_id);

-- Off-cycle inputs for a run: bonus, arrears, incentive, one-off deductions.
CREATE TABLE pay_input (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  pay_run_id  uuid NOT NULL,
  employee_id uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('bonus', 'arrears', 'incentive', 'deduction')),
  amount      numeric(14, 2) NOT NULL,
  note        text,
  entered_by  uuid,
  entered_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, pay_run_id) REFERENCES pay_run (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, entered_by) REFERENCES employee (tenant_id, id)
);

CREATE INDEX ON pay_input (tenant_id, pay_run_id);

-- The bank advice generated when a run is processed.
CREATE TABLE bank_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  pay_run_id   uuid NOT NULL,
  bank_name    text NOT NULL,
  currency     char(3) NOT NULL REFERENCES currency (code),
  total_amount numeric(16, 2) NOT NULL,
  record_count integer NOT NULL,
  reference    text NOT NULL,
  status       text NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'sent', 'acknowledged', 'failed')),
  generated_on date NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, pay_run_id) REFERENCES pay_run (tenant_id, id) ON DELETE CASCADE
);

-- PF, ESI, PT and TDS remittances, with their statutory due dates.
CREATE TABLE compliance_payment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL,
  period_month date NOT NULL,
  kind        text NOT NULL,
  amount      numeric(16, 2) NOT NULL,
  due_on      date NOT NULL,
  paid_on     date,
  challan_ref text,
  status      text NOT NULL DEFAULT 'due'
    CHECK (status IN ('due', 'paid', 'overdue')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, legal_entity_id, period_month, kind),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entity (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Tax declarations
-- ---------------------------------------------------------------------------

CREATE TABLE tax_declaration (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  -- Financial year start, e.g. 2026-04-01.
  fy_start      date NOT NULL,
  regime        text NOT NULL DEFAULT 'new' CHECK (regime IN ('new', 'old')),
  status        text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'verified', 'rejected')),
  submitted_on  date,
  verified_on   date,
  verified_by   uuid,
  proofs_note   text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, fy_start),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, verified_by) REFERENCES employee (tenant_id, id),
  -- The regime locks on verification; the API refuses a change after this.
  CHECK (status <> 'verified' OR verified_on IS NOT NULL)
);

CREATE TABLE tax_declaration_item (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  declaration_id uuid NOT NULL,
  -- '80C_elss', 'hra_rent', 'landlord_pan' and so on.
  code           text NOT NULL,
  amount         numeric(14, 2),
  text_value     text,
  proof_document_id uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, declaration_id, code),
  FOREIGN KEY (tenant_id, declaration_id)
    REFERENCES tax_declaration (tenant_id, id) ON DELETE CASCADE,
  CHECK (amount IS NOT NULL OR text_value IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Loans and advances
-- ---------------------------------------------------------------------------

CREATE TABLE loan (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  loan_type_id  uuid NOT NULL,
  principal     numeric(14, 2) NOT NULL CHECK (principal > 0),
  tenure_months smallint NOT NULL CHECK (tenure_months > 0),
  emi           numeric(14, 2) NOT NULL CHECK (emi > 0),
  interest_rate numeric(5, 2) NOT NULL DEFAULT 0,
  outstanding   numeric(14, 2) NOT NULL CHECK (outstanding >= 0),
  instalments_paid smallint NOT NULL DEFAULT 0,
  currency      char(3) NOT NULL REFERENCES currency (code),
  reason        text,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'closed', 'rejected', 'written_off')),
  requested_on  date NOT NULL DEFAULT CURRENT_DATE,
  sanctioned_on date,
  closed_on     date,
  approver_id   uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, loan_type_id) REFERENCES loan_type (tenant_id, id),
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employee (tenant_id, id),
  CHECK (outstanding <= principal),
  CHECK (status <> 'active' OR sanctioned_on IS NOT NULL)
);

CREATE INDEX ON loan (tenant_id, status, employee_id);

-- One row per EMI actually recovered, tied to the run that recovered it.
CREATE TABLE loan_repayment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  loan_id     uuid NOT NULL,
  pay_run_id  uuid,
  amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
  principal_part numeric(14, 2) NOT NULL DEFAULT 0,
  interest_part  numeric(14, 2) NOT NULL DEFAULT 0,
  recovered_on date NOT NULL,
  UNIQUE (tenant_id, id),
  -- One recovery per loan per run: a rerun must not double-recover.
  UNIQUE (tenant_id, loan_id, pay_run_id),
  FOREIGN KEY (tenant_id, loan_id) REFERENCES loan (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, pay_run_id) REFERENCES pay_run (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------

CREATE TABLE expense_claim (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  title         text NOT NULL,
  currency      char(3) NOT NULL REFERENCES currency (code),
  total_amount  numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  status        text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'reimbursed')),
  submitted_on  date,
  approver_id   uuid,
  acted_on      date,
  -- Reimbursement rides on a payroll run, so the link is explicit.
  reimbursed_in_run uuid,
  reimbursed_on date,
  note          text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, reimbursed_in_run) REFERENCES pay_run (tenant_id, id),
  -- Only an approved claim can be reimbursed. The API enforces this too; here
  -- it is structural.
  CHECK (status <> 'reimbursed' OR reimbursed_on IS NOT NULL)
);

CREATE INDEX ON expense_claim (tenant_id, status, employee_id);

CREATE TABLE expense_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  claim_id    uuid NOT NULL,
  category_id uuid NOT NULL,
  spent_on    date NOT NULL,
  amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
  merchant    text,
  description text,
  project_id  uuid,
  receipt_document_id uuid,
  -- Set at submission if the amount exceeds the category limit. Flagged, not
  -- blocked: the approver decides.
  over_limit  boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES expense_claim (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, category_id) REFERENCES expense_category (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project (tenant_id, id)
);

CREATE INDEX ON expense_item (tenant_id, claim_id);

CREATE TABLE travel_advance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL,
  amount       numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency     char(3) NOT NULL REFERENCES currency (code),
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'settled')),
  requested_on date NOT NULL DEFAULT CURRENT_DATE,
  approver_id  uuid,
  settled_amount numeric(14, 2) NOT NULL DEFAULT 0,
  settled_on   date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employee (tenant_id, id),
  CHECK (settled_amount <= amount)
);

-- ---------------------------------------------------------------------------
-- Benefits
-- ---------------------------------------------------------------------------

CREATE TABLE insurance_policy (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  insurer      text,
  kind         text NOT NULL CHECK (kind IN ('medical', 'accident', 'life', 'other')),
  renews_on    date,
  annual_premium_per_head numeric(12, 2),
  currency     char(3) REFERENCES currency (code),
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- Sum insured varies by grade, which is why this is a table and not a column.
CREATE TABLE insurance_cover (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  policy_id  uuid NOT NULL,
  grade_id   uuid NOT NULL,
  sum_insured numeric(14, 2) NOT NULL CHECK (sum_insured >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, policy_id, grade_id),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES insurance_policy (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, grade_id) REFERENCES grade_band (tenant_id, id)
);

CREATE TABLE fbp_plan (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL,
  fy_start     date NOT NULL,
  -- Budget carved out of special allowance that may be reallocated.
  pool         numeric(14, 2) NOT NULL DEFAULT 0 CHECK (pool >= 0),
  status       text NOT NULL DEFAULT 'not_declared'
    CHECK (status IN ('not_applicable', 'not_declared', 'declared', 'locked')),
  -- The last date a revision can take effect inside the financial year.
  locks_on     date,
  declared_on  date,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, fy_start),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE fbp_allocation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  plan_id      uuid NOT NULL,
  component_id uuid NOT NULL,
  amount       numeric(14, 2) NOT NULL CHECK (amount >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, plan_id, component_id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES fbp_plan (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, component_id) REFERENCES fbp_component (tenant_id, id)
);

COMMENT ON TABLE fbp_allocation IS
  'The per-component ceiling and the pool total are enforced in the service, '
  'not here: a CHECK cannot see the component cap or sum its siblings.';
