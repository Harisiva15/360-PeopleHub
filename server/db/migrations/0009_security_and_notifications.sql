-- ---------------------------------------------------------------------------
-- 0009 — audit, security posture, retention and outbound notifications
-- ---------------------------------------------------------------------------

-- Append-only. Nothing updates or deletes here; the retention job is the only
-- process that removes rows, and it removes whole date ranges.
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  category    text NOT NULL,
  action      text NOT NULL,
  severity    text NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'notice', 'warning', 'critical')),
  -- Who did it. actor_employee_id may be null for a system or platform action;
  -- actor_label keeps the name as it was, so a later rename does not rewrite
  -- history.
  actor_user_id  uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  actor_employee_id uuid,
  actor_label text NOT NULL,
  -- What it was done to, as a loose reference: an audit row must survive the
  -- deletion of its subject, so these are not foreign keys.
  subject_table text,
  subject_id  uuid,
  ip          inet,
  user_agent  text,
  country     char(2) REFERENCES country (code),
  -- Before/after for a change, redacted of anything regulated before it lands.
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_employee_id) REFERENCES employee (tenant_id, id) ON DELETE SET NULL
);

CREATE INDEX ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX ON audit_log (tenant_id, subject_table, subject_id);
CREATE INDEX ON audit_log (tenant_id, actor_employee_id, occurred_at DESC);

COMMENT ON TABLE audit_log IS
  'Append-only. The id is a bigint identity rather than a uuid so the index '
  'stays ordered by insertion, which is how this table is read.';

-- The security-posture screen: named controls and their current state.
CREATE TABLE security_control (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  framework    text,
  status       text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'implemented', 'not_applicable')),
  owner_id     uuid,
  evidence_document_id uuid,
  last_reviewed_on date,
  next_review_on   date,
  note         text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, evidence_document_id) REFERENCES document (tenant_id, id)
);

-- A dated snapshot, so the posture chart has history rather than only today.
CREATE TABLE security_posture_snapshot (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  captured_on   date NOT NULL,
  score         smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  controls_total smallint NOT NULL,
  controls_implemented smallint NOT NULL,
  open_findings smallint NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, captured_on),
  CHECK (controls_implemented <= controls_total)
);

-- How long each kind of record is kept. The retention job reads this; it is
-- per-tenant because the commitment is contractual.
CREATE TABLE retention_policy (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- 'candidate', 'audit_log', 'attendance', 'document' and so on.
  record_kind   text NOT NULL,
  retain_months smallint NOT NULL CHECK (retain_months > 0),
  -- Anonymise keeps the row for analytics with identifiers stripped; purge
  -- removes it. Statutory records are usually neither.
  disposition   text NOT NULL DEFAULT 'purge'
    CHECK (disposition IN ('purge', 'anonymise', 'archive', 'retain_indefinitely')),
  legal_basis   text,
  last_run_at   timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, record_kind)
);

-- Periodic confirmation that each person's access is still appropriate.
CREATE TABLE access_review (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  reviewed_role text NOT NULL,
  cycle_label   text NOT NULL,
  outcome       text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'confirmed', 'revoked', 'changed')),
  reviewer_id   uuid,
  reviewed_on   date,
  note          text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, cycle_label),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reviewer_id) REFERENCES employee (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Outbound notifications
--
-- Consent is the part that matters legally. It is per category, and the
-- categories are not independent: withdrawing transactional consent withdraws
-- marketing with it, because both ride the same number.
-- ---------------------------------------------------------------------------

CREATE TABLE message_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  channel     text NOT NULL DEFAULT 'whatsapp'
    CHECK (channel IN ('whatsapp', 'email', 'sms', 'in_app')),
  code        text NOT NULL,
  name        text NOT NULL,
  -- Meta's categories, which decide the rules and the price.
  category    text NOT NULL DEFAULT 'utility'
    CHECK (category IN ('utility', 'marketing', 'authentication', 'service')),
  body        text NOT NULL,
  cta_label   text,
  trigger_event text,
  audience    text,
  -- A template the provider has not approved cannot be enabled.
  approval_status text NOT NULL DEFAULT 'draft'
    CHECK (approval_status IN ('draft', 'submitted', 'approved', 'rejected', 'paused')),
  enabled     boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel, code),
  -- Enabled implies approved. This is the guard the API enforces, made
  -- structural so no code path can bypass it.
  CHECK (NOT enabled OR approval_status = 'approved')
);

CREATE TABLE notification_consent (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL,
  channel      text NOT NULL DEFAULT 'whatsapp',
  -- Transactional HR updates. Withdrawing this withdraws marketing too.
  transactional boolean NOT NULL DEFAULT false,
  marketing    boolean NOT NULL DEFAULT false,
  destination  text,
  verified     boolean NOT NULL DEFAULT false,
  captured_via text,
  captured_on  date,
  withdrawn_on date,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, channel),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  -- Marketing consent cannot outlive transactional consent.
  CHECK (NOT marketing OR transactional)
);

-- Every consent change, because "we had consent" is a claim that has to be
-- provable on a date. Append-only.
CREATE TABLE consent_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  channel     text NOT NULL,
  category    text NOT NULL CHECK (category IN ('transactional', 'marketing')),
  granted     boolean NOT NULL,
  source      text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  ip          inet,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX ON consent_event (tenant_id, employee_id, occurred_at DESC);

CREATE TABLE notification_log (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  template_id   uuid,
  employee_id   uuid,
  channel       text NOT NULL,
  category      text NOT NULL,
  destination   text,
  status        text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'suppressed')),
  -- Why a send was suppressed: usually 'no_consent' or 'quiet_hours'.
  suppression_reason text,
  error         text,
  reply_text    text,
  cost          numeric(10, 4) NOT NULL DEFAULT 0,
  queued_at     timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  delivered_at  timestamptz,
  read_at       timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES message_template (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE SET NULL,
  CHECK ((status = 'suppressed') = (suppression_reason IS NOT NULL))
);

CREATE INDEX ON notification_log (tenant_id, queued_at DESC);
CREATE INDEX ON notification_log (tenant_id, employee_id, queued_at DESC);

-- When a template fires, who it goes to, and whether it respects quiet hours.
CREATE TABLE notification_rule (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code         text NOT NULL,
  template_id  uuid NOT NULL,
  trigger_event text NOT NULL,
  audience     text NOT NULL,
  respect_quiet_hours boolean NOT NULL DEFAULT true,
  enabled      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, template_id) REFERENCES message_template (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Background work
--
-- Payroll runs, retention sweeps and bulk imports are long jobs that must be
-- resumable and must not run twice for the same input.
-- ---------------------------------------------------------------------------

CREATE TABLE job_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  kind          text NOT NULL,
  -- Caller-supplied key that makes a retry a no-op rather than a second run.
  idempotency_key text NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  requested_by  uuid,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  result        jsonb,
  error         text,
  attempts      smallint NOT NULL DEFAULT 0,
  queued_at     timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, idempotency_key),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES employee (tenant_id, id)
);

CREATE INDEX ON job_run (tenant_id, status, queued_at);
