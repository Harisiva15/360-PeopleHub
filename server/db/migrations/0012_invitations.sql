-- ---------------------------------------------------------------------------
-- 0012 — joining requests
--
-- A manager raises a new joiner; an admin approves it; only then does an
-- employee record exist. Until now there was nowhere for that request to sit,
-- so "manager creates users" would have meant managers writing directly to
-- `employee` — and a manager who can create an employee can create one with
-- any role, for someone who does not work here.
--
-- This table is the queue between the two. It is also the audit trail: who
-- asked for whom, who approved, and when.
-- ---------------------------------------------------------------------------

CREATE TABLE joining_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,

  -- The proposed person. Deliberately the same columns as `employee` rather
  -- than a JSON blob, so the database validates the request as strictly as it
  -- would validate the employee it becomes.
  full_name     text NOT NULL,
  work_email    citext NOT NULL,
  employee_code text,
  designation   text,
  department_id uuid,
  site_id       uuid,
  grade_id      uuid,
  manager_id    uuid,
  joining_on    date NOT NULL,
  employment_type text NOT NULL DEFAULT 'permanent'
    CHECK (employment_type IN ('permanent', 'contract', 'intern', 'consultant')),

  /*
   * The role the requester is asking for. A manager may only ask for
   * 'employee'; the API enforces that, and an admin can raise it afterwards
   * through the normal role change, which is audited separately.
   */
  requested_role text NOT NULL DEFAULT 'employee'
    CHECK (requested_role IN ('admin', 'manager', 'employee')),

  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  note          text,

  requested_by  uuid,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text,

  -- Set on approval. Its presence is what makes the request spent.
  employee_id   uuid,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id),
  FOREIGN KEY (tenant_id, grade_id) REFERENCES grade_band (tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),

  -- A decided request says who decided it and when.
  CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  -- An approved one produced an employee.
  CHECK ((status = 'approved') = (employee_id IS NOT NULL))
);

CREATE INDEX ON joining_request (tenant_id, status, requested_at DESC);

-- One live request per address. Without this, two managers hiring the same
-- person create two employees, and the second one is discovered by payroll.
CREATE UNIQUE INDEX joining_request_one_pending_per_email
  ON joining_request (tenant_id, work_email) WHERE status = 'pending';

COMMENT ON TABLE joining_request IS
  'A manager proposes, an admin disposes. Nothing here is an employee until '
  'the request is approved.';
