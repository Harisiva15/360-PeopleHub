/**
 * Signing in, driven end to end against a real DOM and the real auth client.
 *
 * ## Why this file exists
 *
 * `2ac2970` broke production sign-in: after a correct password the button
 * stayed on "Signing in…" and nobody could get in. It shipped with 34 passing
 * assertions, and every one of them tested `identityPlan` as a pure function —
 * the wrong altitude for the fault. The bug was not in the decision about what
 * to do. It was in when the decision ran, and in what was holding a lock while
 * it ran.
 *
 * `checks/identity-gate.ts` could not have caught it, because a pure function
 * has no ordering. `checks/auth-gate.tsx` could not either: it renders with
 * `renderToStaticMarkup`, which never runs an effect at all.
 *
 * ## What is faked, and what is not
 *
 * **Only `fetch` is faked.** Everything else is the shipping code:
 *
 *   - `@supabase/auth-js` itself, which means the real session store, the real
 *     `INITIAL_SESSION` → `SIGNED_IN` sequence, and — the reason this matters —
 *     the real lock it holds across `onAuthStateChange`. An auth method awaited
 *     inside that callback deadlocks, and a hand-written stub cannot deadlock,
 *     so a stub can pass while production hangs forever.
 *   - React and its scheduler. Deliberately WITHOUT StrictMode: the shipped
 *     bundle does not double-invoke effects, and double-invoking them here
 *     re-subscribes and re-reads the session, which papers over an ordering
 *     that production only gets one shot at.
 *   - The real `HashRouter`, provider tree, `AuthGate` branch order, and
 *     `LoginPage`'s own busy state.
 *
 * Because auth-js is real, the access token below has to be a decodable JWT:
 * `getAuthenticatorAssuranceLevel()` reads the `aal` claim straight out of it
 * without asking the server.
 *
 * Two lines are load-bearing and worth keeping if this file is edited:
 *
 *   - the held getSession above, because the race it forces is the whole
 *     point of assertions 12 to 14 and is invisible without it.
 *   - `setServices(createHttpServices(...))`, because `getServices()` defaults
 *     to the mock over `src/data`. Without it the app never asks the server
 *     anything, and the test proves only that the demo build works.
 */

import { JSDOM } from 'jsdom';

/* ------------------------------------------------------------------ *
 * A DOM, installed before anything that expects one is imported
 * ------------------------------------------------------------------ */

/* The URL is the one from the bug report: a hash deep link, which is what
 * HashRouter reads, and what somebody following a bookmark arrives on. */
const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: 'https://app.test/#/settings?v=company', pretendToBeVisual: true },
);
const w = dom.window;
const g = globalThis as unknown as Record<string, unknown>;

/* Node defines some of these itself — `navigator` as a getter with no setter —
 * so plain assignment throws. Define them rather than assign them. */
const put = (k: string, v: unknown) => {
  Object.defineProperty(globalThis, k, {
    value: v, writable: true, configurable: true, enumerable: true,
  });
};
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'localStorage',
  'sessionStorage', 'DOMParser', 'XMLHttpRequest', 'HTMLInputElement'] as const) {
  put(k, (w as unknown as Record<string, unknown>)[k]);
}
put('requestAnimationFrame', (cb: (t: number) => void) => w.setTimeout(() => cb(0), 0));
put('cancelAnimationFrame', (h: number) => w.clearTimeout(h));
const mm = () => ({
  matches: false, media: '', onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  dispatchEvent: () => false,
});
put('matchMedia', mm);
(w as unknown as Record<string, unknown>).matchMedia = mm;
g.IS_REACT_ACT_ENVIRONMENT = true;

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

/*
 * React warns when an update lands outside act(). Here that is expected and
 * uninteresting: the app keeps fetching after the assertions are made, and the
 * warning says nothing about whether signing in worked. Everything else still
 * reaches the console.
 */
const realError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('was not wrapped in act')) return;
  realError(...args);
};

