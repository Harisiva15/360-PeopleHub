-- ---------------------------------------------------------------------------
-- 0029 — a requirement becomes a job order: commercials, an SLA, an assignment
--        and a history
--
-- `staffing_requirement` has held the shape of a job order since 0008 — client,
-- SOW, title, role, skills, location, bill rate, positions, priority, dates,
-- recruiter, VMS, status. What it has never held is the four things a
-- recruitment desk actually runs on.
--
-- **The commercials were half there.** A bill rate with no pay rate cannot say
-- what an order is worth, and every margin in the product was being derived
-- from the submission instead — which means an order nobody has submitted to
-- has no economics at all. Pay rate, markup and the salary band live on the
-- order now, and the submission's rates stay as the negotiated actuals.
--
-- **The engagement terms were assumed.** Contract, contract-to-hire and direct
-- hire are different products with different commercials, and W2 / 1099 / C2C
-- is the single most load-bearing field on a US staffing order — it decides
-- who may be submitted at all. Both were being carried in the `duration` free
-- text or not at all.
--
-- **There was no SLA.** `close_by` is a target fill date wearing a vague name,
-- and on its own it cannot say whether an order is on track: an order due in
-- ten days with no submissions is in trouble and an order due tomorrow with
-- three candidates at interview is not. Submission, interview and fill each
-- get their own target, so "behind" can be said about the stage that is
-- actually behind.
--
-- **An order had one recruiter.** `recruiter_id` names who owns it; it cannot
-- say who covers them, who manages the desk, or what any of them were asked to
-- deliver. `job_assignment` is that, and it is a table rather than more
-- columns because an order is reassigned — and reassignment is the event a
-- desk argues about, so it is kept rather than overwritten.
--
-- **Nothing recorded what happened.** Not who reviewed the order, not when
-- sourcing started, not why it went on hold. `job_activity` is an append-only
-- history of the order: no updates, no deletes, and every row says who.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- the order's commercials and engagement terms
-- ---------------------------------------------------------------------------

ALTER TABLE staffing_requirement
  -- What kind of engagement is being sold. Distinct from employment_type:
  -- a contract-to-hire order is a contract that converts, and it can be W2 or
  -- C2C on the way there.
  ADD COLUMN IF NOT EXISTS job_type text
    CHECK (job_type IN ('contract', 'contract_to_hire', 'full_time', 'part_time')),
  -- How the person is engaged and paid. On a US desk this gates who may be
  -- put forward at all, which is why it is constrained rather than free text.
  ADD COLUMN IF NOT EXISTS employment_type text
    CHECK (employment_type IN ('w2', 'c2c', 'ten99', 'direct_hire')),
  ADD COLUMN IF NOT EXISTS pay_rate numeric(12, 2) CHECK (pay_rate IS NULL OR pay_rate > 0),
  -- Stored, not derived. The markup a desk quotes is a commercial decision
  -- that survives the rates moving underneath it, and recomputing it from
  -- bill/pay would silently rewrite history every time a rate is renegotiated.
  ADD COLUMN IF NOT EXISTS markup_pct numeric(6, 2) CHECK (markup_pct IS NULL OR markup_pct >= 0),
  -- The band for a permanent order, where there is no rate to quote.
  ADD COLUMN IF NOT EXISTS salary_min numeric(14, 2) CHECK (salary_min IS NULL OR salary_min > 0),
  ADD COLUMN IF NOT EXISTS salary_max numeric(14, 2) CHECK (salary_max IS NULL OR salary_max > 0),
  ADD COLUMN IF NOT EXISTS work_mode text
    CHECK (work_mode IN ('onsite', 'hybrid', 'remote')),
  -- Free text rather than a set: work authorisation is jurisdictional, and a
  -- fixed list would be a US list quietly imposed on every other country.
  ADD COLUMN IF NOT EXISTS work_auth text,
  ADD COLUMN IF NOT EXISTS shift text,
  ADD COLUMN IF NOT EXISTS experience_min smallint
    CHECK (experience_min IS NULL OR experience_min >= 0),
  ADD COLUMN IF NOT EXISTS experience_max smallint
    CHECK (experience_max IS NULL OR experience_max >= 0),
  ADD COLUMN IF NOT EXISTS education text,
  ADD COLUMN IF NOT EXISTS certifications text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS primary_tech text,
  ADD COLUMN IF NOT EXISTS preferred_skills text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS start_on date,
  ADD COLUMN IF NOT EXISTS end_on date,
  ADD COLUMN IF NOT EXISTS po_number text,
  ADD COLUMN IF NOT EXISTS vendor_id uuid,
  ADD COLUMN IF NOT EXISTS account_manager_id uuid,
  ADD COLUMN IF NOT EXISTS sales_owner_id uuid;

