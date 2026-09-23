/*
 * Does the auth gate actually gate?
 *
 * routecheck proves every screen renders in demo mode. This proves the
 * opposite property, which is the one that matters for a real deployment: with
 * a Supabase project configured and no session, NO route may render its
 * content. A gate that has never been tested closed is not a gate.
 */
globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener() {}, removeEventListener() {},
  location: { origin: 'https://example.test', pathname: '/' },
} as never;
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, remove() {} }), body: { appendChild() {} } } as never;
Object.defineProperty(globalThis, 'navigator', { value: { geolocation: null }, configurable: true });

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/state/AppContext';
import { AuthProvider } from '../src/auth/AuthContext';
import { LayerProvider } from '../src/components/Layer';
import { AuthGate, Routed } from '../src/App';
import { authConfigured } from '../src/auth/supabase';
import { ALL_ROUTES } from '../src/nav';
import { loadAllRoutes } from '../src/modules';

await loadAllRoutes();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let broken = 0;
const fail = (label: string, cond: boolean, detail = '') => {
  if (!cond) broken += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `
        ${detail}`}`);
};


/* ------------------------------------------------------------------ *
 * No sign-in path may create its own account
 * ------------------------------------------------------------------ */

/*
 * The login page used to offer "Email me a sign-in link", which called
 * `signInWithOtp` without `shouldCreateUser: false`. Supabase's default is
 * true, so *any* address typed into it got an `auth.users` row and an email —
 * including an address belonging to nobody who works here.
 *
 * The application still refused them: no membership means the session resolver
 * throws and every request is 401. But an unauthenticated stranger could make
 * rows in auth.users and send mail from this domain, and that is worth closing
 * even though it never reached any data.
 *
 * This account model is invitation-only. An account exists because an
 * administrator created one, never because somebody typed an address into a
 * login form. These assertions are what keep that true.
 */
{
  /*
   * Comments stripped: the code that removed this call explains it by name,
   * and a note saying why a thing is gone must not read as the thing.
   */
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const authSrc = strip(readFileSync(join(root, 'src/auth/AuthContext.tsx'), 'utf8'));
  const loginSrc = strip(readFileSync(join(root, 'src/auth/LoginPage.tsx'), 'utf8'));

  const otp = /signInWithOtp/.test(authSrc) || /signInWithOtp/.test(loginSrc);
  fail(
    'no sign-in path calls signInWithOtp',
    !otp,
    'signInWithOtp defaults to shouldCreateUser: true. If it is ever needed '
    + 'again it must pass shouldCreateUser: false, and even then it only works '
    + 'for somebody who already has an auth user.',
  );

  fail(
    'the magic-link capability is not on the auth context',
    !/sendMagicLink/.test(authSrc),
    'leaving the function exported lets the next screen that wants a '
    + 'convenience re-open the hole without anyone noticing it was closed',
  );

  /*
   * Single sign-on went the same way, and for the same reason: OAuth mints an
   * auth user on first use for whichever account the provider hands back, so
   * anybody with a Google account could reach the same dead end.
   */
  fail(
    'no sign-in path calls signInWithSso',
    !/signInWithSso/.test(authSrc) && !/signInWithSso/.test(loginSrc),
    'OAuth sign-in also creates an auth user on first use, for whichever '
    + 'account the provider hands back',
  );

  fail(
    'the login page offers no provider buttons',
    !/ssoProviders/.test(loginSrc),
    'a button that signs somebody in is a way in, whatever it is labelled',
  );

  fail(
    'password sign-in is the way in',
    /signInWithPassword/.test(loginSrc) && /signInWithPassword/.test(authSrc),
    'removing the alternatives must not have removed the remaining one',
  );

  /*
   * Password reset stays, and must: it does not create users, and its message
   * is deliberately identical whether or not the address has an account, so it
   * cannot be used to find out who works here. It is also now the only way a
   * person sets a first password.
   */
  fail(
    'password reset is still offered',
    /sendPasswordReset/.test(loginSrc),
    'somebody locked out of a real account needs a way back in',
  );
  fail(
    'and it still refuses to say whether an address has an account',
    /If that address has an account/.test(loginSrc),
    'a different message for a known address turns this into a directory',
  );
}

console.log(`authConfigured = ${authConfigured}`);
if (!authConfigured) {
  console.log('\nSKIPPED: run with VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY set.');
  console.log('Without them this build is demo mode, which is what routecheck covers.');
  console.log('The source assertions above still ran.');
  process.exit(broken ? 1 : 0);
}

let leaked = 0;
for (const route of ALL_ROUTES) {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/' + route]}>
      <AuthProvider>
        <AppProvider initialRole="admin">
          <LayerProvider>
            {/* Exactly App's own composition — testing anything else proves nothing. */}
            <AuthGate><Routed /></AuthGate>
          </LayerProvider>
        </AppProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  // The shell's own chrome is the tell: if the sidebar rendered, the gate let
  // an unauthenticated request through to the application.
  if (html.includes('class="sidebar') || html.includes('id="app"')) {
    console.log(`LEAK  /${route} rendered the app shell with no session`);
    leaked += 1;
  }
}

console.log(leaked
  ? `\n${leaked} of ${ALL_ROUTES.length} routes rendered without a session`
  : `\nnone of ${ALL_ROUTES.length} routes render without a session`);
process.exit(leaked || broken ? 1 : 0);
