-- ---------------------------------------------------------------------------
-- 0001 — tenancy foundation (Supabase)
--
-- The isolation model is: one database, one schema, a tenant_id on every
-- business table, and Postgres row-level security enforcing it. The
-- application never writes "WHERE tenant_id = $1"; the tenant is established
-- for the transaction and the database refuses to return anything else.
--
-- Why this and not a schema or database per tenant: there are ~100 business
-- tables. Per-tenant schemas multiply that by the tenant count, so every
-- migration becomes a loop that can half-fail, and connection pooling turns
-- into search_path juggling on every checkout. Shared tables with RLS keep one
-- copy of the schema and make isolation a property the database enforces
-- rather than one the application remembers.
--
-- Identity comes from Supabase Auth. auth.users is the person; this migration
-- adds only what Supabase does not model — which tenants that person may
-- enter, and as what.
-- ---------------------------------------------------------------------------

-- Supabase pre-installs these into the `extensions` schema, so these are
-- usually no-ops. They are here so the migrations also run on a plain
-- PostgreSQL, which is the point of not depending on Supabase-only features.
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Tenant context
--
-- Two callers reach this database and they identify themselves differently:
--
--   * The Node API connects as a Postgres role and sets `app.tenant_id` per
--     transaction with SET LOCAL.
--   * PostgREST — the supabase-js client, the dashboard's API — arrives with a
--     Supabase JWT, whose claims land in `request.jwt.claims`.
--
-- One function reads both so a policy never has to care which arrived. The
-- explicit setting wins, because only trusted server code can set it.
--
-- It RAISES when neither is present rather than returning null. An unset
-- tenant is a bug, and a bug that returns no rows is one you find; a bug that
-- returns everyone's rows is one you find later.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw    text;
  claims jsonb;
BEGIN
  raw := current_setting('app.tenant_id', true);
  IF raw IS NOT NULL AND raw <> '' THEN
    RETURN raw::uuid;
  END IF;

  raw := current_setting('request.jwt.claims', true);
  IF raw IS NOT NULL AND raw <> '' THEN
    claims := raw::jsonb;
    -- app_metadata, not user_metadata: user_metadata is writable by the user
    -- themselves, so a tenant id kept there could be edited into someone
    -- else's. app_metadata can only be set with the service role.
    raw := claims -> 'app_metadata' ->> 'tenant_id';
    IF raw IS NOT NULL AND raw <> '' THEN
      RETURN raw::uuid;
    END IF;
  END IF;

  RAISE EXCEPTION 'no tenant in this session: set app.tenant_id, or sign in with a tenant claim'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- The acting employee, for audit defaults. Unlike the tenant this may be
-- absent — migrations and scheduled jobs act without one.
CREATE OR REPLACE FUNCTION current_actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid;
$$;

-- The caller's role in the current tenant. Reads the JWT first because that is
-- the claim Supabase signed; falls back to the membership table for the Node
-- API, which sets app.tenant_id but carries no JWT.
CREATE OR REPLACE FUNCTION current_app_role() RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw text := current_setting('app.role', true);
BEGIN
  IF raw IS NOT NULL AND raw <> '' THEN
    RETURN raw;
  END IF;
  raw := current_setting('request.jwt.claims', true);
  IF raw IS NOT NULL AND raw <> '' THEN
    RETURN raw::jsonb -> 'app_metadata' ->> 'app_role';
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------

CREATE TABLE tenant (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- URL-safe handle: acme.hub.example.com, or /t/acme.
  slug         citext NOT NULL UNIQUE,
  legal_name   text NOT NULL,
  display_name text NOT NULL,
  -- Home country drives statutory defaults for the first legal entity.
  home_country char(2) NOT NULL,
  base_currency char(3) NOT NULL,
  fiscal_year_start_month smallint NOT NULL DEFAULT 4
    CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  status       text NOT NULL DEFAULT 'active'
    CHECK (status IN ('trial', 'active', 'suspended', 'closed')),
  -- Retention and residency commitments differ per customer contract.
  data_region  text NOT NULL DEFAULT 'ap-south-1',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);

COMMENT ON TABLE tenant IS
  'One customer. Every business row in this database belongs to exactly one.';

-- ---------------------------------------------------------------------------
-- Membership
--
-- Which tenants a Supabase user may enter, and as what. This is the table the
-- sign-in flow reads to decide what to put in the JWT, so it is deliberately
-- outside the tenant_isolation policy: scoping it by the tenant it is used to
-- discover would be circular. It gets its own policy in 0010 — a user may read
-- their own memberships and nothing else.
--
-- The role here is the authority. A JWT claim is a cached copy of it, which is
-- why revoking access means updating this row *and* revoking the session.
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_membership (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- Supabase Auth owns the person. Deleting the login removes the membership;
  -- the employee record survives, because employment history is not identity.
  user_id     uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- Mirrors AppRole in the frontend contract.
  role        text NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),
  -- The employee record this login acts as. Null for a tenant admin who is
  -- not on the payroll — an implementation partner, say.
  employee_id uuid,
  status      text NOT NULL DEFAULT 'active'
    CHECK (status IN ('invited', 'active', 'suspended')),
  invited_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX ON tenant_membership (user_id);
CREATE INDEX ON tenant_membership (tenant_id, role);

-- ---------------------------------------------------------------------------
-- Global reference data
--
-- Shared by every tenant and never written at runtime. Not tenant-scoped, so
-- no isolation policy: these are facts about the world, not about a customer.
-- ---------------------------------------------------------------------------

CREATE TABLE country (
  code        char(2) PRIMARY KEY,
  name        text NOT NULL,
  currency    char(3) NOT NULL,
  flag_emoji  text,
  -- Statutory notice period in days where the law sets a floor.
  notice_days smallint
);

CREATE TABLE currency (
  code      char(3) PRIMARY KEY,
  name      text NOT NULL,
  symbol    text NOT NULL,
  -- Minor units: 2 for INR and USD, 0 for JPY.
  precision smallint NOT NULL DEFAULT 2
);

-- Rates are dated, because converting last March's invoice at today's rate is
-- how reported revenue drifts from the ledger.
CREATE TABLE fx_rate (
  base_currency  char(3) NOT NULL REFERENCES currency (code),
  quote_currency char(3) NOT NULL REFERENCES currency (code),
  rate_date      date NOT NULL,
  rate           numeric(18, 8) NOT NULL CHECK (rate > 0),
  PRIMARY KEY (base_currency, quote_currency, rate_date)
);

ALTER TABLE tenant
  ADD CONSTRAINT tenant_home_country_fkey
  FOREIGN KEY (home_country) REFERENCES country (code),
  ADD CONSTRAINT tenant_base_currency_fkey
  FOREIGN KEY (base_currency) REFERENCES currency (code);
