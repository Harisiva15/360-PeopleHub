-- ---------------------------------------------------------------------------
-- 0019 — the project planner and action items
--
-- A work item is the unit of planned effort. The table carries both the
-- planner's tasks and the action items that come out of meetings and reviews,
-- because they are the same record with different provenance: a title, an
-- owner, a due date and a state. Two tables would mean two queues, two
-- notification paths and two places to look for "what am I meant to be doing".
--
-- `project_id` is therefore nullable. An action item from a management meeting
-- belongs to nobody's project and still has to be tracked; forcing one would
-- mean inventing a project called "General" that everything drains into.
--
-- The hierarchy is one self-reference rather than a separate epic table.
-- Anything can parent anything, which is looser than a strict epic/story/task
-- ladder and matches how these are actually used -- a bug found under a task
-- is a child of that task, not of some epic three levels up.
-- ---------------------------------------------------------------------------

-- A sprint, or any other named window work is planned into.
CREATE TABLE iteration (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name        text NOT NULL,
  goal        text,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  status      text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'active', 'closed')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK (ends_on >= starts_on)
);

CREATE INDEX ON iteration (tenant_id, starts_on DESC);

CREATE TABLE work_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- Sequential per tenant, so people can say "PLAN-14" out loud.
  reference   text NOT NULL,
  -- Null for an action item that belongs to no project.
  project_id  uuid,
  iteration_id uuid,
  parent_id   uuid,
  kind        text NOT NULL DEFAULT 'task'
    CHECK (kind IN ('epic', 'story', 'task', 'bug', 'action')),
  title       text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'backlog'
    CHECK (status IN ('backlog', 'todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled')),
  priority    text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
  assignee_id uuid,
  reporter_id uuid,
  -- Where an action item came from: a meeting, a review, an audit.
  source      text,
  due_on      date,
  estimate_hours numeric(6, 2) CHECK (estimate_hours IS NULL OR estimate_hours >= 0),
  -- Position within its board column, so a drag is a number and not a re-sort.
  board_order numeric(12, 4) NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  closed_on   date,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reference),
  FOREIGN KEY (tenant_id, project_id) REFERENCES project (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, iteration_id) REFERENCES iteration (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, parent_id) REFERENCES work_item (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, assignee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, reporter_id) REFERENCES employee (tenant_id, id),
  -- A closed item says when. The service sets both together.
  CHECK ((status IN ('done', 'cancelled')) = (closed_on IS NOT NULL)),
  -- Nothing may parent itself.
  CHECK (parent_id IS NULL OR parent_id <> id)
);

-- The board reads one project's open items; the tracker reads one person's.
CREATE INDEX ON work_item (tenant_id, project_id, status);
CREATE INDEX ON work_item (tenant_id, assignee_id, due_on);
CREATE INDEX ON work_item (tenant_id, kind, status);

CREATE TABLE work_item_comment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL,
  author_id    uuid,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, work_item_id) REFERENCES work_item (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_id) REFERENCES employee (tenant_id, id)
);

CREATE INDEX ON work_item_comment (tenant_id, work_item_id, created_at);

SELECT apply_tenant_isolation('iteration');
SELECT apply_tenant_isolation('work_item');
SELECT apply_tenant_isolation('work_item_comment');
