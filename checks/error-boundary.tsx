/**
 * A page that throws shows a message, and takes nothing else with it.
 *
 * The failure this exists for has happened twice. The Payroll page read
 * `p.earn[0].a` on a payslip with no earning lines, the throw reached the
 * root, React unmounted the tree, and the whole application went white — no
 * navigation, no message, and nothing for the person to report except "it went
 * blank". A blank page is the worst possible rendering of an error: it looks
 * identical to a broken deploy, a dead session and a network failure.
 *
 * So what is asserted here is not that errors stop happening. It is that one
 * page's error costs that page and nothing more: the message is visible, the
 * text names what went wrong so it can be repeated, and moving to another
 * route recovers without a reload.
 *
 * The last assertion is a source check rather than a render. A boundary that
 * is correct and not wired in is worth nothing, and the wiring is one line in
 * App.tsx that a refactor could drop without any test noticing.
 */

import { readFileSync } from 'node:fs';
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
  'sessionStorage', 'DOMParser'] as const) {
  put(k, (w as unknown as Record<string, unknown>)[k]);
}
put('requestAnimationFrame', (cb: (t: number) => void) => w.setTimeout(() => cb(0), 0));
put('cancelAnimationFrame', (h: number) => w.clearTimeout(h));
g.IS_REACT_ACT_ENVIRONMENT = true;

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};

/*
 * React logs every caught error to console.error. That is deliberate in the
 * boundary — the console is the only record this product keeps — but it would
 * bury this suite's own output, so it is captured and counted instead.
 */
const realError = console.error;
const logged: string[] = [];
console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { ErrorBoundary } = await import('../src/components/ErrorBoundary');

const MESSAGE = 'earn[0] is not a thing';
const Boom = (): never => { throw new Error(MESSAGE); };
const Fine = () => React.createElement('p', null, 'the page rendered');

const host = w.document.getElementById('root')!;
const root = createRoot(host);
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => w.setTimeout(r, 0)); });
  }
};

console.log('\na page that works is left alone\n');

await act(async () => {
  root.render(React.createElement(ErrorBoundary, { where: 'payroll' },
    React.createElement(Fine)));
});
await settle();
ok('1. the child renders untouched', host.textContent?.includes('the page rendered') === true,
  host.textContent ?? '');

console.log('\na page that throws\n');

await act(async () => {
  root.render(React.createElement(ErrorBoundary, { where: 'payroll' },
    React.createElement(Boom)));
});
await settle();

const text = host.textContent ?? '';
ok('2. something is on screen at all', text.trim().length > 0,
  'a blank page is the failure this exists to prevent');
ok('3. it says the page could not be displayed',
  /could not be displayed/i.test(text), text.slice(0, 120));
ok('4. it names the page, so a report says which one', /payroll/i.test(text), text.slice(0, 120));
ok('5. it shows the message verbatim, so it can be repeated',
  text.includes(MESSAGE), text.slice(0, 200));
ok('6. it is announced as an alert', host.querySelector('[role="alert"]') !== null);
ok('7. and the throw was logged for whoever can read a console',
  logged.some((l) => l.includes('[page crashed]')),
  `${logged.length} console.error call(s)`);

console.log('\nand the next page is not poisoned\n');

/*
 * The key is what does this: a caught boundary stays caught until it is
 * re-created, so without a per-route key the first crash would hold every
 * later page in the error state for the rest of the session.
 */
await act(async () => {
  root.render(React.createElement(ErrorBoundary, { key: 'leave', where: 'leave' },
    React.createElement(Fine)));
});
await settle();
ok('8. a new route renders normally after a crash',
  (host.textContent ?? '').includes('the page rendered'),
  host.textContent ?? '');

console.log('\nand it is actually wired in\n');

const app = readFileSync('src/App.tsx', 'utf8');
ok('9. App.tsx imports the boundary', /import \{ ErrorBoundary \}/.test(app));
ok('10. RouteView wraps the page in it',
  /<ErrorBoundary[^>]*>\s*<View \/>\s*<\/ErrorBoundary>/.test(app),
  'the page component must be the boundary\'s child, or a crash still reaches the root');
ok('11. keyed by route, so navigation resets it', /<ErrorBoundary\s+key=\{route\}/.test(app));
/*
 * Nesting, not source order. This asserted `indexOf('<Shell>') <
 * indexOf('<ErrorBoundary')` and failed against correct code, because
 * `RouteView` is declared above `Routed` and where a line sits in a file says
 * nothing about what wraps what. The honest version is structural: `Routed`
 * renders `RouteView` within `<Shell>`, and assertion 10 has already shown the
 * boundary wraps the page inside `RouteView` — together those put the boundary
 * inside the shell.
 */
ok('12. and the page sits inside the shell, so the navigation survives a crash',
  /<Shell>[\s\S]*RouteView route=\{r\}[\s\S]*<\/Shell>/.test(app),
  'Routed must render RouteView within <Shell>');

await act(async () => { root.unmount(); });
console.error = realError;

console.log('');
if (failed) { console.error(`${failed} FAILED\n`); process.exit(1); }
console.log('a page can fail without the application failing\n');
process.exit(0);
