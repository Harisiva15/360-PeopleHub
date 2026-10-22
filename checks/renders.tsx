/**
 * Every page mounts the way a browser mounts it, and none of them throws.
 *
 * ## Why this is not checks/routes.tsx
 *
 * That suite renders with `renderToStaticMarkup`, which never runs an effect.
 * It proves a page's markup can be produced; it cannot see anything that
 * happens after data arrives. And that is where this product's blank pages
 * have come from: Payroll read `p.earn[0].a` on a payslip with no earning
 * lines, threw during a client render, React unmounted the tree, and the whole
 * application went white. `check:routes` was green throughout.
 *
 * So this one mounts with `createRoot` inside `act()` and settles the queries
 * before deciding anything, which is the only way the crash class that has
 * actually hurt us is visible to a test.
 *
 * ## What it covers, and what that costs
 *
 * Ten routes at three roles. Not every route: the full set at three roles runs
 * past ten minutes, which is too slow to sit in a gate somebody runs before
 * every push. The ten are the modules being readied for staff, which is also
 * where every blank page so far has been. Widening it is a deliberate trade
 * against gate time, not an oversight.
 *
 * ## Why it runs on the demo dataset
 *
 * An earlier version also ran an "empty tenant" pass, by wrapping each service
 * method to answer as an empty database would. It reported three crashes and
 * all three were artifacts: it returned `null` where the real endpoint returns
 * an object, and `const { data: x = [] }` defaults only on `undefined`. A
 * check that invents failures is worse than no check, so that pass is gone.
 *
 * It did leave a finding worth acting on separately: those `= []` and `= {}`
 * defaults do not protect against a null payload, and several screens lean on
 * them. Proving that properly needs the real API answering for an empty
 * tenant, not a wrapper guessing on its behalf.
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

/* React's act() warnings and expected query failures would bury the report. */
const realError = console.error;
const realWarn = console.warn;
const swallowed: string[] = [];
console.error = (...a: unknown[]) => { swallowed.push(String(a[0]).slice(0, 160)); };
console.warn = () => {};

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router-dom');
const { AppProvider } = await import('../src/state/AppContext');
const { AuthProvider } = await import('../src/auth/AuthContext');
const { LayerProvider } = await import('../src/components/Layer');
const { Shell } = await import('../src/shell/Shell');
const { ALL_ROUTES } = await import('../src/nav');
const { loadAllRoutes } = await import('../src/modules');
const { getModule } = await import('../src/modules/registry');
await loadAllRoutes();

/*
 * The modules being readied for staff, which is also where every blank page so
 * far has been. A route added here costs roughly four seconds of gate time per
 * role.
 */
const SCOPE = ['attendance', 'leave', 'assets', 'documents', 'timesheet', 'planner',
  'projects', 'settings', 'account', 'employees', 'payroll'];
const roles = ['company_admin', 'hr_admin', 'employee'] as const;
const failures: { route: string; role: string; msg: string; where: string }[] = [];
let mounted = 0;

const TARGETS = ALL_ROUTES.filter((r) => SCOPE.includes(r));
for (const route of TARGETS) {
  const mod = getModule(route);
  if (!mod) { failures.push({ route, role: '-', msg: 'no module registered', where: '' }); continue; }
  const View = mod.Component;
  for (const role of roles) {
    const host = w.document.createElement('div');
    w.document.body.appendChild(host);
    const root = createRoot(host);
    try {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={[`/${route}`]}>
            <AuthProvider>
              <AppProvider initialRole={role}>
                <LayerProvider><Shell><View /></Shell></LayerProvider>
              </AppProvider>
            </AuthProvider>
          </MemoryRouter>,
        );
      });
      /* Let the queries resolve and the effects they trigger run. */
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await act(async () => { await new Promise((r) => w.setTimeout(r, 0)); });
      }
      mounted += 1;
    } catch (e) {
      const err = e as Error;
      const line = String(err.stack ?? '').split('\n')
        .filter((l) => /\.tsx?:\d|\/src\//.test(l))
        .slice(0, 4)
        .map((l) => l.trim().replace(/^at\s+/, ''))
        .join('\n         <- ');
      failures.push({
        route, role,
        msg: `${err.name}: ${err.message}`.slice(0, 150),
        where: line.trim().replace(/^at\s+/, '').slice(0, 120),
      });
    }
    try { await act(async () => { root.unmount(); }); } catch { /* teardown */ }
    host.remove();
  }
}

console.error = realError;
console.warn = realWarn;

console.log(`\n=== render audit ===\n`);
console.log(`  routes: ${TARGETS.length} (${TARGETS.join(", ")})   mounts: ${TARGETS.length * 3}`
  + `   clean: ${mounted}   threw: ${failures.length}\n`);
for (const f of failures) {
  console.log(`  THREW  ${f.route} as ${f.role}`);
  console.log(`         ${f.msg}`);
  if (f.where) console.log(`         ${f.where}`);
}

/* React logs a caught render error before rethrowing; those lines name the file. */
const interesting = swallowed.filter((s) => /Error|error/.test(s)).slice(0, 12);
if (interesting.length) {
  console.log('\n  --- console.error during mounting (first 12) ---');
  for (const s of interesting) console.log(`    ${s}`);
}
console.log('');
process.exit(failures.length ? 1 : 0);
