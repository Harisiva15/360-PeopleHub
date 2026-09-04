-- ---------------------------------------------------------------------------
-- 0002 — tenant configuration
--
-- The frontend keeps this as synchronous static config (src/data/org.ts and
-- friends) because it is fetched once and cached. Here it is per-tenant data:
-- every customer defines their own departments, grades, leave types and pay
-- components, so none of it can be global reference data.
--
-- Every table follows the same shape: a uuid primary key, a tenant_id, and
-- UNIQUE (tenant_id, id) so other tables can reference it without being able
-- to cross a tenant boundary. See scripts/check-schema.mjs.
-- ---------------------------------------------------------------------------

-- The employing entity. Multi-country tenants pay from several, and the
-- statutory rules follow the entity rather than the tenant.
CREATE TABLE legal_entity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code        text NOT NULL,
  legal_name  text NOT NULL,
  country     char(2) NOT NULL REFERENCES country (code),
  currency    char(3) NOT NULL REFERENCES currency (code),
  registered_address text,
  -- India: CIN / PAN / TAN. Other countries use their own, hence free text.
  tax_id      text,
  registration_id text,
  pf_code     text,
  esi_code    text,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE department (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  -- Chart colour, so every screen renders a department the same way.
  colour     text,
  head_employee_id uuid,
  parent_id  uuid,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES department (tenant_id, id)
);

CREATE TABLE site (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  city        text,
  country     char(2) NOT NULL REFERENCES country (code),
  address     text,
  timezone    text NOT NULL DEFAULT 'Asia/Kolkata',
  -- Geo-fence. A punch outside the radius is flagged, which is why the radius
  -- may not be zero: a zero fence would flag everyone.
  latitude    numeric(9, 6),
  longitude   numeric(9, 6),
  fence_radius_m integer CHECK (fence_radius_m IS NULL OR fence_radius_m > 0),
  default_shift_id uuid,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE shift (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  starts_at    time,
  ends_at      time,
  break_minutes smallint NOT NULL DEFAULT 60,
  grace_minutes smallint NOT NULL DEFAULT 10,
  is_night     boolean NOT NULL DEFAULT false,
  night_allowance numeric(12, 2),
  -- A flexible pattern has no fixed timing and is excluded from coverage.
  is_flexible  boolean NOT NULL DEFAULT false,
  colour       text,
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

ALTER TABLE site
  ADD CONSTRAINT site_default_shift_fkey
  FOREIGN KEY (tenant_id, default_shift_id) REFERENCES shift (tenant_id, id);

CREATE TABLE grade_band (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code       text NOT NULL,
  label      text NOT NULL,
  -- Ordering for the 9-box and compensation views; lower is more junior.
  rank       smallint NOT NULL,
  min_ctc    numeric(14, 2),
  max_ctc    numeric(14, 2),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (max_ctc IS NULL OR min_ctc IS NULL OR max_ctc >= min_ctc)
);

CREATE TABLE project (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  client_id   uuid,
  billable    boolean NOT NULL DEFAULT true,
  starts_on   date,
  ends_on     date,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE holiday (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  observed_on date NOT NULL,
  name       text NOT NULL,
  -- Optional holidays are chosen by the employee and do not close the office.
  optional   boolean NOT NULL DEFAULT false,
  -- Null means the whole tenant; otherwise a location-specific holiday.
  site_id    uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id)
);

-- One mandatory holiday per date per site. Two rows for the same day is the
-- bug the frontend's config screen already refuses.
CREATE UNIQUE INDEX holiday_one_per_day
  ON holiday (tenant_id, observed_on, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE optional = false;

CREATE TABLE leave_type (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  -- Days granted per year. Changing it reprices every open balance.
  annual_quota numeric(5, 1) NOT NULL DEFAULT 0 CHECK (annual_quota >= 0),
  accrual     text NOT NULL DEFAULT 'annual'
    CHECK (accrual IN ('annual', 'monthly', 'none')),
  carry_forward_max numeric(5, 1) NOT NULL DEFAULT 0,
  encashable  boolean NOT NULL DEFAULT false,
  requires_proof_after_days smallint,
  paid        boolean NOT NULL DEFAULT true,
  colour      text,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE expense_category (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  icon       text,
  -- Per-claim ceiling; an item above it is flagged rather than blocked, so
  -- the approver decides.
  limit_amount numeric(12, 2),
  receipt_required_above numeric(12, 2),
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE ticket_category (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  icon        text,
  -- The team that owns the queue, and the clock it is measured against.
  owning_department_id uuid,
  sla_hours   smallint NOT NULL DEFAULT 24 CHECK (sla_hours > 0),
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, owning_department_id) REFERENCES department (tenant_id, id)
);

CREATE TABLE loan_type (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  -- Ceiling expressed as a multiple of monthly CTC.
  max_ctc_multiple numeric(4, 2) NOT NULL DEFAULT 3,
  max_tenure_months smallint NOT NULL DEFAULT 12,
  interest_rate numeric(5, 2) NOT NULL DEFAULT 0,
  eligibility_note text,
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE letter_type (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  -- Instant letters are generated from live data; the rest queue for HR.
  instant     boolean NOT NULL DEFAULT false,
  requires_approval boolean NOT NULL DEFAULT false,
  template_body text,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- The salary structure's building blocks: Basic, HRA, PF and so on. The
-- percentages here are what generates an employee's structure.
CREATE TABLE salary_component (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL
    CHECK (kind IN ('earning', 'deduction', 'employer_contribution', 'reimbursement')),
  -- Either a percentage of another component, or a flat amount.
  percent_of_code text,
  percent      numeric(6, 3),
  flat_amount  numeric(14, 2),
  taxable      boolean NOT NULL DEFAULT true,
  -- Ordering on the payslip.
  display_order smallint NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (percent IS NOT NULL OR flat_amount IS NOT NULL)
);

-- Flexible benefit components (fuel, meal card, LTA) with their annual
-- tax-free ceilings. An allocation above the cap is refused.
CREATE TABLE fbp_component (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  annual_cap numeric(12, 2) NOT NULL CHECK (annual_cap >= 0),
  note       text,
  icon       text,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- ---------------------------------------------------------------------------
-- Access control
--
-- The frontend's PERMS table gates navigation. That is a convenience; this is
-- the authority. Roles are per-tenant so a customer can rename them, but the
-- three the contract knows about always exist.
-- ---------------------------------------------------------------------------

CREATE TABLE role_permission (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),
  -- Matches a route key in the frontend's nav, e.g. 'payroll'.
  module     text NOT NULL,
  can_read   boolean NOT NULL DEFAULT false,
  can_write  boolean NOT NULL DEFAULT false,
  can_approve boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, role, module)
);
