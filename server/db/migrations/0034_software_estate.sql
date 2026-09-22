-- ---------------------------------------------------------------------------
-- 0034 — the software estate
--
-- **A licence is not a laptop.** The asset register has held software licences
-- under a LICENCE category since 0004, with a serial number, a warranty date
-- and a depreciation curve — none of which a subscription has. What a
-- subscription has is a seat count you renew, and the two questions worth
-- asking are what renews next and what are we paying for that nobody opens.
-- Neither is answerable from a table shaped like an inventory.
--
-- So this is its own pair of tables, shaped around seats and renewals. The
-- asset register keeps its LICENCE rows: those are boxed, perpetual licences
-- issued as kit, and where one is issued to a person the seat here points at
-- it so the two registers cannot disagree about who has what.
--
-- **Seats bought and seats used are different numbers and both are kept.**
-- Deriving the purchase from the assignments would make the register unable to
-- say the one thing it exists to say — that you are paying for forty seats and
-- using twenty-six.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS software_product (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (btrim(name) <> ''),
  vendor        text NOT NULL CHECK (btrim(vendor) <> ''),
  category      text NOT NULL CHECK (category IN (
    'Productivity', 'Engineering', 'Design', 'Security',
    'Sales & marketing', 'Finance', 'People'
  )),
  plan          text NOT NULL DEFAULT '',
  -- What the company pays for. Zero is legitimate — a free tier being tracked
  -- because it holds company data — and is not the same as unlimited.
  seats         integer NOT NULL DEFAULT 0 CHECK (seats >= 0),
  -- Rupees per seat per year, whichever way it is billed. Storing the annual
  -- figure and the billing period separately is what lets a monthly plan and
  -- an annual one be compared without a conversion at every call site.
  unit_cost_pa  numeric(14, 2) NOT NULL DEFAULT 0 CHECK (unit_cost_pa >= 0),
  billing       text NOT NULL DEFAULT 'Annual' CHECK (billing IN ('Annual', 'Monthly')),
  renews_on     date NOT NULL,
  -- The person who signs for it, not the administrator who recorded it.
  owner_id      uuid,
  status        text NOT NULL DEFAULT 'Active'
    CHECK (status IN ('Active', 'Trial', 'Cancelled')),
  -- Whether sign-in goes through the company identity provider. A security
  -- question, kept here because this is the only place that knows the estate.
  sso           boolean NOT NULL DEFAULT false,
  -- Whether the vendor holds employee personal data. Drives the processor
  -- register a data-protection review asks for, and nothing else knows it.
  holds_personal_data boolean NOT NULL DEFAULT false,
  notes         text NOT NULL DEFAULT '',
  created_on    date NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES employee (tenant_id, id)
    ON DELETE SET NULL
);

-- One row per product. Two "Figma" rows is how an estate stops being able to
-- answer what it costs.
CREATE UNIQUE INDEX IF NOT EXISTS software_product_name_unique
  ON software_product (tenant_id, lower(name));

-- The renewal calendar: the read on the landing tab, always time-ordered and
-- always excluding what has been cancelled.
CREATE INDEX IF NOT EXISTS software_product_renewal_idx
  ON software_product (tenant_id, renews_on)
  WHERE status <> 'Cancelled';

SELECT apply_tenant_isolation('software_product');

-- ---------------------------------------------------------------------------
-- who is on it
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS software_seat (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  product_id   uuid NOT NULL,
  employee_id  uuid NOT NULL,
  assigned_on  date NOT NULL DEFAULT CURRENT_DATE,
  -- Null where the seat has been paid for and never opened, which is the
  -- expensive case and deliberately distinguishable from "opened long ago".
  last_used_on date,
  -- Set where the asset register issued this as kit. The two registers then
  -- describe one grant, and revoking it happens in the register that issued
  -- it rather than in both.
  asset_id     uuid,
  CHECK (last_used_on IS NULL OR last_used_on >= assigned_on),
  UNIQUE (tenant_id, id),
  -- Nobody holds the same product twice. Without this the seat count drifts
  -- upward every time somebody is re-added, and the company buys seats it
  -- already has.
  UNIQUE (tenant_id, product_id, employee_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES software_product (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, asset_id) REFERENCES asset (tenant_id, id)
    ON DELETE SET NULL
);

-- Counting the seats on a product is every row of the estate screen.
CREATE INDEX IF NOT EXISTS software_seat_product_idx
  ON software_seat (tenant_id, product_id);

-- "What does this person have", asked on every offboarding.
CREATE INDEX IF NOT EXISTS software_seat_employee_idx
  ON software_seat (tenant_id, employee_id);

-- The reclamation list: seats nobody has opened. Partial on the null case
-- because a seat never opened is the one worth finding first.
CREATE INDEX IF NOT EXISTS software_seat_never_used_idx
  ON software_seat (tenant_id, product_id)
  WHERE last_used_on IS NULL;

SELECT apply_tenant_isolation('software_seat');

COMMENT ON TABLE software_seat IS
  'One person on one subscription. asset_id points at the asset register row '
  'where IT issued the licence as kit, so the two registers describe one grant '
  'rather than disagreeing about it. See 0034.';
