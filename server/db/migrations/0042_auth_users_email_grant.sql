-- ---------------------------------------------------------------------------
-- 0042 — the application role may read a sign-in address, and nothing else
--
-- The user-administration projection joined `auth.users` for one column:
--
--     LEFT JOIN auth.users u ON u.id = m.user_id      -- for u.email
--
-- an account may exist before its employee record carries an address, so the
-- login address is the fallback the screen shows. `app_rw` has no access to
-- the `auth` schema, so every route that reads an account answered:
--
--     permission denied for schema auth
--
-- That is the whole of User Management — the list, one account, create, update
-- and decide. It was invisible until DATABASE_URL was pointed at app_rw,
-- because as the owner the join needs no grant.
--
-- **A function rather than a grant, because a grant is not available.** The
-- `auth` schema is owned by supabase_auth_admin, so the migration role cannot
-- GRANT USAGE on it — `must be owner of schema auth`. That turns out to be the
-- better answer anyway, and it is the one this codebase already uses: 0011,
-- 0013 and 0039 all reach into `auth` through a narrow SECURITY DEFINER
-- function rather than opening the schema.
--
-- **One column, one row, by primary key.** A grant on the table — even column
-- level — would have been a standing permission on `auth.users`. This returns
-- an address for a user id the caller already holds, and can express nothing
-- else: no listing, no search by address, no password hash, no token. A query
-- that wants more has to come back here and say why.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_email_for(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Pinned so the function cannot be redirected at a shadowed table by a caller
-- who controls their own search_path. Mandatory on SECURITY DEFINER.
SET search_path = public, pg_temp
AS $$
  SELECT u.email::text FROM auth.users u WHERE u.id = p_user_id;
$$;

COMMENT ON FUNCTION auth_email_for(uuid) IS
  'The sign-in address for one user id, for the account screens. Returns one '
  'column of one row and nothing else — no listing, no lookup by address, no '
  'password hash. See 0042.';

REVOKE ALL ON FUNCTION auth_email_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_email_for(uuid) TO app_rw;
