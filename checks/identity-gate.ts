/**
 * A signed-in person must never be told they are not signed in.
 *
 * ## The report
 *
 * Signing in and landing on `/#/settings?v=company` showed "We could not tell
 * who you are — You are not signed in", with Try again and Sign out as the only
 * ways out.
 *
 * That sentence comes from `src/services/http/client.ts`, which throws
 * `401 You are not signed in` when `bearerToken()` finds no session. So the
 * identity resolver had asked the server who this was *before* the session
 * existed, latched the refusal into `identityError`, and never asked again —
 * its effect depended on `[setRole, setMeId, attempt]`, and a session arriving
 * is none of those. `AuthGate` then walked past its own `if (!auth.session)
 * return <LoginPage/>` because by that point the session had arrived, and
 * landed on the error branch.
 *
 * Two faults, asserted separately below:
 *
 *   1. Resolution ran before there was a session, and did not restart when one
 *      appeared or when the token was refreshed.
 *   2. "No session" was reported as a broken identity rather than as a reason
 *      to show the sign-in screen.
 *
 * ## What is asserted
 *
 * The orderings, against `identityPlan`: a cold load, a deep link with no
 * session, a session that arrives after mount, an hourly token refresh, and a
 * session that has gone. Then the classification of a failure, so that a lost
 * session routes to sign-in and a genuinely unusable account keeps the
 * explanation it needs. Then that the resolver is actually wired to the
 * session, and that `AuthGate` still cannot be entered without one — because a
 * fix to this that opened the gate would be far worse than the bug.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  IDENTITY_START, identityFailure, identityOnPlan, identityOnSettled, identityPlan,
} from '../src/state/identity';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
/** Comments describe intent; they are not evidence of it. */
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const API = { apiMode: true, authReady: true };

/* ------------------------------------------------------------------ *
 * The window the bug lived in
 * ------------------------------------------------------------------ */

console.log('\nnothing is asked before the session check comes back\n');

{
  const p = identityPlan({
    apiMode: true, authReady: false, accessToken: null, resolvedFor: null,
  });
  ok('1. a cold load waits rather than asking', p.do === 'wait', p.do);
}
{
  /*
   * The precise shape of the reported bug: supabase has not finished reading
   * storage, so there is no token yet, but the page is already mounted on a
   * deep link. Asking here is what produced the 401.
   */
  const p = identityPlan({
    apiMode: true, authReady: false, accessToken: null, resolvedFor: null,
  });
  ok('2. and a deep link does not change that', p.do !== 'resolve', p.do);
}

console.log('\na deep link with no session goes to sign-in, not to a dead end\n');

{
  const p = identityPlan({ ...API, accessToken: null, resolvedFor: null });
  ok('3. no session resolves to the sign-in screen', p.do === 'sign-in', p.do);
  ok('    and emphatically not to an identity error',
    p.do !== 'resolve' && p.do !== 'keep',
    'asking the API with no token is what throws "You are not signed in"');
}

/* ------------------------------------------------------------------ *
 * And that it starts once there is something to start with
 * ------------------------------------------------------------------ */

console.log('\nthe session arriving after mount starts the resolution\n');

{
  const before = identityPlan({
    apiMode: true, authReady: false, accessToken: null, resolvedFor: null,
  });
  const after = identityPlan({ ...API, accessToken: 'tok-1', resolvedFor: null });
  ok('4. wait, then resolve', before.do === 'wait' && after.do === 'resolve',
    `${before.do} -> ${after.do}`);
  ok('    carrying the token it will use',
    after.do === 'resolve' && after.token === 'tok-1',
    JSON.stringify(after));
}
{
  const settled = identityPlan({ ...API, accessToken: 'tok-1', resolvedFor: 'tok-1' });
  ok('5. and does not ask twice for the same token', settled.do === 'keep', settled.do);
}
{
  /* TOKEN_REFRESHED, roughly hourly. */
  const refreshed = identityPlan({ ...API, accessToken: 'tok-2', resolvedFor: 'tok-1' });
  ok('6. a refreshed token resolves again', refreshed.do === 'resolve', refreshed.do);
  ok('    which is how a changed role or membership is noticed',
    refreshed.do === 'resolve' && refreshed.token === 'tok-2',
    'comparing a boolean instead would resolve once and never again');
}

console.log('\nand a session that has gone sends them back to sign in\n');

