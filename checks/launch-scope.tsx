/**
 * What is out of scope for go-live is closed, not merely unlisted.
 *
 * Taking an item out of a menu is not access control and was never meant to be
 * read as one: the module is still registered, still routed, and still mounted
 * by check:renders, so a bookmark or a typed URL walks straight into it. The
 * product has 116 menu items and this company launches with five people, so 72
 * of them are hidden — which makes the difference between "unlisted" and
 * "closed" worth asserting rather than assuming.
 *
 * Four things are checked, and the last is the one that will rot first:
 *
 *   1. a hidden route redirects when reached by URL
 *   2. a hidden tab falls back to its page's default, and the tab strip does
 *      not offer it
 *   3. everything in scope is still reachable — the point of a launch scope is
 *      to be narrow, not broken
 *   4. `NAV` is still complete, so a hidden module keeps being type-checked and
 *      mounted by the other suites rather than quietly rotting out of sight
 */

globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} } as never;
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, remove() {} }), body: { appendChild() {} } } as never;
Object.defineProperty(globalThis, 'navigator', { value: { geolocation: null }, configurable: true });

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Tabs } from '../src/components/ui';
import { useTabFromUrl } from '../src/modules/tabParam';
import {
  ALL_ROUTES, ALL_VIEWS, HIDDEN_ROUTES, HIDDEN_TABS, NAV, VISIBLE_NAV,
  VISIBLE_QUICK_ACTIONS, hrefOf, isHiddenItem, isHiddenRoute, isHiddenTab,
  LAUNCH_LETTERS, PAY_LETTERS, isHiddenLetter,
} from '../src/nav';
import { LETTER_TYPES } from '../src/data/letters';
import { loadAllRoutes } from '../src/modules';
import { getModule } from '../src/modules/registry';

await loadAllRoutes();

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};

console.log('\nthe menu is narrowed\n');

const allItems = NAV.reduce((n, g) => n + g.items.length, 0);
const shownItems = VISIBLE_NAV.reduce((n, g) => n + g.items.length, 0);
ok('1. something is hidden, and something is left', shownItems > 0 && shownItems < allItems,
  `${shownItems} of ${allItems}`);
ok('2. no hidden item survives into the menu',
  VISIBLE_NAV.every((g) => g.items.every((i) => !isHiddenItem(i))),
  VISIBLE_NAV.flatMap((g) => g.items.filter(isHiddenItem).map((i) => i.n)).join(', '));
ok('3. nor into the search index',
  ALL_VIEWS.every((v) => !isHiddenItem(v.item)),
  ALL_VIEWS.filter((v) => isHiddenItem(v.item)).map((v) => v.item.n).join(', '));
ok('4. nor into the quick actions',
  VISIBLE_QUICK_ACTIONS.every((name) =>
    VISIBLE_NAV.some((g) => g.items.some((i) => i.n === name))),
  VISIBLE_QUICK_ACTIONS.join(', '));

console.log('\na hidden route is closed, not just unlisted\n');

/*
 * Source rather than render for the guard itself. Mounting `Routed` needs the
 * whole provider stack and proves the same single branch, and this is the line
 * a refactor would drop: the redirect is one `if` in a function that otherwise
 * looks complete without it.
 */
const app = readFileSync('src/App.tsx', 'utf8');
ok('5. RouteView asks whether the route is hidden',
  /isHiddenRoute\(route\)/.test(app));
ok('6.  and redirects rather than rendering it',
  /if \(isHiddenRoute\(route\)\) return <Navigate to="\/dashboard" replace \/>;/.test(app),
  'the guard must return a redirect, not merely compute something');
ok('7.  before the page component is reached',
  app.indexOf('isHiddenRoute(route)') < app.indexOf('<ErrorBoundary'),
  'a guard after the render is not a guard');

console.log('\na hidden tab falls back, and is not offered\n');

const ALLOWED = ['me', 'runs', 'inputs', 'struct'] as const;
function Probe() {
  const [tab] = useTabFromUrl<typeof ALLOWED[number]>('me', ALLOWED);
  return <span>{tab}</span>;
}
const tabAt = (entry: string) => renderToStaticMarkup(
  <MemoryRouter initialEntries={[entry]}><Probe /></MemoryRouter>,
).replace(/<[^>]*>/g, '');

ok('8. ?v=inputs on payroll falls back to the default', tabAt('/payroll?v=inputs') === 'me',
  `got ${tabAt('/payroll?v=inputs')}`);
ok('9. ?v=runs likewise', tabAt('/payroll?v=runs') === 'me', `got ${tabAt('/payroll?v=runs')}`);
ok('10. a tab in scope still opens', tabAt('/payroll?v=struct') === 'struct',
  `got ${tabAt('/payroll?v=struct')}`);

