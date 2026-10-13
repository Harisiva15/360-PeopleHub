-- ---------------------------------------------------------------------------
-- The five tables Supabase's default privileges left open to the public roles.
--
-- Migration 0010 is careful about exactly this. Its loop walks every
-- tenant-scoped table, enables and forces row-level security, creates the
-- isolation policy, grants app_rw and authenticated, and ends with
--
--     -- Nothing here is public. Supabase sets default privileges that can
--     -- grant new tables to anon; this takes that back explicitly rather
--     -- than trusting the project's current defaults.
--     EXECUTE format('REVOKE ALL ON public.%I FROM anon', t.table_name);
--
-- That covers the 130 tables carrying a tenant_id. Four tables do not carry
-- one -- country, currency, fx_rate and tenant -- and 0010 gives them a SELECT
-- grant and no revoke. A fifth, schema_migration, is created by
-- scripts/migrate.mjs rather than by a migration, so the loop never saw it at
-- all. Supabase's
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT ALL ON TABLES TO anon, authenticated, service_role
--
-- supplied the rest, and the result in production was that anon and
-- authenticated held SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and
-- TRIGGER on all five, with no row-level security on any of them.
--
-- anon is the role the publishable key maps to, and that key ships in the
-- frontend bundle. 130 foreign keys reference tenant (id), every one of them
-- ON DELETE CASCADE, so
--
--     DELETE /rest/v1/tenant?id=eq.<id>
--
-- with a key that is public by design would have deleted the tenant and
-- cascaded through all 130 tenant-scoped tables. The tenant id is readable
-- with the same key. Confirmed against production by privilege catalogue and
-- by a POST of {} through PostgREST, which returned a not-null violation from
-- the database on all five -- meaning the statement was executed -- against
-- "permission denied for table employee" on a table 0010 had covered.
--
-- The local test cluster could not reproduce it: its roles are created by the
-- test harness, which does not set Supabase's default privileges, so tables
-- created there never received the grants. That is why fifty-four migrations
-- of green suites said nothing about it. Section 5 is the part that makes the
-- next one visible wherever it happens.
--
-- ## What this deliberately does not do
--
-- It does not enable row-level security on `tenant`. The slug-to-id lookup at
-- sign-in necessarily runs before any tenant context exists, so forcing RLS
-- there would break authentication. Narrowing that read is a separate change
-- that needs its own thought, and leaving it readable to app_rw is what 0010
-- already intended.
--
-- It does not touch service_role. That key is held only by this server, is
-- documented as bypassing RLS by design, and narrowing it removes no attack
-- surface -- nothing a caller can reach carries it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The five tables.
--
-- SELECT goes too, not only the writes. Nothing reads these as anon or
-- authenticated: the frontend's Supabase client is built in
-- src/auth/supabase.ts and used only for auth.getSession,
-- auth.signInWithPassword, auth.signOut, auth.updateUser,
-- auth.resetPasswordForEmail, auth.onAuthStateChange and the MFA calls. It
-- never calls .from() or .rpc(), and every data read in the product goes
-- through src/services/http/client.ts to this API, which connects as app_rw.
-- So there is no PostgREST read to preserve, and a SELECT grant nobody uses is
-- a tenant's legal name and fiscal configuration readable by anybody holding a
-- public key.
--
-- app_rw keeps everything it had: SELECT on the four reference tables, and the
-- column-level UPDATE (display_name) on tenant that 0053 added. A table-level
-- REVOKE against a different role does not touch a column-level grant to this
-- one.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
  t text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      CONTINUE;
    END IF;
    FOREACH t IN ARRAY ARRAY['country', 'currency', 'fx_rate', 'tenant',
                             'schema_migration'] LOOP
      EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Sequences.
