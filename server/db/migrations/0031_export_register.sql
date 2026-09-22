-- ---------------------------------------------------------------------------
-- 0031 — the export register
--
-- Somebody taking a file of employees out of the building is an access event,
-- and this system has had a table for access events since 0009. So there is no
-- `export_run` table here. An export writes an `audit_log` row with
-- category 'export', and the view below gives that row the shape the export
-- screen reads.
--
-- **Why not its own table.** Two registers of who touched what is two answers
-- to the question an audit asks, and the one nobody maintains is always the
-- one on screen. It also splits a person's afternoon in half: "what did Priya
-- do on Tuesday" would have to union two tables and reconcile their clocks.
-- `audit_log` already carries the actor, the subject, the instant, the IP and
-- a jsonb detail column put there for exactly this — per-action structured
-- payload — and it already has tenant isolation, indexes and a retention story.
--
-- **What the register must never hold.** The rows that were exported. It
-- records that 214 rows of the employee directory left on Tuesday; it does not
-- keep the 214 rows. A log that held the files would quietly become the largest
-- collection of personal data in the product, sitting behind whatever
-- permissions the audit screen happens to have. The CHECK below enforces that
-- structurally: an export's detail may carry counts and filters and nothing
-- shaped like data.
--
-- **Refusals are recorded, not just successes.** A manager reaching for
-- payroll-shaped data is what somebody reviewing this afterwards is looking
-- for. A register holding only the permitted exports has quietly answered a
-- narrower question than the one being asked of it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- what an export row must carry
-- ---------------------------------------------------------------------------

-- The detail column is free-form for every other category, and deliberately
-- so — each module's payload is its own business. An export is the exception,
-- because a second reader (the view below) projects fixed columns out of it,
-- and a row missing a key would surface as a null row count in a compliance
-- report rather than as an error anybody sees.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_export_detail;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_export_detail
  CHECK (
    category <> 'export'
    OR (
      detail ? 'datasetId'
      AND detail ? 'datasetName'
      AND detail ? 'rows'
      AND detail ? 'columns'
      AND detail ? 'outcome'
      AND detail ? 'personal'
      AND jsonb_typeof(detail -> 'rows') = 'number'
      AND jsonb_typeof(detail -> 'columns') = 'number'
      AND (detail ->> 'outcome') IN ('Completed', 'Refused')
      AND jsonb_typeof(detail -> 'personal') = 'boolean'
      -- The register keeps the fact, never the data. `columns` is a count, not
      -- a list of values, and there is no key here that could hold a row.
      AND NOT (detail ? 'data')
      AND NOT (detail ? 'rowData')
      AND NOT (detail ? 'payload')
    )
  );

-- A refused export took nothing. Recording a row count against an attempt that
-- was turned away would inflate every "rows taken" figure by the size of the
-- thing somebody was not allowed to have.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_export_refusal_took_nothing;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_export_refusal_took_nothing
  CHECK (
    category <> 'export'
    OR (detail ->> 'outcome') <> 'Refused'
    OR (detail -> 'rows')::numeric = 0
  );

-- ---------------------------------------------------------------------------
-- the register, as the screen reads it
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS export_run;

-- security_invoker makes the view run as whoever queries it, so `audit_log`'s
-- tenant isolation applies. Without it a view is evaluated as its owner, which
-- would make this one an unfenced hole straight through the RLS the rest of
-- the schema relies on — the single most common way a Postgres tenant boundary
-- is lost.
CREATE VIEW export_run WITH (security_invoker = true) AS
SELECT
  a.id,
  a.tenant_id,
  a.occurred_at                       AS at,
  detail ->> 'datasetId'              AS dataset_id,
  detail ->> 'datasetName'            AS dataset_name,
  a.actor_employee_id                 AS by_id,
  a.actor_label                       AS by_name,
  detail ->> 'byRole'                 AS by_role,
  (detail -> 'rows')::int             AS rows,
  (detail -> 'columns')::int          AS columns,
  COALESCE(detail ->> 'filters', '')  AS filters,
  (detail -> 'personal')::boolean     AS personal,
  detail ->> 'outcome'                AS outcome,
  COALESCE(detail ->> 'note', '')     AS note,
  a.ip,
  a.country
FROM audit_log a
WHERE a.category = 'export';

COMMENT ON VIEW export_run IS
  'Exports, projected out of audit_log. There is no export table: an export is '
  'an access event and belongs in the one trail. The view holds metadata only — '
  'never the exported rows. See 0031.';

-- The register is read two ways and no others: newest first for the whole
-- tenant, and everything one person has taken. Both are already served by
-- indexes on audit_log from 0009, but neither is narrowed to exports, so a
-- tenant with a busy audit trail would scan past every login to find them.
CREATE INDEX IF NOT EXISTS audit_log_export_idx
  ON audit_log (tenant_id, occurred_at DESC)
  WHERE category = 'export';

CREATE INDEX IF NOT EXISTS audit_log_export_actor_idx
  ON audit_log (tenant_id, actor_employee_id, occurred_at DESC)
  WHERE category = 'export';

-- Exports that named individuals, which is the query a data-protection review
-- opens with and the only one that would otherwise filter in memory.
CREATE INDEX IF NOT EXISTS audit_log_export_personal_idx
  ON audit_log (tenant_id, occurred_at DESC)
  WHERE category = 'export' AND (detail -> 'personal')::boolean;