/* ------------------------------------------------------------------ *
 * What the auth server and the API say
 * ------------------------------------------------------------------ */

const USER_ID = '11111111-1111-1111-1111-111111111111';
const EMAIL = 'hr@360.technology';
const PASSWORD = 'correct-horse';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/*
 * A real-shaped JWT. Unsigned, because nothing here verifies it — but it must
 * decode, because auth-js reads `aal` out of the payload locally to decide
 * whether a second factor is still owed.
 */
const jwt = () => {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: 'HS256', typ: 'JWT' }),
    b64url({
      sub: USER_ID,
      email: EMAIL,
      aud: 'authenticated',
      role: 'authenticated',
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: now }],
      session_id: '44444444-4444-4444-4444-444444444444',
      iat: now,
      exp: now + 3600,
    }),
    'not-a-real-signature',
  ].join('.');
};

const USER = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: EMAIL,
  email_confirmed_at: '2020-01-01T00:00:00Z',
  phone: '',
  confirmed_at: '2020-01-01T00:00:00Z',
  last_sign_in_at: new Date().toISOString(),
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  factors: [],
  is_anonymous: false,
  created_at: '2020-01-01T00:00:00Z',
  updated_at: new Date().toISOString(),
};

const session = () => ({
  access_token: jwt(),
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'refresh-token-1',
  user: USER,
});

const EMP = {
  id: '22222222-2222-2222-2222-222222222222',
  code: 'VHM005',
  name: 'HR Head',
  email: EMAIL,
  designation: 'HR Administrator',
  dept: 'HR',
  site: 'CHN',
  managerId: null,
  reports: [],
  status: 'Active',
  type: 'Full-time',
  joined: '2020-01-01',
  shift: 'IN',
};

/*
 * The real `MeIdentity`, not an approximation of it. The shell reads name,
 * code, designation and tenant straight off it, so a half-filled fixture
 * crashes the render for reasons that have nothing to do with signing in —
 * a failing test that teaches nothing.
 */
const IDENTITY = {
  membershipId: '33333333-3333-3333-3333-333333333333',
  empId: EMP.id,
  name: EMP.name,
  email: EMP.email,
  code: EMP.code,
  designation: EMP.designation,
  dept: EMP.dept,
  site: EMP.site,
  tenantName: '360VHM Technology Private Limited',
  tenantSlug: '360vhm',
};

/* Every module the rail can offer, granted outright: this test is about whether
 * signing in works, not about what an administrator may see. */
const { NAV } = await import('../src/nav');
const MODULES = [...new Set(NAV.flatMap((grp) => grp.items.map((i) => i.k)))];
const WHO = {
  role: 'admin',
  summary: 'Administrator',
  modules: MODULES,
  rules: Object.fromEntries(
    MODULES.map((k) => [k, { read: 'all', write: 'all', approve: 'all' }]),
  ),
  identity: IDENTITY,
};

/* ------------------------------------------------------------------ *
 * The network, and only the network
 * ------------------------------------------------------------------ */

const trace: string[] = [];
let calls = 0;

/*
 * Employee *lists* come back empty on purpose. A screen with no rows is a real
 * state the app has to render, and inventing a directory here would mean
 * maintaining a fixture for every tab somebody might deep-link into — none of
 * which is what this test is about. `by-ids` is the exception, because that is
 * the call identity resolution makes to read the signed-in person's own row.
 */
const apiBody = (path: string): unknown => {
  if (path.startsWith('/me/permissions')) return WHO;
  if (path.startsWith('/employees/by-ids')) return [EMP];
  return [];
};

/* GoTrue, answering the handful of routes a password sign-in touches. */
const authBody = (path: string, init?: { body?: unknown }): unknown => {
  if (path.startsWith('/auth/v1/token')) {
    if (path.includes('grant_type=password')) {
      const sent = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { password?: string } : {};
      /* A wrong password must still be a rejection here, or the test could pass
       * for a build that signs anybody in. */
      if (sent.password !== PASSWORD) return { __status: 400, error: 'invalid_grant', error_description: 'Invalid login credentials' };
    }
    return session();
  }
  if (path.startsWith('/auth/v1/user')) return USER;
  if (path.startsWith('/auth/v1/logout')) return {};
  if (path.startsWith('/auth/v1/factors')) return { totp: [], all: [] };
  return {};
};

