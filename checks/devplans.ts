/**
 * A development plan is the employee's, and its course actions are Learning's.
 *
 * Two claims this module makes that nothing else in the product makes, so both
 * are tested hard. First, the employee genuinely writes here — a manager may
 * endorse their plan and may not rewrite it, which inverts the usual ladder and
 * is the sort of rule that quietly reverts. Second, an action that names a
 * course has no state of its own: its progress is the enrolment's, and ticking
 * it off is refused rather than silently creating a second copy.
 */

import { getServices } from '../src/services';
import {
  DEV_ACTIONS, DEV_PLANS, actionProgress, actionsFor, isActionDone, planProgress,
} from '../src/data/devplans';
import { ENROLL } from '../src/data/learning';
import { ACTIVE, DEMO_EMP, DEMO_MGR, EMAP, HRHEAD } from '../src/data/employees';
import { recordAudit } from '../src/data/audit';
import { visibleIds } from '../src/state/rbac';
import { TODAY, ymd } from '../src/lib/dates';
import type { Caller, DevPlanDraft } from '../src/services';

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
const NOW = ymd(TODAY);

/*
 * The employee this runs as needs a plan of their own to exercise the
 * ownership rules. The demo employee may or may not have drawn one, so the
 * check picks somebody who has — and says who, rather than passing vacuously.
 */
const withPlan = DEV_PLANS.find((p) => p.status === 'Active' && EMAP[p.empId]);
const OWNER: Caller = { role: 'employee', meId: withPlan?.empId ?? DEMO_EMP.id };

