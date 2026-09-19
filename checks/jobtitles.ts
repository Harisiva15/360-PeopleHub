/**
 * The job-title catalogue refuses what it should, and counts what it claims.
 *
 * Two kinds of assertion here. The authorisation ones run as all three roles,
 * because a rule that holds for an administrator and leaks for a manager is
 * the only kind that ships. The integrity ones check the thing a catalogue is
 * actually for: that retiring a title cannot orphan the people holding it.
 */

import { getServices } from '../src/services';
import { JOB_TITLES, holdersOf } from '../src/data/jobtitles';
import { ACTIVE, DEMO_EMP, DEMO_MGR, HRHEAD } from '../src/data/employees';
import { recordAudit } from '../src/data/audit';
import type { Caller, JobTitleDraft } from '../src/services';

const s = getServices();
let failed = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const refused = async (label: string, run: () => Promise<unknown>) => {
  try { await run(); check(label, 'accepted', 'refused'); }
  catch { check(label, 'refused', 'refused'); }
};
const allowed = async (label: string, run: () => Promise<unknown>) => {
  try { await run(); check(label, 'allowed', 'allowed'); }
  catch (e) { check(label, `refused: ${(e as Error).message}`, 'allowed'); }
};

const ADMIN: Caller = { role: 'admin', meId: HRHEAD.id };
const MANAGER: Caller = { role: 'manager', meId: DEMO_MGR.id };
const EMPLOYEE: Caller = { role: 'employee', meId: DEMO_EMP.id };

