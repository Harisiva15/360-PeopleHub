/**
 * Timesheets and Projects are two sections, and each role sees exactly its own.
 *
 * The "Timesheet" group held eight items covering two unrelated jobs: the
 * weekly return, and the planner the hours are booked against. It is now two
 * sections, sitting between Time & Attendance and Leave.
 *
 * ## What this pins
 *
 * Both groups, in that position, with exactly the items each role is meant to
 * see — and, for every item, that the server would not refuse the screen it
 * leads to. A menu that offers a view the service rejects is worse than one
 * that hides it: the person clicks, gets a page of nothing, and learns to
 * distrust the navigation.
 *
 * ## Routes are the contract
 *
 * Every `to` is asserted literally, because the whole change was meant to be a
 * regrouping. Somebody's bookmark, or a link pasted into a chat months ago, is
 * a URL — and `/timesheet?v=rep` moving to another group must not move the
 * link. The one label that changed is asserted as changed, and asserted to
 * still answer to its old name in search.
 *
 * ## Ready for the new roles
 *
 * `ROLE_EXPECTATIONS` is keyed by role, so when hr_admin and finance_admin
 * land they are two more entries rather than a rewrite. The assertion that no
 * item leads to a refused screen reads the policy, so it covers a new role the
 * moment the policy does.
 */

import { ALL_VIEWS, NAV } from '../src/nav';
import type { NavItem } from '../src/nav';
import { scopeOfDemo, covers, can, PERMS } from '../src/state/rbac';
import { POLICY } from '../server/src/auth/policy';
import type { AppRole } from '../src/types/employee';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

/* ------------------------------------------------------------------ *
 * Position
 * ------------------------------------------------------------------ */

console.log('\ntwo sections, between Time & Attendance and Leave\n');

const names = NAV.map((g) => g.group);
const iAtt = names.indexOf('Time & Attendance');
const iTs = names.indexOf('Timesheets');
const iPr = names.indexOf('Projects');
const iLv = names.indexOf('Leave');

ok('1. Timesheets exists', iTs >= 0);
ok('2. Projects exists', iPr >= 0);
ok('3. the old single Timesheet group is gone',
  !names.includes('Timesheet'),
  'two headings differing by one letter is worse than one');
ok('4. Timesheets comes directly after Time & Attendance',
  iTs === iAtt + 1, `${names[iAtt]} → ${names[iTs]}`);
ok('5. Projects comes directly after Timesheets', iPr === iTs + 1, `${names[iPr]}`);
ok('6. and Leave directly after Projects', iLv === iPr + 1, `${names[iLv]}`);

const tsGroup = NAV[iTs]!;
const prGroup = NAV[iPr]!;

ok('7. Timesheets keys on timesheet and carries the note icon',
  tsGroup.k === 'timesheet' && tsGroup.ic === 'note', `${tsGroup.k}/${tsGroup.ic}`);
ok('8. Projects keys on planner and carries the projects icon',
  prGroup.k === 'planner' && prGroup.ic === 'projects', `${prGroup.k}/${prGroup.ic}`);
ok('9. each group describes itself',
  /Log your hours each week/.test(tsGroup.desc ?? '')
  && /the projects time is booked against/.test(prGroup.desc ?? ''),
  `${tsGroup.desc} | ${prGroup.desc}`);

/* ------------------------------------------------------------------ *
 * Exactly these items, per role
 * ------------------------------------------------------------------ */

/** name → route, as the brief specifies them. */
const TS_ALL: [string, string][] = [
  ['My timesheet', '/timesheet?v=entry'],
  ['Time entries', '/timesheet?v=entries'],
  ['Timesheet calendar', '/timesheet?v=cal'],
  ['Timesheet history', '/timesheet?v=hist'],
];
const TS_LEAD: [string, string][] = [
  ['Team timesheets', '/timesheet?v=team'],
  ['Pending approvals', '/timesheet?v=appr'],
];
const PR_ALL: [string, string][] = [
  ['My work', '/planner?v=mine'],
  ['Work board', '/planner?v=board'],
  ['Action items', '/planner?v=actions'],
  ['Sprints', '/planner?v=iterations'],
];
const PR_LEAD: [string, string][] = [
  ['Projects', '/timesheet?v=proj'],
  ['Utilisation & effort', '/timesheet?v=rep'],
];

/**
 * What each role should see. Add hr_admin and finance_admin here when the
 * roles land; everything below reads this rather than naming roles.
 */
interface Audience {
  label: string;
  role: AppRole;
  /** Whether the reporting tree gives them the manager layer. */
  hasReports: boolean;
  ts: [string, string][];
  pr: [string, string][];
}

const ROLE_EXPECTATIONS: Audience[] = [
  { label: 'an employee', role: 'employee', hasReports: false, ts: TS_ALL, pr: PR_ALL },
  {
    label: 'an employee with reports',
    role: 'employee',
    hasReports: true,
    ts: [...TS_ALL, ...TS_LEAD],
    pr: [...PR_ALL, ...PR_LEAD],
  },
  {
    label: 'a company administrator',
    role: 'company_admin',
    hasReports: false,
    ts: [...TS_ALL, ...TS_LEAD],
    pr: [...PR_ALL, ...PR_LEAD],
  },
];

/** The items a role actually sees, the way Shell filters them. */
const visible = (
  role: AppRole,
  hasReports: boolean,
  items: readonly NavItem[],
): NavItem[] =>
  items.filter(
    (i) => can(role, i.k, hasReports)
      && (!i.needs || covers(scopeOfDemo(role, hasReports, i.k), i.needs)),
  );