-- A band is a band, not two numbers that happen to sit together.
ALTER TABLE staffing_requirement DROP CONSTRAINT IF EXISTS staffing_requirement_salary_band;
ALTER TABLE staffing_requirement
  ADD CONSTRAINT staffing_requirement_salary_band
  CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_max >= salary_min);

ALTER TABLE staffing_requirement DROP CONSTRAINT IF EXISTS staffing_requirement_experience_band;
ALTER TABLE staffing_requirement
  ADD CONSTRAINT staffing_requirement_experience_band
  CHECK (experience_min IS NULL OR experience_max IS NULL OR experience_max >= experience_min);

-- The margin has to exist for the order to be worth taking. This is the
-- cheapest possible statement of that: a pay rate above the bill rate is a
-- loss on every hour worked, and it is always a typo.
ALTER TABLE staffing_requirement DROP CONSTRAINT IF EXISTS staffing_requirement_rates_make_sense;
ALTER TABLE staffing_requirement
  ADD CONSTRAINT staffing_requirement_rates_make_sense
  CHECK (pay_rate IS NULL OR pay_rate < bill_rate);

-- These three are people, and a job order that names a person who is not an
-- employee of this tenant is a cross-tenant reference. The composite key makes
-- that unrepresentable rather than merely wrong.
ALTER TABLE staffing_requirement DROP CONSTRAINT IF EXISTS staffing_requirement_vendor_fk;
ALTER TABLE staffing_requirement
  ADD CONSTRAINT staffing_requirement_vendor_fk
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendor (tenant_id, id);

ALTER TABLE staffing_requirement DROP CONSTRAINT IF EXISTS staffing_requirement_am_fk;
ALTER TABLE staffing_requirement
  ADD CONSTRAINT staffing_requirement_am_fk
  FOREIGN KEY (tenant_id, account_manager_id) REFERENCES employee (tenant_id, id);

ALTER TABLE staffing_requirement DROP CONSTRAINT IF EXISTS staffing_requirement_sales_fk;
ALTER TABLE staffing_requirement
  ADD CONSTRAINT staffing_requirement_sales_fk
  FOREIGN KEY (tenant_id, sales_owner_id) REFERENCES employee (tenant_id, id);

-- 'draft' and 'cancelled' complete the lifecycle. An order being written is
-- not an open order — it must not appear on a recruiter's desk or in a fill
-- rate — and an order that was cancelled is not the same as one that was
-- worked and lost, which 'closed' and 'lost' already distinguish.
ALTER TABLE staffing_requirement DROP CONSTRAINT IF EXISTS staffing_requirement_status_check;
ALTER TABLE staffing_requirement
  ADD CONSTRAINT staffing_requirement_status_check
  CHECK (status IN ('draft', 'open', 'on_hold', 'filled', 'closed', 'lost', 'cancelled'));

-- ---------------------------------------------------------------------------
-- the SLA
-- ---------------------------------------------------------------------------

ALTER TABLE staffing_requirement
  -- When the clock started. Distinct from received_on: an order can sit as a
  -- draft for a week before anybody is asked to work it, and holding the desk
  -- to the day it arrived would be measuring the wrong thing.
  ADD COLUMN IF NOT EXISTS opened_on date,
  ADD COLUMN IF NOT EXISTS target_submit_on date,
  ADD COLUMN IF NOT EXISTS target_interview_on date,
  ADD COLUMN IF NOT EXISTS target_fill_on date,
  ADD COLUMN IF NOT EXISTS sla_days smallint CHECK (sla_days IS NULL OR sla_days > 0);

-- The targets are a sequence. Interview before submission is not a tighter
-- SLA, it is a data-entry error.
ALTER TABLE staffing_requirement DROP CONSTRAINT IF EXISTS staffing_requirement_sla_order;
ALTER TABLE staffing_requirement
  ADD CONSTRAINT staffing_requirement_sla_order
  CHECK (
    (target_submit_on IS NULL OR target_interview_on IS NULL
      OR target_interview_on >= target_submit_on)
    AND (target_interview_on IS NULL OR target_fill_on IS NULL
      OR target_fill_on >= target_interview_on)
    AND (target_submit_on IS NULL OR target_fill_on IS NULL
      OR target_fill_on >= target_submit_on)
  );

