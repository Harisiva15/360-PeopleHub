/**
 * A token being renewed is not a sign-out.
 *
 * ## What happened
 *
 * `request()` read the token and threw `'You are not signed in'` whenever it
 * got nothing back. `announceFailure` suppressed that message by regex, on the
 * grounds that the auth layer is already showing the login page. True for a
 * sign-out; false for the refresh window, which produced the same message. So
 * a read that landed mid-renewal failed, said nothing, and left `data`
 * undefined — which every one of 366 call sites renders as an empty list.
 *
 * In production that showed up as a company administrator on My account with
 * no name in the identity tile and no photo card, and no error anywhere to
 * report. The endpoint was healthy the whole time: it returned all five people
 * including him, in 40ms.
 *
 * ## What this pins
 *
 * The renewal window is staged through `setSessionSourceForTests`, which is
 * the only way to get a deterministic "no token now, token in a moment"
 * without a Supabase project. `fetch` is counted, because the two halves of
 * the fix are about *when* a request is sent: once, after the renewal, for the
 * pre-send case; and not again when the server itself says 401.
 */

import {
  ApiError, api, isNoSessionError, SESSION_RENEWING_MESSAGE,
} from '../src/services/http/client';
import { coalesceRefresh, setSessionSourceForTests } from '../src/services/http/session';
import type { SessionSource } from '../src/services/http/session';
import { toDirectory } from '../src/services/people';
import type { Employee } from '../src/services/contracts';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
};

/* ---------------------------------------------------------------- harness */

let fetchCalls: { url: string; auth: string | null }[] = [];

const realFetch = globalThis.fetch;
/** A server that answers 200 with a body, unless told to answer a status. */
function stubFetch(status = 200, body: unknown = { ok: true }) {
  fetchCalls = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({ url: String(url), auth: headers.authorization ?? null });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response);
  }) as typeof globalThis.fetch;
}

/** A session that hands out nothing until the renewal, then a token. */
function renewingSession(opts: {
  tokenNow?: string | null;
  signedOut?: boolean;
  renewTo?: string | null;
}): SessionSource & { refreshes: number } {
  const state = {
    refreshes: 0,
    token: () => Promise.resolve(opts.tokenNow ?? null),
    refresh() {
      state.refreshes += 1;
      /* A real renewal is not synchronous; resolving on a later turn is what
         makes the coalescing assertion below meaningful. */
      return new Promise<string | null>((resolve) => {
        setTimeout(() => resolve(opts.renewTo ?? null), 5);
      });
    },
    signedOut: () => Boolean(opts.signedOut),
  };
  return state;
}

const caught = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try { await fn(); return null; } catch (e) { return e; }
};

/* ============================================================ the renewal */

console.log(`${NL}a request that arrives while the token is being renewed${NL}`);

{
  const session = renewingSession({ tokenNow: null, signedOut: false, renewTo: 'fresh-token' });
  const restore = setSessionSourceForTests(session);
  stubFetch(200, [{ id: 'b68c8dc4', name: 'Hari siva' }]);
  try {
    const out = await api.get<Employee[]>('/employees');
    ok('1. the request succeeds', Array.isArray(out) && out.length === 1,
      JSON.stringify(out));
    ok('2.  after exactly one renewal', session.refreshes === 1,
      `${session.refreshes} renewals`);
    ok('3.  and is sent once, not twice', fetchCalls.length === 1,
      `${fetchCalls.length} fetches`);
    ok('4.  carrying the renewed token', fetchCalls[0]?.auth === 'Bearer fresh-token',
      String(fetchCalls[0]?.auth));
  } finally { restore(); globalThis.fetch = realFetch; }
}

/* A write takes the same path, and this is the reason it is safe: the retry
   happens before anything is sent, so there is no question of applying it
   twice. */
{
  const session = renewingSession({ tokenNow: null, signedOut: false, renewTo: 'fresh-token' });
  const restore = setSessionSourceForTests(session);
  stubFetch(200, { url: 'https://example/photo.png' });
  try {
    await api.put('/employees/b68c8dc4/photo', { any: 'body' });
    ok('5. a write is sent exactly once through a renewal', fetchCalls.length === 1,
      `${fetchCalls.length} fetches — a retry after sending would double-apply it`);
  } finally { restore(); globalThis.fetch = realFetch; }
}

/*
 * Ten panels mounting at once must not start ten renewals — supabase-js
 * rotates the refresh token on each, and racing rotations drops a live
 * session. The counting source goes in through `coalesceRefresh`, which is the
 * wrapper the real one is built with.
 */
{
  const counting = renewingSession({ tokenNow: null, signedOut: false, renewTo: 'fresh-token' });
  const restore = setSessionSourceForTests(coalesceRefresh(counting));
  stubFetch(200, []);
  try {
    await Promise.all(Array.from({ length: 10 }, () => api.get('/employees')));
    ok('6. ten concurrent reads share one renewal', counting.refreshes === 1,
      `${counting.refreshes} renewals — rotating ten times races the session away`);
    ok('7.  and each is still sent once', fetchCalls.length === 10,
      `${fetchCalls.length} fetches`);
    ok('8.  all with the renewed token',
      fetchCalls.every((c) => c.auth === 'Bearer fresh-token'));
  } finally { restore(); globalThis.fetch = realFetch; }
}

