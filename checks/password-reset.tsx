/**
 * A failed password reset says so, and does not look like a success.
 *
 * ## The regression this exists for
 *
 * `setPassword` used to swallow a failed `passwordChanged` call and clear
 * `mustChange` locally anyway. The reasoning was kind — the password really had
 * changed, so why block somebody — but what it produced was the worst part of
 * the step A outage: the screen reported success, the stored flag was
 * untouched, and the next `refreshPasswordStatus` put the person straight back
 * on this screen. A reset that looks successful and changes nothing is harder
 * to diagnose, and more alarming to live through, than one that says it failed.
 *
 * The Supabase password change stands, because it is already done and is not
 * this application's to undo. The *obligation* is discharged only if the server
 * agrees it has been.
 *
 * ## What is faked, and what is not
 *
 * Only `fetch`, as in `signin-flow.tsx`, and the sign-in is driven through the
 * real form rather than by injecting a session — `setSession` against a faked
 * host retries and hangs, which cost a round of this check to discover.
 *
 * `/users/me/account-status` answers `mustChangePassword: true`, which is what
 * an administrator's reset leaves behind. `/users/me/password-changed` answers
 * 500 — the shape the outage took, when every authenticated route was failing.
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: 'https://app.test/#/', pretendToBeVisual: true },
);
const w = dom.window;
const g = globalThis as unknown as Record<string, unknown>;

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

const realError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('was not wrapped in act')) return;
  realError(...args);
};

/* ------------------------------------------------------------------ *
 * The session and the server
 * ------------------------------------------------------------------ */

const USER_ID = '11111111-1111-1111-1111-111111111111';
const EMAIL = 'hari.siva@360.technology';
const PASSWORD = 'correct-horse';
const NEW_PASSWORD = 'Str0ng-New-Passw0rd!';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: 'ES256', typ: 'JWT' }),
    b64url({
      sub: USER_ID, email: EMAIL, aud: 'authenticated', role: 'authenticated',
      iat: now, exp: now + 3600, app_metadata: {},
      user_metadata: { email_verified: true },
      amr: [{ method: 'password', timestamp: now }],
    }),
    'sig',
  ].join('.');
};
const USER = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email: EMAIL,
  email_confirmed_at: new Date().toISOString(), app_metadata: {},
  user_metadata: { email_verified: true }, identities: [],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};
const session = () => ({
  access_token: jwt(), refresh_token: 'r', token_type: 'bearer',
  expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER,
});

const trace: string[] = [];
let calls = 0;
let updateUserCalls = 0;
let passwordChangedCalls = 0;

put('fetch', async (url: unknown, init?: { body?: unknown; method?: string }) => {
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

  let body: unknown = {};
  let status = 200;

  if (path.startsWith('/auth/v1/token')) {
    if (path.includes('grant_type=password')) {
      const sent = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { password?: string } : {};
      if (sent.password !== PASSWORD) {
        body = { __status: 400, error: 'invalid_grant', error_description: 'Invalid login credentials' };
        status = 400;
      } else body = session();
    } else body = session();
  } else if (path.startsWith('/auth/v1/user')) {
    /* PUT is updateUser — the password change itself, which succeeds. That is
       the point of the test: the password DID change. */
    if ((init?.method ?? 'GET').toUpperCase() === 'PUT') updateUserCalls += 1;
    body = USER;
  } else if (path.startsWith('/auth/v1/logout')) body = {};
  else if (path.startsWith('/auth/v1/factors')) body = { totp: [], all: [] };
  else if (path.startsWith('/users/me/account-status')) {
    body = { mustChangePassword: true, mustEnrolMfa: false };
  } else if (path.startsWith('/users/me/password-changed')) {
    passwordChangedCalls += 1;
    status = 500;
    body = { error: 'could not record the change' };
  } else if (path.startsWith('/me/permissions')) {
    body = { modules: [], rules: {} };
  }

  return {
    ok: status < 400,
    status,
    url: u,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
  };
});

