/*
 * Last in the RNG chain, after the software estate.
 */
import './software';

import { sortBy } from '../lib/collections';
import { addDays, daysBetween, parseYmd, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE, EMAP } from './employees';
import { COURSES, ENROLL } from './learning';
import { JOB_LEVELS, titleForEmployee } from './jobtitles';
import type { JobLevel } from './jobtitles';

/**
 * Development plans — where somebody is trying to get to, and what will get
 * them there.
 *
 * **This is not the goals module with a longer date on it.** A goal is what
 * you owe this cycle and it is scored; a development plan is the next role and
 * nobody is marked on it. They have different horizons, different owners — the
 * employee writes the plan, the manager endorses it — and different
 * consequences for missing them. Folding one into the other gives a screen
 * where career conversations compete with quarterly delivery for attention,
 * and delivery wins every time.
 *
 * The other rule: **an action that names a course does not keep its own
 * progress.** It reads the enrolment in the learning module. Two copies of
 * "how far through the AWS course are you" would disagree within a fortnight,
 * and the plan is the copy nobody updates.
 */

export const DEV_AREAS = [
  'Technical skills', 'Leadership', 'Communication', 'Domain knowledge',
  'Process & delivery', 'Commercial',
] as const;
export type DevArea = (typeof DEV_AREAS)[number];