{
  const gone = identityPlan({ ...API, accessToken: null, resolvedFor: 'tok-1' });
  ok('7. signed out in another tab goes to sign-in', gone.do === 'sign-in', gone.do);
  ok('    not keeping an identity the token no longer backs',
    gone.do !== 'keep', 'the screens would go on asking for "my" everything');
}

console.log('\nthe demo build is untouched by any of this\n');

{
  const demo = identityPlan({
    apiMode: false, authReady: false, accessToken: null, resolvedFor: null,
  });
  ok('8. no session, no waiting, no resolution', demo.do === 'keep', demo.do);
}

/* ------------------------------------------------------------------ *
 * What a failure means
 * ------------------------------------------------------------------ */

console.log('\na lost session is not a broken account\n');

class FakeApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

ok('9. a 401 is a lost session',
  identityFailure(new FakeApiError(401, 'You are not signed in')) === 'session-lost');
ok('10. so is the message alone, if the status did not survive',
  identityFailure(new Error('You are not signed in')) === 'session-lost',
  'the client throws that exact sentence from one place');
ok('11. an account with no employee row is unusable, and says so',
  identityFailure(new Error(
    'Your account is not linked to an employee record yet.')) === 'unusable',
  'that one genuinely cannot proceed, and the explanation is the useful answer');
ok('12. a 500 is unusable rather than a sign-out',
  identityFailure(new FakeApiError(500, 'boom')) === 'unusable',
  'signing somebody out because the server erred would lose their session for nothing');
ok('13. and a failed read of the employee row too',
  identityFailure(new Error('Your employee record could not be read.')) === 'unusable');

/* ------------------------------------------------------------------ *
 * The hourly refresh must not take the application down with it
 * ------------------------------------------------------------------ */

console.log('\na token refresh re-resolves underneath a mounted UI\n');

/** Somebody signed in and working. */
const MOUNTED = { ready: true, error: null, sessionLost: false };

{
  const plan = identityPlan({ ...API, accessToken: 'tok-2', resolvedFor: 'tok-1' });
  const next = identityOnPlan(MOUNTED, plan);
  ok('22. TOKEN_REFRESHED resolves again', plan.do === 'resolve', plan.do);
  ok('23. and identityReady stays true while it does', next.ready === true,
    JSON.stringify(next));
  ok('    so the gate does not unmount every hour',
    next.ready === MOUNTED.ready,
    'setting ready false here would throw away a half-typed leave reason to a '
    + 'background token rotation');
  ok('    with no error and no sign-out claimed in the meantime',
    next.error === null && next.sessionLost === false, JSON.stringify(next));
}
{
  /* And when it comes back, the identity is simply confirmed. */
  const settled = identityOnSettled(MOUNTED, { kind: 'resolved' });
  ok('24. a completed re-resolution leaves it mounted and clean',
    settled.ready === true && settled.error === null && settled.sessionLost === false,
    JSON.stringify(settled));
}
{
  /* A first load is the other direction: not ready, and it must stay that way. */
  const first = identityOnPlan(IDENTITY_START,
    identityPlan({ ...API, accessToken: 'tok-1', resolvedFor: null }));
  ok('25. a first resolution is still not ready until it answers',
    first.ready === false, JSON.stringify(first));
}
{
  /* An unusable failure must not unmount a working session either. */
  const hiccup = identityOnSettled(MOUNTED, {
    kind: 'failed', failure: 'unusable', message: 'Request failed (500)',
  });
  ok('26. a 500 on an hourly re-resolution keeps them mounted',
    hiccup.ready === true && hiccup.error === 'Request failed (500)',
    JSON.stringify(hiccup));
  ok('    rather than tearing down screens that were working a minute ago',
    hiccup.sessionLost === false, JSON.stringify(hiccup));

  const onFirstLoad = identityOnSettled(IDENTITY_START, {
    kind: 'failed', failure: 'unusable', message: 'not linked to an employee record',
  });
  ok('27. while on a first load the same failure shows the explanation',
    onFirstLoad.ready === false && Boolean(onFirstLoad.error),
    JSON.stringify(onFirstLoad));
}
{
  /* And a lost session unmounts on purpose, which is the one case that should. */
  const lost = identityOnSettled(MOUNTED, {
    kind: 'failed', failure: 'session-lost', message: 'token could not be verified',
  });
  ok('28. a lost session does unmount, and routes to sign-in',
    lost.ready === false && lost.sessionLost === true && lost.error === null,
    JSON.stringify(lost));
}

console.log('\nand the server\'s own 401 is one of those\n');

