/**
 * Where the transport gets its token, and how it tells a renewal apart from a
 * sign-out.
 *
 * ## Why this is its own module
 *
 * `request()` used to read the token inline:
 *
 *     const token = await bearerToken();
 *     if (!token) throw new ApiError(401, 'You are not signed in');
 *
 * Those two lines conflate two different situations. One is a person who is
 * signed out, where the auth layer is already putting the login page up and
 * the right thing to do is nothing. The other is a person who is signed in and
 * whose access token is being renewed *right now* — supabase-js refreshes in
 * the background, and `getSession()` can answer with nothing for the width of
 * that window. The second one is not a failure at all, and it was being
 * reported as the first: the read failed, the toast for it was deliberately
 * suppressed, and the screen was left half-empty with no error anywhere. That
 * is the production symptom this fixes.
 *
 * Telling them apart needs a fact `getSession()` does not carry: whether we
 * have ever seen a session on this page. That is what `believed` below tracks,
 * and keeping it here — rather than in `client.ts` — is what lets the check
 * drive the whole decision without a Supabase project.
 */

import { supabase } from '../../auth/supabase';

/**
 * The transport's view of the session. Three questions, because the answer to
 * "no token" depends entirely on which of the other two applies.
 */
export interface SessionSource {
  /** The access token right now, or null if there is not one this instant. */
  token(): Promise<string | null>;
  /**
   * Wait for a renewal to finish and answer with the token afterwards, or null
   * if it did not produce one. Concurrent callers share one renewal.
   */
  refresh(): Promise<string | null>;
  /**
   * True when there is known to be no session: signed out, or never signed in
   * on this page. False means a session has been seen and a missing token is
   * therefore a renewal in progress.
   */
  signedOut(): boolean;
}

/**
 * Whether a session has ever been observed on this page.
 *
 * `unknown` and `no` are both treated as signed out, and that asymmetry is
 * deliberate. Before sign-in — the login page, a cold load by a visitor with
 * no session — there is nothing to renew, so a missing token means exactly
 * what it says and must stay silent. Only after a session has actually been
 * seen can a missing token mean "being renewed", which is the one case worth
 * waiting for. So the quiet answer is the default and the retry is the
 * exception, rather than the other way round.
 */
type Believed = 'unknown' | 'yes' | 'no';

function supabaseSource(): SessionSource {
  let believed: Believed = 'unknown';

  /*
   * `onAuthStateChange` fires INITIAL_SESSION on load, then SIGNED_IN,
   * TOKEN_REFRESHED and SIGNED_OUT as they happen. Any event carrying a
   * session proves there is one; SIGNED_OUT proves there is not. Anything
   * else leaves the belief alone — an event we do not recognise is not
   * evidence either way.
   */
  supabase?.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') believed = 'no';
    else if (session) believed = 'yes';
  });

  return {
    async token() {
      if (!supabase) return null;
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token ?? null;
      if (token) believed = 'yes';
      return token;
    },

    async refresh() {
      if (!supabase) return null;
      try {
        const { data } = await supabase.auth.refreshSession();
        const token = data.session?.access_token ?? null;
        if (token) believed = 'yes';
        return token;
      } catch {
        /* A renewal that throws is not a sign-out: the refresh token may
           still be good and the network may not have been. The caller
           reports it as something to retry, which is what it is. */
        return null;
      }
    },

    signedOut() {
      return believed !== 'yes';
    },
  };
}

/**
 * One renewal, however many requests are waiting on it.
 *
 * Ten panels mounting at once would otherwise start ten renewals, and
 * supabase-js *rotates* the refresh token on each — racing rotations is how a
 * perfectly good session gets dropped, which would turn this fix into a worse
 * version of the bug it repairs.
 *
 * Separated from `supabaseSource` so it can be driven in a check: the sharing
 * is the part with a race in it, and asserting it needs a source that counts
 * its renewals, not a Supabase project.
 */
export function coalesceRefresh(inner: SessionSource): SessionSource {
  let inFlight: Promise<string | null> | null = null;

  return {
    token: () => inner.token(),
    signedOut: () => inner.signedOut(),
    refresh() {
      if (inFlight) return inFlight;
      const run = inner.refresh();
      inFlight = run;
      /* Cleared once settled, and only if it is still the current one, so a
         later renewal is never cancelled by an earlier one finishing. */
      void run.then(
        () => { if (inFlight === run) inFlight = null; },
        () => { if (inFlight === run) inFlight = null; },
      );
      return run;
    },
  };
}

let source: SessionSource = coalesceRefresh(supabaseSource());

export const sessionSource = (): SessionSource => source;

/**
 * Replace the session for a test, and hand back a restore function.
 *
 * The only way to drive a renewal window deterministically. Everything in
 * `client.ts` goes through `sessionSource()`, so a check can make the first
 * read answer nothing and the renewal answer a token, which is the sequence
 * that produced the outage and cannot otherwise be staged.
 */
export function setSessionSourceForTests(next: SessionSource): () => void {
  const previous = source;
  source = next;
  return () => { source = previous; };
}
