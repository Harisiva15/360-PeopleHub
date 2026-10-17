/**
 * The people screens — org chart, structure and celebrations.
 *
 * The drawing is CSS and has to be looked at; what is checked here is the
 * arithmetic underneath. Who sits under whom and what happens when the
 * reporting lines loop; whether a department card's rows sum to its own total;
 * and whether a recurring date lands in the right year. Each is a mistake that
 * renders perfectly well and is wrong.
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
import { OrgStructure, subTeams } from '../src/modules/people/OrgStructure';
import { CelebrationsView, occasionsIn } from '../src/modules/people/Celebrations';
import { DEPTS } from '../src/data/org';
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

/* ---------- the department breakdown ---------- */

/*
 * The listed rows have to sum to the total underneath them. A top-few that
 * silently drops the rest invites the reader to add up the column and reach a
 * number that disagrees with the card's own total.
 */
const staff = (roles: string[]) => roles.map((r, i) =>
  ({ ...emp('p' + i), designation: r } as Employee));

const few = staff(['Engineer', 'Engineer', 'Tester']);
check('a short list is shown as it is', subTeams(few), [
  { name: 'Engineer', n: 2 }, { name: 'Tester', n: 1 },
]);
check('and still sums to the headcount',
  subTeams(few).reduce((n, r) => n + r.n, 0), few.length);

const many = staff([
  ...Array(9).fill('Consultant'), ...Array(5).fill('Architect'),
  ...Array(4).fill('Analyst'), ...Array(3).fill('Manager'),
  'Scribe', 'Herald', 'Envoy',
]);
const folded = subTeams(many);
check('a long list names the largest few', folded.slice(0, 4).map((r) => r.name),
  ['Consultant', 'Architect', 'Analyst', 'Manager']);
check('largest first', folded.map((r) => r.n).slice(0, 4), [9, 5, 4, 3]);
check('the remainder is one line, not dropped',
  folded[folded.length - 1], { name: 'Other roles', n: 3 });
check('so the column sums to the headcount',
  folded.reduce((n, r) => n + r.n, 0), many.length);
check('exactly the named count needs no tail',
  subTeams(staff(['A', 'B', 'C', 'D'])).some((r) => r.name === 'Other roles'), false);

/* ---------- the structure view renders ---------- */

if (ceo) {
  const structure = renderToStaticMarkup(
    <MemoryRouter><AuthProvider><AppProvider initialRole="admin">
      <LayerProvider>
        <OrgStructure everyone={everyone} requisitions={[]} onOpen={() => {}} q="" deptFilter="" />
      </LayerProvider>
    </AppProvider></AuthProvider></MemoryRouter>,
  );
  check('the structure view names the chief executive', structure.includes(ceo.name), true);

  /* "DevOps & Cloud" is "DevOps &amp; Cloud" once rendered. */
  const esc = (t: string) => t.replace(/&/g, '&amp;');
  const shown = DEPTS.filter((d) => everyone.some((e) => e.dept === d.id));
  check('every populated department gets a card',
    shown.every((d) => structure.includes(esc(d.name))), true);
  check('an empty department gets none',
    DEPTS.filter((d) => !everyone.some((e) => e.dept === d.id))
      .every((d) => !structure.includes(esc(d.name))), true);

  /* Each card's total is the department's real headcount. */
  const totals = shown.map((d) => everyone.filter((e) => e.dept === d.id).length);
  check('each card carries its real headcount',
    totals.every((n) => structure.includes('<b>' + n + '</b>')), true);
  check('the department totals account for everyone',
    totals.reduce((a, b) => a + b, 0), everyone.length);

  const filtered = renderToStaticMarkup(
    <MemoryRouter><AuthProvider><AppProvider initialRole="admin">
      <LayerProvider>
        <OrgStructure everyone={everyone} requisitions={[]} onOpen={() => {}}
          q="" deptFilter={shown[0]!.id} />
      </LayerProvider>
    </AppProvider></AuthProvider></MemoryRouter>,
  );
  check('filtering to one department leaves the others out',
    shown.slice(1).every((d) => !filtered.includes(esc(d.name))), true);
  check('but keeps the one asked for', filtered.includes(esc(shown[0]!.name)), true);
}

