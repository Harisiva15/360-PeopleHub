-- ---------------------------------------------------------------------------
-- 0016 — remove location tracking
--
-- Attendance no longer records where a person was, only that they punched and
-- which work mode they punched under: an office, from home, or at a client.
--
-- The columns are dropped rather than left unwritten. Coordinates are the most
-- sensitive thing this schema held — a punch history is a movement history —
-- and a nullable column nobody fills is still a column somebody can start
-- filling. Dropping them makes the feature unrepresentable rather than merely
-- unused, which is the same argument the composite foreign keys make about
-- cross-tenant references.
--
-- What survives is everything that decides pay: punch_in, punch_out,
-- worked_minutes, late, and the work mode via site_id. None of those needed a
-- coordinate. Lateness is measured against the employee's own shift timezone
-- (0015) and always was.
--
-- Irreversible by design: the point is that the data stops existing.
-- ---------------------------------------------------------------------------

ALTER TABLE attendance
  DROP COLUMN IF EXISTS latitude,
  DROP COLUMN IF EXISTS longitude,
  DROP COLUMN IF EXISTS distance_m,
  DROP COLUMN IF EXISTS geo_ok;

-- The site keeps its address, city and timezone. A site is a place people are
-- based, which is a label on a person; it is no longer a circle on a map that
-- a punch is measured against.
ALTER TABLE site
  DROP COLUMN IF EXISTS latitude,
  DROP COLUMN IF EXISTS longitude,
  DROP COLUMN IF EXISTS fence_radius_m;
