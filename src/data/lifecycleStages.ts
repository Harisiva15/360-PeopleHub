/*
 * Last in the RNG chain, after the audit trail.
 */
import './audit';

import { sortBy } from '../lib/collections';
import { addDays, daysBetween, parseYmd, TODAY, ymd } from '../lib/dates';
import { chance, ri, uid } from '../lib/rng';
import { ACTIVE, EMAP, EMP } from './employees';
import { LIFECYCLE } from './lifecycle';
import { ONBOARD } from './onboarding';
import { EXITS } from './exit';
import { CANDS, REQS } from './ats';
import { LEAVES } from './leave';

/**
 * Where somebody is in their employment.
 *
 * **The stage is derived, never stored.** Every one of these is already
 * knowable from a record the product keeps: an onboarding row says
 * pre-boarding or onboarding, an exit row says notice or clearance, the
 * employee's own status says active or alumni. Storing it again would create
 * a field that can disagree with the records it summarises — and it would,
 * because six modules write those records and only this one would remember to
 * update the copy.
 *
 * So `stageOf` reads them. The cost is that the stage cannot be set directly;
 * the benefit is that it cannot be wrong.
 */
export const LIFECYCLE_STAGES = [
  'Candidate', 'Offer', 'Pre-boarding', 'Joined', 'Onboarding', 'Active',
  'Promotion', 'Transfer', 'Leave of Absence', 'Exit', 'Offboarding', 'Alumni',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** The stages an ordinary employment passes through, in order, for the timeline. */
export const CORE_PATH: LifecycleStage[] = [
  'Offer', 'Pre-boarding', 'Joined', 'Onboarding', 'Active', 'Exit', 'Alumni',
];

export interface LifecycleTask {
  id: string;
  empId: string;
  stage: LifecycleStage;
  n: string;
  /** A team rather than a person, where the template names one. */
  owner: string;
  assigneeId: string | null;
  due: string;
  done: boolean;
  doneOn: string | null;
  note: string;
}

export const LIFECYCLE_TASKS: LifecycleTask[] = [];

/** Where somebody stands, and since when. */
export interface Standing {
  empId: string;
  stage: LifecycleStage;
  /** The day they entered it. */
  since: string;
  daysInStage: number;
  /** The one thing that should happen next, or null when nothing is pending. */
  nextAction: string | null;
}

const reqOf = (id: string) => REQS.find((r) => r.id === id);

/** The most recent lifecycle event of a kind, if there is one. */
const lastEvent = (empId: string, type: string) =>
  sortBy((LIFECYCLE[empId] ?? []).filter((e) => e.type === type), (e) => e.on, 'desc')[0];

/**
 * Somebody's current stage, read off the records that already exist.
 *
 * Ordered by precedence rather than by the path: leaving supersedes being
 * active, and being on long leave supersedes a promotion three months ago.
 * The first match wins, so the order of these branches is the rule.
 */
export function stageOf(empId: string, asOf: string = ymd(TODAY)): Standing {
  const e = EMAP[empId];
  /*
   * `since` is floored at today, once here rather than at each branch.
   *
   * Several of the dates these branches read are deliberately forward-looking:
   * a joining date, a last working day. Somebody in clearance whose last day
   * is next month, or pre-boarding for a joiner six weeks out, would otherwise
   * be reported as having entered the stage on a day that has not happened.
   * They are in the stage now — the record exists now, which is the evidence —
   * and nothing in the data says when it began, so today is the honest floor.
   */
  const say = (stage: LifecycleStage, on: string, nextAction: string | null): Standing => {
    const since = on > asOf ? asOf : on;
    return { empId, stage, since, daysInStage: Math.max(0, daysBetween(since, asOf)), nextAction };
  };

  /* Still in the pipeline: an application, with or without an offer out. */
  const cand = CANDS.find((c) => c.id === empId);
  if (cand) {
    return cand.stage === 'offer'
      ? say('Offer', cand.appliedOn, 'Awaiting a decision on the offer')
      : say('Candidate', cand.appliedOn, `At ${cand.stage}`);
  }

  /* Gone: the employment is over and the settlement is done. */
  const exit = EXITS.find((x) => x.empId === empId);
  if (e?.status === 'Exited') {
    return say('Alumni', e.dol ?? exit?.lwd ?? asOf, null);
  }

  /* Leaving: still employed, and on the way out. */
  if (exit) {
    return exit.status === 'In Clearance'
      ? say('Offboarding', exit.lwd, 'Complete clearance and settle dues')
      : say('Exit', exit.resignedOn, `Last working day ${exit.lwd}`);
  }

  /*
   * Joining: an onboarding record that has not finished.
   *
   * Matched by id, because a joiner is not an employee yet — they have an
   * onboarding row and no payroll record, which is exactly what pre-boarding
   * means. Matching on name looked reasonable and could never fire: there is
   * no employee to have the same name as.
   */
  const onb = ONBOARD.find((o) => o.id === empId);
  if (onb && onb.status !== 'Completed') {
    const pending = onb.tasks.filter((t) => !t.done).length;
    if (onb.status !== 'Pre-boarding') {
      return say('Onboarding', onb.doj, `${pending} onboarding task(s) outstanding`);
    }
    /*
     * Pre-boarding starts when the offer is accepted, not on the joining
     * date — the joining date is what it ends on, and it is in the future for
     * most of these people. Dating the stage from it said everybody had been
     * pre-boarding for zero days, which is the one figure the column exists
     * to give. The checklist's own first completed task is the record of when
     * it actually began; its earliest due date is the fallback.
     *
     * For somebody joining more than a month out, even that fallback is still
     * ahead, and the answer is today: the record exists now, which is evidence
     * they are in the stage now, and there is no evidence of an earlier date.
     * A forward-dated "in this stage since" would be a claim about a day that
     * has not happened.
     */
    const doneOn = sortBy(onb.tasks.map((t) => t.doneOn).filter(Boolean) as string[], (d) => d);
    const due = sortBy(onb.tasks.map((t) => t.due), (d) => d);
    const began = doneOn[0] ?? due[0] ?? onb.doj;
    return say('Pre-boarding', began,
      `${pending} joining task(s) before day one`);
  }

  /*
   * On long leave. A fortnight is the line: shorter than that is a holiday,
   * and calling a holiday a lifecycle stage would put half the company in it
   * every December.
   */
  const longLeave = LEAVES.find((l) =>
    l.empId === empId && l.status === 'Approved' && l.days >= 14
    && l.from <= asOf && l.to >= asOf);
  if (longLeave) {
    return say('Leave of Absence', longLeave.from, `Returns ${longLeave.to}`);
  }

  /* Recently moved. Three months, after which it is simply their job. */
  const RECENT = 92;
  const promo = lastEvent(empId, 'Promotion');
  const transfer = lastEvent(empId, 'Transfer');
  const recent = sortBy([promo, transfer].filter(Boolean), (x) => x!.on, 'desc')[0];
  if (recent && daysBetween(recent.on, asOf) <= RECENT) {
    return say(
      recent.type === 'Promotion' ? 'Promotion' : 'Transfer',
      recent.on,
      'Confirm the change has taken effect in payroll',
    );
  }

  /* On probation — joined, not yet confirmed. */
  if (e) {
    const confirmed = lastEvent(empId, 'Confirmation');
    const sinceJoin = daysBetween(e.doj, asOf);
    if (!confirmed && sinceJoin < 180) {
      return say('Joined', e.doj, `Probation review due ${ymd(addDays(parseYmd(e.doj), 180))}`);
    }
    return say('Active', confirmed?.on ?? e.doj, null);
  }

  return say('Candidate', asOf, 'Awaiting an offer');
}

/**
 * The tasks a stage carries.
 *
 * Onboarding's live in the onboarding record and offboarding's are the
 * clearance rows — both already exist and are already worked, so duplicating
 * them here would give two checklists that disagree. What this holds is
 * everything the other stages need, which nothing owned before.
 */
const TEMPLATES: Partial<Record<LifecycleStage, { n: string; owner: string; day: number }[]>> = {
  Promotion: [
    { n: 'Confirm the new band in payroll', owner: 'Finance', day: 3 },
    { n: 'Issue the promotion letter', owner: 'HR', day: 5 },
    { n: 'Update the reporting line and access', owner: 'IT', day: 7 },
  ],
  Transfer: [
    { n: 'Confirm the receiving team and manager', owner: 'HR', day: 2 },
    { n: 'Move site, seating and asset assignment', owner: 'Operations', day: 7 },
    { n: 'Hand over open work', owner: 'Manager', day: 10 },
  ],
  'Leave of Absence': [
    { n: 'Record the leave type and expected return', owner: 'HR', day: 1 },
    { n: 'Arrange cover for the period', owner: 'Manager', day: 3 },
    { n: 'Pause or adjust payroll where applicable', owner: 'Finance', day: 5 },
  ],
  Joined: [
    { n: 'Set the 30-60-90 plan', owner: 'Manager', day: 7 },
    { n: 'Schedule the probation review', owner: 'HR', day: 150 },
  ],
};

(function genTasks() {
  ACTIVE().forEach((e) => {
    const standing = stageOf(e.id);
    const template = TEMPLATES[standing.stage];
    if (!template) return;

    template.forEach((t) => {
      const due = ymd(addDays(parseYmd(standing.since), t.day));
      /* Older tasks are mostly done; the recent ones mostly are not. */
      const overdue = due < ymd(TODAY);
      LIFECYCLE_TASKS.push({
        id: uid('LTK'),
        empId: e.id,
        stage: standing.stage,
        n: t.n,
        owner: t.owner,
        assigneeId: t.owner === 'Manager' ? e.managerId : null,
        due,
        done: overdue ? chance(0.75) : chance(0.2),
        doneOn: null,
        note: '',
      });
    });
  });

  /* A done task was done on a day, and that day is not in the future. */
  LIFECYCLE_TASKS.forEach((t) => {
    if (!t.done) return;
    const dueDay = parseYmd(t.due);
    const doneDay = addDays(dueDay, -ri(0, 5));
    t.doneOn = ymd(doneDay) > ymd(TODAY) ? ymd(TODAY) : ymd(doneDay);
  });
})();

export const tasksFor = (empId: string) =>
  sortBy(LIFECYCLE_TASKS.filter((t) => t.empId === empId), (t) => t.due);

/**
 * Somebody the lifecycle tracks, whether or not they are on the payroll yet.
 *
 * The journey starts before employment does — a joiner in pre-boarding has an
 * onboarding record and no employee row, which is the whole point of the
 * stage. A population drawn from employees alone can never show the first
 * three stages, which is what it did.
 */
export interface LifecycleSubject {
  id: string;
  name: string;
  code: string;
  dept: string;
  designation: string;
  site: string;
  managerId: string | null;
  startOn: string;
  /** False while they are still a joiner rather than an employee. */
  onPayroll: boolean;
  /** Grade band code, or null where none has been recorded. */
  grade?: string | null;
  /** The employee column that confirming probation clears. */
  onProbation?: boolean;
}

export const lifecyclePopulation = (): LifecycleSubject[] => [
  /*
   * People in the pipeline. Candidate and Offer are stages of the employment
   * journey the brief describes, and the records are already in Recruitment —
   * drawing them from there rather than inventing a parallel list is what
   * keeps the two from disagreeing about who has an offer out.
   *
   * Rejected and hired candidates are excluded: one never entered the journey
   * and the other has an onboarding row that supersedes this.
   */
  ...CANDS.filter((c) => c.stage !== 'rejected' && c.stage !== 'hired').map((c) => ({
    id: c.id,
    name: c.name,
    code: '—',
    /* A candidate belongs to a requisition, not a department — the role they
       applied for is the requisition's. */
    dept: reqOf(c.reqId)?.dept ?? '',
    designation: reqOf(c.reqId)?.title ?? '',
    site: c.loc,
    managerId: null,
    startOn: c.appliedOn,
    onPayroll: false,
  })),
  ...ONBOARD.filter((o) => o.status !== 'Completed').map((o) => ({
    id: o.id,
    name: o.name,
    code: '—',
    dept: o.dept,
    designation: o.designation,
    site: o.site,
    managerId: o.managerId,
    startOn: o.doj,
    onPayroll: false,
  })),
  ...EMP.filter((e) => e.status === 'Active' || e.status === 'Exited').map((e) => ({
    id: e.id,
    name: e.name,
    code: e.code,
    dept: e.dept,
    designation: e.designation,
    site: e.site,
    managerId: e.managerId,
    startOn: e.doj,
    onPayroll: true,
  })),
];

/** One subject by id, from either source. */
export const subjectOf = (id: string): LifecycleSubject | undefined =>
  lifecyclePopulation().find((s) => s.id === id);

/** The stage an event belongs to, for the timeline on a person's page. */
export const stageForEvent = (type: string): LifecycleStage | null => ({
  Joined: 'Joined' as LifecycleStage,
  Confirmation: 'Active' as LifecycleStage,
  Promotion: 'Promotion' as LifecycleStage,
  Transfer: 'Transfer' as LifecycleStage,
  'Manager Change': 'Transfer' as LifecycleStage,
}[type] ?? null);
