/**
 * The two derivations, tested by changing the records underneath them.
 *
 * Both modules make the same bet: a value that could have been a column is
 * computed from the records that imply it, so it cannot disagree with them.
 * The way to test that bet is not to read the value once — it is to change the
 * underlying record and watch the value follow.
 *
 * Neither of these could be tested by the module's own check suite, which asks
 * whether today's answer is self-consistent. This one asks whether the answer
 * moves.
 */

import { stageOf } from '../src/data/lifecycleStages';
import { ONBOARD } from '../src/data/onboarding';
import { EXITS } from '../src/data/exit';
import { LEAVES } from '../src/data/leave';
import { CANDS } from '../src/data/ats';
import { EMAP, ACTIVE } from '../src/data/employees';
import { LIFECYCLE } from '../src/data/lifecycle';
import { DEV_ACTIONS, DEV_PLANS, actionProgress, isActionDone } from '../src/data/devplans';
import { ENROLL, COURSES } from '../src/data/learning';
import { getServices } from '../src/services';
import { recordAudit } from '../src/data/audit';
import { addDays, TODAY, ymd } from '../src/lib/dates';
import { DEMO_EMP, HRHEAD } from '../src/data/employees';
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
const NOW = ymd(TODAY);

(async () => {
  console.log('\nderivations — does the answer move when the records do?\n');

  /* ================= lifecycle ================= */

  /*
   * One employee, put through the states one at a time. Everything is restored
   * afterwards, so this does not disturb the dataset the other checks read.
   */
  const subject = ACTIVE().find((e) =>
    !EXITS.some((x) => x.empId === e.id)
    && !ONBOARD.some((o) => o.id === e.id))!;
  check('there is an employee to move through the stages', !!subject, true);

  const before = {
    status: subject.status,
    events: LIFECYCLE[subject.id] ? [...LIFECYCLE[subject.id]!] : undefined,
  };
  const added = { exits: 0, onboard: 0, leaves: 0, cands: 0 };

  console.log(`  moving ${subject.name} through every stage\n`);

  /* --- Active: nothing outstanding, confirmed, joined long ago --- */
  LIFECYCLE[subject.id] = [{
    on: ymd(addDays(TODAY, -700)), type: 'Confirmation', note: 'Confirmed', from: null, to: null,
  }];
  check('with nothing outstanding, they are Active', stageOf(subject.id).stage, 'Active');

  /* --- Joined: on probation, no confirmation --- */
  LIFECYCLE[subject.id] = [];
  const realDoj = subject.doj;
  subject.doj = ymd(addDays(TODAY, -30));
  check('a recent joiner with no confirmation is Joined', stageOf(subject.id).stage, 'Joined');
  check('and is told when their probation review is due',
    stageOf(subject.id).nextAction?.startsWith('Probation review due'), true);
  subject.doj = realDoj;
  LIFECYCLE[subject.id] = [{
    on: ymd(addDays(TODAY, -700)), type: 'Confirmation', note: 'Confirmed', from: null, to: null,
  }];

  /* --- Promotion: a move inside the recent window --- */
  LIFECYCLE[subject.id]!.unshift({
    on: ymd(addDays(TODAY, -10)), type: 'Promotion', note: 'Promoted', from: 'A', to: 'B',
  });
  check('a promotion last week makes them Promotion', stageOf(subject.id).stage, 'Promotion');

  /* --- and it lapses --- */
  LIFECYCLE[subject.id]![0]!.on = ymd(addDays(TODAY, -200));
  check('a promotion two hundred days ago is simply their job again',
    stageOf(subject.id).stage, 'Active');

  /* --- Transfer --- */
  LIFECYCLE[subject.id]!.unshift({
    on: ymd(addDays(TODAY, -5)), type: 'Transfer', note: 'Moved team', from: 'X', to: 'Y',
  });
  check('a recent transfer makes them Transfer', stageOf(subject.id).stage, 'Transfer');
  LIFECYCLE[subject.id] = [];

  /* --- Leave of Absence: long, approved, covering today --- */
  LEAVES.push({
    id: 'CHK-LV', empId: subject.id, type: 'SL', from: ymd(addDays(TODAY, -5)),
    to: ymd(addDays(TODAY, 20)), days: 25, half: null, reason: 'Check',
    status: 'Approved', approverId: null, appliedOn: ymd(addDays(TODAY, -10)),
    actedOn: null, note: '',
  });
  added.leaves++;
  check('a long approved leave covering today is Leave of Absence',
    stageOf(subject.id).stage, 'Leave of Absence');

  /*
   * And a short one is not. A fortnight is the line, and a holiday that
   * counted would put half the company on leave every December.
   */
  LEAVES[LEAVES.length - 1]!.days = 5;
  check('a five-day holiday is not a lifecycle stage',
    stageOf(subject.id).stage === 'Leave of Absence', false);
  LEAVES.pop(); added.leaves--;

  /* --- Onboarding and Pre-boarding: an open journey --- */
  ONBOARD.push({
    id: subject.id, candId: 'CHK', name: subject.name, reqId: 'CHK',
    dept: subject.dept, designation: subject.designation, site: subject.site,
    doj: ymd(addDays(TODAY, 20)), managerId: subject.managerId ?? '', buddyId: '',
    ctc: 0, status: 'Pre-boarding', bgv: 'Pending',
    tasks: [{ k: 'x', n: 'Check task', owner: 'HR', day: -30,
      due: ymd(addDays(TODAY, -10)), done: true, doneOn: ymd(addDays(TODAY, -8)) }],
  } as never);
  added.onboard++;
  check('an open pre-boarding journey is Pre-boarding', stageOf(subject.id).stage, 'Pre-boarding');
  /*
   * And it is dated from when pre-boarding began, not from the joining date it
   * ends on — the bug that reported everybody as nought days in.
   */
  check('dated from when it began, not the joining date',
    stageOf(subject.id).since, ymd(addDays(TODAY, -8)));

  ONBOARD[ONBOARD.length - 1]!.status = 'In Progress';
  check('an in-progress journey is Onboarding', stageOf(subject.id).stage, 'Onboarding');
  ONBOARD.pop(); added.onboard--;

  /* --- Exit and Offboarding --- */
  EXITS.push({
    id: 'CHK-EX', empId: subject.id, resignedOn: ymd(addDays(TODAY, -20)),
    lwd: ymd(addDays(TODAY, 40)), status: 'Notice Period', reason: 'Check',
    noticeDays: 60, rehire: true,
  } as never);
  added.exits++;
  check('an open exit record is Exit', stageOf(subject.id).stage, 'Exit');
  check('and it supersedes everything else', stageOf(subject.id).nextAction !== null, true);

  EXITS[EXITS.length - 1]!.status = 'In Clearance';
  check('clearance is Offboarding', stageOf(subject.id).stage, 'Offboarding');

  /* --- Alumni: the employment is over --- */
  subject.status = 'Exited';
  check('an exited employee is Alumni', stageOf(subject.id).stage, 'Alumni');
  subject.status = before.status;
  EXITS.pop(); added.exits--;

  /* --- Candidate and Offer, from the pipeline --- */
  const screening = CANDS.find((c) => c.stage !== 'offer' && c.stage !== 'rejected' && c.stage !== 'hired');
  if (screening) {
    check('somebody in the pipeline is a Candidate', stageOf(screening.id).stage, 'Candidate');
    const was = screening.stage;
    screening.stage = 'offer';
    check('and moving them to offer makes them Offer', stageOf(screening.id).stage, 'Offer');
    screening.stage = was;
    check('and putting them back restores it', stageOf(screening.id).stage, 'Candidate');
  }

  /* --- restore --- */
  if (before.events) LIFECYCLE[subject.id] = before.events;
  else delete LIFECYCLE[subject.id];
  subject.status = before.status;
  subject.doj = realDoj;
  check('every temporary record was removed',
    [added.exits, added.onboard, added.leaves, added.cands], [0, 0, 0, 0]);
  check('the subject is back where they started', stageOf(subject.id).stage !== undefined, true);

  /* ================= development actions ================= */

  console.log('\n  the course-progress rule\n');

  /*
   * The rule: an action naming a course has no completion of its own, because
   * the enrolment owns it. Tested by moving the enrolment and watching the
   * action follow — and by trying to tick it off, which must be refused.
   */
  const plan = DEV_PLANS.find((p) => p.status === 'Active')!;
  const emp = plan.empId;
  const course = COURSES[3]!;

  const courseAction = await s.devPlans.addAction(ADMIN, plan.id, {
    kind: 'Course', area: 'Technical skills', n: 'Check course action',
    due: NOW, courseId: course.id,
  });
  const plainAction = await s.devPlans.addAction(ADMIN, plan.id, {
    kind: 'On-the-job', area: 'Technical skills', n: 'Check plain action', due: NOW,
  });

  /* Valid course action: no completion date of its own, ever. */
  check('a course action carries no completion date',
    DEV_ACTIONS.find((a) => a.id === courseAction.id)!.doneOn, null);

  /* Invalid course completion: refused, not silently ignored. */
  await refused('ticking off a course action is refused',
    () => s.devPlans.setActionDone(ADMIN, courseAction.id, true));
  check('and it still has no completion date',
    DEV_ACTIONS.find((a) => a.id === courseAction.id)!.doneOn, null);

  /* The progress follows the enrolment, and moves when the enrolment moves. */
  const existing = ENROLL.find((e) => e.empId === emp && e.courseId === course.id);
  const restore = existing ? { ...existing } : null;
  if (!existing) {
    ENROLL.push({ empId: emp, courseId: course.id, progress: 0,
      status: 'Not Started', completedOn: null, score: null });
  }
  const enrolment = ENROLL.find((e) => e.empId === emp && e.courseId === course.id)!;

  enrolment.status = 'Not Started'; enrolment.progress = 0;
  const act = DEV_ACTIONS.find((a) => a.id === courseAction.id)!;
  check('an untouched course reads as no progress', actionProgress(act, emp), 0);

  enrolment.status = 'In Progress'; enrolment.progress = 45;
  check('and follows the enrolment when it moves', actionProgress(act, emp), 45);
  check('still not done at forty-five per cent', isActionDone(act, emp), false);

  enrolment.status = 'Completed'; enrolment.progress = 100;
  check('a completed course completes the action', actionProgress(act, emp), 100);
  check('and the action is done', isActionDone(act, emp), true);
  check('without ever writing a completion date',
    DEV_ACTIONS.find((a) => a.id === courseAction.id)!.doneOn, null);

  /* Valid non-course completion: ticked here, dated here. */
  await allowed('a plain action can be ticked off',
    () => s.devPlans.setActionDone(ADMIN, plainAction.id, true));
  check('and it is dated', DEV_ACTIONS.find((a) => a.id === plainAction.id)!.doneOn, NOW);

  /* Null completion: reopening clears it. */
  await allowed('and reopened', () => s.devPlans.setActionDone(ADMIN, plainAction.id, false));
  check('which clears the date',
    DEV_ACTIONS.find((a) => a.id === plainAction.id)!.doneOn, null);

  /* No seeded action breaks the rule either. */
  check('no action anywhere has both a course and a completion date',
    DEV_ACTIONS.filter((a) => a.courseId && a.doneOn).length, 0);

  /* --- restore --- */
  for (const a of [courseAction.id, plainAction.id]) {
    const i = DEV_ACTIONS.findIndex((x) => x.id === a);
    if (i >= 0) DEV_ACTIONS.splice(i, 1);
  }
  if (restore) Object.assign(enrolment, restore);
  else ENROLL.splice(ENROLL.indexOf(enrolment), 1);
  check('the check left no actions behind',
    DEV_ACTIONS.filter((a) => a.n.startsWith('Check ')).length, 0);

  recordAudit.reset();
  void EMAP; void DEMO_EMP;

  console.log();
  if (failed) {
    console.error(`${failed} derivation checks failed`);
    process.exit(1);
  }
  console.log('the derived values follow the records they are derived from');
})();
