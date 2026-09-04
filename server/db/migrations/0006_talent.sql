-- ---------------------------------------------------------------------------
-- 0006 — hiring, onboarding, performance and learning
--
-- A candidate is not an employee and must not be one: they have no payroll,
-- no leave balance and no login, and most of them never will. The bridge is
-- onboarding_journey, which turns an accepted offer into an employee row on
-- the joining date.
-- ---------------------------------------------------------------------------

CREATE TABLE requisition (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code          text NOT NULL,
  title         text NOT NULL,
  department_id uuid NOT NULL,
  site_id       uuid,
  grade_id      uuid,
  openings      smallint NOT NULL DEFAULT 1 CHECK (openings > 0),
  filled        smallint NOT NULL DEFAULT 0 CHECK (filled >= 0),
  priority      text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  status        text NOT NULL DEFAULT 'open'
    CHECK (status IN ('draft', 'open', 'on_hold', 'closed', 'cancelled')),
  employment_type text NOT NULL DEFAULT 'permanent',
  hiring_manager_id uuid NOT NULL,
  recruiter_id  uuid,
  budget_min    numeric(14, 2),
  budget_max    numeric(14, 2),
  currency      char(3) REFERENCES currency (code),
  experience    text,
  description   text,
  must_have_skills text[] NOT NULL DEFAULT '{}',
  opened_on     date NOT NULL DEFAULT CURRENT_DATE,
  closed_on     date,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id),
  FOREIGN KEY (tenant_id, grade_id) REFERENCES grade_band (tenant_id, id),
  FOREIGN KEY (tenant_id, hiring_manager_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, recruiter_id) REFERENCES employee (tenant_id, id),
  CHECK (filled <= openings),
  CHECK (budget_max IS NULL OR budget_min IS NULL OR budget_max >= budget_min)
);

CREATE INDEX ON requisition (tenant_id, status, hiring_manager_id);

CREATE TABLE candidate (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  requisition_id uuid NOT NULL,
  full_name     text NOT NULL,
  email         citext NOT NULL,
  phone         text,
  -- Pipeline stage: applied, screening, interview, offer, hired, rejected.
  stage         text NOT NULL DEFAULT 'applied',
  source        text,
  location      text,
  current_employer text,
  experience    text,
  current_ctc   numeric(14, 2),
  expected_ctc  numeric(14, 2),
  currency      char(3) REFERENCES currency (code),
  notice_period text,
  rating        smallint CHECK (rating BETWEEN 1 AND 5),
  skills        text[] NOT NULL DEFAULT '{}',
  resume_document_id uuid,
  applied_on    date NOT NULL DEFAULT CURRENT_DATE,
  -- Candidate data is deleted or anonymised on this date unless they are
  -- hired. Driven by retention_policy; stored per row so the job is a simple
  -- scan rather than a policy re-derivation.
  purge_after   date,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, requisition_id, email),
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES requisition (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX ON candidate (tenant_id, stage);
CREATE INDEX ON candidate (tenant_id, purge_after) WHERE purge_after IS NOT NULL;

CREATE TABLE candidate_note (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL,
  author_id    uuid,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidate (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_id) REFERENCES employee (tenant_id, id)
);

CREATE INDEX ON candidate_note (tenant_id, candidate_id, created_at DESC);

CREATE TABLE interview (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL,
  requisition_id uuid NOT NULL,
  round        text NOT NULL,
  panel_member_id uuid NOT NULL,
  scheduled_at timestamptz NOT NULL,
  mode         text NOT NULL DEFAULT 'video'
    CHECK (mode IN ('video', 'phone', 'onsite', 'take_home')),
  status       text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'no_show', 'cancelled')),
  verdict      text CHECK (verdict IN ('strong_hire', 'hire', 'hold', 'no_hire')),
  feedback     text,
  submitted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidate (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES requisition (tenant_id, id),
  FOREIGN KEY (tenant_id, panel_member_id) REFERENCES employee (tenant_id, id),
  -- A completed interview without a verdict is the thing the dashboard chases,
  -- so it is representable; a verdict without completion is not.
  CHECK (verdict IS NULL OR status = 'completed')
);

CREATE INDEX ON interview (tenant_id, panel_member_id, scheduled_at);

