/**
 * The Supabase client, and the decision about whether there is one at all.
 *
 * Two modes, chosen by whether the build was given a Supabase project:
 *
 *   configured   — real sign-in. Nobody sees a page without a session.
 *   demo         — no project, so no auth. The role switcher stands in, and
 *                  every screen reads the in-memory dataset.
 *
 * That split is deliberate rather than a convenience. The public demo at
 * harisiva15.github.io has no backend and must keep working; a real deployment
 * must not be reachable without signing in. One build, and the environment
 * decides which it is — with the fallback being the harmless one.
 */

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * How this page was arrived at, if Supabase sent us here — read first, before
 * anything else in the module.
 *
 * Supabase's `/auth/v1/verify` redirects to `redirect_to#access_token=…&type=…`
 * where `type` is `invite`, `recovery`, `magiclink` or `signup`. The client
 * below is created with `detectSessionInUrl`, which consumes that fragment and
 * clears it, so by the time any component renders there is nothing left to
 * read. Hence this runs at module evaluation, above `createClient`, and keeps
 * the answer.
 *
 * It matters because an invitation does **not** arrive as `PASSWORD_RECOVERY`.
 * Supabase treats verifying an invite as a sign-in, so the only client-side
 * signal that somebody got here from an invitation rather than by typing a
 * password is this `type`. Without it an invited person went straight to the
 * home page.
 *
 * The database flag `must_change_password` is the authority; this exists so the
 * password screen is up immediately, rather than after `account-status` comes
 * back. If the two disagree, the flag wins.
 *
 * A normal route looks like `#/employees`, which carries no `=` and parses to
 * nothing — so this reads null on every ordinary page load.
 */
export function linkTypeFrom(hash: string): string | null {
  /* A HashRouter path like `#/employees` carries no `=` and is not an
     arrival. Checking for one first keeps routes out of the parser. */
  if (!hash.includes('=')) return null;
  try {
    return new URLSearchParams(hash.replace(/^#\/?/, '')).get('type');
  } catch {
    return null;
  }
}

export const arrivedByLinkType: string | null = (() => {
  try {
    return linkTypeFrom(typeof window === 'undefined' ? '' : window.location.hash);
  } catch {
    /* A cross-origin or otherwise unreadable location is not a link arrival. */
    return null;
  }
})();

/**
 * Whether that link can only mean "choose a password".
 *
 * `invite` and `recovery` both do. `magiclink` and `signup` do not — those are
 * ways of signing in, not of setting a credential, and treating them as a
 * password change would trap anybody using one.
 */
export const setsPasswordType = (t: string | null): boolean =>
  t === 'invite' || t === 'recovery';

/**
 * Whether this arrival still owes a password.
 *
 * A function over a mutable flag rather than a constant, because it describes
 * an obligation and obligations get discharged. `AuthProvider` seeds its
 * `recovering` state from this on mount, and `recovering` short-circuits the
 * gate — so a constant would re-close the gate on **every** remount of the
 * provider, for the rest of the page's life, including after the password had
 * been set. Somebody who set their password and signed in again would be sent
 * straight back to the password screen with nothing left to do there.
 *
 * It stays true across a remount until the password is actually set, which is
 * the behaviour wanted in between: if the provider remounts before somebody
 * has chosen one, the gate must still close.
 *
 * `clearArrivedToSetPassword` is what discharges it, called from `setPassword`
 * once the change has gone through.
 */
let passwordOwed = setsPasswordType(arrivedByLinkType);

export const arrivedToSetPassword = (): boolean => passwordOwed;
export const clearArrivedToSetPassword = (): void => { passwordOwed = false; };

const url = import.meta.env.VITE_SUPABASE_URL ?? '';

/*
 * The browser-side key. Safe to ship in a bundle — it identifies the project
 * and authorises nothing; row-level security is what authorises.
 *
 * There used to be a fallback to `VITE_SUPABASE_ANON_KEY`, from when Supabase
 * issued an anon JWT here instead of `sb_publishable_...`. It is gone, because
 * this project's legacy JWT-based API keys have been disabled: the fallback
 * could no longer reach a working key, and all it could still do is turn a
 * missing publishable key into a build that looks configured, fails every
 * request at Supabase, and says nothing about why.
 *
 * Missing is now simply missing, and `authConfigured` reports it as demo mode.
 */
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';

/** True when this build has a project to authenticate against. */
export const authConfigured = Boolean(url && publishableKey);

/**
 * Null in demo mode. Every caller checks `authConfigured` first, so the null
 * is never dereferenced — and making it null rather than a stub means a
 * mistake fails loudly at the call site instead of silently doing nothing.
 */
export const supabase: SupabaseClient | null = authConfigured
  ? createClient(url, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // The OAuth redirect comes back with the token in the URL fragment.
        // This app uses HashRouter, so the fragment is also the route — let
        // the client consume the token and clean up before routing reads it.
        detectSessionInUrl: true,
      },
    })
  : null;


/**
 * Where the identity provider sends the browser back to.
 *
 * Must be the page itself, and must be listed in Supabase under
 * Authentication -> URL Configuration. Built from `location` rather than
 * hard-coded so the same build works on localhost and on the deployed path.
 */
export const redirectTo = (): string =>
  `${window.location.origin}${window.location.pathname}`;
