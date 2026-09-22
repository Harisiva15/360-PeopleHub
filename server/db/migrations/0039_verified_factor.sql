-- ---------------------------------------------------------------------------
-- 0039 — is a second factor actually required of this caller?
--
-- **Why this exists at all.** The application grew a two-factor sign-in whose
-- gate lived entirely in the browser. `AuthGate` refused to render while the
-- session sat at aal1, which looks like a security control and is not one: the
-- token in that session is a perfectly valid bearer token, and every endpoint
-- on this server accepted it. Anybody who could reach the sign-in page with a
-- stolen password could skip the code screen by not using the screen — curl
-- with the token from local storage, and the whole API answers.
--
-- That is the exact failure a hidden menu item is: a control drawn on the
-- client and enforced nowhere. Migration 0011 exists because a JWT is a cached
-- copy of a decision; this one exists for the same reason one layer up.
--
-- **What the token already says, and what it does not.** Supabase puts `aal`
-- in the claims: 'aal2' once a factor has been satisfied, 'aal1' otherwise.
-- But 'aal1' on its own is not grounds for refusal — an account with no factor
-- enrolled is legitimately at aal1 forever. The missing half is whether this
-- user *has* a verified factor, which lives in auth.mfa_factors and which the
-- token deliberately does not carry.
--
-- **SECURITY DEFINER, and narrowly.** Returns one boolean about one user id.
-- It cannot list factors, cannot name them and cannot be asked anything about
-- a user the caller has not already authenticated as — the only call site
-- passes the `sub` of a token it has just verified. The search_path is pinned
-- because it must be on any SECURITY DEFINER function.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_has_verified_factor(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM auth.mfa_factors f
     WHERE f.user_id = p_user_id
       AND f.status = 'verified'
  );
$$;

COMMENT ON FUNCTION auth_has_verified_factor(uuid) IS
  'True when this user has a verified MFA factor, so an aal1 token from them '
  'must be refused. One boolean about one user and nothing else. See 0039.';

REVOKE ALL ON FUNCTION auth_has_verified_factor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_has_verified_factor(uuid) TO app_rw;
