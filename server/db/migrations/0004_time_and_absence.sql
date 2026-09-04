-- ---------------------------------------------------------------------------
-- 0004 — attendance, rosters, overtime, timesheets and leave
--
-- These are the highest-volume tables in the product: one attendance row per
-- person per day, one roster row per person per day. At 5,000 employees that
-- is ~2.5m rows a year each, so they are the ones worth indexing deliberately
-- and, past a few years, partitioning by date.
-- ---------------------------------------------------------------------------

CREATE TABLE attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  work_date   date NOT NULL,
  -- P present, W work-from-home, A absent, L on leave, H holiday, O week off.
  status      char(1) NOT NULL CHECK (status IN ('P', 'W', 'A', 'L', 'H', 'O')),
  punch_in    timestamptz,
  punch_out   timestamptz,
  -- Denormalised from the punches because every report sums it.
  worked_minutes integer NOT NULL DEFAULT 0 CHECK (worked_minutes >= 0),
  late        boolean NOT NULL DEFAULT false,
  site_id     uuid,
  shift_id    uuid,
  -- Where the punch happened, and how far from the site's fence.
  latitude    numeric(9, 6),
  longitude   numeric(9, 6),
  distance_m  integer,
  -- Null when the site has no fence configured; false is a real exception.
  geo_ok      boolean,
  source      text NOT NULL DEFAULT 'web'
    CHECK (source IN ('web', 'mobile', 'biometric', 'kiosk', 'import', 'system')),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- One row per person per day. A second punch updates this row.
  UNIQUE (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shift (tenant_id, id),
  CHECK (punch_out IS NULL OR punch_in IS NULL OR punch_out >= punch_in)
);

-- Month-range reads dominate: "this person, this month" and "this site, today".
CREATE INDEX ON attendance (tenant_id, work_date, site_id);
CREATE INDEX ON attendance (tenant_id, employee_id, work_date DESC);

-- A correction to an attendance row, which a manager approves. Separate from
-- attendance because it has its own approval state and its own audit trail.
CREATE TABLE regularisation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  attendance_id uuid NOT NULL,
  employee_id   uuid NOT NULL,
  requested_in  timestamptz,
  requested_out timestamptz,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  raised_on     date NOT NULL DEFAULT CURRENT_DATE,
  approver_id   uuid,
  acted_on      date,
  approver_note text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendance (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employee (tenant_id, id),
  -- An approved or rejected request has to say when and by whom.
  CHECK (status = 'pending' OR (approver_id IS NOT NULL AND acted_on IS NOT NULL))
);

CREATE INDEX ON regularisation (tenant_id, status, employee_id);

-- One row per person per rostered day.
CREATE TABLE roster_entry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  work_date   date NOT NULL,
  -- Null shift means a week off.
  shift_id    uuid,
  is_week_off boolean NOT NULL DEFAULT false,
  published   boolean NOT NULL DEFAULT false,
  -- The employee acknowledges a change; unacknowledged changes are chased.
  acknowledged_at timestamptz,
  assigned_by uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shift (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES employee (tenant_id, id),
  CHECK (is_week_off = (shift_id IS NULL))
);

CREATE INDEX ON roster_entry (tenant_id, work_date, shift_id);

CREATE TABLE overtime (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL,
  work_date    date NOT NULL,
  hours        numeric(4, 1) NOT NULL CHECK (hours > 0 AND hours <= 12),
  reason       text NOT NULL,
  -- Comp off is credited to the leave balance on approval; overtime pay goes
  -- to the next payroll run. Approving does both in one transaction.
  compensation text NOT NULL CHECK (compensation IN ('comp_off', 'overtime_pay')),
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  approver_id  uuid,
  approved_on  date,
  -- Set when the comp-off credit has actually been written, so a retry cannot
  -- credit twice.
  credited_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employee (tenant_id, id),
  CHECK (status <> 'approved' OR approver_id IS NOT NULL)
);

CREATE INDEX ON overtime (tenant_id, status, employee_id);

-- ---------------------------------------------------------------------------
-- Timesheets
-- ---------------------------------------------------------------------------

