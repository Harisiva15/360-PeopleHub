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

console.log(`authConfigured = ${authConfigured}`);
if (!authConfigured) {
  console.log('\nSKIPPED: run with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY set.');
  console.log('Without them this build is demo mode, which is what routecheck covers.');
  process.exit(0);
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
process.exit(leaked ? 1 : 0);
