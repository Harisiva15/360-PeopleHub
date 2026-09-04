/* Shares the RNG stream with announcements — this import fixes the draw order. */
import './announcements';

import { sum } from '../lib/collections';
import { addDays, TODAY, ymd } from '../lib/dates';
import { clamp } from '../lib/format';
import { chance, pick, ri, rnd, uid } from '../lib/rng';
import { ACTIVE } from './employees';
import { deptOf } from './org';

/** Company values — used by praise and referenced in reviews. */
export const VALUES = [
  { k: 'Customer First', ic: '🎯', c: 'var(--s1)' },
  { k: 'Ownership', ic: '🛠️', c: 'var(--s2)' },
  { k: 'Craftsmanship', ic: '💎', c: 'var(--s3)' },
  { k: 'One Team', ic: '🤝', c: 'var(--s7)' },
  { k: 'Integrity', ic: '🧭', c: 'var(--s5)' },
];

export interface Rating {
  v: number;
  label: string;
  c: string;
  band: string;
}

export const RATINGS: Rating[] = [
  { v: 5, label: 'Outstanding', c: 'var(--s6)', band: 'Top 10%' },
  { v: 4, label: 'Exceeds Expectations', c: 'var(--s3)', band: 'Next 20%' },
  { v: 3, label: 'Meets Expectations', c: 'var(--s1)', band: 'Core 55%' },
  { v: 2, label: 'Needs Improvement', c: 'var(--s4)', band: 'Next 10%' },
  { v: 1, label: 'Unsatisfactory', c: 'var(--s8)', band: 'Bottom 5%' },
];

export const ratingOf = (v: number): Rating => RATINGS.find((r) => r.v === Math.round(v)) || RATINGS[2];

export const POTENTIAL = [
  { v: 3, label: 'High' },
  { v: 2, label: 'Medium' },
  { v: 1, label: 'Low' },
];

/** Keyed `performance-potential`, each 1 (low) to 3 (high). */
export const NINEBOX: Record<string, { n: string; c: string; a: string }> = {
  '3-3': { n: 'Star', c: 'var(--s6)', a: 'Stretch assignment, accelerate, retain hard' },
  '3-2': { n: 'High Performer', c: 'var(--s3)', a: 'Reward well, broaden scope' },
  '3-1': { n: 'Trusted Professional', c: 'var(--s1)', a: 'Deepen expertise, protect and retain' },
  '2-3': { n: 'High Potential', c: 'var(--s3)', a: 'Grow into the next level, mentor' },
  '2-2': { n: 'Core Player', c: 'var(--s1)', a: 'Keep engaged, steady development' },
  '2-1': { n: 'Effective', c: 'var(--s1)', a: 'Reliable in role, focus on mastery' },
  '1-3': { n: 'Enigma', c: 'var(--s4)', a: 'Diagnose blockers — potential is not converting' },
  '1-2': { n: 'Inconsistent', c: 'var(--s4)', a: 'Coach on delivery and consistency' },
  '1-1': { n: 'Under Performer', c: 'var(--s8)', a: 'Performance improvement plan' },
};

export interface Cycle {
  id: string;
  name: string;
  from: string;
  to: string;
  status: string;
  /** Budgeted average increment, as a percentage. */
  hikePool: number;
}

export const CYCLES: Cycle[] = [
  { id: 'CY-H2FY26', name: 'H2 FY 2025-26 Appraisal', from: '2025-10-01', to: '2026-03-31', status: 'Completed', hikePool: 9.5 },
  { id: 'CY-H1FY27', name: 'H1 FY 2026-27 Appraisal', from: '2026-04-01', to: '2026-09-30', status: 'In Progress', hikePool: 11.0 },
];

export const CUR_CYCLE = CYCLES[1];

export const REVIEW_PHASES = [
  { k: 'goals', n: 'Goal setting', from: '2026-04-01', to: '2026-04-15' },
  { k: 'checkin', n: 'Mid-cycle check-ins', from: '2026-06-01', to: '2026-06-30' },
  { k: 'self', n: 'Self appraisal', from: '2026-09-01', to: '2026-09-10' },
  { k: 'manager', n: 'Manager review', from: '2026-09-11', to: '2026-09-20' },
  { k: 'peer', n: '360° peer feedback', from: '2026-09-05', to: '2026-09-18' },
  { k: 'calib', n: 'Calibration', from: '2026-09-21', to: '2026-09-27' },
  { k: 'release', n: 'Letters released', from: '2026-10-01', to: '2026-10-05' },
];