put('fetch', async (url: unknown, init?: { body?: unknown }) => {
  const u = String(url);
  const path = u.startsWith('http') ? u.slice(u.indexOf('/', u.indexOf('//') + 2)) : u;
  calls += 1;
  if (calls > 300) {
    realError('');
    realError(`FAIL  the app made ${calls} requests — a request loop.`);
    realError(`      last 12: ${trace.slice(-12).join(' -> ')}`);
    process.exit(1);
  }
  trace.push(path.startsWith('/auth/v1/') ? `auth ${path.replace('/auth/v1/', '')}` : `api ${path}`);

  const body = path.startsWith('/auth/v1/') ? authBody(path, init) : apiBody(path);
  const rec = body as { __status?: number };
  const status = rec?.__status ?? 200;
  return {
    ok: status < 400,
    status,
    url: u,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
  };
});

/* ------------------------------------------------------------------ *
 * The application, wired the way main.tsx wires it
 * ------------------------------------------------------------------ */

const sb = await import('../src/auth/supabase');
if (!sb.supabase) {
  realError('SKIPPED: this build has no Supabase project configured, so there is '
    + 'no sign-in to drive.');
  process.exit(0);
}

/*
 * The first session check, held.
 *
 * AuthProvider resolves the session two ways: once at mount via getSession(),
 * and continuously via onAuthStateChange. Both write the same two pieces of
 * state, so whichever lands last wins. This holds the first one and delivers
 * the answer it captured — "there is no session" — after SIGNED_IN, which is
 * what a slow first session check does in a real browser.
 *
 * Everything else about auth-js stays real; only the timing is forced.
 */
const realGetSession = sb.supabase.auth.getSession.bind(sb.supabase.auth);
let heldOnce = false;
let releaseHeld: (() => void) | null = null;
(sb.supabase.auth as unknown as Record<string, unknown>).getSession = async () => {
  const answer = await realGetSession();
  if (!heldOnce) {
    heldOnce = true;
    trace.push('getSession HELD (stale answer captured)');
    await new Promise<void>((r) => { releaseHeld = r; });
    trace.push('getSession RELEASED (stale answer delivered)');
  }
  return answer;
};

const { getServices, setServices } = await import('../src/services');
const { createHttpServices, apiConfigured } = await import('../src/services/http');
if (!apiConfigured) {
  realError('SKIPPED: no VITE_API_URL, so there is no API to sign in against.');
  process.exit(0);
}
setServices(createHttpServices(getServices()));

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const App = (await import('../src/App')).default;
const { loadAllRoutes } = await import('../src/modules');
await loadAllRoutes();

/*
 * The symptom this test exists for is a hang, so it must not answer a hang with
 * one of its own. 90s is far past a healthy run.
 */
const watchdog = setTimeout(() => {
  realError('');
  realError('FAIL  signing in never settled — 90s, no resolution.');
  realError('      This is the production symptom. A deadlock inside auth-js shows up');
  realError('      here as a trace that stops at "auth token?grant_type=password".');
  realError(`      trace: ${trace.join(' -> ')}`);
  realError(`      on screen: ${(w.document.getElementById('root')?.textContent ?? '').slice(0, 300)}`);
  process.exit(1);
}, 90_000);

const root = createRoot(w.document.getElementById('root')!);

/** Let queued microtasks, timers and effects settle. */
const settle = async (times = 10) => {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => w.setTimeout(r, 0)); });
  }
};

const html = () => w.document.getElementById('root')!.innerHTML;
const text = () => (w.document.getElementById('root')!.textContent ?? '');

await act(async () => {
  root.render(React.createElement(App, null));
});
await settle();