CREATE TABLE timesheet (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL,
  -- Always a Monday. The unique below is what stops two sheets for one week.
  week_start   date NOT NULL,
  status       text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'returned')),
  total_hours  numeric(6, 2) NOT NULL DEFAULT 0 CHECK (total_hours >= 0),
  submitted_on date,
  approver_id  uuid,
  acted_on     date,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, week_start),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employee (tenant_id, id),
  -- An empty sheet cannot be submitted; the service refuses it and so does this.
  CHECK (status = 'draft' OR total_hours > 0)
);

CREATE INDEX ON timesheet (tenant_id, status, week_start DESC);

-- One row per project per task per day. The frontend groups these into rows of
-- seven; storing them per day is what makes "hours on project X in September"
-- a plain aggregate rather than array arithmetic.
CREATE TABLE timesheet_entry (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  timesheet_id uuid NOT NULL,
  project_id   uuid NOT NULL,
  task         text NOT NULL DEFAULT '',
  work_date    date NOT NULL,
  hours        numeric(4, 2) NOT NULL CHECK (hours >= 0 AND hours <= 24),
  billable     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, timesheet_id, project_id, task, work_date),
  FOREIGN KEY (tenant_id, timesheet_id) REFERENCES timesheet (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES project (tenant_id, id)
);

CREATE INDEX ON timesheet_entry (tenant_id, project_id, work_date);

-- ---------------------------------------------------------------------------
-- Leave
--
-- The balance is a stored row rather than a computed sum. Both are defensible;
-- this way the ledger below is the audit trail and the balance is the answer,
-- which means a report does not re-derive entitlement rules from history.
-- ---------------------------------------------------------------------------

CREATE TABLE leave_balance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  -- Leave years do not always match the financial year.
  year_start    date NOT NULL,
  quota         numeric(6, 1) NOT NULL DEFAULT 0 CHECK (quota >= 0),
  carried_over  numeric(6, 1) NOT NULL DEFAULT 0 CHECK (carried_over >= 0),
  used          numeric(6, 1) NOT NULL DEFAULT 0 CHECK (used >= 0),
  encashed      numeric(6, 1) NOT NULL DEFAULT 0 CHECK (encashed >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, leave_type_id, year_start),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_type (tenant_id, id)
);

COMMENT ON COLUMN leave_balance.used IS
  'Debited when a request is approved, not when it is applied for. Credited '
  'back on cancellation. leave_ledger is the trail of every such movement.';

CREATE TABLE leave_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  days          numeric(5, 1) NOT NULL CHECK (days > 0),
  -- 'first_half' or 'second_half' on a single-day request.
  half_day      text CHECK (half_day IN ('first_half', 'second_half')),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  applied_on    date NOT NULL DEFAULT CURRENT_DATE,
  approver_id   uuid,
  acted_on      date,
  approver_note text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_type (tenant_id, id),
  FOREIGN KEY (tenant_id, approver_id) REFERENCES employee (tenant_id, id),
  CHECK (ends_on >= starts_on),
  CHECK (half_day IS NULL OR starts_on = ends_on),
  CHECK (status = 'pending' OR acted_on IS NOT NULL)
);

CREATE INDEX ON leave_request (tenant_id, status, employee_id);
CREATE INDEX ON leave_request (tenant_id, starts_on, ends_on);

-- Every movement of a balance, so "why is my balance 8" has an answer.
-- Append-only: corrections are new rows, never updates.
CREATE TABLE leave_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  year_start    date NOT NULL,
  -- Negative debits, positive credits.
  days          numeric(6, 1) NOT NULL CHECK (days <> 0),
  reason        text NOT NULL
    CHECK (reason IN ('accrual', 'carry_forward', 'approval', 'cancellation',
                      'encashment', 'comp_off_credit', 'quota_change', 'adjustment', 'lapse')),
  leave_request_id uuid,
  overtime_id   uuid,
  note          text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_type (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_request_id) REFERENCES leave_request (tenant_id, id),
  FOREIGN KEY (tenant_id, overtime_id) REFERENCES overtime (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employee (tenant_id, id)
);

CREATE INDEX ON leave_ledger (tenant_id, employee_id, created_at DESC);

-- A leave request is debited exactly once. This is the double-approval guard
-- the frontend services already enforce, made structural.
CREATE UNIQUE INDEX leave_ledger_one_approval_per_request
  ON leave_ledger (tenant_id, leave_request_id) WHERE reason = 'approval';
