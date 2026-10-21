/**
 * An invited person sets a password before they reach anything.
 *
 * ## The bug
 *
 * Accepting an invitation logged somebody straight into the home page and
 * never asked them for a password, so they ended up with an account they
 * could use and no credential of their own.
 *
 * Two things had to be true at once for that to happen, and both were:
 *
 * 1. `createUser` set `must_change_password = (sendInvitation === false)` —
 *    so sending an invitation left it **false**, on the assumption that the
 *    link itself would force a password to be chosen.
 *
 * 2. It does not. Supabase's `/auth/v1/verify?type=invite` hands back a real
 *    session and the client reports it as an ordinary `SIGNED_IN`.
 *    `PASSWORD_RECOVERY` — the only event `AuthContext` watched — never fires
 *    for an invitation.
 *
 * So the gate had no reason to close from either side.
 *
 * ## What this holds
 *
 * The database flag is the authority and is covered server-side by
 * `check:invite`. This suite covers the client half and the round trip:
 *
 *   * `arrivedToSetPassword` is read from the URL fragment before the Supabase
 *     client consumes it, is true for `invite` and `recovery`, and false for
 *     `magiclink`, `signup` and an ordinary route.
 *   * arriving on an invite link shows "Set a new password" and **not** the
 *     application.
 *   * setting a password there works, and the gate then opens.
 *   * signing in again afterwards with that password reaches the application
 *     and is *not* sent back to the password screen.
 *
 * The last one is the point. A fix that showed the screen but left the flag
 * set would trap the person in it forever, which is the failure mode this
 * codebase has already had once.
 */

import { JSDOM } from 'jsdom';

/* ------------------------------------------------------------------ *
 * The session, built before the DOM so the fragment can carry it
 * ------------------------------------------------------------------ */

