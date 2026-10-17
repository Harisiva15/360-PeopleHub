globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} } as never;
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, remove() {} }), body: { appendChild() {} } } as never;
Object.defineProperty(globalThis, 'navigator', { value: { geolocation: null }, configurable: true });

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/state/AppContext';
import { AuthProvider } from '../src/auth/AuthContext';
import { LayerProvider } from '../src/components/Layer';
import { Shell } from '../src/shell/Shell';
import { ALL_ROUTES, NAV, QUICK_ACTIONS } from '../src/nav';
import { loadAllRoutes } from '../src/modules';
import { getModule } from '../src/modules/registry';
import type { AppRole } from '../src/types/employee';

/*
 * Routes are code-split, so the app's own `RouteView` suspends and a static
 * render would return the fallback rather than the page. The check registers
 * every module up front and renders the component directly — the point is to
 * prove each page renders, not to exercise Suspense.
 */
await loadAllRoutes();

const at = (path: string, role: AppRole) => {
  const route = path.replace(/^\//, '');
  const View = getModule(route)!.Component;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppProvider initialRole={role}>
          <LayerProvider><Shell><View /></Shell></LayerProvider>
        </AppProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
};

const ported = ALL_ROUTES.filter((r) => !at('/' + r, 'admin').includes('has not been ported'));
console.log('ported  :', ported.join(', '));
console.log('pending :', ALL_ROUTES.filter((r) => !ported.includes(r)).join(', '));
console.log(`progress: ${ported.length}/${ALL_ROUTES.length} modules`);
let failed = 0;
for (const role of ['admin', 'manager', 'employee'] as AppRole[]) {
  for (const r of ALL_ROUTES) {
    try {
      at('/' + r, role);
    } catch (e) {
      failed++;
      console.log('FAIL', role, r, (e as Error).message);
    }
  }
}
console.log('all routes render for all roles');

/*
 * The header's quick actions name a view rather than a URL, so a renamed tab
 * empties the menu silently rather than producing a dead link. Assert the
 * names still resolve — and that each resolves to exactly one view, because
 * two sections sharing an item name would make which one you get an accident
 * of ordering.
 */
const names = NAV.flatMap((g) => g.items.map((i) => i.n));
for (const want of QUICK_ACTIONS) {
  const hits = names.filter((n) => n === want).length;
  if (hits !== 1) {
    failed++;
    console.log(`FAIL quick action "${want}" resolves to ${hits} views, expected 1`);
  }
}
console.log(`all ${QUICK_ACTIONS.length} quick actions resolve to a view`);

if (failed) process.exit(1);
