-- Who has answered a survey, without recording what they said.
--
-- `survey_response` was built for anonymity and does it properly:
-- `respondent_id` is nullable and 0007 says in as many words never to write it
-- for an anonymous survey. That leaves one thing unanswerable — whether a
-- given person has already responded — and the submit path needs it, or the
-- same person can answer a pulse ten times and move the mean on their own.
--
-- The two facts cannot live in one row. A row that holds both the answer and
-- the respondent is not anonymous, whatever the column is called. So
-- participation is recorded separately: this table knows *that* somebody
-- answered and never *what*, and `survey_response` knows what and, for an
-- anonymous survey, never who. Nothing joins them — there is no column to join
-- on, which is the point.
--
-- The remaining exposure is stated rather than hidden: on a survey with one
-- respondent, the single response row is theirs by elimination. That is what
-- `min_responses_to_show` exists for, and it is enforced in the service.
--
-- Additive: no existing table is altered and no existing row is touched.

CREATE TABLE survey_participation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  survey_id    uuid NOT NULL,
  employee_id  uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),

  -- Every tenant table carries this so another can reference it without
  -- crossing tenants; check-schema.mjs enforces it.
  UNIQUE (tenant_id, id),

  -- One row per person per survey is the constraint that matters. A unique
  -- index rather than a check in the service, so a second submission fails on
  -- insert — two concurrent submissions would both pass a read-then-write.
  UNIQUE (tenant_id, survey_id, employee_id),

  FOREIGN KEY (tenant_id, survey_id) REFERENCES survey (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE
);

SELECT apply_tenant_isolation('survey_participation');

COMMENT ON TABLE survey_participation IS
  'That a person answered a survey, never what they answered. Deliberately '
  'unjoinable to survey_response so an anonymous survey stays anonymous.';
