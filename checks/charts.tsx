/**
 * A chart with no data says so, keeps its labels inside, and the dashboard
 * only offers tiles whose module is open.
 *
 * ## Why a check rather than a look
 *
 * Both chart faults were invisible in every screenshot anyone could take of
 * this product, because the demo dataset has six full months of attendance.
 * `attendanceTrend` drops months with no records, so an empty tenant hands
 * `LineChart` empty arrays and one month hands it a single point — and those
 * are the two cases nobody can see locally.
 *
 * What they looked like: `Math.max()` of nothing is -Infinity, the x scale
 * divided by `labels.length - 1` of -1, and the area path came out as
 * `M46,188 L L46,188 Z`, which a browser partly draws. A single month was a
 * marker with no line through it — a dot in an empty box, which reads as a
 * fault rather than as data.
 *
 * ## And the axis labels
 *
 * Every x label was anchored `middle`, including the last, which is centred
 * on `width - 10` in viewBox units. Half of it fell outside the viewBox and
 * the SVG clipped it. A fixed right padding cannot fix this, because the
 * padding would have to know how wide the label is; anchoring the end labels
 * inwards does know.
 *
 * ## And the launch scope
 *
 * The last assertion is here because of a mistake made writing the tile
 * gates: `isReady('requisitions')` looks right and is wrong — the hidden set
 * names `requirements`, and `requisitions` is not a route at all. An unknown
 * key makes `isReady` return true, so a typo silently means "show it", which
 * is the failure mode the gate exists to prevent. Every key must be one the
 * menu knows.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { LineChart } from '../src/components/charts';
import { HIDDEN_ROUTES, NAV } from '../src/nav';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};

/* ---------------- nothing to plot ---------------- */

const none = renderToStaticMarkup(
  <LineChart labels={[]} series={[{ name: 'Attendance', color: 'var(--s1)', data: [] }]} />,
);
ok('no data renders an empty state rather than an empty chart',
  none.includes('chart-empty') && !none.includes('<svg'), none.slice(0, 220));
ok('no data draws no markers', !none.includes('circle'), none.slice(0, 220));
ok('no data emits no malformed path',
  !none.includes('d="M"') && !none.includes('L L'), none.slice(0, 220));

const noSeries = renderToStaticMarkup(<LineChart labels={['Jan']} series={[]} />);
ok('no series renders the empty state too', noSeries.includes('chart-empty'),
  noSeries.slice(0, 220));

/* ---------------- one point is data, not an error ---------------- */

const one = renderToStaticMarkup(
  <LineChart labels={['Nov']} series={[{ name: 'Attendance', color: 'var(--s1)', data: [92] }]} />,
);
ok('a single data point still draws a chart', one.includes('<svg'), one.slice(0, 160));
ok('a single data point draws its marker', (one.match(/circle/g) ?? []).length > 0);

/* ---------------- labels stay inside ---------------- */

const six = renderToStaticMarkup(
  <LineChart
    labels={['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'November 2026']}
    series={[{ name: 'A', color: 'var(--s1)', data: [90, 91, 92, 93, 94, 95] }]}
  />,
);
const axis = [...six.matchAll(/text-anchor="(start|middle|end)"[^>]*>([A-Za-z0-9 ]+)</g)]
  .map((m) => ({ anchor: m[1]!, text: m[2]! }))
  .filter((a) => /^(Jun|Jul|Aug|Sep|Oct|November 2026)$/.test(a.text));

ok('the x axis was found', axis.length === 6, `found ${axis.length}: ${
  axis.map((a) => a.text).join(', ')}`);
ok('the first x label anchors to its start', axis[0]?.anchor === 'start',
  axis.map((a) => `${a.text}:${a.anchor}`).join(' '));
ok('the last x label anchors to its end', axis.at(-1)?.anchor === 'end',
  axis.map((a) => `${a.text}:${a.anchor}`).join(' '));
ok('the labels between stay centred',
  axis.slice(1, -1).every((a) => a.anchor === 'middle'),
  axis.map((a) => `${a.text}:${a.anchor}`).join(' '));

/* ---------------- every launch-scope key is a real one ---------------- */

const keys = new Set<string>();
const walk = (groups: typeof NAV) => {
  for (const g of groups) {
    keys.add(g.k);
    for (const i of g.items) keys.add(i.k);
  }
};
walk(NAV);
for (const r of HIDDEN_ROUTES) keys.add(r);

const src = readFileSync('src/modules/dashboard/index.tsx', 'utf8');
const asked = [...src.matchAll(/isReady\('([^']+)'\)/g)].map((m) => m[1]!);
ok('the dashboard asks about some modules', asked.length > 0,
  'no isReady() calls found — if the gating moved, point this assertion at it');

const unknown = asked.filter((k) => !keys.has(k));
ok('every module the dashboard gates on is one the menu knows',
  unknown.length === 0,
  `${unknown.join(', ')} — not a NAV key and not in HIDDEN_ROUTES. isReady() `
  + 'returns true for a name nothing recognises, so a typo here shows a tile '
  + 'for a module that is closed, which is the opposite of what it is for.');
console.log(`  note  dashboard gates on: ${asked.join(', ')}`);

console.log();
if (failed) {
  console.error(`${failed} chart check(s) failed`);
  process.exit(1);
}
console.log('charts say when they have nothing, and tiles follow the launch scope');
