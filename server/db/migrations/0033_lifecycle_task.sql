-- ---------------------------------------------------------------------------
-- 0033 — lifecycle tasks
--
-- **There is no `lifecycle_stage` column here, and that is the design.**
--
-- Every stage the module reports — candidate, offer, pre-boarding, joined,
-- onboarding, active, promotion, transfer, leave of absence, exit,
-- offboarding, alumni — is already knowable from a record this schema keeps.
-- An `onboarding` row says pre-boarding or onboarding. An `exit_record` says
-- notice or clearance. `employee.status` says active or alumni. A `candidate`
-- says where in the pipeline somebody is. Storing the stage again would create
-- a column that can disagree with the six tables it summarises — and it would,
-- because six modules write those tables and only one of them would remember
-- to update the copy.
--
-- So the stage is a query, and what lives here is the one thing the derivation
-- cannot produce: tasks. A task is work somebody has to remember, not a fact
-- about a record, and nothing else in the schema holds it.
--
-- Onboarding and offboarding tasks are deliberately absent too. They already
-- exist — `onboarding_task` since 0005, the clearance rows since 0007 — and
-- are already worked. Duplicating them here would give two checklists that
-- disagree about whether somebody has handed their laptop back.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lifecycle_task (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- Who it is about. An employee, always: the stages before employment —
  -- candidate, offer, pre-boarding — carry their tasks on the candidate and
  -- onboarding records, which is where the people working them already look.
  employee_id  uuid NOT NULL,
  -- The stage this task was raised under, as it was at the time.
  --
  -- Not a foreign key and not re-derived on read: it is a note about why the
  -- task exists. Somebody promoted in March has a "confirm the new band"
  -- task from March, and it stays a promotion task after they settle back to
  -- Active in June. Recomputing it would silently relabel finished work.
  stage        text NOT NULL CHECK (stage IN (
    'Candidate', 'Offer', 'Pre-boarding', 'Joined', 'Onboarding', 'Active',
    'Promotion', 'Transfer', 'Leave of Absence', 'Exit', 'Offboarding', 'Alumni'
  )),
  title        text NOT NULL CHECK (btrim(title) <> ''),
  -- The team accountable. A team rather than a person, because "HR" outlives
  -- whichever member of HR was asked.
  owner_team   text NOT NULL DEFAULT 'HR',
  -- The person on the hook, where there is one. Null is normal: plenty of
  -- tasks belong to a team and no individual.
  assignee_id  uuid,
  due_on       date NOT NULL,
  done_on      date,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  -- Done is a date, not a boolean beside one. Two columns that have to agree
  -- eventually stop agreeing; here "is it done" is "done_on IS NOT NULL" and
  -- the question has one answer.
  CHECK (done_on IS NULL OR done_on >= '2000-01-01'),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, assignee_id) REFERENCES employee (tenant_id, id)
    ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, created_by_id) REFERENCES employee (tenant_id, id)
    ON DELETE SET NULL
);

-- The two reads: this person's tasks, and everything outstanding. Both are
-- always narrowed to the tenant first.
CREATE INDEX IF NOT EXISTS lifecycle_task_employee_idx
  ON lifecycle_task (tenant_id, employee_id, due_on);

CREATE INDEX IF NOT EXISTS lifecycle_task_open_idx
  ON lifecycle_task (tenant_id, due_on)
  WHERE done_on IS NULL;

-- "What is assigned to me" is on the dashboard of everybody who has any.
CREATE INDEX IF NOT EXISTS lifecycle_task_assignee_idx
  ON lifecycle_task (tenant_id, assignee_id, due_on)
  WHERE done_on IS NULL AND assignee_id IS NOT NULL;

SELECT apply_tenant_isolation('lifecycle_task');

COMMENT ON TABLE lifecycle_task IS
  'Work raised against somebody''s employment stage. The stage itself is '
  'derived from onboarding, exit_record, employee.status and the candidate '
  'pipeline — it is deliberately not stored. See 0033.';