(async () => {
  console.log(`\n${DEV_PLANS.length} plans, ${DEV_ACTIONS.length} actions`);
  console.log(`  running the ownership checks as ${EMAP[OWNER.meId]?.name ?? OWNER.meId}\n`);

  check('there is a plan to run the ownership checks against', !!withPlan, true);
  if (!withPlan) { process.exit(1); }

  /* ---- a course action has no state of its own ---- */

  const courseActions = DEV_ACTIONS.filter((a) => a.courseId);
  check('some actions track a course', courseActions.length > 0, true);
  check('no course action carries its own completion date',
    courseActions.filter((a) => a.doneOn).length, 0);

  /*
   * The figure on screen must be the enrolment's, not a number that merely
   * looks like it. Recomputed here from the enrolment rather than compared to
   * itself — comparing a function to itself is how this kind of check passes
   * while the screen shows something else.
   */
  const mismatched = DEV_PLANS.flatMap((p) =>
    actionsFor(p.id).filter((a) => {
      if (!a.courseId) return false;
      const en = ENROLL.find((e) => e.empId === p.empId && e.courseId === a.courseId);
      const want = !en ? 0 : en.status === 'Completed' ? 100 : en.progress;
      return actionProgress(a, p.empId) !== want;
    }));
  check('a course action reports exactly what the enrolment says', mismatched.length, 0);

  check('plan progress is the mean of its actions',
    DEV_PLANS.filter((p) => {
      const acts = actionsFor(p.id);
      const want = acts.length
        ? Math.round(acts.reduce((n, a) => n + actionProgress(a, p.empId), 0) / acts.length)
        : 0;
      return planProgress(p) !== want;
    }).length, 0);

  check('nothing was completed in the future',
    DEV_ACTIONS.filter((a) => a.doneOn && a.doneOn > NOW).length, 0);
  check('every action belongs to a plan that exists',
    DEV_ACTIONS.filter((a) => !DEV_PLANS.some((p) => p.id === a.planId)).length, 0);
  check('nobody holds two live plans',
    DEV_PLANS.filter((p) => p.status !== 'Cancelled')
      .filter((p, _i, arr) => arr.filter((x) => x.empId === p.empId).length > 1).length, 0);
  check('nobody mentors themselves',
    DEV_PLANS.filter((p) => p.mentorId === p.empId).length, 0);
  check('every seeded plan belongs to an employee',
    DEV_PLANS.filter((p) => !EMAP[p.empId]).length, 0);

  /* ---- what the figures claim ---- */

  const stats = await s.devPlans.stats(ADMIN);
  check('the plan count matches', stats.plans, DEV_PLANS.length);
  check('endorsed counts only endorsed plans',
    stats.endorsed, DEV_PLANS.filter((p) => p.endorsedOn).length);

  /*
   * Coverage is the claim a development programme is judged on, so it must be
   * endorsed live plans over headcount — not drafts, which would let the
   * figure be inflated by writing documents nobody agreed to.
   */
  const wantCoverage = Math.round(
    (DEV_PLANS.filter((p) => p.status === 'Active' && p.endorsedOn).length / ACTIVE().length) * 100);
  check('coverage counts endorsed live plans over headcount', stats.coverage, wantCoverage);
  check('a draft is never counted as coverage',
    DEV_PLANS.some((p) => p.status === 'Draft' && p.endorsedOn), false);

  check('actions done matches the actions',
    stats.actionsDone,
    DEV_PLANS.flatMap((p) => actionsFor(p.id).filter((a) => isActionDone(a, p.empId))).length);

  const focus = await s.devPlans.focus(ADMIN);
  check('every focus row counts at least one plan',
    focus.filter((r) => r.plans < 1).length, 0);

  /* ---- who sees whom ---- */

  const all = await s.devPlans.list(ADMIN);
  check('an administrator sees every plan', all.length, DEV_PLANS.length);

  const mgrRows = await s.devPlans.list(MANAGER);
  const line = new Set([...visibleIds('manager', DEMO_MGR.id), DEMO_MGR.id]);
  check('a manager sees only their line',
    mgrRows.filter((r) => !line.has(r.plan.empId)).length, 0);

  const empRows = await s.devPlans.list(OWNER);
  check('an employee sees only their own',
    empRows.filter((r) => r.plan.empId !== OWNER.meId).length, 0);

  const someoneElse = all.find((r) => r.plan.empId !== OWNER.meId)!;
  await refused("an employee cannot open somebody else's plan",
    () => s.devPlans.get(OWNER, someoneElse.plan.id));
  await allowed('but can open their own', () => s.devPlans.get(OWNER, withPlan.id));

  const nothing = await s.devPlans.get(ADMIN, 'IDP-does-not-exist');
  check('an id that does not exist is null, not a refusal', nothing, null);

  const mine = await s.devPlans.mine(OWNER);
  check('mine returns the plan that is theirs', mine?.plan.empId, OWNER.meId);

  await refused('an employee cannot see who is mentoring whom',
    () => s.devPlans.mentors(OWNER));

  /* ---- the ownership rule ---- */

  /*
   * The inversion. A manager may endorse and may not rewrite, which is the
   * opposite of every other module here and therefore the rule most likely to
   * be undone by somebody tidying up.
   */
  await refused("a manager cannot rewrite somebody's aspiration",
    () => s.devPlans.update(MANAGER, withPlan.id, { aspiration: 'Something they never said' }));
  await allowed('but the person themselves can',
    () => s.devPlans.update(OWNER, withPlan.id, { strengths: 'Set by the check' }));

  await refused('nobody can endorse their own plan',
    () => s.devPlans.endorse(OWNER, withPlan.id));

  /* ---- creating ---- */

  const spare = ACTIVE().find((e) => !DEV_PLANS.some((p) => p.empId === e.id));
  check('there is somebody without a plan to test creation', !!spare, true);
  const SPARE: Caller = { role: 'employee', meId: spare!.id };

  const base = (over: Partial<DevPlanDraft> = {}): DevPlanDraft => ({
    aspiration: 'Check aspiration',
    horizonMonths: 12,
    focus: ['Technical skills'],
    ...over,
  });

  await refused('a plan with no aspiration is refused',
    () => s.devPlans.create(SPARE, base({ aspiration: '  ' })));
  await refused('a plan with no focus area is refused',
    () => s.devPlans.create(SPARE, base({ focus: [] })));
  await refused('an unknown horizon is refused',
    () => s.devPlans.create(SPARE, base({ horizonMonths: 9 as never })));
  await refused('a mentor who does not exist is refused',
    () => s.devPlans.create(SPARE, base({ mentorId: 'EMP-nobody' })));
  await refused('you cannot mentor yourself',
    () => s.devPlans.create(SPARE, base({ mentorId: spare!.id })));
  await refused("a manager cannot raise a plan on somebody else's behalf",
    () => s.devPlans.create(MANAGER, base({ empId: spare!.id })));

  const fresh = await s.devPlans.create(SPARE, base());
  check('a new plan starts as a draft', fresh.status, 'Draft');
  check('and is not endorsed', fresh.endorsedOn, null);
  await refused('a second live plan is refused', () => s.devPlans.create(SPARE, base()));
  await refused('a plan cannot be made active without an endorsement',
    () => s.devPlans.setStatus(SPARE, fresh.id, 'Active'));

  /* ---- endorsement ---- */

  await refused('a plan with no actions cannot be endorsed',
    () => s.devPlans.endorse(ADMIN, fresh.id));

  await allowed('the owner can add an action', () => s.devPlans.addAction(SPARE, fresh.id, {
    kind: 'On-the-job', area: 'Technical skills', n: 'Check action', due: NOW,
  }));
  await refused('an action with no name is refused',
    () => s.devPlans.addAction(SPARE, fresh.id, {
      kind: 'On-the-job', area: 'Technical skills', n: ' ', due: NOW,
    }));
  await refused('an action naming a course that does not exist is refused',
    () => s.devPlans.addAction(SPARE, fresh.id, {
      kind: 'Course', area: 'Technical skills', n: 'Check course', due: NOW, courseId: 'C-nope',
    }));

  await allowed('now it can be endorsed', () => s.devPlans.endorse(ADMIN, fresh.id));
  const endorsed = DEV_PLANS.find((p) => p.id === fresh.id)!;
  check('endorsing makes it active', endorsed.status, 'Active');
  check('and records who endorsed it', endorsed.endorsedById, HRHEAD.id);

  /*
   * The rule that makes endorsement mean something: change what the plan is
   * for and the signature does not carry over.
   */
  await s.devPlans.update(SPARE, fresh.id, { aspiration: 'Something quite different' });
  const rewritten = DEV_PLANS.find((p) => p.id === fresh.id)!;
  check('rewriting the aspiration withdraws the endorsement', rewritten.endorsedOn, null);
  check('and puts the plan back to a draft', rewritten.status, 'Draft');

  await s.devPlans.endorse(ADMIN, fresh.id);
  await s.devPlans.update(SPARE, fresh.id, { notes: 'A note changes nothing material' });
  check('an immaterial change keeps the endorsement',
    !!DEV_PLANS.find((p) => p.id === fresh.id)!.endorsedOn, true);

  /* ---- ticking things off ---- */

  const own = DEV_ACTIONS.find((a) => a.planId === fresh.id && !a.courseId)!;
  await refused('a manager cannot tick off somebody else’s action',
    () => s.devPlans.setActionDone(MANAGER, own.id, true));
  await allowed('the owner can', () => s.devPlans.setActionDone(SPARE, own.id, true));
  check('ticking it dates it', DEV_ACTIONS.find((a) => a.id === own.id)!.doneOn, NOW);

  const courseAction = await s.devPlans.addAction(SPARE, fresh.id, {
    kind: 'Course', area: 'Technical skills', n: 'Check course action', due: NOW, courseId: 'C4',
  });
  await refused('a course action cannot be ticked off here',
    () => s.devPlans.setActionDone(SPARE, courseAction.id, true));
  check('and it still carries no completion date of its own',
    DEV_ACTIONS.find((a) => a.id === courseAction.id)!.doneOn, null);

  /* ---- the audit trail ---- */

  const detail = (await s.devPlans.get(ADMIN, fresh.id))!;
  const actions = detail.history.map((h) => h.action);
  check('creating is recorded', actions.includes('dev_plan.created'), true);
  check('endorsing is recorded', actions.includes('dev_plan.endorsed'), true);
  check('a withdrawn endorsement is recorded',
    actions.includes('dev_plan.endorsement_withdrawn'), true);
  check('adding an action is recorded', actions.includes('dev_plan.action_added'), true);
  check('the trail is newest first',
    detail.history.every((h, i) => i === 0 || detail.history[i - 1].at >= h.at), true);
  check('every entry names who did it',
    detail.history.filter((h) => !h.actorLabel).length, 0);

  /* ---- clean up ---- */

  for (const a of DEV_ACTIONS.filter((x) => x.planId === fresh.id)) {
    DEV_ACTIONS.splice(DEV_ACTIONS.indexOf(a), 1);
  }
  DEV_PLANS.splice(DEV_PLANS.findIndex((p) => p.id === fresh.id), 1);
  withPlan.strengths = '';
  check('the check left no plans behind',
    DEV_PLANS.some((p) => p.id === fresh.id), false);
  check('and no orphaned actions',
    DEV_ACTIONS.filter((a) => !DEV_PLANS.some((p) => p.id === a.planId)).length, 0);
  recordAudit.reset();

  console.log();
  if (failed) {
    console.error(`${failed} development-plan checks failed`);
    process.exit(1);
  }
  console.log('the plan belongs to the person it is about');
})();
