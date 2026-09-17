-- ---------------------------------------------------------------------------
-- 0018 — geo-fenced attendance, restored
--
-- 0016 removed location tracking and dropped the columns rather than leaving
-- them unwritten. That was the right way to remove a feature and it means this
-- is a rebuild: the coordinates recorded before 0016 are gone and cannot be
-- recovered. Capture starts again from here.
--
-- What comes back is the same shape, because the reasoning behind it has not
-- changed:
--
--   * geo_ok is nullable on purpose. NULL means there was nothing to measure
--     against — a site with no fence, or a punch with no fix. FALSE is a real
--     exception somebody has to explain. Collapsing the two would make every
--     work-from-home punch look like a violation.
--
--   * distance_m is stored alongside the coordinates even though it is
--     derivable from them, because the fence radius can move afterwards and
--     the distance at the time of the punch is what the decision was made on.
--
-- The privacy consequence is real and belongs in the retention register, not
-- only in a migration comment: a punch history with coordinates is a movement
-- history of a named person. The register is updated in the same commit.
-- ---------------------------------------------------------------------------

ALTER TABLE site
  ADD COLUMN IF NOT EXISTS latitude  numeric(9, 6),
  ADD COLUMN IF NOT EXISTS longitude numeric(9, 6),
  -- A zero radius would flag every punch at the site, which reads as a fault
  -- rather than a policy, so it is refused here as well as in the service.
  ADD COLUMN IF NOT EXISTS fence_radius_m integer
    CHECK (fence_radius_m IS NULL OR fence_radius_m > 0);

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS latitude   numeric(9, 6),
  ADD COLUMN IF NOT EXISTS longitude  numeric(9, 6),
  ADD COLUMN IF NOT EXISTS distance_m integer,
  ADD COLUMN IF NOT EXISTS geo_ok     boolean;

-- The exception report is "show me every punch outside its fence", and it is
-- read per month.
CREATE INDEX IF NOT EXISTS attendance_geo_exceptions
  ON attendance (tenant_id, work_date DESC) WHERE geo_ok = false;
