-- ---------------------------------------------------------------------------
-- 0037 — saved reports, outbound endpoints and API keys
--
-- Three small tables that share one property: each holds a *definition*, never
-- the thing the definition produces.
--
-- **A saved report stores its question and not its answer.** Running one asks
-- the export path as whoever is running it, so a report an administrator
-- shares and a manager opens returns the manager's rows. Storing results would
-- turn every shared report into a copy of the data with none of the
-- permissions attached — which is the same mistake 0031 refuses for exports,
-- and it would be a larger one here because a report is meant to be shared.
--
-- **An API key is stored as its last four characters.** The secret is returned
-- once, at creation, and never again. A table of live credentials readable by
-- anybody who can open the settings page is the usual shape of this feature
-- and it is a breach with a date on it. The CHECK below makes a long value in
-- that column impossible rather than merely discouraged.
--
-- **A key is revoked, never deleted.** The key that pulled the directory in
-- March is part of the record of who had access; removing the row removes the
-- only evidence it ever existed.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS saved_report (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (btrim(name) <> ''),
  description text NOT NULL DEFAULT '',
  -- Which dataset it asks. Text rather than a foreign key: the catalogue is
  -- code, not a table, and a report naming a dataset that has since been
  -- retired must still be readable enough to say so.
  dataset_id  text NOT NULL,
  -- Column keys, in the order they appear. Empty means every column.
  columns     text[] NOT NULL DEFAULT '{}',
  group_by    text,
  -- [{col, agg}] and [{col, op, value}]. Small, variable-shape structures that
  -- are only ever read whole — a child table for each would be two joins to
  -- reconstruct something the application treats as one value.
  measures    jsonb NOT NULL DEFAULT '[]'::jsonb,
  filters     jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort        jsonb,
  owner_id    uuid NOT NULL,
  -- Sharing shares the question. See the note at the top.
  shared      boolean NOT NULL DEFAULT false,
  created_on  date NOT NULL DEFAULT CURRENT_DATE,
  last_run_on date,
  run_count   integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  CHECK (jsonb_typeof(measures) = 'array'),
  CHECK (jsonb_typeof(filters) = 'array'),
  -- Measures without a grouping have nothing to aggregate over.
  CHECK (group_by IS NOT NULL OR measures = '[]'::jsonb),
  --
  -- There is deliberately no column here for results, and no constraint
  -- pretending to enforce that. A CHECK cannot look at a column that does not
  -- exist, and a whole-row reference is not allowed in one — the guard is the
  -- absence of the column, which a reviewer can see, plus the comment on this
  -- table saying why.
  --
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES employee (tenant_id, id) ON DELETE CASCADE
);

-- The list is read two ways: everything shared, and everything mine.
CREATE INDEX IF NOT EXISTS saved_report_shared_idx
  ON saved_report (tenant_id, run_count DESC)
  WHERE shared;

CREATE INDEX IF NOT EXISTS saved_report_owner_idx
  ON saved_report (tenant_id, owner_id);

SELECT apply_tenant_isolation('saved_report');

-- ---------------------------------------------------------------------------
-- where we post when something happens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_endpoint (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (btrim(name) <> ''),
  -- https only, at the schema level. A webhook carries employee data across
  -- the internet; over http it carries it to everybody in between, and that is
  -- not a preference to be overridden by whoever writes the next form.
  url         text NOT NULL CHECK (url LIKE 'https://%'),
  events      text[] NOT NULL CHECK (cardinality(events) > 0),
  active      boolean NOT NULL DEFAULT true,
  created_on  date NOT NULL DEFAULT CURRENT_DATE,
  created_by_id uuid,
  last_fired_on date,
  last_status smallint,
  deliveries  integer NOT NULL DEFAULT 0 CHECK (deliveries >= 0),
  failures    integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  -- More failures than attempts is not a degraded endpoint, it is a counter bug.
  CHECK (failures <= deliveries),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_id) REFERENCES employee (tenant_id, id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS webhook_endpoint_active_idx
  ON webhook_endpoint (tenant_id)
  WHERE active;

SELECT apply_tenant_isolation('webhook_endpoint');

-- ---------------------------------------------------------------------------
-- credentials issued to other systems
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_key (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (btrim(name) <> ''),
  -- The last four characters of the key, and nothing else.
  --
  -- Constrained to four so the column cannot quietly become the place somebody
  -- stores the whole thing. Four characters identify a key in a list and are
  -- useless to anybody who finds them.
  tail        text NOT NULL CHECK (length(tail) = 4),
  -- A hash, for the day the API verifies keys itself. Never the key.
  secret_hash text,
  scopes      text[] NOT NULL CHECK (cardinality(scopes) > 0),
  created_on  date NOT NULL DEFAULT CURRENT_DATE,
  created_by_id uuid,
  last_used_on date,
  expires_on  date,
  revoked_on  date,
  -- A key cannot have been used before it existed, or after it was revoked.
  CHECK (last_used_on IS NULL OR last_used_on >= created_on),
  CHECK (last_used_on IS NULL OR revoked_on IS NULL OR last_used_on <= revoked_on),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_id) REFERENCES employee (tenant_id, id)
    ON DELETE SET NULL
);

-- Live keys are the list that matters; revoked ones are history and are read
-- only when somebody is looking back.
CREATE INDEX IF NOT EXISTS api_key_live_idx
  ON api_key (tenant_id, name)
  WHERE revoked_on IS NULL;

SELECT apply_tenant_isolation('api_key');

COMMENT ON COLUMN api_key.tail IS
  'The last four characters of the key. The key itself is returned once at '
  'creation and is never stored. See 0037.';

COMMENT ON TABLE saved_report IS
  'A saved question. Running it asks the export path as whoever runs it, so a '
  'shared report returns each reader their own rows — it holds no results. '
  'See 0037.';