const GOAL_LIB: Record<string, [string, string][]> = {
  ENG: [['Ship Atlas 4.1 with zero P1 defects', 'Delivery'], ['Reduce p95 API latency to under 300 ms', 'Quality'], ['Raise unit-test coverage from 62% to 80%', 'Quality'], ['Mentor two junior engineers to independent delivery', 'People'], ['Close 95% of sprint commitments each sprint', 'Delivery']],
  QA: [['Automate 70% of the regression suite', 'Quality'], ['Cut defect leakage to production below 3%', 'Quality'], ['Reduce release-cycle test time to under 2 days', 'Delivery'], ['Build a performance-test pack for Atlas', 'Quality']],
  DEVOPS: [['Achieve 99.95% platform uptime', 'Quality'], ['Cut monthly cloud spend by 18%', 'Cost'], ['Move 100% of services to IaC', 'Delivery'], ['Reduce mean time to recovery below 20 minutes', 'Quality']],
  PROD: [['Launch three customer-requested features', 'Delivery'], ['Lift activation rate from 41% to 55%', 'Growth'], ['Run 20 customer discovery interviews', 'Customer'], ['Ship the redesigned onboarding flow', 'Delivery']],
  SALES: [['Close ₹4.2 Cr in new ARR', 'Revenue'], ['Build a 3× qualified pipeline', 'Revenue'], ['Win 4 logos in the BFSI segment', 'Growth'], ['Keep win rate above 27%', 'Revenue']],
  SUP: [['Keep CSAT above 4.5 / 5', 'Customer'], ['First response under 30 minutes for P1', 'Customer'], ['Deflect 25% of tickets with self-service', 'Cost'], ['Resolve 90% of tickets within SLA', 'Customer']],
  HR: [['Reduce time to hire to under 32 days', 'Delivery'], ['Keep regretted attrition below 8%', 'People'], ['Complete 100% compliance training', 'Compliance'], ['Lift eNPS from 34 to 45', 'People']],
  FIN: [['Close books within 5 working days', 'Delivery'], ['Zero statutory filing delays', 'Compliance'], ['Cut DSO from 58 to 45 days', 'Cost'], ['Automate the payroll journal export', 'Delivery']],
};

export interface KeyResult {
  k: string;
  done: boolean;
}

export interface Goal {
  id: string;
  empId: string;
  cycleId: string;
  title: string;
  category: string;
  /** Percentage of the scorecard; the set sums to 100. */
  weight: number;
  progress: number;
  due: string;
  status: 'Achieved' | 'On Track' | 'At Risk' | 'Behind';
  alignedTo: string | null;
  keyResults: KeyResult[];
}

export interface CheckIn {
  id: string;
  empId: string;
  on: string;
  by: string | null;
  wins: string;
  blockers: string;
  next: string;
}

export const GOALS: Goal[] = [];
export const CHECKINS: CheckIn[] = [];

/** Stable per-employee offset so goal selection does not repeat across the org. */
function empSeqHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

(function genGoals() {
  ACTIVE().forEach((e) => {
    const lib = GOAL_LIB[e.dept] || GOAL_LIB.ENG;
    const n = e.grade >= 'L4' ? 4 : 3;
    const picked: [string, string][] = [];
    for (let i = 0; i < n; i++) {
      const g = lib[(i + empSeqHash(e.id)) % lib.length];
      if (!picked.includes(g)) picked.push(g);
    }

    let wLeft = 100;
    picked.forEach((g, i) => {
      const weight = i === picked.length - 1 ? wLeft : i === 0 ? 40 : 30;
      wLeft -= weight;
      const progress = ri(15, 100);
      GOALS.push({
        id: uid('G'),
        empId: e.id,
        cycleId: CUR_CYCLE.id,
        title: g[0],
        category: g[1],
        weight,
        progress,
        due: '2026-09-30',
        status: progress >= 100 ? 'Achieved' : progress >= 60 ? 'On Track' : progress >= 35 ? 'At Risk' : 'Behind',
        alignedTo: e.managerId ? 'Team objective — ' + deptOf(e.dept).name : null,
        keyResults: [
          { k: 'Baseline measured and agreed', done: true },
          { k: 'Mid-cycle milestone delivered', done: progress >= 50 },
          { k: 'Target achieved and verified', done: progress >= 100 },
        ],
      });
    });

    if (chance(0.75)) {
      CHECKINS.push({
        id: uid('CI'),
        empId: e.id,
        on: ymd(addDays(TODAY, -ri(5, 60))),
        by: e.managerId,
        wins: pick(['Shipped the release ahead of schedule.', 'Unblocked the integration issue for the client.', 'Took ownership of the on-call rotation.', 'Closed two long-pending customer escalations.']),
        blockers: pick(['Waiting on the vendor API sandbox.', 'Bandwidth split across two projects.', 'Needs a second reviewer on the design.', 'None this cycle.']),
        next: pick(['Complete the migration by month end.', 'Start the automation spike.', 'Pair with QA on the regression pack.', 'Draft the architecture note.']),
      });
    }
  });
})();