export const ACTION_KINDS = [
  'Course', 'Certification', 'Stretch assignment', 'Mentoring', 'On-the-job', 'Reading',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const PLAN_STATUSES = ['Draft', 'Active', 'Completed', 'Cancelled'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const HORIZONS = [6, 12, 24] as const;
export type Horizon = (typeof HORIZONS)[number];

export interface DevAction {
  id: string;
  planId: string;
  kind: ActionKind;
  area: DevArea;
  n: string;
  /** Set only where `kind` is Course or Certification — the enrolment owns the progress. */
  courseId: string | null;
  due: string;
  /** Null while it is outstanding. Ignored for a course action, which reads the enrolment. */
  doneOn: string | null;
  note: string;
}

export interface DevPlan {
  id: string;
  empId: string;
  /** What they said they are aiming at, in their words. */
  aspiration: string;
  targetLevel: JobLevel | null;
  horizonMonths: Horizon;
  from: string;
  to: string;
  status: PlanStatus;
  /** Somebody inside the company who has agreed to coach them. */
  mentorId: string | null;
  focus: DevArea[];
  strengths: string;
  createdOn: string;
  /** The next conversation about it. Overdue is the figure a manager is judged on. */
  reviewOn: string;
  endorsedOn: string | null;
  endorsedById: string | null;
  notes: string;
}

export const DEV_PLANS: DevPlan[] = [];
export const DEV_ACTIONS: DevAction[] = [];

/* ---------------- what a plan is worth ---------------- */

const enrolmentFor = (empId: string, courseId: string) =>
  ENROLL.find((e) => e.empId === empId && e.courseId === courseId);

/**
 * How far through one action somebody is, as a percentage.
 *
 * A course action reads the enrolment rather than a field of its own. That is
 * the whole reason `courseId` exists: without it the plan would carry a second
 * progress number, and the one nobody touches is always the one on screen.
 */
export function actionProgress(a: DevAction, empId: string): number {
  if (a.courseId) {
    const en = enrolmentFor(empId, a.courseId);
    if (!en) return 0;
    return en.status === 'Completed' ? 100 : en.progress;
  }
  return a.doneOn ? 100 : 0;
}

export const isActionDone = (a: DevAction, empId: string): boolean =>
  actionProgress(a, empId) >= 100;

export const actionsFor = (planId: string) =>
  sortBy(DEV_ACTIONS.filter((a) => a.planId === planId), (a) => a.due);

/** The mean of the actions, which is zero rather than NaN for an empty plan. */
export function planProgress(p: DevPlan): number {
  const acts = actionsFor(p.id);
  if (!acts.length) return 0;
  return Math.round(acts.reduce((n, a) => n + actionProgress(a, p.empId), 0) / acts.length);
}

export const overdueActions = (p: DevPlan, asOf = ymd(TODAY)) =>
  actionsFor(p.id).filter((a) => a.due < asOf && !isActionDone(a, p.empId));

/**
 * A plan is only real once somebody has agreed to it.
 *
 * A draft nobody endorsed is a wish, and counting wishes as coverage is how a
 * development programme reports 90% and changes nothing.
 */
export const isEndorsed = (p: DevPlan): boolean => !!p.endorsedOn;

export const isReviewDue = (p: DevPlan, asOf = ymd(TODAY)): boolean =>
  p.status === 'Active' && p.reviewOn <= asOf;

export const planFor = (empId: string) =>
  DEV_PLANS.find((p) => p.empId === empId && p.status !== 'Cancelled');

/** The level above the one somebody holds, or null at the top of the ladder. */
export function nextLevel(empId: string): JobLevel | null {
  const t = titleForEmployee(empId);
  if (!t) return null;
  const i = JOB_LEVELS.findIndex((l) => l.id === t.level);
  return i >= 0 && i < JOB_LEVELS.length - 1 ? JOB_LEVELS[i + 1].id : null;
}

/* ---------------- the seed ---------------- */

/**
 * What people put on a plan, by the area it develops.
 *
 * Written as things somebody would actually say in a conversation with their
 * manager. A template list of "improve communication skills" produces a module
 * that looks complete and reads as filler.
 */
const TEMPLATES: Record<DevArea, { kind: ActionKind; n: string; course?: string }[]> = {
  'Technical skills': [
    { kind: 'Course', n: 'Work through Advanced React Patterns', course: 'C4' },
    { kind: 'Certification', n: 'Sit the AWS Solutions Architect exam', course: 'C5' },
    { kind: 'Certification', n: 'Prepare for and sit the CKA', course: 'C6' },
    { kind: 'Course', n: 'Finish SQL & Data Analysis Fundamentals', course: 'C9' },
    { kind: 'On-the-job', n: 'Own the design review for one service this quarter' },
    { kind: 'On-the-job', n: 'Take the on-call rota for a full cycle' },
  ],
  Leadership: [
    { kind: 'Course', n: 'Complete the First-Time Manager Programme', course: 'C7' },
    { kind: 'Mentoring', n: 'Meet the assigned mentor monthly' },
    { kind: 'Stretch assignment', n: 'Run the standup and sprint planning for a quarter' },
    { kind: 'Stretch assignment', n: 'Mentor one new joiner through their first 90 days' },
    { kind: 'On-the-job', n: 'Sit in on two interview panels and write the debrief' },
  ],
  Communication: [
    { kind: 'Course', n: 'Giving & Receiving Feedback', course: 'C8' },
    { kind: 'Course', n: 'Effective Business Writing', course: 'C12' },
    { kind: 'Stretch assignment', n: 'Present at one company all-hands' },
    { kind: 'On-the-job', n: 'Write the release notes for two releases' },
  ],
  'Domain knowledge': [
    { kind: 'Reading', n: 'Read the BFSI compliance primer and summarise it for the team' },
    { kind: 'On-the-job', n: 'Shadow two client calls a month' },
    { kind: 'Mentoring', n: 'Monthly session with a domain lead' },
  ],
  'Process & delivery': [
    { kind: 'Stretch assignment', n: 'Own one release end to end, including the rollback plan' },
    { kind: 'On-the-job', n: 'Run the retrospective for two sprints' },
    { kind: 'Reading', n: 'Work through the internal delivery playbook' },
  ],
  Commercial: [
    { kind: 'Course', n: 'Consultative Selling for BFSI', course: 'C10' },
    { kind: 'On-the-job', n: 'Build the estimate for one proposal' },
    { kind: 'Mentoring', n: 'Quarterly session with the account lead' },
  ],
};

/** What somebody at this level is usually reaching for. */
const ASPIRATION: Record<string, string> = {
  L2: 'Grow into a solid mid-level contributor',
  L3: 'Become a senior individual contributor',
  L4: 'Move into a lead role',
  L5: 'Step up to people management',
  L6: 'Take on a wider directorship',
  L7: 'Move into an executive seat',
  L8: 'Broaden the executive remit',
};

(function genDevPlans() {
  const mentorPool = ACTIVE().filter((e) => /Manager|Head|Lead|Director|Chief|VP/i.test(e.designation));

  ACTIVE().forEach((e) => {
    /*
     * Somebody who joined last month has not had the conversation yet, and a
     * dataset where every joiner already holds a signed development plan is
     * the kind of detail that makes a demo unbelievable.
     */
    const tenureDays = daysBetween(e.doj, ymd(TODAY));
    if (tenureDays < 120 || !chance(0.62)) return;

    const target = nextLevel(e.id);
    const managerial = target ? ['L6', 'L7', 'L8'].includes(target) : false;

    /*
     * The focus follows the step being taken. Somebody moving to L6 is moving
     * into management, and a plan for that step that is all technical courses
     * is the single most common way these documents fail.
     */
    const pool: DevArea[] = managerial
      ? ['Leadership', 'Communication', 'Process & delivery', 'Commercial']
      : ['Technical skills', 'Domain knowledge', 'Process & delivery', 'Communication'];
    const focus = sortBy(pool.filter(() => chance(0.55)), (a) => a);
    if (!focus.length) focus.push(pool[0]);

    const horizon = pick([...HORIZONS]);
    const from = ymd(addDays(TODAY, -ri(20, 300)));
    const to = ymd(addDays(parseYmd(from), horizon * 30));

    /* Most plans are running; a few are drafts nobody has signed off yet. */
    const drafted = chance(0.14);
    const finished = !drafted && to < ymd(TODAY) && chance(0.5);
    const status: PlanStatus = drafted ? 'Draft' : finished ? 'Completed' : 'Active';

    const plan: DevPlan = {
      id: uid('IDP'),
      empId: e.id,
      aspiration: ASPIRATION[target ?? ''] ?? 'Deepen expertise in the current role',
      targetLevel: target,
      horizonMonths: horizon,
      from,
      to,
      status,
      mentorId: chance(0.55) && mentorPool.length
        ? pick(mentorPool.filter((m) => m.id !== e.id)).id
        : null,
      focus,
      strengths: '',
      createdOn: from,
      /* Reviewed quarterly, so some are due and a few are overdue. */
      reviewOn: ymd(addDays(TODAY, ri(-45, 80))),
      endorsedOn: drafted ? null : ymd(addDays(parseYmd(from), ri(1, 14))),
      endorsedById: drafted ? null : e.managerId,
      notes: '',
    };
    DEV_PLANS.push(plan);

    /* Three to six actions, drawn from the areas the plan is actually about. */
    const wanted = ri(3, 6);
    const seen = new Set<string>();
    for (let i = 0; i < wanted * 3 && seen.size < wanted; i++) {
      const area = pick(focus);
      const t = pick(TEMPLATES[area]);
      if (seen.has(t.n)) continue;
      seen.add(t.n);

      const due = ymd(addDays(parseYmd(from), ri(20, horizon * 30)));
      const course = t.course && COURSES.some((c) => c.id === t.course) ? t.course : null;
      DEV_ACTIONS.push({
        id: uid('IDA'),
        planId: plan.id,
        kind: t.kind,
        area,
        n: t.n,
        courseId: course,
        due,
        /*
         * A course action's progress comes from the enrolment, so it never
         * carries a completion date of its own — writing one would create the
         * second copy this module exists to avoid.
         */
        doneOn: course ? null : (due < ymd(TODAY) && chance(0.62)
          ? ymd(addDays(parseYmd(due), -ri(0, 20)))
          : null),
        note: '',
      });
    }
  });

  /* A finished plan has finished actions, or it was not finished. */
  DEV_PLANS.filter((p) => p.status === 'Completed').forEach((p) => {
    actionsFor(p.id).forEach((a) => {
      if (a.courseId || a.doneOn) return;
      a.doneOn = ymd(addDays(parseYmd(p.to), -ri(0, 30)));
    });
  });

  /* Nothing was completed in the future. */
  DEV_ACTIONS.forEach((a) => {
    if (a.doneOn && a.doneOn > ymd(TODAY)) a.doneOn = ymd(TODAY);
  });
})();

/* ---------------- the figures a programme is read for ---------------- */

export function devKPI(scope: DevPlan[] = DEV_PLANS, asOf = ymd(TODAY)) {
  const live = scope.filter((p) => p.status === 'Active');
  const actions = scope.flatMap((p) =>
    actionsFor(p.id).map((a) => ({ a, empId: p.empId })));
  return {
    plans: scope.length,
    active: live.length,
    drafts: scope.filter((p) => p.status === 'Draft').length,
    completed: scope.filter((p) => p.status === 'Completed').length,
    /* Endorsement is the line between a plan and a wish. */
    endorsed: scope.filter(isEndorsed).length,
    reviewsDue: live.filter((p) => isReviewDue(p, asOf)).length,
    actions: actions.length,
    actionsDone: actions.filter(({ a, empId }) => isActionDone(a, empId)).length,
    overdue: live.reduce((n, p) => n + overdueActions(p, asOf).length, 0),
    withMentor: live.filter((p) => p.mentorId).length,
    /* The share of the company with a live, endorsed plan — the real coverage. */
    coverage: ACTIVE().length
      ? Math.round((live.filter(isEndorsed).length / ACTIVE().length) * 100)
      : 0,
  };
}

/** How many live plans name each area, for the "what are people working on" view. */
export function focusSpread(scope: DevPlan[] = DEV_PLANS) {
  const live = scope.filter((p) => p.status === 'Active');
  return DEV_AREAS.map((area) => ({
    area,
    plans: live.filter((p) => p.focus.includes(area)).length,
  })).filter((r) => r.plans > 0);
}

export const mentorLoad = () => {
  const counts = new Map<string, number>();
  DEV_PLANS.filter((p) => p.status === 'Active' && p.mentorId).forEach((p) => {
    counts.set(p.mentorId!, (counts.get(p.mentorId!) ?? 0) + 1);
  });
  return sortBy(
    [...counts].map(([id, n]) => ({ mentorId: id, name: EMAP[id]?.name ?? id, mentees: n })),
    (r) => -r.mentees,
  );
};
