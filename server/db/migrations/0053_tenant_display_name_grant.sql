-- The application may rename what the company calls itself, and nothing else.
--
-- `tenant` is the tenancy root. 0010 granted `app_rw` SELECT on it and nothing
-- more, deliberately, alongside `country`, `currency` and `fx_rate` — the global
-- reference tables. In fifty-two migrations nothing has ever written to it
-- outside the seed, and `app_rw` is NOBYPASSRLS precisely so the database is the
-- boundary rather than the application's memory of one.
--
-- That is the right default and this migration keeps almost all of it. The one
-- thing it opens is `display_name`: the trading name, which the Company Profile
-- screen has shown from a client-side constant since the screen existed, so an
-- administrator correcting it changed nothing.
--
-- ## Why a column grant rather than a table grant
--
-- `GRANT UPDATE ON tenant` would let the application write every column, and the
-- columns on this table are not preferences:
--
--   * `status` — a suspended tenant could set itself back to 'active'.
--   * `data_region` — a residency commitment in a customer contract, not a
--     setting.
--   * `slug` — the URL identity, UNIQUE, and how a login finds its tenant.
--   * `base_currency` — read by hiring, expenses, benefits, leave, assets and
--     exits. Several of those store amounts that carry no currency of their own,
--     so changing this reinterprets money already recorded.
--   * `home_country` and `fiscal_year_start_month` — statutory defaults, and the
--     second decides which leave year `leave_balance` repricing targets.
--
-- A column-level grant makes all of that unreachable in the database rather than
-- unreachable by convention. If the service is ever wrong — a patch that spreads
-- a request body into an UPDATE, say — PostgreSQL refuses the statement instead
-- of applying it. This is the first column-level grant in the schema; every
-- other grant here is table-level, because every other table has no column that
-- must stay beyond reach.
--
-- `updated_at` is deliberately NOT granted. Bumping it would widen this grant,
-- and since nothing has ever updated `tenant`, the column already equals
-- `created_at` and already does not mean "last modified". `audit_log` records who
-- changed the name and when.
--
-- ## Why this is safe to run against a live database
--
-- One statement, and it is a catalogue change: GRANT writes to `pg_attribute`'s
-- ACL. No table rewrite, no lock on the rows, no data touched, and the cost does
-- not grow with the number of tenants. It adds a privilege and removes none, so
-- every existing read keeps working. There is nothing to roll back but the
-- grant itself.
--
-- It is also idempotent: granting a privilege that is already held is a no-op.

GRANT UPDATE (display_name) ON tenant TO app_rw;

COMMENT ON COLUMN tenant.display_name IS
  'The trading name, shown wherever the product names the company. The only '
  'column on this table the application role may write — see migration 0053.';
