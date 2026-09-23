/**
 * The timesheet screens read the API, and an employee is not offered the team.
 *
 * Two failures this guards against, both of which were live in this module
 * until now.
 *
 * **A picker built from a hand-written list.** `addEntry` validates the project
 * code against `project WHERE code = $1 AND active`, so a dropdown built from
 * `src/data/org.ts` offers codes the server will refuse and omits ones it would
 * accept. The two lists agreed by luck. `useProjects()` was supposed to be the
 * real source and called `planner.board()`, which returns `{status, count,
 * estimate}` — not projects at all — and nothing consumed it.
 *
 * **A team view offered to somebody with no team.** The policy grants
 * `timesheet` as employee `own`, manager `team`, admin `all`. The server scopes
 * every read in SQL regardless, so the worst an over-offered tab does is show
 * an empty table — but an empty table is how somebody concludes the feature is
 * broken rather than forbidden.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROJECTS } from '../src/data/org';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const readRaw = (rel: string) => readFileSync(join(root, rel), 'utf8');

/*
 * Comments stripped. This file's own docstring names the call it forbids, and
 * explaining a fix must not fail the check for the fix.
 */
const read = (rel: string) =>
  readRaw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/* ------------------------------------------------------------------ *
 * 1. Projects come from the service
 * ------------------------------------------------------------------ */

console.log('\nprojects come from the API, not a hand-written list\n');

{
  const data = read('src/modules/timesheet/data.ts');
  ok('useProjects calls the timesheet service', /s\.timesheet\.projects\(\)/.test(data),
    'it used to call planner.board(), which returns BoardStats and not projects');
  ok('and it is not the planner board', !/planner\.board/.test(data));

  const contract = read('src/services/contracts.ts');
  ok('the contract declares projects()', /projects\(\): Promise<TimesheetProject\[\]>/.test(contract));

  const http = read('src/services/http/index.ts');
  ok('it is mapped to GET /projects', /projects: \(\) => api\.get\('\/projects'\)/.test(http),
    'an unmapped method falls through to the mock, which is the one failure '
    + 'mode that looks like working software');

  const routes = read('server/src/http/app.ts');
  ok('the server serves that route', /pattern: '\/projects'/.test(routes));
}

/*
 * No screen builds a project dropdown from the static array. `projOf` for
 * display is fine — resolving a stored code to a name is not choosing one —
 * which is why this looks for the list inside JSX rather than banning import.
 */
console.log('\nno timesheet screen offers the static project list\n');

