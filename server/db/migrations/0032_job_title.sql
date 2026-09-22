-- ---------------------------------------------------------------------------
-- 0032 — the job title catalogue
--
-- `employee.designation` has been free text since 0003. That is why the
-- company has "Senior Software Engineer", "Sr. Software Engineer" and "Senior
-- SW Engineer" on its books, why headcount by title cannot be asked, and why
-- no requisition can say which title it is hiring for without retyping it.
--
-- **The catalogue is the record; the string becomes a pointer.** This adds
-- `employee.job_title_id`, backfills it by matching the existing text, and
-- leaves the text column in place. Dropping it would be the tidy thing and the
-- wrong one: the backfill will not match everybody — a company always has a
-- handful of titles nobody ever added to a catalogue — and turning those into
-- nulls would lose what the person's job actually is. The text stays as the
-- fallback, and `job_title_id` is the answer wherever it is set.
--
-- **A title somebody holds cannot be retired or deleted.** Retiring one is how
-- a catalogue is kept current; doing it under the feet of forty people is how
-- a headcount report starts reporting a title that does not exist. The FK with
-- ON DELETE RESTRICT makes the delete impossible; the status transition is the
-- service's to refuse, because "inactive" is not a constraint SQL can express
-- without a trigger nobody would expect to find.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_title (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- Short, unique, and read aloud in a requisition — 'ENG-SSE3', not a uuid.
  code           text NOT NULL,
  name           text NOT NULL,
  department_id  uuid NOT NULL,
  -- A family cuts across departments: Engineering, Quality, Leadership. Kept
  -- as text rather than a table because it is a fixed list the product owns,
  -- not something a tenant configures.
  family         text NOT NULL,
  -- L1..L8. Distinct from grade_band, which is a pay range: two titles at the
  -- same level can sit in different bands in different countries.
  level          text NOT NULL CHECK (level ~ '^L[1-8]$'),
  employment_type text NOT NULL DEFAULT 'Full Time',
  description    text NOT NULL DEFAULT '',
  -- Ordered lists, and order carries meaning — the first responsibility is the
  -- job. An array keeps that; a child table would need a sequence column to
  -- say the same thing and a join to read it.
  responsibilities text[] NOT NULL DEFAULT '{}',
  required_skills  text[] NOT NULL DEFAULT '{}',
  preferred_skills text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'Active'
    CHECK (status IN ('Active', 'Inactive', 'Archived')),
  created_on     date NOT NULL DEFAULT CURRENT_DATE,
  created_by_id  uuid,
  modified_on    date,
  modified_by_id uuid,
  UNIQUE (tenant_id, id),
  -- Both are the point of a catalogue: two rows for one job is the disease.
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, modified_by_id) REFERENCES employee (tenant_id, id)
);

-- Case-insensitive, because "Senior Engineer" and "senior engineer" are the
-- same job and a catalogue that holds both has failed at its one task.
CREATE UNIQUE INDEX IF NOT EXISTS job_title_name_unique
  ON job_title (tenant_id, lower(name));

-- The catalogue is read filtered by department far more than any other way.
CREATE INDEX IF NOT EXISTS job_title_dept_idx
  ON job_title (tenant_id, department_id)
  WHERE status = 'Active';

SELECT apply_tenant_isolation('job_title');

-- ---------------------------------------------------------------------------
-- the employee's title becomes a reference
-- ---------------------------------------------------------------------------

ALTER TABLE employee
  ADD COLUMN IF NOT EXISTS job_title_id uuid;

-- RESTRICT rather than SET NULL. Deleting a title out from under its holders
-- should fail loudly at the point somebody tries it, not quietly blank the job
-- of everybody who had it and leave the failure to be discovered in a report.
ALTER TABLE employee DROP CONSTRAINT IF EXISTS employee_job_title_fk;
ALTER TABLE employee
  ADD CONSTRAINT employee_job_title_fk
  FOREIGN KEY (tenant_id, job_title_id) REFERENCES job_title (tenant_id, id)
  ON DELETE RESTRICT;

-- "Who holds this title" is the count on every row of the catalogue screen.
CREATE INDEX IF NOT EXISTS employee_job_title_idx
  ON employee (tenant_id, job_title_id)
  WHERE status <> 'exited';

-- Build the catalogue from the titles people actually hold, then point them at
-- it. Generating a plausible catalogue and leaving the employees on their own
-- strings would give a module where every count read zero — which looks like a
-- bug and is worse than no module.
--
-- The code is derived from the department and the title, deduplicated by a
-- suffix where two titles collide. Nobody will love these codes; they are a
-- starting point an administrator can rename, and every one of them is better
-- than the uuid that is the only alternative.
INSERT INTO job_title (tenant_id, code, name, department_id, family, level, created_on)
SELECT DISTINCT ON (e.tenant_id, lower(e.designation))
       e.tenant_id,
       upper(regexp_replace(COALESCE(d.code, 'GEN'), '[^A-Za-z0-9]', '', 'g'))
         || '-' || upper(substr(regexp_replace(e.designation, '[^A-Za-z]', '', 'g'), 1, 6))
         || '-' || substr(md5(lower(e.designation)), 1, 4),
       e.designation,
       e.department_id,
       COALESCE(d.name, 'General'),
       -- Read off the grade where there is one. A title with no grade behind
       -- it lands at L3, which is the middle and the least wrong default.
       CASE
         WHEN g.rank IS NULL THEN 'L3'
         WHEN g.rank <= 1 THEN 'L1'
         WHEN g.rank >= 8 THEN 'L8'
         ELSE 'L' || g.rank::text
       END,
       CURRENT_DATE
  FROM employee e
  LEFT JOIN department  d ON d.id = e.department_id
  LEFT JOIN grade_band  g ON g.id = e.grade_id
 WHERE e.designation IS NOT NULL
   AND btrim(e.designation) <> ''
 ORDER BY e.tenant_id, lower(e.designation), e.joined_on
ON CONFLICT DO NOTHING;

UPDATE employee e
   SET job_title_id = t.id
  FROM job_title t
 WHERE t.tenant_id = e.tenant_id
   AND lower(t.name) = lower(e.designation)
   AND e.job_title_id IS NULL;

COMMENT ON COLUMN employee.job_title_id IS
  'The catalogue entry for this job. designation is kept as the fallback for '
  'anybody the 0032 backfill could not match — job_title_id is the answer '
  'wherever it is set.';
