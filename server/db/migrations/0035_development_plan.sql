-- ---------------------------------------------------------------------------
-- 0035 — development plans
--
-- **This is not the goals table with a longer date on it.** `goal` has existed
-- since 0006: what somebody owes this cycle, weighted, scored, rolled into a
-- rating. A development plan is the next role, and nobody is marked on it.
-- Different horizon, different owner — the employee writes the plan and the
-- manager endorses it — and different consequences for missing it. Folding one
-- into the other produces a table where career conversations compete with
-- quarterly delivery for the same columns, and delivery wins.
--
-- **An action that names a course keeps no progress of its own.** `enrollment`
-- has held how far through a course somebody is since 0006. A second copy here
-- would disagree within a fortnight, and the plan is always the copy nobody
-- updates. So a course action stores `course_id` and nothing else about
-- progress, and the CHECK below makes storing a completion date against one
-- impossible rather than merely discouraged.
--
-- **Endorsement is a column, not an inference.** A draft nobody agreed to is a
-- wish, and counting wishes is how a development programme reports ninety per
-- cent coverage and changes nothing.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS development_plan (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  -- In their words. Deliberately free text: the whole value of the field is
  -- that somebody wrote it themselves, and a dropdown would collect the
  -- product's vocabulary instead of theirs.
  aspiration    text NOT NULL CHECK (btrim(aspiration) <> ''),
  target_level  text CHECK (target_level IS NULL OR target_level ~ '^L[1-8]$'),
  horizon_months smallint NOT NULL CHECK (horizon_months IN (6, 12, 24)),
  starts_on     date NOT NULL DEFAULT CURRENT_DATE,
  ends_on       date NOT NULL,
  status        text NOT NULL DEFAULT 'Draft'
    CHECK (status IN ('Draft', 'Active', 'Completed', 'Cancelled')),
  -- Somebody inside the company who has agreed to coach them.
  mentor_id     uuid,
  -- What the plan is about. An array because the order is not meaningful and
  -- the set is small and fixed; a join table would be three tables to answer
  -- "how many plans mention leadership".
  focus_areas   text[] NOT NULL DEFAULT '{}' CHECK (cardinality(focus_areas) > 0),
  strengths     text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  -- The next conversation. Overdue reviews are the figure a manager is held
  -- to, so it is a column rather than something computed from the last one.
  review_on     date NOT NULL,
  endorsed_on   date,
  endorsed_by_id uuid,
  created_on    date NOT NULL DEFAULT CURRENT_DATE,
  CHECK (ends_on > starts_on),
  -- Endorsed means somebody endorsed it. Half a signature is not a state.
  CHECK ((endorsed_on IS NULL) = (endorsed_by_id IS NULL)),
  -- Active is what endorsement buys. Without this the status could be set
  -- directly and coverage would count plans nobody agreed to.
  CHECK (status <> 'Active' OR endorsed_on IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, mentor_id) REFERENCES employee (tenant_id, id)
    ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, endorsed_by_id) REFERENCES employee (tenant_id, id)
    ON DELETE SET NULL
);

-- Nobody mentors themselves. It reads as an obvious mistake and is the kind a
-- dropdown makes easy.
ALTER TABLE development_plan DROP CONSTRAINT IF EXISTS development_plan_no_self_mentor;
ALTER TABLE development_plan
  ADD CONSTRAINT development_plan_no_self_mentor
  CHECK (mentor_id IS NULL OR mentor_id <> employee_id);

-- Nobody endorses their own plan.
ALTER TABLE development_plan DROP CONSTRAINT IF EXISTS development_plan_no_self_endorse;
ALTER TABLE development_plan
  ADD CONSTRAINT development_plan_no_self_endorse
  CHECK (endorsed_by_id IS NULL OR endorsed_by_id <> employee_id);

-- One live plan each. Partial, so the history of completed and cancelled plans
-- is unconstrained — somebody may have had four over their career, and has one
-- now.
CREATE UNIQUE INDEX IF NOT EXISTS development_plan_one_live
  ON development_plan (tenant_id, employee_id)
  WHERE status IN ('Draft', 'Active');

-- Reviews that are due: the manager's list, read time-ordered.
CREATE INDEX IF NOT EXISTS development_plan_review_idx
  ON development_plan (tenant_id, review_on)
  WHERE status = 'Active';

CREATE INDEX IF NOT EXISTS development_plan_mentor_idx
  ON development_plan (tenant_id, mentor_id)
  WHERE status = 'Active' AND mentor_id IS NOT NULL;

SELECT apply_tenant_isolation('development_plan');

-- ---------------------------------------------------------------------------
-- what will get them there
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS development_action (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN (
    'Course', 'Certification', 'Stretch assignment', 'Mentoring',
    'On-the-job', 'Reading'
  )),
  area        text NOT NULL,
  title       text NOT NULL CHECK (btrim(title) <> ''),
  -- Set only where the action tracks a course in the catalogue. Its progress
  -- is then the enrolment's, and this row holds no copy of it.
  course_id   uuid,
  due_on      date NOT NULL,
  done_on     date,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_id) REFERENCES development_plan (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, course_id) REFERENCES course (tenant_id, id)
    ON DELETE SET NULL
);

-- The rule that keeps one progress figure rather than two.
--
-- A course action's state lives in `enrollment`. Ticking it off here would put
-- two screens into disagreement about the same course, and the disagreement
-- would be invisible: both would look right on their own page. The constraint
-- makes the second copy unwritable instead of asking everybody to remember.
ALTER TABLE development_action DROP CONSTRAINT IF EXISTS development_action_course_owns_progress;
ALTER TABLE development_action
  ADD CONSTRAINT development_action_course_owns_progress
  CHECK (course_id IS NULL OR done_on IS NULL);

CREATE INDEX IF NOT EXISTS development_action_plan_idx
  ON development_action (tenant_id, plan_id, due_on);

CREATE INDEX IF NOT EXISTS development_action_overdue_idx
  ON development_action (tenant_id, due_on)
  WHERE done_on IS NULL;

SELECT apply_tenant_isolation('development_action');

COMMENT ON CONSTRAINT development_action_course_owns_progress ON development_action IS
  'An action that names a course cannot record its own completion: the '
  'enrolment is the single source of that. See 0035.';
