/**
 * The job order, its desk and its history.
 *
 * The three things worth asserting about generated data are that it obeys the
 * same rules the database does, that the SLA says something useful rather than
 * merely something, and that the timeline agrees with the funnel beside it —
 * a history that contradicts the numbers on the same screen is worse than no
 * history at all.
 */

import {
  ACTIVITY_META, JOB_ACTIVITY, JOB_ASSIGNMENTS, PLACEMENTS, REQUIREMENTS, SUBMISSIONS,
  activityFor, holderOf, slaOf,
} from '../src/data/staffing';
import type { StaffingRequirement } from '../src/data/staffing';
import { EMAP } from '../src/data/employees';
import { ymd, TODAY } from '../src/lib/dates';

let failed = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log(
  `${REQUIREMENTS.length} job orders · ${JOB_ASSIGNMENTS.length} assignments · `
  + `${JOB_ACTIVITY.length} activity rows`,
);

/* ---- the order obeys what 0029 enforces ---- */

const perm = (r: StaffingRequirement) => r.jobType === 'Full Time' || r.jobType === 'Part Time';

check('every order has a job type and an employment type',
  REQUIREMENTS.filter((r) => !r.jobType || !r.employmentType).length, 0);
check('a pay rate never meets or exceeds the bill rate',
  REQUIREMENTS.filter((r) => r.payRate !== null && r.payRate >= r.billRate).length, 0);
check('a contract order is quoted as rates, not a band',
  REQUIREMENTS.filter((r) => !perm(r) && (r.payRate === null || r.salaryMin !== null)).length, 0);
check('a permanent order is quoted as a band, not rates',
  REQUIREMENTS.filter((r) => perm(r) && (r.payRate !== null || r.salaryMin === null)).length, 0);
check('a permanent order is a direct hire',
  REQUIREMENTS.filter((r) => perm(r) && r.employmentType !== 'Direct Hire').length, 0);
check('no salary band runs backwards',
  REQUIREMENTS.filter((r) =>
    r.salaryMin !== null && r.salaryMax !== null && r.salaryMax < r.salaryMin).length, 0);
check('no experience band runs backwards',
  REQUIREMENTS.filter((r) => r.expMax < r.expMin).length, 0);

/* The markup is stored, so it must still describe the rates it was quoted on. */
const markupDrift = REQUIREMENTS.filter((r) => {
  if (r.payRate === null || r.markupPct === null) return false;
  const implied = ((r.billRate - r.payRate) / r.payRate) * 100;
  return Math.abs(implied - r.markupPct) > 1.5;
});
check('the stored markup matches the rates it was quoted on', markupDrift.length, 0);

/* ---- the SLA is a sequence ---- */

check('every order has an SLA',
  REQUIREMENTS.filter((r) => !r.openedOn || !r.targetFillOn || !r.slaDays).length, 0);
check('the submission target never falls after the interview target',
  REQUIREMENTS.filter((r) => r.targetSubmitOn > r.targetInterviewOn).length, 0);
check('the interview target never falls after the fill target',
  REQUIREMENTS.filter((r) => r.targetInterviewOn > r.targetFillOn).length, 0);
check('an order never opens before it was received',
  REQUIREMENTS.filter((r) => r.openedOn < r.receivedOn).length, 0);

/* ---- the SLA says something useful ---- */

const countsFor = (r: StaffingRequirement) => {
  const subs = SUBMISSIONS.filter((s) => s.reqId === r.id);
  return {
    submissions: subs.length,
    interviews: subs.filter((s) => s.interviewOn).length,
    hires: PLACEMENTS.filter((p) => p.reqId === r.id).length,
  };
};

const standings = REQUIREMENTS.map((r) => ({ r, s: slaOf(r, countsFor(r)) }));
const spread = standings.reduce<Record<string, number>>((acc, x) => {
  acc[x.s.state] = (acc[x.s.state] ?? 0) + 1;
  return acc;
}, {});
console.log('SLA spread:', JSON.stringify(spread));

check('every SLA state is reachable in the data',
  ['On Track', 'Approaching', 'Overdue'].filter((k) => !spread[k]).length, 0);
check('days open is never negative',
  standings.filter((x) => x.s.daysOpen < 0).length, 0);
check('only an overdue order ages',
  standings.filter((x) => x.s.aging > 0 && x.s.state !== 'Overdue').length, 0);
check('an overdue order names the stage that is behind',
  standings.filter((x) => x.s.state === 'Overdue' && !x.s.behind).length, 0);
check('a settled order is never overdue',
  standings.filter((x) => x.s.state === 'Overdue'
    && ['Filled', 'Closed', 'Lost', 'Cancelled'].includes(x.r.status)).length, 0);

