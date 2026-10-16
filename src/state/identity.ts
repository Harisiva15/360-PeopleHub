/**
 * When to ask the server who you are, and what to do when it cannot say.
 *
 * ## The bug this is lifted out of
 *
 * `useResolvedIdentity` ran its effect on mount with the dependencies
 * `[setRole, setMeId, attempt]` — none of which is the session. So on a cold
 * load it called `users.me()` immediately, in parallel with `AuthProvider`
 * still resolving the session out of storage or out of the URL fragment. When
 * `supabase.auth.getSession()` had not settled yet, `bearerToken()` returned
 * null, the client threw `401 You are not signed in`, and the resolver latched
 * that into `identityError`.
 *
 * A moment later the session arrived, `auth.session` became non-null, so
 * `AuthGate` walked past its own `if (!auth.session) return <LoginPage/>` and
 * reached the identity branch — where the error was already sitting. The result
 * was a signed-in person looking at "We could not tell who you are — You are
 * not signed in", with only Try again or Sign out to escape, on a URL they had
 * deep-linked to. The effect never re-ran, because nothing it depended on had
 * changed.
 *
 * Two separate faults, and this module is about both:
 *
 *   1. Resolution started before there was a session to resolve against, and
 *      never restarted when one appeared.
 *   2. "There is no session" was reported as an identity failure, which is a
 *      dead end, when it is simply a reason to show the sign-in screen.
 *
 * ## Why a pure function
 *
 * The decision is four inputs and five outcomes, and all of the interesting
 * cases are orderings — session after mount, token replaced an hour in, an
 * expired session whose refresh failed. Driving those through a React effect
 * needs a DOM and a clock; driving them through a function needs neither, and
 * the assertions end up pinning the rule rather than the render.
 */

/** What the identity resolver should do next. */
export type IdentityPlan =
  /** The session check has not come back. Show nothing, decide nothing. */
  | { do: 'wait' }
  /**
   * There is no session. The sign-in screen — never the identity error, which
   * is what produced a dead end for somebody who only needed to sign in again.
   */
  | { do: 'sign-in' }
  /** Ask the server, with this token. */
  | { do: 'resolve'; token: string }
  /** Already answered for this exact token; asking again would be a loop. */
  | { do: 'keep' };

export interface IdentityInputs {
  /** False in the demo build, where identity comes from the dataset. */
  apiMode: boolean;
  /** Whether the first session check has resolved. */
  authReady: boolean;
  /** The access token the session currently holds, or null for no session. */
  accessToken: string | null;
  /** The token identity was last resolved against, or null if never. */
  resolvedFor: string | null;
}

/**
 * The rule, in order.
 *
 * `resolvedFor` is the token rather than a boolean on purpose: a refresh
 * replaces the token roughly hourly, and re-resolving then is how the app
 * notices a membership or a role that changed underneath it. Comparing a
 * boolean would resolve once and never again; comparing the token resolves
 * exactly when the answer could have changed.
 */
export function identityPlan(i: IdentityInputs): IdentityPlan {
  /* The demo build has an identity before it renders, and no session at all. */
  if (!i.apiMode) return { do: 'keep' };
  /*
   * Before the session check settles there is nothing to say. This is the
   * window the original bug lived in: it used to ask anyway.
   */
  if (!i.authReady) return { do: 'wait' };
  if (!i.accessToken) return { do: 'sign-in' };
  if (i.resolvedFor === i.accessToken) return { do: 'keep' };
  return { do: 'resolve', token: i.accessToken };
}

/**
 * What a failed resolution means.
 *
 * `session-lost` is the case that must not become a dead end: the token was
 * there when the plan was made and gone by the time the request went out,
 * which is an expired session whose refresh failed, or a sign-out in another
 * tab. The answer is the sign-in screen.
 *
 * `unusable` is everything else, and the explanatory screen is right for it —
 * an account with no employee row genuinely cannot proceed, and "ask your HR
 * administrator" is the only useful thing to say. Collapsing the two is what
 * made a recoverable state look like a broken account.
 */
export type IdentityFailure = 'session-lost' | 'unusable';

export function identityFailure(e: unknown): IdentityFailure {
  const status = (e as { status?: unknown } | null)?.status;
  /*
   * Every 401, not just the one the client raises itself. The server answers
   * `401 token could not be verified` for a signature it cannot check and for a
   * JWKS endpoint that is down, and `ApiError` carries the status through — so
   * an expired or unverifiable token arrives here as a 401 and belongs at the
   * sign-in screen rather than behind "We could not tell who you are".
   */
  if (status === 401) return 'session-lost';
  const message = e instanceof Error ? e.message : String(e ?? '');
  /*
   * The client throws this exact sentence from one place, when it has no token
   * to attach. Matched as a fallback for the case where the error crossed a
   * boundary that kept the message and dropped the status.
   */
  return /not signed in/i.test(message) ? 'session-lost' : 'unusable';
}

/* ------------------------------------------------------------------ *
 * The state the gate reads, as a transition rather than a set of setters
 * ------------------------------------------------------------------ */

/**
 * What `AuthGate` branches on.
 *
 * `ready` is the one that decides whether the application is mounted at all,
 * which makes every transition that touches it a decision about whether
 * somebody's screen survives.
 */
export interface IdentityState {
  ready: boolean;
  error: string | null;
  sessionLost: boolean;
}

export const IDENTITY_START: IdentityState = {
  ready: false, error: null, sessionLost: false,
};

/**
 * Moving on a plan, before the request goes out.
 *
 * **`resolve` preserves `ready`, and that is the whole point of this function.**
 * The access token is replaced roughly hourly by `TOKEN_REFRESHED`, which makes
 * the plan `resolve` again — and setting `ready` false there would unmount the
 * entire application every hour, mid-sentence, while a request nobody asked for
 * went out. Somebody typing a leave reason would lose it to a background token
 * rotation. So a re-resolution happens underneath a mounted UI, and `ready`
 * only ever goes false when there is genuinely nothing to show.
 *
 * On a first load `ready` is already false and stays false, so the gate shows
 * "Loading your profile…" exactly as before.
 */
export function identityOnPlan(prev: IdentityState, plan: IdentityPlan): IdentityState {
  switch (plan.do) {
    case 'keep':
      return prev;
    /* Nothing is known yet; nothing is claimed. */
    case 'wait':
      return { ready: prev.ready, error: null, sessionLost: false };
    case 'sign-in':
      return { ready: false, error: null, sessionLost: true };
    case 'resolve':
      /* ready carried over deliberately — see above. */
      return { ready: prev.ready, error: null, sessionLost: false };
    default:
      return prev;
  }
}

/** How a resolution ended. */
export type IdentitySettled =
  | { kind: 'resolved' }
  | { kind: 'failed'; failure: IdentityFailure; message: string };

/**
 * Moving on the answer.
 *
 * `unusable` also preserves `ready`, for the same reason: an account that was
 * fine a moment ago and whose hourly re-resolution hit a 500 should not have its
 * screens torn down. The gate only renders the explanatory panel while `ready`
 * is false, so a first load still shows the error and a working session still
 * works — and the error is recorded either way.
 */
export function identityOnSettled(
  prev: IdentityState,
  settled: IdentitySettled,
): IdentityState {
  if (settled.kind === 'resolved') {
    return { ready: true, error: null, sessionLost: false };
  }
  if (settled.failure === 'session-lost') {
    return { ready: false, error: null, sessionLost: true };
  }
  return { ready: prev.ready, error: settled.message, sessionLost: false };
}