/* ------------------------------------------------------------------ *
 * Before signing in
 * ------------------------------------------------------------------ */

console.log('\narriving on a hash deep link with no session\n');

ok('1. the sign-in form is shown',
  /type="email"/.test(html()) && /type="password"/.test(html()),
  text().slice(0, 200));
ok('2. nobody is told we could not tell who they are',
  !/could not tell who you are/i.test(text()),
  'that screen is for an account that cannot be read, not for somebody who has '
  + 'not signed in yet');
ok('3. and the app asked the API nothing without a token',
  !trace.some((t) => t.startsWith('api ')),
  `a request went out before there was a session: ${trace.join(' -> ')}`);

/* ------------------------------------------------------------------ *
 * Signing in
 * ------------------------------------------------------------------ */

console.log('\nentering a correct password\n');

const emailInput = w.document.querySelector('input[type="email"]') as HTMLInputElement | null;
const pwInput = w.document.querySelector('input[type="password"]') as HTMLInputElement | null;
const form = w.document.querySelector('form');
ok('4. the form and both fields are present',
  Boolean(emailInput && pwInput && form),
  'the rest of this test cannot run without them');

/* React tracks value changes through its own descriptor, so set the value the
 * way a browser would and dispatch the event React listens for. */
const setValue = (el: HTMLInputElement, value: string) => {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
};

await act(async () => {
  setValue(emailInput!, EMAIL);
  setValue(pwInput!, PASSWORD);
});

await act(async () => {
  form!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
});
await settle(16);

/* ------------------------------------------------------------------ *
 * What somebody is looking at afterwards
 * ------------------------------------------------------------------ */

console.log('\nafter a successful sign-in\n');

ok('5. the password was actually sent',
  trace.some((t) => t.includes('grant_type=password')),
  `the form did not submit: ${trace.join(' -> ')}`);
ok('6. the button is not stuck on "Signing in…"',
  !/Signing in/.test(text()),
  'this is the production symptom — the button clears in a finally, so it can '
  + 'only stay set if the promise never settled');
ok('7. the sign-in form is gone',
  !/type="password"/.test(html()),
  text().slice(0, 200));
ok('8. and they are not told they could not be identified',
  !/could not tell who you are/i.test(text()),
  text().slice(0, 300));
ok('9. the identity was resolved against the server',
  trace.some((t) => t.includes('/me/permissions')),
  `identity never asked who this is: ${trace.join(' -> ')}`);
ok('10. the signed-in person is named on screen',
  text().includes(EMP.name),
  `the shell rendered without them: ${text().slice(0, 300)}`);
ok('11. the deep-linked destination survived signing in',
  w.location.hash.includes('/settings'),
  `landed on ${w.location.hash} — a bookmark must not be lost at the door`);

console.log(`\n  ${calls} request(s): ${trace.join(' → ')}\n`);

/* ------------------------------------------------------------------ *
 * And then the first session check finally answers
 * ------------------------------------------------------------------ */

console.log('');
console.log('the first session check answers at last, with what it saw before');
console.log('');

await act(async () => { releaseHeld?.(); });
await settle(16);

ok('12. a stale session check does not sign them back out',
  !/type=.password./.test(html()),
  'getSession answered after SIGNED_IN with the session it saw before it. '
  + 'Letting that overwrite a newer one throws somebody who just signed in '
  + 'back to the login form, and latches them there: ' + text().slice(0, 200));
ok('13. and the button is still not stuck on Signing in',
  !/Signing in/.test(text()),
  text().slice(0, 200));
ok('14. the signed-in person is still named on screen',
  text().includes(EMP.name),
  text().slice(0, 200));

console.log('');
console.log('  trace: ' + trace.join(' -> '));
console.log('');

clearTimeout(watchdog);
root.unmount();
w.close();

if (failed) {
  realError(`${failed} sign-in flow check(s) failed`);
  process.exit(1);
}
console.log('a correct password signs somebody in, and the button does not hang');
process.exit(0);