/* ------------------------------------------------------------------ *
 * The application, wired the way main.tsx wires it
 * ------------------------------------------------------------------ */

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

/* The symptom class here includes hangs, so this must not answer one with
   another. 90s is far past a healthy run. */
const watchdog = setTimeout(() => {
  realError('');
  realError('FAIL  the reset never settled — 90s, no resolution.');
  realError(`      trace: ${trace.join(' -> ')}`);
  realError(`      on screen: ${(w.document.getElementById('root')?.textContent ?? '').slice(0, 300)}`);
  process.exit(1);
}, 90_000);

const root = createRoot(w.document.getElementById('root')!);
const settle = async (times = 10) => {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => w.setTimeout(r, 0)); });
  }
};
const text = () => (w.document.getElementById('root')!.textContent ?? '');
const setValue = (el: HTMLInputElement, value: string) => {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
};

await act(async () => { root.render(React.createElement(App, null)); });
await settle();

/* ------------------------------------------------------------------ *
 * Sign in, and land on the pending reset
 * ------------------------------------------------------------------ */

console.log('\nsigning in with a reset pending\n');

const emailInput = w.document.querySelector('input[type="email"]') as HTMLInputElement | null;
const pwInput = w.document.querySelector('input[type="password"]') as HTMLInputElement | null;
ok('1. the sign-in form is shown', Boolean(emailInput && pwInput), text().slice(0, 160));

await act(async () => {
  setValue(emailInput!, EMAIL);
  setValue(pwInput!, PASSWORD);
});
await act(async () => {
  w.document.querySelector('form')!
    .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
});
await settle(16);

ok('2. account-status was asked', trace.some((t) => t.includes('account-status')),
  trace.join(' -> '));
ok('3. and the pending reset put us on "Set a new password"',
  /Set a new password/i.test(text()),
  text().replace(/\s+/g, ' ').slice(0, 200));

/* ------------------------------------------------------------------ *
 * Set a new password, with the server refusing to record it
 * ------------------------------------------------------------------ */

console.log('\nthe server refuses to record the change\n');

const fields = [...w.document.querySelectorAll('input[type="password"]')] as HTMLInputElement[];
ok(`4. the form has two password fields (${fields.length})`, fields.length >= 2);

await act(async () => {
  setValue(fields[0]!, NEW_PASSWORD);
  setValue(fields[1]!, NEW_PASSWORD);
});
await act(async () => {
  w.document.querySelector('form')!
    .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
});
await settle(16);

ok('5. the password change itself was attempted', updateUserCalls >= 1,
  `PUT /auth/v1/user called ${updateUserCalls} time(s): ${trace.join(' -> ')}`);
ok('6. and the application was told to record it', passwordChangedCalls >= 1,
  `/users/me/password-changed called ${passwordChangedCalls} time(s)`);

ok('7. an error is shown', /could not record|not record that you changed|did not work/i.test(text()),
  `the screen says: ${text().replace(/\s+/g, ' ').slice(0, 240)}`);
ok('8.   and it says the password itself was saved',
  /password was saved/i.test(text()),
  'otherwise somebody sets it twice and cannot tell which one took');

/*
 * The invariant. If `mustChange` were cleared locally despite the failure, the
 * gate would fall through into the application and the next refresh would
 * bounce the person back here — which is exactly what production did.
 */
ok('9. the person is still on "Set a new password"',
  /Set a new password/i.test(text()),
  'a failed reset must not look like a success — this is the regression');
ok('10.  the gate has not fallen through into the application',
  !/My payslips|Dashboard/i.test(text()),
  'mustChange was cleared locally despite the server refusing');

clearTimeout(watchdog);
console.log('');
if (failed) { console.error(`${failed} FAILED\n`); process.exit(1); }
console.log('a failed reset reports the failure and keeps the person on the screen\n');
process.exit(0);
