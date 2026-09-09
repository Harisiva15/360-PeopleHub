-- ---------------------------------------------------------------------------
-- 0015 — regional shifts replace rotational rosters
--
-- The original model came from the prototype: named patterns (General, Early,
-- Night, Flexible) assigned per person per day in `roster_entry`. That suits a
-- support desk running 24/7 out of one country. It does not describe this
-- business, where somebody in Chennai works US hours and somebody in Dubai
-- works Gulf hours, and neither of them rotates.
--
-- So a shift becomes a *working-hours profile for a region*, tagged once on
-- the employee, and the daily roster grid goes away entirely.
--
-- The important part is the timezone, which the old model did not carry at
-- all. It sat on `site`, which is wrong the moment someone in India works US
-- hours: a 21:30 punch is either three hours late or bang on time depending
-- on which clock you measure it against, and the site cannot tell you which.
-- Attendance and timesheets both hang off that answer.
--
-- roster_entry is dropped rather than deprecated. It holds no rows, nothing
-- reads it, and leaving an unused table that looks authoritative is how the
-- next person builds against it.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS roster_entry;

-- ---------------------------------------------------------------------------
-- Reshape `shift`
-- ---------------------------------------------------------------------------

ALTER TABLE shift
  -- The clock a person's hours are measured against. Not nullable: a shift
  -- without a timezone cannot decide whether anyone is late.
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  -- The country this shift follows, for reporting and holiday calendars.
  ADD COLUMN IF NOT EXISTS region char(2);

COMMENT ON TABLE shift IS
  'A working-hours profile for a region, tagged on the employee. Not a '
  'rotational pattern — see migration 0015.';
COMMENT ON COLUMN shift.timezone IS
  'The clock this shift is measured against. Someone in Chennai on the US '
  'shift is judged against America/New_York, not their site.';

/*
 * Replace the prototype's patterns with the four regions actually worked.
 *
 * The old codes are updated in place rather than deleted and recreated, so
 * employee.shift_id and site.default_shift_id keep pointing at something.
 * GEN becomes IN — it is the same people, on the same hours, renamed.
 */
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    UPDATE shift SET code = 'IN', name = 'India Shift', starts_at = '09:30',
           ends_at = '18:30', timezone = 'Asia/Kolkata', region = 'IN',
           is_night = false, is_flexible = false
     WHERE code = 'GEN';

    UPDATE shift SET code = 'US', name = 'US Shift', starts_at = '09:00',
           ends_at = '18:00', timezone = 'America/New_York', region = 'US',
           is_night = false, is_flexible = false
     WHERE code = 'EARLY';

    UPDATE shift SET code = 'UK', name = 'UK Shift', starts_at = '09:00',
           ends_at = '17:30', timezone = 'Europe/London', region = 'GB',
           is_night = false, is_flexible = false
     WHERE code = 'NIGHT';

    UPDATE shift SET code = 'AE', name = 'UAE Shift', starts_at = '09:00',
           ends_at = '18:00', timezone = 'Asia/Dubai', region = 'AE',
           is_night = false, is_flexible = false
     WHERE code = 'FLEX';

    -- For a tenant that never had the prototype's four, create the set.
    INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone, region)
    SELECT t.id, v.code, v.name, v.starts::time, v.ends::time, v.tz, v.region
      FROM (VALUES
        ('IN', 'India Shift', '09:30', '18:30', 'Asia/Kolkata',      'IN'),
        ('US', 'US Shift',    '09:00', '18:00', 'America/New_York',  'US'),
        ('UK', 'UK Shift',    '09:00', '17:30', 'Europe/London',     'GB'),
        ('AE', 'UAE Shift',   '09:00', '18:00', 'Asia/Dubai',        'AE')
      ) AS v(code, name, starts, ends, tz, region)
     ON CONFLICT (tenant_id, code) DO NOTHING;
  END LOOP;
END;
$$;

ALTER TABLE shift
  ADD CONSTRAINT shift_region_fkey FOREIGN KEY (region) REFERENCES country (code);

-- ---------------------------------------------------------------------------
-- Everyone gets a shift
--
-- Nullable shift_id was survivable while attendance was empty. It is not once
-- punches arrive: a person with no shift has no hours to be measured against,
-- and the honest options are to reject their punch or silently pick a default.
-- Neither is good, so the column stops being optional.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    UPDATE employee e
       SET shift_id = COALESCE(
             e.shift_id,
             (SELECT s.id FROM shift s
               WHERE s.region = (SELECT le.country FROM legal_entity le WHERE le.id = e.legal_entity_id)
               LIMIT 1),
             (SELECT s.id FROM shift s WHERE s.code = 'IN' LIMIT 1))
     WHERE e.shift_id IS NULL;
  END LOOP;
END;
$$;

ALTER TABLE employee ALTER COLUMN shift_id SET NOT NULL;