/**
 * Whether the server would grant this role a read in this module.
 *
 * Resolved against whichever layer names the policy actually carries, rather
 * than against a hardcoded list. The policy is mid-migration from three roles
 * to four plus a derived manager layer, and this check has to pass on both
 * sides of that — so `admin` finds `admin` today and `company_admin` later,
 * and a role is refused only when *no* layer applying to it grants a read.
 */
const ALIASES: Record<string, string[]> = {
  employee: ['employee'],
  manager: ['employee', 'manager'],
  admin: ['admin', 'company_admin'],
  hr_admin: ['employee', 'hr_admin'],
  finance_admin: ['employee', 'finance_admin'],
  company_admin: ['company_admin', 'admin'],
};

const policyReads = (role: string, module: string): boolean => {
  const byLayer = POLICY[module] as Record<string, { read: string }> | undefined;
  if (!byLayer) return false;
  const layers = (ALIASES[role] ?? [role]).filter((l) => l in byLayer);
  if (!layers.length) {
    /* A role the policy has never heard of must not be silently waved through. */
    console.log(`        note: policy has no layer for ${role}`);
    return false;
  }
  return layers.some((l) => byLayer[l]!.read !== 'none');
};

for (const want of ROLE_EXPECTATIONS) {
  console.log(`\nas ${want.label}\n`);
  const r = want.role;
  const hr = want.hasReports;

  for (const [group, items, expected] of [
    ['Timesheets', tsGroup.items, want.ts],
    ['Projects', prGroup.items, want.pr],
  ] as const) {
    const got = visible(r, hr, items);
    ok(`${group}: ${expected.length} items, in order`,
      got.length === expected.length
      && got.every((g, n) => g.n === expected[n]![0]),
      `${got.map((g) => g.n).join(', ')}`);
    ok('    each at the route the brief names',
      got.every((g, n) => (g.to ?? `/${g.k}`) === expected[n]![1]),
      got.map((g) => `${g.n}→${g.to}`).join(', '));
  }

  /*
   * And the part a menu check usually skips: would the server serve it.
   * An item offering a screen the policy grants no read on is a 403 with a
   * menu entry in front of it.
   */
  const refused = [...visible(r, hr, tsGroup.items), ...visible(r, hr, prGroup.items)]
    .filter((i) => !policyReads(r, i.k));
  ok('    nothing offered that the policy refuses',
    refused.length === 0, refused.map((i) => `${i.n} (${i.k})`).join(', '));

  /* The group heading itself has to be reachable, or the items are unreachable. */
  ok('    both headings open for this role',
    can(r, tsGroup.k) && can(r, prGroup.k),
    `timesheet ${can(r, tsGroup.k)}, planner ${can(r, prGroup.k)}`);
}

/* ------------------------------------------------------------------ *
 * Routes and the one rename
 * ------------------------------------------------------------------ */

console.log('\nevery route survives the regrouping\n');

const allRoutes = [...TS_ALL, ...TS_LEAD, ...PR_ALL, ...PR_LEAD].map(([, to]) => to);
const inNav = new Set([...tsGroup.items, ...prGroup.items].map((i) => i.to ?? `/${i.k}`));
ok('10. all twelve routes are present',
  allRoutes.every((r) => inNav.has(r)),
  allRoutes.filter((r) => !inNav.has(r)).join(', '));
ok('11. and nothing extra crept in', inNav.size === allRoutes.length,
  `${inNav.size} vs ${allRoutes.length}`);

ok('12. Iterations is relabelled Sprints',
  [...prGroup.items].some((i) => i.n === 'Sprints' && i.to === '/planner?v=iterations'));
ok('13. and the route is untouched, so the bookmark works',
  inNav.has('/planner?v=iterations'));
ok('14. no item is still called Iterations',
  ![...tsGroup.items, ...prGroup.items].some((i) => i.n === 'Iterations'));

ok('15. the two timesheet views under Projects keep k: timesheet',
  PR_LEAD.every(([n]) => prGroup.items.find((i) => i.n === n)?.k === 'timesheet'),
  'grouping is presentation; k is the permission');
ok('16. and the planner views keep k: planner',
  PR_ALL.every(([n]) => prGroup.items.find((i) => i.n === n)?.k === 'planner'));

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

console.log('\nthe old names still find the right views\n');

const hit = (needle: string): string[] => ALL_VIEWS
  .filter((v) => `${v.group} · ${v.item.n}`.toLowerCase().includes(needle.toLowerCase())
    || (v.item.alt ?? []).some((a) => a.toLowerCase().includes(needle.toLowerCase())))
  .map((v) => `${v.group} · ${v.item.n}`);

const iter = hit('Iterations');
ok('17. "Iterations" still finds Sprints',
  iter.some((l) => /Sprints/.test(l)), iter.join(', ') || '(nothing)');

const ts = hit('Timesheet');
ok('18. "Timesheet" finds the weekly views', ts.some((l) => /My timesheet/.test(l)));
ok('19. and the two that moved to Projects',
  ts.some((l) => /Projects · Projects/.test(l))
  && ts.some((l) => /Utilisation & effort/.test(l)),
  ts.join(', '));

/* ------------------------------------------------------------------ *
 * The mirror, and the phone
 * ------------------------------------------------------------------ */

console.log('\nwhat must not have changed\n');

ok('20. planner is still in every role\'s module list',
  (Object.keys(PERMS) as AppRole[]).every((r) => PERMS[r].includes('planner')),
  'the Projects heading keys on it');
ok('21. timesheet too',
  (Object.keys(PERMS) as AppRole[]).every((r) => PERMS[r].includes('timesheet')));

console.log();
if (failed) {
  console.error(`${failed} nav checks failed`);
  process.exit(1);
}
console.log('Timesheets and Projects are two sections, every route intact, and each role sees its own');