--
-- audit_log_id_seq and notification_log_id_seq were USAGE and UPDATE to both
-- public roles, from the same default privileges. Neither role can reach
-- either table, so this bought nothing but the ability to burn sequence
-- values. Revoked across the schema rather than by name, because the two that
-- turned up are only the two that happen to exist today.
--
-- app_rw is unaffected: 0010 grants it USAGE, SELECT on all sequences, and a
-- revoke naming anon and authenticated does not reach it.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. And so the defaults stop handing out grants nobody asked for.
--
-- Sections 1 and 2 fix the objects that exist. This is why the next table does
-- not arrive in the same state: default privileges are per owning role and
-- schema, migrations run as the owner, and so an object a future migration
-- creates is covered the day it is created rather than the day somebody
-- notices.
--
-- Deliberately before the two objects this migration goes on to create, so
-- they are not granted out and immediately revoked.
--
-- Safe because no PostgREST caller exists to break. If one is ever wanted, the
-- grant becomes a line in the migration that introduces it, which is where a
-- decision like that belongs: visible, reviewed, and attached to a reason.
--
-- ## What this cannot do, and why section 5 is the real guard
--
-- ALTER DEFAULT PRIVILEGES only edits pg_default_acl, which is the set of
-- *additional* grants a role makes on the objects it creates. It cannot touch
-- PostgreSQL's own built-in default, which grants EXECUTE on every new
-- function to PUBLIC and is part of the language rather than of any ACL this
-- statement can reach. There is no "ALTER DEFAULT PRIVILEGES ... REVOKE
-- EXECUTE ... FROM PUBLIC" that makes the next CREATE FUNCTION private.
--
-- So the next function added to this schema will be executable by anon again,
-- through PUBLIC, whatever this section says — exactly as the seven
-- invoker-rights functions in section 6 were. The only thing that catches that
-- is public_write_exposure(), checked by scripts/migrate.mjs after every run.
-- This section narrows what the defaults hand out; the gate is what notices
-- when something slips past anyway, and the two are not substitutes.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The grant the startup check needs.
--
-- app_rw had nothing at all on schema_migration, because migrate.mjs creates
-- it outside the migrations and no migration ever granted it. The server needs
-- to read it to answer "is this code newer than this database" -- the question
-- that made this investigation necessary, since de4b462 deployed four
-- migrations ahead of production and nothing said so.
--
-- SELECT only. The ledger is written by the migration runner connecting as the
-- owning role, and an application that can edit the record of what has been
-- applied can erase the evidence of what it did.
-- ---------------------------------------------------------------------------

GRANT SELECT ON schema_migration TO app_rw;

-- ---------------------------------------------------------------------------
-- 5. So that the next one is caught by the build rather than by reading
--    catalogues at eleven at night.
--
-- The same shape as tenancy_gaps(), which has been catching a missing
-- tenant_id since 0010: one row per problem, nothing when there is nothing to
-- say, called by scripts/migrate.mjs after every run.
--
-- RLS is what makes a write grant acceptable, which is why a table is only a
-- finding when it is writable *and* unprotected. `authenticated` holds DML on
-- all 130 tenant-scoped tables and that is correct, because the isolation
-- policy stands between it and anybody else's rows.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public_write_exposure()
RETURNS TABLE (object_kind text, object_name text, grantee text, problem text)
LANGUAGE sql
STABLE
AS $$
  WITH public_roles AS (
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  )
  SELECT 'table'::text, c.relname::text, r.rolname::text,
         'writable by a public role with no row-level security'::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN public_roles r
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND NOT c.relrowsecurity
     AND (has_table_privilege(r.rolname, c.oid, 'INSERT')
       OR has_table_privilege(r.rolname, c.oid, 'UPDATE')
       OR has_table_privilege(r.rolname, c.oid, 'DELETE')
       OR has_table_privilege(r.rolname, c.oid, 'TRUNCATE'))

  UNION ALL

  SELECT 'sequence'::text, c.relname::text, r.rolname::text,
         'usable by a public role'::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN public_roles r
   WHERE n.nspname = 'public'
     AND c.relkind = 'S'
     AND (has_sequence_privilege(r.rolname, c.oid, 'USAGE')
       OR has_sequence_privilege(r.rolname, c.oid, 'UPDATE'))

  UNION ALL

  SELECT 'function'::text, p.proname::text, r.rolname::text,
         CASE WHEN p.prosecdef
              THEN 'SECURITY DEFINER and executable by a public role'
              ELSE 'executable by a public role' END::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN public_roles r
   WHERE n.nspname = 'public'
     AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')

  ORDER BY 1, 2, 3;
$$;

COMMENT ON FUNCTION public_write_exposure() IS
  'Tables, sequences and functions in public that anon or authenticated can '
  'reach without row-level security standing in the way. Empty is correct.';