-- Everything already on the books opened when it arrived, and its existing
-- close_by is its fill target. Backfilled rather than left null so "days open"
-- and the SLA indicator mean something on day one instead of after the next
-- edit of every row.
UPDATE staffing_requirement
   SET opened_on      = COALESCE(opened_on, received_on),
       target_fill_on = COALESCE(target_fill_on, close_by)
 WHERE opened_on IS NULL OR target_fill_on IS NULL;

-- Days open is the commonest read on the whole module — every dashboard tile,
-- every aging list — and it is always scoped to the open ones.
CREATE INDEX IF NOT EXISTS staffing_requirement_open_aging_idx
  ON staffing_requirement (tenant_id, opened_on)
  WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- who is working it
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_assignment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  requirement_id   uuid NOT NULL,
  recruiter_id     uuid NOT NULL,
  -- Primary owns it, backup covers it, manager runs the desk. One row per
  -- person per role, so "the backup" is a question with one answer.
  role             text NOT NULL CHECK (role IN ('primary', 'backup', 'manager')),
  assigned_on      date NOT NULL DEFAULT CURRENT_DATE,
  assigned_by_id   uuid,
  -- What this person was asked to deliver on this order. Null where no target
  -- was set, which is different from a target of zero.
  target_submissions smallint CHECK (target_submissions IS NULL OR target_submissions >= 0),
  target_interviews  smallint CHECK (target_interviews IS NULL OR target_interviews >= 0),
  target_hires       smallint CHECK (target_hires IS NULL OR target_hires >= 0),
  daily_submissions  smallint CHECK (daily_submissions IS NULL OR daily_submissions >= 0),
  weekly_submissions smallint CHECK (weekly_submissions IS NULL OR weekly_submissions >= 0),
  priority         text,
  notes            text,
  -- Reassignment ends a row rather than deleting it: who was on this order in
  -- March is a question the desk asks when a placement falls through.
  released_on      date,
  CHECK (released_on IS NULL OR released_on >= assigned_on),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requirement_id)
    REFERENCES staffing_requirement (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, recruiter_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by_id) REFERENCES employee (tenant_id, id)
);

-- One live holder of each role per order. Partial, so the history of released
-- assignments is unconstrained — an order may have had four primaries over its
-- life, but it has one now.
CREATE UNIQUE INDEX IF NOT EXISTS job_assignment_one_live_per_role
  ON job_assignment (tenant_id, requirement_id, role)
  WHERE released_on IS NULL;

CREATE INDEX IF NOT EXISTS job_assignment_recruiter_idx
  ON job_assignment (tenant_id, recruiter_id)
  WHERE released_on IS NULL;

SELECT apply_tenant_isolation('job_assignment');

-- ---------------------------------------------------------------------------
-- what happened
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_activity (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  requirement_id uuid NOT NULL,
  -- The instant, not the date. A desk's day is read in order, and two events
  -- an hour apart are a different story from two events on the same date.
  at             timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid,
  kind           text NOT NULL CHECK (kind IN (
    'created', 'assigned', 'reassigned', 'reviewed', 'sourced', 'screened',
    'submitted', 'client_review', 'interview_scheduled', 'interview_done',
    'offer_released', 'offer_accepted', 'offer_declined', 'placed',
    'status_changed', 'sla_changed', 'note', 'closed'
  )),
  -- What it says on the timeline. Written by whatever performed the action, so
  -- the line reads the same whether a person typed it or a submission moving
  -- stage produced it.
  summary        text NOT NULL CHECK (summary <> ''),
  -- Where a count is the point of the event: "20 candidates sourced".
  qty            integer,
  -- The submission, interview or placement this refers to, when it refers to
  -- one. Deliberately not a foreign key: the history outlives the row it
  -- describes, and a withdrawn submission must not erase the fact that it was
  -- once submitted.
  ref_id         uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requirement_id)
    REFERENCES staffing_requirement (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, actor_id) REFERENCES employee (tenant_id, id)
);

-- The timeline is always read newest-first for one order.
CREATE INDEX IF NOT EXISTS job_activity_timeline_idx
  ON job_activity (tenant_id, requirement_id, at DESC);

-- Recruiter activity is the other read: what one person did over a period.
CREATE INDEX IF NOT EXISTS job_activity_actor_idx
  ON job_activity (tenant_id, actor_id, at DESC);

SELECT apply_tenant_isolation('job_activity');

-- Append-only, enforced rather than agreed. A history that can be edited is
-- not a history — and the desk uses this to settle disputes about who
-- submitted a candidate first, which is exactly when somebody would want to
-- change it.
REVOKE UPDATE, DELETE ON job_activity FROM app_rw;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE UPDATE, DELETE ON job_activity FROM authenticated;
  END IF;
END $$;
