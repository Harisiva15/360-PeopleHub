-- ---------------------------------------------------------------------------
-- 0025 — tell people their location is recorded, and prove they were told
--
-- 0018 restored geo-fenced attendance and said the privacy consequence "belongs
-- in the retention register, not only in a migration comment". The register
-- entry exists — 24 months, legitimate interest — as a row on a screen. Nothing
-- reads it and nothing purges anything, so a movement history of a named person
-- accumulates forever.
--
-- Two things close that, and this migration is the storage for both.
--
-- **Notice, not consent.** The register declares legitimate interest as the
-- basis, and legitimate interest is not consent — asking somebody to agree and
-- then processing anyway if they decline is worse than not asking. What the DPDP
-- Act requires alongside it is notice: the person is told what is collected, why,
-- and for how long. `location_notice` records that they were told, on a date,
-- against a version of the wording, so "we informed them" is provable rather
-- than asserted.
--
-- The table is therefore an acknowledgement trail, not a toggle. It is append
-- only in spirit — one row per person per version of the notice — so reissuing
-- a changed notice creates a new row rather than overwriting the old one, and
-- the history of what somebody was told when survives.
--
-- **The notice gates collection, not attendance.** A punch from somebody who
-- has not seen the notice still goes through; it simply carries no coordinates.
-- Blocking the punch would mean an employee who has not clicked a dialog does
-- not get paid, which is not a privacy control, it is a payroll fault.
-- ---------------------------------------------------------------------------

CREATE TABLE location_notice (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL,
  -- Bumped when the wording changes materially. An old acknowledgement does
  -- not cover new wording, which is the whole reason to version it.
  notice_version smallint NOT NULL DEFAULT 1,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  -- Where it was acknowledged from, for the same reason consent_event keeps it.
  ip            inet,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, notice_version),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE location_notice IS
  'Proof a person was told their punch records a position. Notice under a '
  'legitimate-interest basis, not consent — see migration 0025.';

CREATE INDEX ON location_notice (tenant_id, employee_id);

SELECT apply_tenant_isolation('location_notice');

-- ---------------------------------------------------------------------------
-- The retention rule, as a row something can act on
--
-- 24 months matches what the register has been claiming on screen. The
-- disposition is 'anonymise' rather than 'purge': the punch itself is a payroll
-- record and has to survive, so what expires is the location on it — the
-- coordinates, the distance and the verdict — leaving the time, the work mode
-- and the hours intact.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    INSERT INTO retention_policy (tenant_id, record_kind, retain_months, disposition, legal_basis)
    VALUES (t.id, 'attendance_location', 24, 'anonymise',
            'Legitimate interest — payroll accuracy and dispute resolution. '
            'The punch is kept; the position on it is cleared.')
    ON CONFLICT (tenant_id, record_kind) DO UPDATE
      SET retain_months = EXCLUDED.retain_months,
          disposition   = EXCLUDED.disposition,
          legal_basis   = EXCLUDED.legal_basis;
  END LOOP;
END;
$$;
