-- ---------------------------------------------------------------------------
-- 0001 — tenancy foundation
--
-- The isolation model is: one database, one schema, a tenant_id on every
-- business table, and Postgres row-level security enforcing it. The
-- application never writes "WHERE tenant_id = $1"; it sets the tenant for the
-- transaction and the database refuses to return anything else.
--
-- Why this and not a schema or database per tenant: there are ~100 business
-- tables. Per-tenant schemas multiply that by the tenant count, so every
-- migration becomes a loop that can half-fail, and connection pooling turns
-- into search_path juggling on every checkout. Shared tables with RLS keep one
-- copy of the schema and make isolation a property the database enforces
-- rather than one the application remembers.
--
-- What that model costs, stated plainly: a noisy tenant shares your buffer
-- cache, per-tenant restore means filtering rows rather than restoring a
-- database, and one bad migration touches everyone. Tenants that need physical
-- separation get their own deployment; this schema is unchanged by that.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Tenant context
--
-- Set per transaction with SET LOCAL, so it cannot leak to the next request
-- that borrows the same pooled connection. Reading it is deliberately strict:
-- an unset tenant raises rather than defaulting to something permissive.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw text := current_setting('app.tenant_id', true);
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RAISE EXCEPTION 'app.tenant_id is not set for this transaction'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN raw::uuid;
END;
$$;

-- The acting user, for audit defaults. Unlike the tenant this may be absent —
-- migrations and scheduled jobs act without one.
CREATE OR REPLACE FUNCTION current_actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- Tenants and identities
--
-- These four tables are NOT tenant-scoped: they are how a request discovers
-- which tenant it belongs to, so scoping them by tenant would be circular.
-- They carry no RLS and the application must query them deliberately.
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

-- A person's login, which is global: the same human can be an employee at one
-- tenant and an external recruiter at another without two passwords.
CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  full_name     text NOT NULL,
  -- Null when the account authenticates only through SSO.
  password_hash text,
  mfa_secret    text,
  mfa_enabled   boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active'
    CHECK (status IN ('invited', 'active', 'locked', 'disabled')),
  last_login_at timestamptz,
  failed_logins smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Which tenants a login may enter, and as what. This is the table the login
-- flow reads to build a session; the role here is the one RLS and the API
-- authorise against.
CREATE TABLE tenant_membership (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  -- Mirrors AppRole in the frontend contract.
  role        text NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),
  -- The employee record this login acts as. Null for a tenant admin who is
  -- not on the payroll — an implementation partner, say.
  employee_id uuid,
  status      text NOT NULL DEFAULT 'active'
    CHECK (status IN ('invited', 'active', 'suspended')),
  invited_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX ON tenant_membership (user_id);
CREATE INDEX ON tenant_membership (tenant_id, role);

-- Issued sessions, so a compromised token can be revoked without waiting for
-- expiry. One row per refresh token; access tokens stay stateless.
CREATE TABLE user_session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  -- The tenant this session is scoped to. Switching tenant issues a new
  -- session rather than mutating this one.
  tenant_id      uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  ip             inet,
  user_agent     text
);

CREATE INDEX ON user_session (user_id, expires_at);

-- ---------------------------------------------------------------------------
-- Global reference data
--
-- Shared by every tenant and never written at runtime. Not tenant-scoped, so
-- no RLS: these are facts about the world, not about a customer.
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