const USER_ID = '22222222-2222-2222-2222-222222222222';
const EMAIL = 'prem@360.technology';
const CHOSEN = 'Str0ng-Chosen-Passw0rd!';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: 'ES256', typ: 'JWT' }),
    b64url({
      sub: USER_ID, email: EMAIL, aud: 'authenticated', role: 'authenticated',
      iat: now, exp: now + 3600, app_metadata: {},
      user_metadata: { email_verified: true },
      amr: [{ method: 'otp', timestamp: now }],
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

/*
 * Exactly the shape Supabase redirects with after verifying an invitation:
 * the tokens and the type, in the fragment, on the configured redirect.
 */
const INVITE_FRAGMENT = [
  `access_token=${jwt()}`,
  'expires_in=3600',
  'refresh_token=r',
  'token_type=bearer',
  'type=invite',
].join('&');

const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: `https://app.test/#${INVITE_FRAGMENT}`, pretendToBeVisual: true },
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
 * 1. The server, faked — with the flag the fix now sets
 * ------------------------------------------------------------------ *
 *
 * Installed before anything imports `auth/supabase`, which matters: that
 * module creates the client at evaluation, the client is configured with
 * `detectSessionInUrl`, and turning the fragment into a session means asking
 * `/auth/v1/user` who the token belongs to. Import it first and that request
 * goes to the real project — which is how the first version of this suite came
 * to render the sign-in page instead of the password screen.
 */

const trace: string[] = [];
let calls = 0;
let updateUserCalls = 0;
let passwordChangedCalls = 0;
/*
 * The membership's flag — and it starts **false** here, deliberately.
 *
 * The fix has two halves and each has to be provable on its own. The database
 * flag is the authority and is covered where it is set (`check:invite`, which
 * asserts `must_change_password` is true for every invited membership) and
 * where it is read (`check:passwordreset`, which drives the screen from
 * `account-status`).
 *
 * This suite is therefore the *other* half: with the flag false, the only
 * thing that can close the gate is the link type. Starting it true made the
 * render assertions pass with the client fix reverted — the server flag was
 * doing all the work and the client half was untested. Found by reverting the
 * seeding and watching nothing fail.
 */
let mustChange = false;
/* Read through a function: inside a closure TypeScript uses the declared type,
   so this does not get narrowed to the literal it was initialised with. */
const flagIsSet = () => mustChange;
/* What the account's password is, as far as the fake server is concerned.
   Null until one is chosen — an invited account has none. */
let storedPassword: string | null = null;

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
      if (storedPassword === null || sent.password !== storedPassword) {
        body = { error: 'invalid_grant', error_description: 'Invalid login credentials' };
        status = 400;
      } else body = session();
    } else body = session();
  } else if (path.startsWith('/auth/v1/user')) {
    if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
      updateUserCalls += 1;
      const sent = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { password?: string } : {};
      if (sent.password) storedPassword = sent.password;
    }
    body = USER;
  } else if (path.startsWith('/auth/v1/logout')) body = {};
  else if (path.startsWith('/auth/v1/factors')) body = { totp: [], all: [] };
  else if (path.startsWith('/users/me/account-status')) {
    body = { mustChangePassword: mustChange, mustEnrolMfa: false };
  } else if (path.startsWith('/users/me/password-changed')) {
    passwordChangedCalls += 1;
    mustChange = false;
    body = { ok: true };
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
 * 2. The link type is read, and discriminates
 * ------------------------------------------------------------------ */

/*
 * Asserted against the exported parser rather than by re-evaluating the
 * module. The module-level constant can only be computed once — that is the
 * point of it — so the logic is a pure function and this calls it directly.
 * `arrivedToSetPassword` is checked once, on the real arrival, below.
 *
 * This is also the first import of `auth/supabase`, so it is what evaluates
 * the module with the invitation fragment in the URL and creates the client.
 */
console.log('\nthe link type is read before the client consumes it\n');

const { linkTypeFrom, setsPasswordType, arrivedToSetPassword } =
  await import('../src/auth/supabase');
const setsPassword = (hash: string) => setsPasswordType(linkTypeFrom(hash));

ok('1. an invitation is recognised', setsPassword(`#${INVITE_FRAGMENT}`) === true);
ok('2. so is a recovery link', setsPassword('#access_token=x&type=recovery') === true);
ok('3. a magic link is not — it signs you in, it does not set a credential',
  setsPassword('#access_token=x&type=magiclink') === false);
ok('4. nor is a signup confirmation',
  setsPassword('#access_token=x&type=signup') === false);
ok('5. an ordinary route is not a link arrival',
  setsPassword('#/employees') === false,
  'HashRouter paths must not be parsed as a fragment');
ok('6. and neither is no hash at all', setsPassword('') === false);
ok('7. the type itself is reported, not just the verdict',
  linkTypeFrom('#access_token=x&type=invite') === 'invite');
ok('8. and this arrival was read as one',
  arrivedToSetPassword() === true,
  'the module saw the fragment at load — without this the gate never closes');

/* ------------------------------------------------------------------ *
 * 3. The application, wired the way main.tsx wires it
 * ------------------------------------------------------------------ */

const { getServices, setServices } = await import('../src/services');
const { createHttpServices, apiConfigured } = await import('../src/services/http');
if (!apiConfigured) {
  realError('SKIPPED: no VITE_API_URL, so there is no API to accept an invitation against.');
  process.exit(0);
}
setServices(createHttpServices(getServices()));

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const App = (await import('../src/App')).default;
const { loadAllRoutes } = await import('../src/modules');
await loadAllRoutes();

const watchdog = setTimeout(() => {
  realError('');
  realError('FAIL  the invitation never settled — 90s, no resolution.');
  realError(`      trace: ${trace.join(' -> ')}`);
  realError(`      on screen: ${(w.document.getElementById('root')?.textContent ?? '').slice(0, 300)}`);
  process.exit(1);
}, 90_000);

const root = createRoot(w.document.getElementById('root')!);
const settle = async (times = 12) => {
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
 * 4. The invitation lands on the password screen
 * ------------------------------------------------------------------ */

console.log('\nopening the invitation link\n');

ok('9. the password screen is shown', /Set a new password/i.test(text()),
  text().slice(0, 200));
ok('10.  and the application is not',
  !/My payslips|Dashboard|Directory/i.test(text()),
  'an invitation must not reach the app before a password is chosen');

const fields = Array.from(
  w.document.querySelectorAll('input[type="password"]'),
) as HTMLInputElement[];
ok(`11. it asks twice (${fields.length} fields)`, fields.length >= 2);

/* ------------------------------------------------------------------ *
 * 5. Setting the password opens the gate
 * ------------------------------------------------------------------ */

console.log('\nchoosing a password\n');

await act(async () => {
  setValue(fields[0]!, CHOSEN);
  setValue(fields[1]!, CHOSEN);
});
await settle(2);

const submit = Array.from(w.document.querySelectorAll('button'))
  .find((b) => /set password/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
ok('12. the submit is offered and enabled',
  Boolean(submit) && submit!.disabled === false,
  submit ? `disabled=${submit.disabled}` : 'no submit button found');

await act(async () => { submit!.click(); });
await settle();

ok('13. the password was actually set', updateUserCalls >= 1,
  `updateUser called ${updateUserCalls} time(s)`);
ok('14.  and the change was recorded', passwordChangedCalls >= 1,
  `password-changed called ${passwordChangedCalls} time(s)`);
ok('15.  and the link alone closed the gate, not the flag',
  flagIsSet() === false,
  'the flag was true, so this run did not test the link type at all');
ok('16. the gate has opened', !/Set a new password/i.test(text()),
  text().slice(0, 200));

/* ------------------------------------------------------------------ *
 * 6. And the chosen password works as an ordinary sign-in
 * ------------------------------------------------------------------ */

console.log('\nsigning in again with that password\n');

/* A fresh arrival: no fragment this time, and no session. */
w.history.replaceState(null, '', 'https://app.test/#/');
await act(async () => { root.unmount(); });
w.localStorage.clear();
w.sessionStorage.clear();

const root2 = createRoot(w.document.getElementById('root')!);
await act(async () => { root2.render(React.createElement(App, null)); });
await settle();

const email2 = w.document.querySelector('input[type="email"]') as HTMLInputElement | null;
const pw2 = w.document.querySelector('input[type="password"]') as HTMLInputElement | null;
ok('17. the sign-in form is shown', Boolean(email2 && pw2), text().slice(0, 200));

if (email2 && pw2) {
  await act(async () => {
    setValue(email2, EMAIL);
    setValue(pw2, CHOSEN);
  });
  await settle(2);
  const signIn = Array.from(w.document.querySelectorAll('button'))
    .find((b) => /sign in/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
  await act(async () => { signIn?.click(); });
  await settle();
}

ok('18. the chosen password is accepted',
  !/Invalid login credentials|incorrect/i.test(text()), text().slice(0, 200));
ok('19.  and it is not sent back to the password screen',
  !/Set a new password/i.test(text()),
  'the flag must stay cleared — this is the trap the last fix left');

clearTimeout(watchdog);
console.log('');
if (failed) { console.error(`${failed} FAILED\n`); process.exit(1); }
console.log('an invitation sets a password first, and that password then works\n');
process.exit(0);
