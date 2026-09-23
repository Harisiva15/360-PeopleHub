-- ---------------------------------------------------------------------------
-- 0044 — what kind of place a site is, and which one is head office
--
-- `site` has carried name, code, city, country, address, timezone, a geo-fence
-- and an active flag since 0002. Location management needs four more: the kind
-- of place it is, the state and postal code for a full address, and which one
-- is head office.
--
-- **`kind` is drawn from the rows that already exist, not from a tidy guess.**
-- This tenant's sites include CLIENT and WFH alongside real offices. A type
-- column offering only "headquarters" and "office" would have forced both into
-- a category that misdescribes them — somebody working from home is not at an
-- office, and a client site is not ours. So the list covers what is actually
-- there, and the backfill below reads the codes rather than assuming.
--
-- **At most one head office, enforced rather than requested.** A partial unique
-- index over `is_headquarters` where true: the constraint permits any number of
-- false rows and exactly one true. Asking an administrator to remember is how
-- you end up with two, and then with a report that quietly counts one of them.
-- An inactive site cannot be head office either — the index covers `active`,
-- because a closed building is not where the company is registered.
-- ---------------------------------------------------------------------------

ALTER TABLE site
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'office'
    CHECK (kind IN ('headquarters', 'office', 'client', 'remote')),
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS is_headquarters boolean NOT NULL DEFAULT false;

/*
 * The two sites that are not offices, named by the codes this schema has used
 * since 0002. Guarded so a tenant without them is untouched.
 */
UPDATE site SET kind = 'client' WHERE code = 'CLIENT' AND kind = 'office';
UPDATE site SET kind = 'remote' WHERE code = 'WFH' AND kind = 'office';

-- One head office, or none. Never two.
DROP INDEX IF EXISTS site_one_headquarters;
CREATE UNIQUE INDEX site_one_headquarters
  ON site (tenant_id)
  WHERE is_headquarters AND active;

/*
 * A site flagged as head office should say so in its kind, and one that says so
 * should be flagged. Two columns describing one fact is how they come to
 * disagree; this makes the disagreement impossible rather than unlikely.
 */
ALTER TABLE site DROP CONSTRAINT IF EXISTS site_headquarters_is_consistent;
ALTER TABLE site
  ADD CONSTRAINT site_headquarters_is_consistent
  CHECK (is_headquarters = (kind = 'headquarters'));

COMMENT ON COLUMN site.kind IS
  'headquarters, office, client or remote. CLIENT and WFH are not offices and '
  'are not described as such. See 0044.';
COMMENT ON COLUMN site.is_headquarters IS
  'At most one per tenant among active sites, enforced by site_one_headquarters '
  'and kept in step with kind by site_headquarters_is_consistent. See 0044.';
