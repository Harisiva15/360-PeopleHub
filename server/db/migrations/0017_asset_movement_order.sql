-- ---------------------------------------------------------------------------
-- 0017 — give the custody trail an order
--
-- asset_movement records the day a movement happened and nothing finer, so two
-- movements on the same day cannot be sequenced. That is most of them: an
-- asset added and issued in the morning and returned in the afternoon reads
-- back in whatever order the rows happen to come out.
--
-- A custody trail exists to answer "who had this, and in what order". One that
-- can only be ordered to the nearest day answers half the question, and the
-- half it drops is the half a dispute turns on.
--
-- moved_on stays: it is the business date, which is what a person means by
-- "when did this move", and it can be backdated when kit is recorded late.
-- recorded_at is when the system was told, which is what orders the trail.
-- ---------------------------------------------------------------------------

ALTER TABLE asset_movement
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now();

-- The trail is read per asset, newest first.
CREATE INDEX IF NOT EXISTS asset_movement_asset_recorded
  ON asset_movement (tenant_id, asset_id, recorded_at DESC);
