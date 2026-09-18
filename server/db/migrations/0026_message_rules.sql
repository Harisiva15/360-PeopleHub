-- ---------------------------------------------------------------------------
-- 0026 — when a message actually goes out
--
-- 0009 gave messaging almost everything: `message_template` holds the wording
-- and Meta's approval state, `notification_consent` and `consent_event` hold
-- who agreed to what and when, and `notification_log` holds what was sent.
--
-- What it did not hold is the rule between them — the thing that says "on
-- payroll publish, to everyone in the run, but not outside working hours".
-- `message_template.trigger_event` gestures at it, but one template can be
-- driven by more than one rule (an interview invite goes out on scheduling
-- *and* two hours before) and a rule can be paused without withdrawing the
-- template Meta approved. Two lifetimes, so two tables.
--
-- The screens have been rendering fourteen of these from a constant in the
-- frontend and offering a toggle that went nowhere. This is where the toggle
-- lands.
-- ---------------------------------------------------------------------------

CREATE TABLE message_rule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  code        text NOT NULL,
  template_id uuid NOT NULL,
  -- When it fires, in words. Deliberately text rather than a cron expression:
  -- these are read by whoever decides whether a rule should be on, and a
  -- scheduler that needs a machine-readable form can carry its own column.
  fires_when  text NOT NULL,
  audience    text NOT NULL,
  -- Held back until local working hours. A payslip notification at 03:00 is
  -- the kind of thing that gets a whole channel muted.
  quiet_hours boolean NOT NULL DEFAULT true,
  enabled     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, template_id) REFERENCES message_template (tenant_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE message_rule IS
  'What sends a template, and to whom. Separate from the template because one '
  'template can have several rules and a rule can be paused without '
  'withdrawing the approved wording — see migration 0026.';

CREATE INDEX ON message_rule (tenant_id, template_id);

SELECT apply_tenant_isolation('message_rule');

-- ---------------------------------------------------------------------------
-- A template that is not approved cannot have a rule running against it
--
-- `message_template` already refuses to be enabled without approval. The same
-- has to hold one level up, or a paused template still sends because its rule
-- never noticed. Enforced as a trigger rather than a CHECK because it spans
-- two tables.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION message_rule_needs_approved_template() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t record;
BEGIN
  IF NOT NEW.enabled THEN RETURN NEW; END IF;

  SELECT approval_status, enabled INTO t
    FROM message_template WHERE id = NEW.template_id;

  IF t.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'template is %, so a rule on it cannot be enabled', t.approval_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT t.enabled THEN
    RAISE EXCEPTION 'template is paused, so a rule on it cannot be enabled'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER message_rule_approved_template
  BEFORE INSERT OR UPDATE OF enabled, template_id ON message_rule
  FOR EACH ROW EXECUTE FUNCTION message_rule_needs_approved_template();