export interface PeerFeedback {
  by: string;
  rating: number;
  comment: string;
}

export interface Review {
  id: string;
  empId: string;
  cycleId: string;
  status: string;
  /** Weighted goal attainment, 0-100. */
  goalAchievement: number;
  self: { rating: number | null; comments: string; on: string | null };
  manager: { rating: number | null; comments: string; on: string | null; by: string | null };
  peers: PeerFeedback[];
  potential: number;
  final: { rating: number; hike: number; promoted: boolean } | null;
  /** Flagged for a performance improvement plan. */
  pip: boolean;
}

export const REVIEWS: Review[] = [];

(function genReviews() {
  ACTIVE().forEach((e) => {
    const g = GOALS.filter((x) => x.empId === e.id);
    const achv = sum(g, (x) => x.progress * x.weight) / Math.max(1, sum(g, (x) => x.weight));
    const selfR = clamp(Math.round(achv / 30) + 2 + (chance(0.25) ? 1 : 0), 2, 5);
    const mgrR = clamp(selfR - (chance(0.42) ? 1 : 0), chance(0.04) ? 1 : 2, 5);
    const st = pick(['Self pending', 'Self pending', 'Manager pending', 'Manager pending', 'Calibrated', 'Completed']);

    REVIEWS.push({
      id: uid('RV'),
      empId: e.id,
      cycleId: CUR_CYCLE.id,
      status: st,
      goalAchievement: Math.round(achv),
      self: {
        rating: st === 'Self pending' ? null : selfR,
        comments: 'Delivered against all committed goals; took on additional scope during the release.',
        on: st === 'Self pending' ? null : ymd(addDays(TODAY, -ri(2, 20))),
      },
      manager: {
        rating: ['Manager pending', 'Self pending'].includes(st) ? null : mgrR,
        comments: 'Consistent contributor. Strong on execution; can push further on cross-team influence.',
        on: null,
        by: e.managerId,
      },
      peers: ['Manager pending', 'Self pending'].includes(st)
        ? []
        : Array.from({ length: ri(2, 3) }, () => ({
            by: pick(ACTIVE().filter((x) => x.dept === e.dept && x.id !== e.id)).id,
            rating: clamp(mgrR + (chance(0.5) ? 1 : 0), 1, 5),
            comment: pick([
              'Great collaborator, always available for a review.',
              'Deep product knowledge; explains trade-offs clearly.',
              'Reliable under pressure, keeps the team calm.',
              'Could communicate progress more proactively.',
            ]),
          })),
      potential: pick([1, 2, 2, 2, 3, 3]),
      final: ['Calibrated', 'Completed'].includes(st)
        ? {
            rating: mgrR,
            hike: +(CUR_CYCLE.hikePool * (mgrR / 3) * (0.85 + rnd() * 0.3)).toFixed(1),
            promoted: mgrR >= 5 && chance(0.35),
          }
        : null,
      pip: mgrR <= 2 && chance(0.5),
    });
  });
})();

export const reviewOf = (id: string): Review | undefined =>
  REVIEWS.find((r) => r.empId === id && r.cycleId === CUR_CYCLE.id);

export interface Praise {
  id: string;
  fromId: string;
  toId: string;
  value: string;
  text: string;
  on: string;
  likes: number;
}

export const PRAISE: Praise[] = [];

(function genPraise() {
  const texts = [
    'Jumped on the production incident at 11 PM and had it fixed before the client noticed. Textbook ownership.',
    'Rewrote the onboarding docs — three new joiners shipped code in week one because of it.',
    'Handled a very unhappy customer call with complete composure and turned it around.',
    'Spotted the data issue in the payroll import before it went out. Saved us a painful week.',
    'Volunteered to cover the release weekend so the team could take the long weekend off.',
    'The design review feedback was blunt, fair and made the feature substantially better.',
    'Mentored two interns through their first production deployment.',
    'Closed the quarter 118% to target while still helping the new AEs ramp.',
    'Pushed back on a shortcut that would have cost us later. Right call.',
    'Built the internal dashboard nobody asked for and everybody now uses daily.',
  ];
  for (let i = 0; i < 26; i++) {
    const to = pick(ACTIVE());
    const from = pick(ACTIVE().filter((x) => x.id !== to.id));
    PRAISE.push({
      id: uid('PR'),
      fromId: from.id,
      toId: to.id,
      value: pick(VALUES).k,
      text: texts[i % texts.length],
      on: ymd(addDays(TODAY, -ri(0, 55))),
      likes: ri(2, 28),
    });
  }
})();