-- ---------------------------------------------------------------------------
-- 6. Functions, last, so the sweep covers the one created above.
--
-- Twelve functions in `public` are ours rather than an extension's, and all
-- twelve were executable by anon and authenticated. Five are SECURITY DEFINER,
-- which means they run as their owner and row-level security does not apply to
-- what they read:
--
--     auth_claim_membership(uuid, citext)  attaches an auth user to a membership
--     auth_email_for(uuid)                 reads an address out of auth.users
--     auth_has_verified_factor(uuid)       reads MFA state
--     auth_membership(uuid)                reads one user's memberships
--     auth_membership_status(uuid)         reads one membership's status
--
-- Every one of those migrations already said what it wanted:
--
--     REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--     GRANT EXECUTE ON FUNCTION ... TO app_rw;
--
-- REVOKE FROM PUBLIC removes the implicit grant every role holds. It does not
-- remove an explicit grant to a named role, and Supabase's default privileges
-- make an explicit one to anon and authenticated at creation time. So the
-- intent was recorded five times and defeated five times.
--
-- auth_claim_membership is the one that matters: it takes a user id and an
-- email and it writes, and it is the function the claim flow uses to attach an
-- invited administrator's account. 0049 narrowed what it will accept; it was
-- never meant to be callable by an unauthenticated caller.
--
-- 0011 granted auth_membership(uuid) to authenticated deliberately -- "granted
-- anyway so a tenant picker can use one call". No tenant picker was ever built
-- on it, nothing in src/ calls an RPC, and as written the function takes an
-- arbitrary user id without checking it against auth.uid(), so any
-- authenticated caller could read any other user's memberships. That grant is
-- withdrawn with the rest. If a PostgREST tenant picker is ever wanted, it
-- needs the auth.uid() check first.
--
-- ## Both halves of the revoke, which the rehearsal is what found
--
-- The seven invoker-rights functions needed PUBLIC revoking as well as the two
-- named roles. PostgreSQL grants EXECUTE on a new function to PUBLIC, so
-- revoking anon's explicit grant left anon holding it anyway through PUBLIC --
-- and that is precisely why the five above read as revoked after a first
-- attempt while these seven did not: their own migrations had each already
-- revoked PUBLIC, and these had nothing.
--
-- ## And why app_rw is granted all of them back
--
-- Because PUBLIC is where app_rw was getting most of these, and two of them
-- are load-bearing. tenancy_gaps() is called by src/index.ts at startup and
-- the server refuses to boot if it cannot run it. current_tenant_id() is
-- called by the isolation policy on all 130 tables and by the tenant_id
-- default on every one of them, evaluated as whoever is querying -- which is
-- app_rw. Granting the whole set rather than enumerating is the choice that
-- cannot be subtly wrong in the direction of an outage, and it hands app_rw
-- nothing it can misuse: the SECURITY DEFINER five were already granted to it
-- on purpose, and apply_tenant_isolation(text) performs DDL that app_rw does
-- not own and therefore cannot execute successfully.
--
-- ## supabase_auth_admin loses these seven, and that was checked rather than
--    assumed
--
-- It holds EXECUTE on the seven invoker-rights functions and on none of the
-- five SECURITY DEFINER ones — which is the signature of a privilege nobody
-- granted: PUBLIC gave it the seven, and the five had PUBLIC revoked by their
-- own migrations. Revoking PUBLIC therefore takes those seven away from the
-- role GoTrue connects as, so before doing it:
--
--   triggers on any auth.* table                                  0
--   event triggers pointing into public                           0 (all six
--                                                 point at extensions.*)
--   auth.* functions mentioning "public."                         0
--   auth.* functions naming any of our twelve                     0
--   column defaults on auth.* naming any of our twelve            0
--   policies on auth.* tables                                     0
--   Auth Hooks configured in the project                          none
--   supabase_auth_admin search_path                               "auth"
--
-- public is not even on that role's search_path, so an unqualified call could
-- not resolve, and there is no qualified one. Nothing in the auth stack can
-- reach these functions. Auth Hooks are the one feature that would make GoTrue
-- call a function of ours, and none are configured.
--
-- Not granted back, because a role reachable only by Supabase's own auth
-- service has no business holding EXECUTE on this product's functions. If
-- sign-in ever did depend on one of them, the rollback beside the pre-migration
-- dump restores PUBLIC in a single statement.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r text;
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       -- Plain functions and procedures. An aggregate is not revocable with
       -- ON FUNCTION, and pg_get_functiondef refuses one outright — which is
       -- how this filter was found, from a catalogue query that hit one in the
       -- auth schema. There is no aggregate in public today; this is so that
       -- adding one does not abort the migration that comes after it.
       AND p.prokind IN ('f', 'p')
       -- An extension's functions are the extension's business: citext's
       -- operators have to stay callable or citext columns stop working.
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f.sig, r);
      END IF;
    END LOOP;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_rw', f.sig);
  END LOOP;
END;
$$;