/*
 * The point of measuring each target separately: an order past its fill date
 * that has candidates at interview is behind on 'fill', not on 'submission'.
 * If nothing in the book demonstrates that, the distinction is untested.
 */
const behindLate = standings.filter((x) => x.s.behind === 'fill');
check('an order can be behind on fill alone', behindLate.length > 0, true);

/* ---- the desk ---- */

check('every order has exactly one live primary recruiter',
  REQUIREMENTS.filter((r) => !holderOf(r.id, 'primary')).length, 0);
check('every order has a recruitment manager',
  REQUIREMENTS.filter((r) => !holderOf(r.id, 'manager')).length, 0);
check('no order has two live holders of the same desk role',
  REQUIREMENTS.filter((r) => {
    const live = JOB_ASSIGNMENTS.filter((a) => a.reqId === r.id && !a.releasedOn);
    return new Set(live.map((a) => a.role)).size !== live.length;
  }).length, 0);
check('every assignment names a real employee',
  JOB_ASSIGNMENTS.filter((a) => !EMAP[a.recruiterId] || !EMAP[a.assignedById]).length, 0);
check('the primary is the order’s named recruiter',
  REQUIREMENTS.filter((r) => holderOf(r.id, 'primary')!.recruiterId !== r.recruiterId).length, 0);
check('a target hire count matches the positions on the order',
  REQUIREMENTS.filter((r) => holderOf(r.id, 'primary')!.targetHires !== r.positions).length, 0);
check('no order promises more submissions than the client will read',
  REQUIREMENTS.filter((r) => {
    const t = holderOf(r.id, 'primary')!.targetSubmissions;
    return t !== null && t > r.maxSubmissions;
  }).length, 0);

/* ---- the history ---- */

check('every order has a history',
  REQUIREMENTS.filter((r) => activityFor(r.id).length === 0).length, 0);
check('every activity row carries a summary',
  JOB_ACTIVITY.filter((a) => !a.summary.trim()).length, 0);
check('every activity kind is one the database accepts',
  JOB_ACTIVITY.filter((a) => !ACTIVITY_META[a.kind]).length, 0);
check('every activity row is an instant, not a date',
  JOB_ACTIVITY.filter((a) => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(a.at)).length, 0);
check('the timeline is newest first',
  JOB_ACTIVITY.every((a, i) => i === 0 || JOB_ACTIVITY[i - 1].at >= a.at), true);
check('every actor on the timeline is a real employee',
  JOB_ACTIVITY.filter((a) => a.actorId && !EMAP[a.actorId]).length, 0);
check('no activity is dated in the future',
  JOB_ACTIVITY.filter((a) => a.at.slice(0, 10) > ymd(TODAY)).length, 0);

/*
 * The history is generated from the pipeline, so it must agree with it. This
 * is the assertion that would catch a timeline drifting away from the funnel
 * on the same screen.
 */
const submissionLines = REQUIREMENTS.filter((r) => {
  const logged = activityFor(r.id).filter((a) => a.kind === 'submitted').length;
  return logged !== SUBMISSIONS.filter((s) => s.reqId === r.id).length;
});
check('the timeline logs exactly one line per submission', submissionLines.length, 0);

/*
 * Placements that have not started yet are not on the timeline — a consultant
 * with a start date next month has not started. So the line count matches the
 * placements that have actually begun, not every placement on the books.
 */
const placementLines = REQUIREMENTS.filter((r) => {
  const logged = activityFor(r.id).filter((a) => a.kind === 'placed').length;
  const started = PLACEMENTS.filter((p) => p.reqId === r.id && p.startOn <= ymd(TODAY)).length;
  return logged !== started;
});
check('the timeline logs one line per placement that has started', placementLines.length, 0);
check('a placement that has not started yet is not on the timeline',
  PLACEMENTS.filter((p) => p.startOn > ymd(TODAY)
    && activityFor(p.reqId).some((a) => a.kind === 'placed' && a.refId === p.id)).length, 0);

check('every submission line points at the submission it describes',
  JOB_ACTIVITY.filter((a) => a.kind === 'submitted'
    && !SUBMISSIONS.some((s) => s.id === a.refId)).length, 0);

check('a sourcing line always carries its count',
  JOB_ACTIVITY.filter((a) => (a.kind === 'sourced' || a.kind === 'screened') && a.qty === null).length, 0);
check('nothing is screened that was not sourced',
  REQUIREMENTS.filter((r) => {
    const acts = activityFor(r.id);
    const s = acts.find((a) => a.kind === 'sourced')?.qty ?? 0;
    const k = acts.find((a) => a.kind === 'screened')?.qty ?? 0;
    return k > s;
  }).length, 0);

console.log();
if (failed) {
  console.error(`${failed} job-order checks failed`);
  process.exit(1);
}
console.log('the job order, its desk and its history all hold up');