CREATE TABLE offer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL,
  grade_id     uuid,
  designation  text NOT NULL,
  annual_ctc   numeric(14, 2) NOT NULL CHECK (annual_ctc > 0),
  currency     char(3) NOT NULL REFERENCES currency (code),
  joining_on   date NOT NULL,
  status       text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'negotiating', 'accepted', 'declined', 'withdrawn')),
  sent_on      date,
  responded_on date,
  approved_by  uuid,
  UNIQUE (tenant_id, id),
  -- One live offer per candidate.
  UNIQUE (tenant_id, candidate_id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidate (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, grade_id) REFERENCES grade_band (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES employee (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Onboarding — the bridge from accepted offer to employee
-- ---------------------------------------------------------------------------

CREATE TABLE onboarding_journey (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  candidate_id  uuid,
  -- Null until the journey completes and the person becomes an employee.
  employee_id   uuid,
  full_name     text NOT NULL,
  department_id uuid,
  site_id       uuid,
  designation   text,
  joining_on    date NOT NULL,
  manager_id    uuid,
  buddy_id      uuid,
  annual_ctc    numeric(14, 2),
  currency      char(3) REFERENCES currency (code),
  status        text NOT NULL DEFAULT 'pre_boarding'
    CHECK (status IN ('pre_boarding', 'in_progress', 'completed', 'cancelled')),
  background_check text NOT NULL DEFAULT 'not_started',
  completed_on  date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidate (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, buddy_id) REFERENCES employee (tenant_id, id),
  CHECK (status <> 'completed' OR employee_id IS NOT NULL)
);

CREATE INDEX ON onboarding_journey (tenant_id, status, joining_on);

CREATE TABLE onboarding_task (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  journey_id  uuid NOT NULL,
  -- Stable key so a checklist can be re-templated without losing progress.
  task_key    text NOT NULL,
  title       text NOT NULL,
  owner       text NOT NULL
    CHECK (owner IN ('hr', 'it', 'manager', 'finance', 'candidate', 'employee')),
  due_on      date,
  done        boolean NOT NULL DEFAULT false,
  done_on     date,
  done_by     uuid,
  display_order smallint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, journey_id, task_key),
  FOREIGN KEY (tenant_id, journey_id) REFERENCES onboarding_journey (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, done_by) REFERENCES employee (tenant_id, id),
  CHECK (done = (done_on IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Performance
-- ---------------------------------------------------------------------------

CREATE TABLE review_cycle (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  status      text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'active', 'calibration', 'closed')),
  -- Company-wide increment pool as a percentage, approved by the board.
  hike_pool_percent numeric(5, 2),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (ends_on > starts_on)
);

CREATE TABLE goal (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  cycle_id    uuid NOT NULL,
  title       text NOT NULL,
  category    text,
  weight      smallint NOT NULL DEFAULT 0 CHECK (weight BETWEEN 0 AND 100),
  progress    smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  -- Derived from progress by the service, stored so reports do not re-derive.
  status      text NOT NULL DEFAULT 'behind'
    CHECK (status IN ('achieved', 'on_track', 'at_risk', 'behind')),
  due_on      date,
  aligned_to  text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES review_cycle (tenant_id, id)
);

CREATE INDEX ON goal (tenant_id, cycle_id, employee_id);

CREATE TABLE key_result (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  goal_id    uuid NOT NULL,
  title      text NOT NULL,
  done       boolean NOT NULL DEFAULT false,
  display_order smallint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, goal_id) REFERENCES goal (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE check_in (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  cycle_id    uuid,
  held_on     date NOT NULL,
  held_with   uuid,
  wins        text,
  blockers    text,
  next_steps  text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES review_cycle (tenant_id, id),
  FOREIGN KEY (tenant_id, held_with) REFERENCES employee (tenant_id, id)
);

CREATE INDEX ON check_in (tenant_id, employee_id, held_on DESC);

CREATE TABLE review (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  cycle_id    uuid NOT NULL,
  status      text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'self_review', 'manager_review',
                      'calibration', 'calibrated', 'completed')),
  goal_achievement numeric(5, 2),
  self_rating      smallint CHECK (self_rating BETWEEN 1 AND 5),
  self_comments    text,
  self_submitted_on date,
  manager_rating   smallint CHECK (manager_rating BETWEEN 1 AND 5),
  manager_comments text,
  manager_submitted_on date,
  manager_id       uuid,
  -- 9-box vertical axis.
  potential        smallint CHECK (potential BETWEEN 1 AND 3),
  final_rating     smallint CHECK (final_rating BETWEEN 1 AND 5),
  final_hike_percent numeric(5, 2),
  promoted         boolean NOT NULL DEFAULT false,
  on_pip           boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, cycle_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, cycle_id) REFERENCES review_cycle (tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id) REFERENCES employee (tenant_id, id),
  -- A calibrated review carries its outcome.
  CHECK (status NOT IN ('calibrated', 'completed') OR final_rating IS NOT NULL)
);

CREATE INDEX ON review (tenant_id, cycle_id, status);

CREATE TABLE peer_feedback (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  review_id  uuid NOT NULL,
  peer_id    uuid NOT NULL,
  rating     smallint CHECK (rating BETWEEN 1 AND 5),
  comments   text,
  submitted_on date,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, review_id, peer_id),
  FOREIGN KEY (tenant_id, review_id) REFERENCES review (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, peer_id) REFERENCES employee (tenant_id, id)
);

CREATE TABLE praise (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  from_employee_id uuid NOT NULL,
  to_employee_id   uuid NOT NULL,
  company_value    text,
  message     text NOT NULL,
  given_on    date NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, from_employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, to_employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  CHECK (from_employee_id <> to_employee_id)
);

CREATE INDEX ON praise (tenant_id, given_on DESC);

-- ---------------------------------------------------------------------------
-- Learning
-- ---------------------------------------------------------------------------

CREATE TABLE course (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code        text NOT NULL,
  title       text NOT NULL,
  category    text,
  provider    text,
  hours       numeric(5, 1) NOT NULL DEFAULT 0,
  -- Mandatory courses drive the compliance tracker and have a deadline.
  mandatory   boolean NOT NULL DEFAULT false,
  due_on      date,
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE enrollment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  course_id   uuid NOT NULL,
  progress    smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  status      text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed')),
  score       smallint CHECK (score BETWEEN 0 AND 100),
  enrolled_on date NOT NULL DEFAULT CURRENT_DATE,
  completed_on date,
  certificate_document_id uuid,
  UNIQUE (tenant_id, id),
  -- One enrolment per person per course; re-enrolling resets this row.
  UNIQUE (tenant_id, employee_id, course_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, course_id) REFERENCES course (tenant_id, id) ON DELETE CASCADE,
  -- Status follows progress; the two cannot disagree.
  CHECK ((status = 'completed') = (progress = 100)),
  CHECK (completed_on IS NULL OR status = 'completed')
);

CREATE INDEX ON enrollment (tenant_id, course_id, status);
