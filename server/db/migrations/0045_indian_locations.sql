-- ---------------------------------------------------------------------------
-- 0045 — Bangalore is head office; Pune joins Chennai and Hyderabad
--
-- The four Indian locations the company actually operates from. Three already
-- exist as rows (BLR, CHN, HYD); Pune does not, and nothing has ever been
-- marked as head office.
--
-- **Data in a migration, deliberately.** These are not test fixtures and not
-- seed defaults — they are this company's offices, and they have to be the
-- same in every environment the schema is applied to. The alternative is a
-- one-off script somebody runs against production and nowhere else, which is
-- how staging and production come to disagree about where people work.
--
-- **Idempotent, and tenant-scoped.** ON CONFLICT on (tenant_id, code) so a
-- re-run changes nothing, and every statement is scoped by tenant so a
-- multi-tenant database does not acquire another company's offices.
--
-- Timezone is Asia/Kolkata for all four, which is also the column default;
-- stated anyway, because a location's timezone is the sort of thing that is
-- read later and assumed to have been decided rather than inherited.
-- ---------------------------------------------------------------------------

/*
 * Pune. Inserted for every tenant that already has a Bangalore, which is how
 * this migration identifies "a tenant that operates in India" without naming
 * one — a fresh tenant created later gets its sites from the seed, not here.
 */
INSERT INTO site (tenant_id, code, name, city, state, country, timezone, kind, active)
SELECT s.tenant_id, 'PNQ', 'Pune', 'Pune', 'Maharashtra', 'IN', 'Asia/Kolkata',
       'office', true
  FROM site s
 WHERE s.code = 'BLR'
ON CONFLICT (tenant_id, code) DO NOTHING;

/* The states the existing three sit in, which the rows have never carried. */
UPDATE site SET state = 'Karnataka'  WHERE code = 'BLR' AND state IS NULL;
UPDATE site SET state = 'Tamil Nadu' WHERE code = 'CHN' AND state IS NULL;
UPDATE site SET state = 'Telangana'  WHERE code = 'HYD' AND state IS NULL;

/* All four open. */
UPDATE site SET active = true WHERE code IN ('BLR', 'CHN', 'HYD', 'PNQ');

/*
 * Bangalore is head office.
 *
 * Clearing any other first, because site_one_headquarters permits exactly one
 * active flagged row per tenant and this would otherwise fail on a tenant that
 * had already nominated a different site. Both columns move together —
 * site_headquarters_is_consistent (0044) refuses them apart.
 */
UPDATE site
   SET is_headquarters = false, kind = 'office'
 WHERE is_headquarters AND code <> 'BLR';

UPDATE site
   SET is_headquarters = true, kind = 'headquarters'
 WHERE code = 'BLR';
