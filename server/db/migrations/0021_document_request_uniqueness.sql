-- A document is asked for once.
--
-- 0020 declared UNIQUE (tenant_id, journey_id, employee_id, kind) and it never
-- fired. Exactly one of journey_id and employee_id is non-null — the CHECK on
-- the table insists on it — and under the SQL default two NULLs are not equal,
-- so every row differed from every other in the column that was NULL. The
-- constraint existed, was reported by the catalogue, and permitted the exact
-- duplicate it was written to forbid: a second 'photo_id' request against the
-- same joiner, asked for twice and chased twice.
--
-- NULLS NOT DISTINCT makes NULL compare equal here, which is the intent. It is
-- the whole fix; the column layout is right.
--
-- Any duplicates already collected are folded down first, keeping the row that
-- has been acted on: verified outranks received, received outranks rejected and
-- waived, and anything outranks an untouched pending copy. Where neither has
-- moved the survivor is arbitrary (id breaks the tie) — the rows are identical
-- in every way anyone would notice, so there is nothing to choose between them.
-- The fold and the rebuild share the migration's transaction, so there is no
-- window in which a new duplicate could slip in between them.

DELETE FROM document_request d
 WHERE EXISTS (
   SELECT 1 FROM document_request k
    WHERE k.tenant_id = d.tenant_id
      AND k.kind = d.kind
      AND k.journey_id IS NOT DISTINCT FROM d.journey_id
      AND k.employee_id IS NOT DISTINCT FROM d.employee_id
      AND (
        CASE k.status WHEN 'verified' THEN 4 WHEN 'received' THEN 3
                      WHEN 'rejected' THEN 2 WHEN 'waived' THEN 1 ELSE 0 END,
        k.id
      ) > (
        CASE d.status WHEN 'verified' THEN 4 WHEN 'received' THEN 3
                      WHEN 'rejected' THEN 2 WHEN 'waived' THEN 1 ELSE 0 END,
        d.id
      ));

ALTER TABLE document_request
  DROP CONSTRAINT document_request_tenant_id_journey_id_employee_id_kind_key,
  ADD CONSTRAINT document_request_tenant_id_journey_id_employee_id_kind_key
    UNIQUE NULLS NOT DISTINCT (tenant_id, journey_id, employee_id, kind);
