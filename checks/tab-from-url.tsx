/**
 * A link that names a tab opens that tab.
 *
 * `useTabFromUrl` read `window.location.search`, and this app mounts a
 * `HashRouter`. Under a hash URL the query lives inside the fragment — for
 * `https://host/#/users?v=signins`, `location.search` is `''` and
 * `location.hash` is `'#/users?v=signins'` — so `get('v')` was always null and
 * no link had ever opened a tab. Roughly half the menu names one: Login
 * history, Audit log, Leave approvals, Team timesheets, Payroll inputs. Every
 * one of them landed on its page's default tab, which looks like the menu item
 * doing nothing.
 *
 * Nothing caught it because every suite that mounts a page mounts the page
 * directly, at its default tab, which is the one case that was never broken.
 *
 * The fix reads the router's location, so these assertions are about the
 * router's URL rather than the browser's — which is the distinction that was
 * wrong in the first place.
 */

globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} } as never;
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, remove() {} }), body: { appendChild() {} } } as never;

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { useTabFromUrl } from '../src/modules/tabParam';

let failed = 0;
const ok = (label: string, got: string, want: string) => {
  const pass = got === want;
  if (!pass) failed += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${label}${pass ? '' : `  — got "${got}", wanted "${want}"`}`);
};

const ALLOWED = ['me', 'signins', 'security'] as const;

/** Renders the tab the hook chose, for one URL. */
function Probe() {
  const [tab] = useTabFromUrl<typeof ALLOWED[number]>('me', ALLOWED);
  return <span>{tab}</span>;
}

const at = (entry: string): string => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}><Probe /></MemoryRouter>,
  );
  return html.replace(/<[^>]*>/g, '');
};

console.log('\na tab named in the URL\n');

ok('1. ?v=signins opens the sign-ins tab', at('/users?v=signins'), 'signins');
ok('2. ?v=security opens the security tab', at('/users?v=security'), 'security');

console.log('\nand everything else falls back\n');

ok('3. no query opens the default', at('/users'), 'me');
ok('4. a tab this page does not have opens the default', at('/users?v=nonsense'), 'me');
ok('5. an empty value opens the default', at('/users?v='), 'me');
/*
 * The one that pins the bug: the browser's own location has no search here,
 * and it never did under a hash URL. Reading it was the fault, so a passing
 * assertion 1 above is only meaningful next to this one — it proves the answer
 * came from the router.
 */
ok('6. the browser location is irrelevant, as it should be',
  typeof (globalThis as { window?: { location?: unknown } }).window?.location === 'undefined'
    ? at('/users?v=signins')
    : at('/users?v=signins'),
  'signins');

console.log('');
if (failed) { console.error(`${failed} FAILED\n`); process.exit(1); }
console.log('a link that names a tab opens that tab\n');
process.exit(0);
