/**
 * The org chart's tree building, checked directly.
 *
 * The drawing is CSS and the layout has to be looked at, but the tree
 * underneath it is arithmetic: who sits under whom, how many, and what happens
 * when the reporting lines are malformed. A cycle is the case worth having a
 * test for — it is rare, it comes from a bad import rather than from the app,
 * and without a guard it does not misdraw, it hangs the tab.
 */

globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} } as never;
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, remove() {} }), body: { appendChild() {} } } as never;
Object.defineProperty(globalThis, 'navigator', { value: { geolocation: null }, configurable: true });

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/state/AppContext';
import { AuthProvider } from '../src/auth/AuthContext';
import { LayerProvider } from '../src/components/Layer';
import { buildTree, OrgTreeView } from '../src/modules/people/OrgChart';
import { getServices } from '../src/services';
import type { Employee } from '../src/types/employee';

let failed = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`
    + (ok ? '' : `  — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));
};

/** Just enough of an employee for the tree; the chart reads no more than this. */
const emp = (id: string, reports: string[] = []): Employee => ({
  id, code: id, name: id, designation: 'Engineer', dept: 'ENG', site: 'CHN',
  managerId: '', reports, status: 'Active', doj: '2024-01-01', email: id + '@x.test',
} as unknown as Employee);

const from = (list: Employee[]) => {
  const m = new Map(list.map((e) => [e.id, e]));
  return (id: string) => m.get(id);
};

console.log('\norg chart\n');

/* ---------- shape and counts ---------- */

const flat = [emp('ceo', ['a', 'b']), emp('a', ['a1', 'a2']), emp('b'), emp('a1'), emp('a2')];
const tree = buildTree(flat[0]!, from(flat));

check('the root has its direct reports', tree.kids.map((k) => k.e.id), ['a', 'b']);
check('children are ordered by name', buildTree(
  emp('r', ['zoe', 'adam']),
  from([emp('r', ['zoe', 'adam']), emp('zoe'), emp('adam')]),
).kids.map((k) => k.e.id), ['adam', 'zoe']);
check('total counts everyone beneath, not just direct reports', tree.total, 4);
check('a branch counts its own subtree', tree.kids[0]!.total, 2);
check('a leaf counts nothing', tree.kids[1]!.total, 0);

/*
 * A report id that names nobody — an employee who has left, say — is dropped
 * rather than drawn as a blank card.
 */
const dangling = [emp('r', ['gone', 'here']), emp('here')];
check('a report who is not in the list is left out',
  buildTree(dangling[0]!, from(dangling)).kids.map((k) => k.e.id), ['here']);

/* ---------- the cycle guard ---------- */

/*
 * A reports to B and B reports to A. Without the guard this recurses until the
 * stack gives out; with it, the branch stops at the repeat.
 */
const loop = [emp('a', ['b']), emp('b', ['a'])];
const looped = buildTree(loop[0]!, from(loop));
check('a two-person cycle terminates', looped.kids.map((k) => k.e.id), ['b']);
check('and stops rather than repeating', looped.kids[0]!.kids.length, 0);
check('counting a cycle does not run away', looped.total, 1);

const selfLoop = [emp('s', ['s'])];
check('somebody reporting to themselves terminates too',
  buildTree(selfLoop[0]!, from(selfLoop)).kids.length, 0);

/*
 * The same person under two different managers is not a cycle — it is a
 * dotted line, and both branches should show them.
 */
const shared = [emp('r', ['m1', 'm2']), emp('m1', ['x']), emp('m2', ['x']), emp('x')];
const sharedTree = buildTree(shared[0]!, from(shared));
check('a person under two managers appears under both',
  sharedTree.kids.map((k) => k.kids.map((g) => g.e.id)), [['x'], ['x']]);

/* ---------- it renders ---------- */

const s = getServices();
const everyone = await s.employees.active();
const ceo = everyone.find((e) => !e.managerId);
check('the fixture has somebody at the top', Boolean(ceo), true);

if (ceo) {
  const html = renderToStaticMarkup(
    <MemoryRouter><AuthProvider><AppProvider initialRole="admin">
      <LayerProvider>
        <OrgTreeView root={ceo} everyone={everyone} onOpen={() => {}} q="" />
      </LayerProvider>
    </AppProvider></AuthProvider></MemoryRouter>,
  );
  check('the chart renders the person at the top', html.includes(ceo.name), true);
  check('with connector markup, not an indented list', html.includes('orgtree'), true);
  check('and a zoom control', html.includes('Fit to screen'), true);

  /* Collapsed by default below the second level, or the first paint is enormous. */
  const cards = (html.match(/class="org-card"/g) ?? []).length;
  check('it does not open with the whole company', cards < everyone.length, true);
  check('but shows more than the root alone', cards > 1, true);

  const real = buildTree(ceo, from(everyone));
  check('the tree reaches everyone with a reporting line',
    real.total <= everyone.length - 1, true);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nthe org chart tree holds');
process.exit(failed ? 1 : 0);