{
  /*
   * The exact answer the live API gives for a signature it cannot check or a
   * JWKS endpoint that is down — confirmed against it:
   *   401 {"error":"token could not be verified"}
   * `ApiError` carries the status, so this must classify on the status and not
   * on the wording.
   */
  const e = new FakeApiError(401, 'token could not be verified');
  ok('29. "token could not be verified" is a lost session',
    identityFailure(e) === 'session-lost', identityFailure(e));
  const after = identityOnSettled(MOUNTED, {
    kind: 'failed', failure: identityFailure(e), message: e.message,
  });
  ok('    and it reaches the sign-in screen',
    after.sessionLost === true && after.ready === false, JSON.stringify(after));
  ok('    without showing the identity error panel',
    after.error === null,
    'that panel offers Try again and Sign out, which is the dead end this fixes');
}
{
  /* An expired token is the same shape and must not be special-cased. */
  const expired = new FakeApiError(401, 'jwt expired');
  ok('30. an expired token too, on the status rather than the wording',
    identityFailure(expired) === 'session-lost', identityFailure(expired));
}

/* ------------------------------------------------------------------ *
 * That the resolver is actually wired to it
 * ------------------------------------------------------------------ */

console.log('\nthe resolver reacts to the session rather than to its own mount\n');

const appCtx = code('src/state/AppContext.tsx');

ok('14. it uses the plan rather than deciding inline',
  /identityPlan\(/.test(appCtx),
  'the orderings above are only guaranteed if this is the thing that runs');
ok('15. and classifies failures rather than latching every one',
  /identityFailure\(/.test(appCtx),
  'otherwise a lost session is still a dead end');
ok('    moving its state through the transitions rather than loose setters',
  /identityOnPlan\(/.test(appCtx) && /identityOnSettled\(/.test(appCtx),
  'whether the UI survives a refresh must not depend on which setter a path '
  + 'happens to call');
ok('    and never sets readiness false on its own',
  !/setReady\(false\)/.test(appCtx),
  'that is the line that would unmount the application every hour');
ok('16. the effect depends on the access token',
  /accessToken/.test(appCtx),
  'the original depended on [setRole, setMeId, attempt], so a session arriving '
  + 'restarted nothing');
ok('17. and reads the session from the auth layer',
  /useAuth\(/.test(appCtx),
  'rather than racing it through supabase directly');

/*
 * The absence that matters most. A resolver that asks with no token is the
 * whole bug, so the call has to sit behind the plan.
 */
const resolverBody = appCtx.slice(
  appCtx.indexOf('function useResolvedIdentity'),
  appCtx.indexOf('export function AppProvider'));
/*
 * Asserted as the ordering rather than as a phrasing. The first version of
 * this looked for `plan.do === 'resolve'`, which the fix does not contain: it
 * returns early for 'keep', 'wait' and 'sign-in' instead, which gates the
 * request just as effectively and reads better. The property is that the plan
 * is consulted first and that the other cases leave, so that is what is
 * checked — a test pinned to one spelling fails the next correct rewrite.
 */
const planAt = resolverBody.indexOf('identityPlan(');
const askAt = resolverBody.indexOf('users.me(');
ok('18. the plan is consulted before the server is asked',
  planAt >= 0 && askAt > planAt,
  `identityPlan at ${planAt}, users.me at ${askAt}`);
ok('    and every case that is not a resolution returns first',
  /plan\.do === 'keep'/.test(resolverBody)
  && /plan\.do === 'sign-in'/.test(resolverBody)
  && /return undefined;/.test(resolverBody),
  'otherwise the request goes out in the window the session has not settled in');

/* ------------------------------------------------------------------ *
 * And that the fix did not open the gate
 * ------------------------------------------------------------------ */

console.log('\nthe gate still cannot be entered without a session\n');

const app = code('src/App.tsx');
ok('19. no session still renders the login page',
  /if \(!auth\.session\) return <LoginPage/.test(app),
  'a fix to the dead end that let unauthenticated requests through would be worse '
  + 'than the dead end');
ok('20. and the app still waits for an identity before rendering screens',
  /if \(!app\.identityReady\)/.test(app),
  'rendering with a provisional identity is the defect that sent E008 to Postgres');
ok('21. a lost session reaches the sign-in screen rather than the error panel',
  /identitySessionLost|sessionLost/.test(app) || /identitySessionLost/.test(appCtx),
  'the gate has to know the difference the classification draws');

console.log();
if (failed) {
  console.error(`${failed} identity-gate checks failed`);
  process.exit(1);
}
console.log('a session decides when identity is asked for, and losing one means signing in again');