/* And a renewal after that one settles is a new renewal, not a cached null. */
{
  const counting = renewingSession({ tokenNow: null, signedOut: false, renewTo: 'fresh-token' });
  const restore = setSessionSourceForTests(coalesceRefresh(counting));
  stubFetch(200, []);
  try {
    await api.get('/employees');
    await api.get('/employees');
    ok('9. a later request renews again', counting.refreshes === 2,
      `${counting.refreshes} renewals — the shared promise must not outlive itself`);
  } finally { restore(); globalThis.fetch = realFetch; }
}

/* ======================================================= a real sign-out */

console.log(`${NL}a session that is genuinely gone${NL}`);

{
  const session = renewingSession({ tokenNow: null, signedOut: true });
  const restore = setSessionSourceForTests(session);
  stubFetch();
  try {
    const e = await caught(() => api.get('/employees'));
    ok('10. it refuses', e instanceof ApiError);
    ok('11.  as no_session', e instanceof ApiError && e.kind === 'no_session',
      e instanceof ApiError ? e.kind : String(e));
    ok('12.  without attempting a renewal', session.refreshes === 0,
      `${session.refreshes} renewals — there is nothing to renew`);
    ok('13.  without sending anything', fetchCalls.length === 0);
    ok('14.  and that is the one failure nobody is told about',
      isNoSessionError(e));
  } finally { restore(); globalThis.fetch = realFetch; }
}

/* ============================================ a renewal that never lands */

console.log(`${NL}a renewal that does not produce a token${NL}`);

{
  const session = renewingSession({ tokenNow: null, signedOut: false, renewTo: null });
  const restore = setSessionSourceForTests(session);
  stubFetch();
  try {
    const e = await caught(() => api.get('/employees'));
    ok('15. it refuses as session_renewing',
      e instanceof ApiError && e.kind === 'session_renewing',
      e instanceof ApiError ? e.kind : String(e));
    ok('16.  with a message that asks the person to try again',
      e instanceof ApiError && e.message === SESSION_RENEWING_MESSAGE,
      e instanceof ApiError ? e.message : '');
    ok('17.  and is NOT suppressed', !isNoSessionError(e),
      'this is the failure that was invisible in production');
  } finally { restore(); globalThis.fetch = realFetch; }
}

/* ==================================================== the server's own 401 */

console.log(`${NL}a 401 from the server is a different thing${NL}`);

{
  const session = renewingSession({ tokenNow: 'a-valid-looking-token', signedOut: false });
  const restore = setSessionSourceForTests(session);
  stubFetch(401, { error: 'no bearer token' });
  try {
    const e = await caught(() => api.get('/employees'));
    ok('18. it is reported as an http failure',
      e instanceof ApiError && e.kind === 'http' && e.status === 401,
      e instanceof ApiError ? `${e.kind}/${e.status}` : String(e));
    ok('19.  and is not retried', fetchCalls.length === 1,
      `${fetchCalls.length} fetches — the request was already judged`);
    ok('20.  nor renewed around', session.refreshes === 0);
    ok('21.  and it is reported, not suppressed', !isNoSessionError(e));
  } finally { restore(); globalThis.fetch = realFetch; }
}

/* ======================================== failed is not the same as empty */

console.log(`${NL}the directory tells a failure apart from an empty company${NL}`);

const rows = [{ id: 'a', name: 'Hari siva' }] as unknown as Employee[];
const noop = () => {};
const err = new ApiError(401, SESSION_RENEWING_MESSAGE, 'session_renewing');

{
  const d = toDirectory([], false, null, noop);
  ok('22. nobody, and nothing went wrong -> empty, not failed',
    d.list.length === 0 && d.failed === false);
}
{
  const d = toDirectory(undefined, false, err, noop);
  ok('23. a failed read -> failed', d.failed === true);
  ok('24.  carrying the reason', d.error === err);
}
{
  const d = toDirectory(rows, false, err, noop);
  ok('25. rows on screen and a failed refetch -> not failed',
    d.failed === false,
    'blanking rows the person can already see would be a regression');
}
{
  let retried = 0;
  const d = toDirectory(undefined, false, err, () => { retried += 1; });
  d.retry();
  ok('26. retry re-runs the read', retried === 1);
}

/* ============================================================ source rules */

console.log(`${NL}and the rules that stop it coming back${NL}`);

const { readFileSync } = await import('node:fs');
const react = readFileSync('src/services/react.tsx', 'utf8');
const client = readFileSync('src/services/http/client.ts', 'utf8');

ok('27. the toast suppressor asks the kind, not the wording',
  /isNoSessionError\(e\)/.test(react));
/*
 * Tests for the *use*, not the mention. The comment above the suppressor
 * quotes the old regex, as it should — it explains what went wrong. What must
 * not come back is matching on the wording to decide behaviour.
 */
ok('28.  and no longer decides behaviour from the wording',
  !/\.test\(e\.message\)/.test(react),
  'the sentence was load-bearing in another module, which is how this broke');
ok('29. a no-token refusal names itself no_session',
  /'You are not signed in', 'no_session'/.test(client));
ok('30.  and the renewal case is a different kind',
  /SESSION_RENEWING_MESSAGE, 'session_renewing'/.test(client));

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`a renewal is waited out, a sign-out stays quiet${NL}`);
process.exit(0);
