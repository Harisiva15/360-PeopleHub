-- ---------------------------------------------------------------------------
-- 0023 — retire the prototype shifts 0015 meant to replace
--
-- 0015 renamed GEN → IN, EARLY → US, NIGHT → UK and FLEX → AE, then inserted
-- the four regional profiles for any tenant that never had the prototype's.
-- On a database created after 0015, the renames matched nothing and the insert
-- did the work — correctly.
--
-- What 0015 could not foresee is that `scripts/seed.mjs` still planted the
-- prototype four on every run, *after* the migration. So the live database
-- carries eight shifts: IN, US, UK and AE alongside GEN, EARLY, NIGHT and
-- FLEX, which are the same working days under older names and carry no
-- timezone at all. A roster offering a choice between "General" and "India
-- Shift" is a roster nobody can answer correctly.
--
-- The seed is fixed in the same change. This removes what it left behind.
--
-- Only unreferenced rows go. A shift somebody is actually on is left alone and
-- reported, because deleting it would either fail on the foreign key or, worse,
-- succeed against a schema that let it — and moving a person between working
-- hours is a decision, not a migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t       record;
  stuck   text;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    SELECT string_agg(s.code, ', ') INTO stuck
      FROM shift s
     WHERE s.code IN ('GEN', 'EARLY', 'MID', 'NIGHT', 'FLEX')
       AND (EXISTS (SELECT 1 FROM employee e WHERE e.shift_id = s.id)
         OR EXISTS (SELECT 1 FROM site si WHERE si.default_shift_id = s.id)
         OR EXISTS (SELECT 1 FROM attendance a WHERE a.shift_id = s.id));

    IF stuck IS NOT NULL THEN
      RAISE WARNING 'tenant %: prototype shift(s) % are still in use and were kept. '
                    'Move those people onto a regional profile, then delete.',
                    t.id, stuck;
    END IF;

    DELETE FROM shift s
     WHERE s.code IN ('GEN', 'EARLY', 'MID', 'NIGHT', 'FLEX')
       AND NOT EXISTS (SELECT 1 FROM employee e WHERE e.shift_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM site si WHERE si.default_shift_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.shift_id = s.id);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- A site's default shift was never set, which meant a new joiner's shift came
-- from the fallback in 0015 rather than from where they sit. Point each site
-- at the profile for its country, so the default is at least defensible.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    UPDATE site si
       SET default_shift_id = COALESCE(
             (SELECT s.id FROM shift s WHERE s.region = si.country AND s.active LIMIT 1),
             (SELECT s.id FROM shift s WHERE s.code = 'IN' AND s.active LIMIT 1))
     WHERE si.default_shift_id IS NULL;
  END LOOP;
END;
$$;
