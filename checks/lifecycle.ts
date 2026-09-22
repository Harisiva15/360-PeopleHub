/**
 * The lifecycle derives a stage, and refuses what it should.
 *
 * Three kinds of assertion. The derivation ones check that the stage matches
 * the records it was read from — that is the whole bet of this module, so it
 * is the part worth testing hardest. The scope ones run as all three roles,
 * because a rule that holds for an administrator and leaks for a manager is
 * the only kind that ships. And one assertion checks a hole: that no method
 * anywhere sets a stage, because the moment one does the derivation is a lie.
 */

import { getServices } from '../src/services';
import { LIFECYCLE_TASKS, lifecyclePopulation, stageOf } from '../src/data/lifecycleStages';
import { DEMO_EMP, DEMO_MGR, EMAP, HRHEAD } from '../src/data/employees';
import { ONBOARD } from '../src/data/onboarding';
import { EXITS } from '../src/data/exit';
import { CANDS } from '../src/data/ats';
import { recordAudit } from '../src/data/audit';
import { visibleIds } from '../src/state/rbac';
import { TODAY, ymd } from '../src/lib/dates';
import type { Caller } from '../src/services';

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
const NOW = ymd(TODAY);

(async () => {
  const pop = lifecyclePopulation();
  console.log(`\n${pop.length} people tracked across the lifecycle\n`);

  /* ---- there is no way to set a stage ---- */

  /*
   * The load-bearing assertion. Everything else here is only worth checking
   * because the stage is derived; a `setStage` would make the rest theatre.
   */
  check('no method sets a stage',
    Object.keys(s.lifecycle).filter((m) => /stage/i.test(m)), []);

  /* ---- the derivation matches the records ---- */

  const rows = await s.lifecycle.list(ADMIN);
  check('an administrator sees everybody', rows.length, pop.length);
  check('nobody appears twice',
    new Set(rows.map((r) => r.subject.id)).size, rows.length);
  check('every row carries a stage',
    rows.filter((r) => !r.standing.stage).length, 0);
  check('no stage started in the future',
    rows.filter((r) => r.standing.since > NOW).length, 0);
  check('days in stage is never negative',
    rows.filter((r) => r.standing.daysInStage < 0).length, 0);

  /* Each branch of `stageOf`, checked against the record it reads. */

  const inClearance = EXITS.find((x) => x.status === 'In Clearance'
    && EMAP[x.empId]?.status !== 'Exited');
  if (inClearance) {
    check('somebody in clearance is offboarding',
      stageOf(inClearance.empId).stage, 'Offboarding');
  }

  const onNotice = EXITS.find((x) => x.status !== 'In Clearance'
    && EMAP[x.empId]?.status !== 'Exited');
  if (onNotice) {
    check('somebody serving notice is exiting', stageOf(onNotice.empId).stage, 'Exit');
  }

  const exited = Object.values(EMAP).find((e) => e.status === 'Exited');
  if (exited) check('an exited employee is alumni', stageOf(exited.id).stage, 'Alumni');

  const pre = ONBOARD.find((o) => o.status === 'Pre-boarding');
  if (pre) {
    check('a pre-boarding record reads as pre-boarding',
      stageOf(pre.id).stage, 'Pre-boarding');
  }

  const onb = ONBOARD.find((o) => o.status !== 'Completed' && o.status !== 'Pre-boarding');
  if (onb) {
    check('an open onboarding record reads as onboarding',
      stageOf(onb.id).stage, 'Onboarding');
  }

  const offered = CANDS.find((c) => c.stage === 'offer');
  if (offered) {
    check('a candidate with an offer out is at Offer', stageOf(offered.id).stage, 'Offer');
  }

  const screening = CANDS.find((c) => c.stage !== 'offer'
    && c.stage !== 'rejected' && c.stage !== 'hired');
  if (screening) {
    check('a candidate still in the pipeline is a Candidate',
      stageOf(screening.id).stage, 'Candidate');
  }

  /* Rejected and hired candidates are somebody else's business. */
  const rejected = CANDS.filter((c) => c.stage === 'rejected').map((c) => c.id);
  check('rejected candidates are not tracked',
    pop.filter((p) => rejected.includes(p.id)).length, 0);

  /* Nobody in the pipeline is on the payroll, and every employee is. */
  check('pipeline people are not on payroll',
    pop.filter((p) => !p.onPayroll && EMAP[p.id]).length, 0);
  check('employees are on payroll',
    pop.filter((p) => p.onPayroll && !EMAP[p.id]).length, 0);

  /* ---- the stats agree with the list ---- */

  const stats = await s.lifecycle.stats(ADMIN);
  const at = (stage: string) => rows.filter((r) => r.standing.stage === stage).length;
  check('the pre-boarding figure matches the list', stats.preboarding, at('Pre-boarding'));
  check('the onboarding figure matches the list', stats.onboarding, at('Onboarding'));
  check('the exit figure matches the list', stats.exits, at('Exit'));
  check('the offboarding figure matches the list', stats.offboarding, at('Offboarding'));

  /* ---- who sees whom ---- */

  const mgrRows = await s.lifecycle.list(MANAGER);
  const line = new Set(visibleIds('manager', DEMO_MGR.id));
  check('a manager sees only their line',
    mgrRows.filter((r) => !line.has(r.subject.id)
      && r.subject.managerId !== DEMO_MGR.id).length, 0);
  check('a manager sees fewer people than an administrator',
    mgrRows.length < rows.length, true);

  const empRows = await s.lifecycle.list(EMPLOYEE);
  check('an employee sees exactly themselves', empRows.length, 1);
  check('and it is them', empRows[0]?.subject.id, DEMO_EMP.id);

  const someoneElse = rows.find((r) => r.subject.id !== DEMO_EMP.id)!;
  await refused('an employee cannot read somebody else',
    () => s.lifecycle.get(EMPLOYEE, someoneElse.subject.id));
  await allowed('but can read themselves', () => s.lifecycle.get(EMPLOYEE, DEMO_EMP.id));

  const missing = await s.lifecycle.get(ADMIN, 'EMP-does-not-exist');
  check('an id that does not exist is null, not a refusal', missing, null);

  /* ---- filtering ---- */

  const active = await s.lifecycle.list(ADMIN, { stage: 'Active' });
  check('a stage filter narrows to that stage',
    active.filter((r) => r.standing.stage !== 'Active').length, 0);

  const eng = await s.lifecycle.list(ADMIN, { dept: 'ENG' });
  check('a department filter narrows to that department',
    eng.filter((r) => r.subject.dept !== 'ENG').length, 0);

  const byName = await s.lifecycle.list(ADMIN, { q: rows[0].subject.name.toUpperCase() });
  check('search is case-insensitive',
    byName.some((r) => r.subject.id === rows[0].subject.id), true);

  check('the list is longest in stage first',
    rows.every((r, i) => i === 0
      || rows[i - 1].standing.daysInStage >= r.standing.daysInStage), true);

  /* ---- tasks ---- */

  const subject = mgrRows[0].subject;
  const draft = { n: 'Check task', due: NOW };

  await refused('an employee cannot assign a task',
    () => s.lifecycle.addTask(EMPLOYEE, DEMO_EMP.id, draft));
  await refused('a manager cannot assign outside their line',
    () => s.lifecycle.addTask(MANAGER, HRHEAD.id, draft));
  await allowed('a manager can assign on their line',
    () => s.lifecycle.addTask(MANAGER, subject.id, draft));

  await refused('a task with no name is refused',
    () => s.lifecycle.addTask(ADMIN, subject.id, { n: '  ', due: NOW }));
  await refused('a task with no due date is refused',
    () => s.lifecycle.addTask(ADMIN, subject.id, { n: 'Check x', due: '' }));
  await refused('a task for an assignee who does not exist is refused',
    () => s.lifecycle.addTask(ADMIN, subject.id, { ...draft, assigneeId: 'EMP-nobody' }));

  const mine = await s.lifecycle.addTask(ADMIN, DEMO_EMP.id,
    { ...draft, n: 'Check own task', assigneeId: DEMO_EMP.id });
  await allowed('an employee can complete a task assigned to them',
    () => s.lifecycle.setTaskDone(EMPLOYEE, mine.id, true));

  const theirs = await s.lifecycle.addTask(ADMIN, subject.id,
    { ...draft, n: 'Check other task' });
  await refused('an employee cannot complete a task that is not theirs',
    () => s.lifecycle.setTaskDone(EMPLOYEE, theirs.id, true));

  await refused('a manager cannot remove a task',
    () => s.lifecycle.removeTask(MANAGER, theirs.id));
  await refused('an employee cannot remove a task',
    () => s.lifecycle.removeTask(EMPLOYEE, mine.id));

  /* A completed task is dated, and reopening clears the date. */
  const done = await s.lifecycle.setTaskDone(ADMIN, theirs.id, true);
  check('completing a task dates it', done.doneOn, NOW);
  const back = await s.lifecycle.setTaskDone(ADMIN, theirs.id, false);
  check('reopening clears the date', back.doneOn, null);

  check('no generated task was completed in the future',
    LIFECYCLE_TASKS.filter((t) => t.doneOn && t.doneOn > NOW).length, 0);
  check('every task belongs to somebody tracked',
    LIFECYCLE_TASKS.filter((t) => !pop.some((p) => p.id === t.empId)).length, 0);

  /* ---- the audit trail ---- */

  const trail = recordAudit.all({ subjectTable: 'employee' }).map((a) => a.action);
  check('assigning a task is recorded', trail.includes('lifecycle.task_added'), true);
  check('completing one is recorded', trail.includes('lifecycle.task_done'), true);
  check('reopening one is recorded', trail.includes('lifecycle.task_reopened'), true);

  await allowed('an administrator can remove a task',
    () => s.lifecycle.removeTask(ADMIN, theirs.id));
  check('removing is recorded',
    recordAudit.all({ subjectTable: 'employee' })
      .some((a) => a.action === 'lifecycle.task_removed'), true);

  /* ---- clean up ---- */

  for (const t of LIFECYCLE_TASKS.filter((x) => x.n.startsWith('Check '))) {
    const i = LIFECYCLE_TASKS.findIndex((x) => x.id === t.id);
    if (i >= 0) LIFECYCLE_TASKS.splice(i, 1);
  }
  check('the check left no tasks behind',
    LIFECYCLE_TASKS.filter((t) => t.n.startsWith('Check ')).length, 0);
  recordAudit.reset();

  console.log();
  if (failed) {
    console.error(`${failed} lifecycle checks failed`);
    process.exit(1);
  }
  console.log('the lifecycle derives what it claims');
})();