const tsFiles = execSync('git ls-files src/modules/timesheet', { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => /\.tsx?$/.test(f));

const offenders = tsFiles.filter((rel) => /\{PROJECTS[.\s]/.test(read(rel)));
ok('no PROJECTS.map in a timesheet screen', offenders.length === 0,
  `${offenders.join(', ')} builds options from the static list; addEntry would `
  + 'refuse a code the server does not hold');

for (const rel of ['src/modules/timesheet/MyWeek.tsx']) {
  ok(`${rel.split('/').pop()} takes its projects from the hook`,
    /useBookableProjects\(\)/.test(read(rel)));
}

/*
 * The demo's list and the seed's must agree, or the demo teaches a project
 * production would reject — the same rule checks/locations.ts applies to sites.
 */
console.log('\nthe demo offers what the seed creates\n');
{
  const seed = read('server/scripts/seed.mjs');
  const block = seed.match(/const PROJECTS = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  const seeded = [...block.matchAll(/^\s*\['([A-Z0-9-]+)',/gm)].map((m) => m[1]!);
  ok('the seed names its projects', seeded.length > 0,
    'nothing parsed out of seed.mjs — the shape this reads has moved');

  const demo = PROJECTS.map((p) => p.id).sort();
  const onlyDemo = demo.filter((c) => !seeded.includes(c));
  const onlySeed = seeded.filter((c) => !demo.includes(c)).sort();
  ok('every demo project exists in the seed', onlyDemo.length === 0,
    `the demo offers ${onlyDemo.join(', ')}, which no seed creates`);
  ok('every seeded project is in the demo', onlySeed.length === 0,
    `the seed creates ${onlySeed.join(', ')}, which the demo omits`);
}

/*
 * An unknown code must not render as some other project's name. projOf used to
 * fall back to PROJECTS[0], so a project the server holds and the demo list
 * does not appeared confidently as "Atlas Core Platform".
 */
console.log('\nan unknown project code does not borrow a name\n');
{
  const org = read('src/data/org.ts');
  ok('projOf does not fall back to the first project',
    !/PROJECTS\.find\(p => p\.id === id\) \|\| PROJECTS\[0\]/.test(org),
    'an unknown code would render as whatever sits at the top of the array');
}

/* ------------------------------------------------------------------ *
 * 2. Who is offered what
 * ------------------------------------------------------------------ */

console.log('\nan employee is offered only their own week\n');

{
  const idx = read('src/modules/timesheet/index.tsx');

  const self = idx.match(/const SELF: \{ v: Tab; label: string \}\[\] = \[([\s\S]*?)\];/)?.[1] ?? '';
  const team = idx.match(/const TEAM: \{ v: Tab; label: string \}\[\] = \[([\s\S]*?)\];/)?.[1] ?? '';
  const labels = (s: string) => [...s.matchAll(/label: '([^']+)'/g)].map((m) => m[1]!);

  ok(`the self views are ${labels(self).join(', ')}`, labels(self).length === 4);
  ok(`the team views are ${labels(team).join(', ')}`, labels(team).length === 4);

  ok('team views are withheld from an employee',
    /const seesOthers = app\.role !== 'employee';/.test(idx),
    'the four team views read somebody else’s week');
  ok('and the tab list is built from that', /tabs = seesOthers \? \[\.\.\.SELF, \.\.\.TEAM\] : SELF/.test(idx));

  for (const view of ['Team Timesheets', 'Pending Approvals', 'Projects', 'Reports']) {
    ok(`  ${view} is a team view, not a self view`,
      team.includes(`'${view}'`) && !self.includes(`'${view}'`));
  }
}

console.log('\nand the menu agrees with the tabs\n');
{
  const nav = read('src/nav.ts');
  for (const [view, gated] of [
    ['v=entry', false], ['v=entries', false], ['v=cal', false], ['v=hist', false],
    ['v=team', true], ['v=appr', true], ['v=proj', true], ['v=rep', true],
  ] as [string, boolean][]) {
    const line = nav.split('\n').find((l) => l.includes(`/timesheet?${view}'`)) ?? '';
    ok(`${view.padEnd(10)} ${gated ? 'is manager/admin only' : 'is offered to everyone'}`,
      line !== '' && /roles: \['manager', 'admin'\]/.test(line) === gated,
      line || 'no menu item points at this view');
  }
}

/* ------------------------------------------------------------------ *
 * 3. The lifecycle stays on the server
 * ------------------------------------------------------------------ */

console.log('\nthe lifecycle is the service’s, not the screen’s\n');

{
  const data = read('src/modules/timesheet/data.ts');
  for (const [name, method] of [
    ['submit', 's.timesheet.submit(id)'],
    ['recall', 's.timesheet.recall(id)'],
    ['add an entry', 's.timesheet.addEntry(id, draft)'],
    ['copy last week', 's.timesheet.copyPreviousWeek(id)'],
  ] as [string, string][]) {
    ok(`${name} goes through the service`, data.includes(method), `expected ${method}`);
  }

  const week = read('src/modules/timesheet/MyWeek.tsx');
  /*
   * Editability is the sheet's status, read from the service. A screen that
   * decided this itself would eventually disagree with the server about an
   * approved week, and the disagreement would look like a bug in saving.
   */
  ok('editing follows the status the service returns',
    /status === 'Draft' \|\| .*status === 'Returned'/.test(week)
    || /editable/.test(week),
    'the editor must not decide for itself whether an approved week is open');
  ok('an approved week is not editable',
    !/status !== 'Approved' \? true/.test(week));
}

console.log(failed
  ? `\n${failed} failed\n`
  : '\nprojects are real, and the team views are not offered to an employee\n');
process.exit(failed ? 1 : 0);