/* ---------- celebrations: projecting recurring dates ---------- */

/*
 * A birthday is a day and month that returns every year. The service hands
 * back the next occurrence, whatever year that lands in; the calendar asks for
 * whichever month is on screen, so the projection has to move the year across
 * and leave the day and month alone. Getting this wrong shows a March birthday
 * in the wrong March, which nobody would notice until somebody's day passed
 * uncelebrated.
 */
const nameOf = (id: string) => 'Person ' + id;
const person = (id: string, doj: string): Employee =>
  ({ ...emp(id), doj, name: 'Person ' + id } as Employee);

const march = occasionsIn(
  '2027-03',
  [{ kind: 'birthday', empId: 'b', date: '2026-03-09', inDays: 0 },
    { kind: 'anniversary', empId: 'a', date: '2026-03-21', inDays: 0, years: 4 }],
  [],
  [],
  nameOf,
);
check('a recurring date is projected onto the month asked for',
  march.map((o) => o.date), ['2027-03-09', '2027-03-21']);
check('and keeps its kind', march.map((o) => o.kind), ['birthday', 'anniversary']);
check('an anniversary keeps the years', march[1]!.years, 4);

check('a recurring date in another month is left out',
  occasionsIn('2027-04',
    [{ kind: 'birthday', empId: 'b', date: '2026-03-09', inDays: 0 }], [], [], nameOf).length, 0);

/*
 * A joining date is not recurring — somebody joined once. Projecting it would
 * invent an anniversary of joining, which is what the anniversary record is
 * already for.
 */
const joiners = [person('j1', '2026-05-04'), person('j2', '2024-05-04')];
check('a joiner shows in the month they actually joined',
  occasionsIn('2026-05', [], joiners, [], nameOf).map((o) => o.empId), ['j1']);
check('and not in the same month of a later year',
  occasionsIn('2027-05', [], joiners, [], nameOf).length, 0);

/* Festivals move year to year, so they are matched as the dates they are. */
const fests = [{ d: '2026-11-08', n: 'Deepavali' }, { d: '2025-10-20', n: 'Deepavali' }];
check('a festival is taken as the date it falls on',
  occasionsIn('2026-11', [], [], fests, nameOf).map((o) => o.label), ['Deepavali']);
check('a festival has no employee attached',
  occasionsIn('2026-11', [], [], fests, nameOf)[0]!.empId, undefined);

check('everything in a month comes back in date order',
  occasionsIn('2026-11',
    [{ kind: 'birthday', empId: 'z', date: '2026-11-20', inDays: 0 }],
    [person('j3', '2026-11-02')],
    fests,
    nameOf).map((o) => o.date), ['2026-11-02', '2026-11-08', '2026-11-20']);

/* ---------- the celebrations screen renders ---------- */

const cel = await s.noticeboard.celebrations(365);
const celebHtml = renderToStaticMarkup(
  <MemoryRouter><AuthProvider><AppProvider initialRole="admin">
    <LayerProvider>
      <CelebrationsView cel={cel} everyone={everyone} onOpen={() => {}}
        onWish={() => {}} onAdd={() => {}} canPost />
    </LayerProvider>
  </AppProvider></AuthProvider></MemoryRouter>,
);
check('the celebrations screen mounts', celebHtml.includes('Celebration calendar'), true);
check('with every kind in the legend',
  ['Birthday', 'Work anniversary', 'New joiner', 'Festival']
    .every((k) => celebHtml.includes(k)), true);
check('and an add button for someone who may post',
  celebHtml.includes('Add celebration'), true);

const asEmployee = renderToStaticMarkup(
  <MemoryRouter><AuthProvider><AppProvider initialRole="employee">
    <LayerProvider>
      <CelebrationsView cel={cel} everyone={everyone} onOpen={() => {}}
        onWish={() => {}} onAdd={() => {}} canPost={false} />
    </LayerProvider>
  </AppProvider></AuthProvider></MemoryRouter>,
);
check('but none for someone who may not', asEmployee.includes('Add celebration'), false);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nthe people screens hold up');
process.exit(failed ? 1 : 0);