(async () => {
  console.log(`\n${JOB_TITLES.length} job titles in the catalogue\n`);

  /* ---- the catalogue describes the people who exist ---- */

  const listed = await s.jobTitles.list(ADMIN);
  check('every title is listed for an administrator', listed.length, JOB_TITLES.length);

  const mapped = listed.reduce((n, r) => n + r.employees, 0);
  check('the catalogue accounts for real employees', mapped > 0, true);

  /*
   * The count is the reason the module exists, so it has to be the truth
   * rather than a plausible number.
   */
  const drift = listed.filter((r) => r.employees !== holdersOf(r.title).length);
  check('every count matches the people actually holding that title', drift.length, 0);

  check('no two titles share a code',
    new Set(JOB_TITLES.map((t) => t.code)).size, JOB_TITLES.length);
  check('no two titles share a name',
    new Set(JOB_TITLES.map((t) => t.n.toLowerCase())).size, JOB_TITLES.length);
  check('every title names a level that exists',
    JOB_TITLES.filter((t) => !/^L[1-8]$/.test(t.level)).length, 0);

  /* ---- who may do what ---- */

  await allowed('a manager may browse the catalogue', () => s.jobTitles.list(MANAGER));
  await refused('an employee may not browse the catalogue', () => s.jobTitles.list(EMPLOYEE));

  const mine = await s.jobTitles.mine(EMPLOYEE);
  check('an employee gets their own title', mine?.title.n, DEMO_EMP.designation);

  const someoneElse = JOB_TITLES.find((t) => t.n !== DEMO_EMP.designation)!;
  await refused("an employee cannot read somebody else's title",
    () => s.jobTitles.get(EMPLOYEE, someoneElse.id));

  const own = JOB_TITLES.find((t) => t.n === DEMO_EMP.designation);
  if (own) {
    await allowed('but can read their own', () => s.jobTitles.get(EMPLOYEE, own.id));
  }

  const base = (over: Partial<JobTitleDraft> = {}): JobTitleDraft => ({
    n: `Check Role ${Math.random().toString(36).slice(2, 7)}`,
    code: `CHK-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    dept: 'ENG',
    level: 'L3',
    ...over,
  });

  await refused('a manager cannot add a title', () => s.jobTitles.create(MANAGER, base()));
  await refused('an employee cannot add a title', () => s.jobTitles.create(EMPLOYEE, base()));
  await allowed('an administrator can', () => s.jobTitles.create(ADMIN, base()));

  /* ---- validation ---- */

  await refused('a title with no name is refused', () => s.jobTitles.create(ADMIN, base({ n: ' ' })));
  await refused('a title with no code is refused', () => s.jobTitles.create(ADMIN, base({ code: '' })));
  await refused('a malformed code is refused',
    () => s.jobTitles.create(ADMIN, base({ code: 'a b' })));
  await refused('a duplicate code is refused',
    () => s.jobTitles.create(ADMIN, base({ code: JOB_TITLES[0].code })));
  await refused('a duplicate name is refused',
    () => s.jobTitles.create(ADMIN, base({ n: JOB_TITLES[0].n })));
  await refused('a title with no department is refused',
    () => s.jobTitles.create(ADMIN, base({ dept: '' })));

  /* ---- the integrity rule the module exists for ---- */

  const held = listed.find((r) => r.employees > 0)!;
  await refused('a title somebody holds cannot be retired',
    () => s.jobTitles.setStatus(ADMIN, held.title.id, 'Inactive'));
  await refused('nor deleted',
    () => s.jobTitles.remove(ADMIN, held.title.id));

  const empty = await s.jobTitles.create(ADMIN, base());
  await allowed('a title nobody holds can be retired',
    () => s.jobTitles.setStatus(ADMIN, empty.id, 'Inactive'));
  await allowed('and reactivated', () => s.jobTitles.setStatus(ADMIN, empty.id, 'Active'));
  await allowed('and deleted', () => s.jobTitles.remove(ADMIN, empty.id));
  check('deleting removes it from the catalogue',
    JOB_TITLES.some((t) => t.id === empty.id), false);

  /* ---- the audit trail ---- */

  const audited = await s.jobTitles.create(ADMIN, base());
  await s.jobTitles.update(ADMIN, audited.id, { desc: 'Changed for the check' });
  await s.jobTitles.setStatus(ADMIN, audited.id, 'Inactive');

  const detail = (await s.jobTitles.get(ADMIN, audited.id))!;
  const actions = detail.history.map((h) => h.action);
  check('creating is recorded', actions.includes('job_title.created'), true);
  check('updating is recorded', actions.includes('job_title.updated'), true);
  check('a status change is recorded', actions.includes('job_title.status'), true);
  check('the trail is newest first',
    detail.history.every((h, i) => i === 0 || detail.history[i - 1].at >= h.at), true);
  check('every entry names who did it',
    detail.history.filter((h) => !h.actorLabel).length, 0);
  check('an update says what changed',
    detail.history.find((h) => h.action === 'job_title.updated')!.summary.includes('desc'), true);

  /* ---- filtering ---- */

  const eng = await s.jobTitles.list(ADMIN, { dept: 'ENG' });
  check('a department filter narrows to that department',
    eng.filter((r) => r.title.dept !== 'ENG').length, 0);

  const byName = await s.jobTitles.list(ADMIN, { q: JOB_TITLES[0].n.slice(0, 6).toUpperCase() });
  check('search is case-insensitive',
    byName.some((r) => r.title.id === JOB_TITLES[0].id), true);

  const active = await s.jobTitles.list(ADMIN, { status: 'Active' });
  check('a status filter narrows to that status',
    active.filter((r) => r.title.status !== 'Active').length, 0);

  /* ---- clean up ---- */

  for (const t of JOB_TITLES.filter((x) => x.code.startsWith('CHK-'))) {
    const i = JOB_TITLES.findIndex((x) => x.id === t.id);
    if (i >= 0) JOB_TITLES.splice(i, 1);
  }
  check('the check left no titles behind',
    JOB_TITLES.filter((t) => t.code.startsWith('CHK-')).length, 0);
  check('the roster is untouched', ACTIVE().length > 0, true);
  recordAudit.reset();

  console.log();
  if (failed) {
    console.error(`${failed} job-title checks failed`);
    process.exit(1);
  }
  console.log('the job-title catalogue holds its rules');
})();