const strip = (entry: string) => renderToStaticMarkup(
  <MemoryRouter initialEntries={[entry]}>
    <Tabs
      value="me"
      options={[
        { v: 'me', label: 'My payslips' },
        { v: 'struct', label: 'Salary details' },
        { v: 'runs', label: 'Payroll Runs' },
        { v: 'inputs', label: 'Payroll Inputs' },
      ]}
      onChange={() => {}}
    />
  </MemoryRouter>,
);
const painted = strip('/payroll');
ok('11. the tab strip does not paint a hidden tab',
  !painted.includes('Payroll Runs') && !painted.includes('Payroll Inputs'), painted.slice(0, 160));
ok('12.  while still painting the ones in scope',
  painted.includes('My payslips') && painted.includes('Salary details'), painted.slice(0, 160));

console.log('\nwhat is in scope is reachable\n');

ok('13. every visible item points at a route with a module',
  VISIBLE_NAV.every((g) => g.items.every((i) => {
    const route = hrefOf(i).replace(/^\//, '').split('?')[0]!;
    return Boolean(getModule(route));
  })));
ok('14.  and at a route that is not itself hidden',
  VISIBLE_NAV.every((g) => g.items.every((i) => {
    const route = hrefOf(i).replace(/^\//, '').split('?')[0]!;
    return !isHiddenRoute(route);
  })));
ok('15.  and names a tab that is not hidden',
  VISIBLE_NAV.every((g) => g.items.every((i) => {
    const href = hrefOf(i);
    const [path, query] = href.replace(/^\//, '').split('?');
    const tab = new URLSearchParams(query ?? '').get('v');
    return !tab || !isHiddenTab(path!, tab);
  })));

console.log('\nand nothing hidden is allowed to rot\n');

ok('16. NAV still names every route', ALL_ROUTES.length >= HIDDEN_ROUTES.size,
  `${ALL_ROUTES.length} routes, ${HIDDEN_ROUTES.size} hidden`);
ok('17. every hidden route still has a registered module',
  [...HIDDEN_ROUTES].every((r) => Boolean(getModule(r))),
  [...HIDDEN_ROUTES].filter((r) => !getModule(r)).join(', '));
ok('18. every hidden route is a route that exists',
  [...HIDDEN_ROUTES].every((r) => ALL_ROUTES.includes(r)),
  [...HIDDEN_ROUTES].filter((r) => !ALL_ROUTES.includes(r)).join(', '));
ok('19. every hidden tab names a route that exists',
  [...HIDDEN_TABS].every((t) => ALL_ROUTES.includes(t.split(':')[0]!)),
  [...HIDDEN_TABS].filter((t) => !ALL_ROUTES.includes(t.split(':')[0]!)).join(', '));

/* ===========================================================================
 * Letters, which are an action rather than a route or a tab
 *
 * `LAUNCH_LETTERS` was declared and never read, so all eight types stayed on
 * offer and the three that quote pay are `self: true` — "Generate now", not a
 * request to HR. Both halves are asserted: that they are out of scope while
 * the flag is false, and that the page consults the gate rather than the
 * catalogue. The second is the one that matters, because the first was true
 * of the old code too.
 * ======================================================================== */

const offered = LETTER_TYPES.filter((t) => !isHiddenLetter(t.id));

ok('20. every pay letter names a type that exists',
  [...PAY_LETTERS].every((id) => LETTER_TYPES.some((t) => t.id === id)),
  [...PAY_LETTERS].filter((id) => !LETTER_TYPES.some((t) => t.id === id)).join(', '));

ok(`21. no letter that quotes pay is offered (${offered.length} of ${LETTER_TYPES.length})`,
  !LAUNCH_LETTERS && offered.every((t) => !PAY_LETTERS.has(t.id)),
  offered.filter((t) => PAY_LETTERS.has(t.id)).map((t) => t.n).join(', '));

ok('22.  and the five that do not are all still offered',
  offered.length === LETTER_TYPES.length - PAY_LETTERS.size,
  `${offered.length} offered, expected ${LETTER_TYPES.length - PAY_LETTERS.size}`);

const docs = readFileSync('src/modules/documents/index.tsx', 'utf8');

ok('23. the page consults the gate rather than the catalogue',
  /isHiddenLetter/.test(docs));

ok('24.  at every place it offers one',
  !/LETTER_TYPES\.map\(/.test(docs) && !/\ballTypes\.map\(/.test(docs),
  'an unfiltered map over the catalogue is back');

const navSrc = readFileSync('src/nav.ts', 'utf8');
const gateDef = navSrc.slice(navSrc.indexOf('export const isHiddenLetter'), navSrc.length);

ok('25. the gate reads the flag, which is how this failed before',
  /LAUNCH_LETTERS/.test(gateDef.slice(0, 220)),
  'isHiddenLetter no longer consults LAUNCH_LETTERS');

console.log('');
if (failed) { console.error(`${failed} FAILED\n`); process.exit(1); }
console.log('the launch scope is narrow, enforced, and reversible\n');
process.exit(0);
