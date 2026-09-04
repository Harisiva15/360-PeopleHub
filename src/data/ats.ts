/* Shares the RNG stream with payroll — this import fixes the draw order. */
import './payroll';

import { uniq } from '../lib/collections';
import { addDays, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, rnd, uid } from '../lib/rng';
import { EMP, HEADS, MANAGERS } from './employees';
import { deptOf, FIRST_F, FIRST_M, GRADES, LAST, siteOf, SKILLS } from './org';
import type { Grade } from '../types/country';

export interface Stage {
  id: string;
  name: string;
  color: string;
}

/** The hiring funnel, in order. `hired` and `rejected` are terminal. */
export const STAGES: Stage[] = [
  { id: 'applied', name: 'Applied', color: 'var(--s1)' },
  { id: 'screen', name: 'Screening', color: 'var(--s4)' },
  { id: 'tech', name: 'Technical', color: 'var(--s7)' },
  { id: 'manager', name: 'Manager Round', color: 'var(--s2)' },
  { id: 'hr', name: 'HR / Fitment', color: 'var(--s5)' },
  { id: 'offer', name: 'Offer', color: 'var(--s3)' },
  { id: 'hired', name: 'Hired', color: 'var(--s6)' },
  { id: 'rejected', name: 'Rejected', color: 'var(--s8)' },
];

export const SOURCES = ['Naukri', 'LinkedIn', 'Referral', 'Careers Page', 'Instahyre', 'Campus', 'Agency'];

export interface Requisition {
  id: string;
  title: string;
  dept: string;
  grade: Grade;
  site: string;
  openings: number;
  filled: number;
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  status: 'Open' | 'On Hold' | 'Closed';
  hiringManagerId: string;
  recruiterId: string;
  openedOn: string;
  budgetMin: number;
  budgetMax: number;
  type: string;
  desc: string;
  must: string[];
  exp: string;
}

export const REQS: Requisition[] = [];

(function genReqs() {
  const plan = [
    { dept: 'ENG', grade: 'L3', title: 'Senior Software Engineer — React', site: 'CHN', open: 4, pri: 'High' },
    { dept: 'ENG', grade: 'L2', title: 'Software Engineer — Java/Spring', site: 'BLR', open: 3, pri: 'High' },
    { dept: 'ENG', grade: 'L4', title: 'Engineering Manager — Platform', site: 'CHN', open: 1, pri: 'Critical' },
    { dept: 'DEVOPS', grade: 'L3', title: 'Senior SRE — Kubernetes', site: 'BLR', open: 2, pri: 'High' },
    { dept: 'QA', grade: 'L2', title: 'QA Automation Engineer', site: 'CHN', open: 2, pri: 'Medium' },
    { dept: 'PROD', grade: 'L3', title: 'Senior Product Manager', site: 'BLR', open: 1, pri: 'Medium' },
    { dept: 'SALES', grade: 'L2', title: 'Account Executive — BFSI', site: 'HYD', open: 3, pri: 'High' },
    { dept: 'SUP', grade: 'L1', title: 'Support Associate (Night Shift)', site: 'HYD', open: 4, pri: 'Medium' },
    { dept: 'FIN', grade: 'L2', title: 'Accountant — Payroll', site: 'CHN', open: 1, pri: 'Low' },
    { dept: 'HR', grade: 'L2', title: 'Talent Acquisition Specialist', site: 'CHN', open: 2, pri: 'High' },
    { dept: 'ENG', grade: 'L1', title: 'Associate Engineer — Campus 2026', site: 'CHN', open: 8, pri: 'Medium' },
    { dept: 'PROD', grade: 'L2', title: 'Product Designer', site: 'CHN', open: 1, pri: 'Low' },
  ] as const;

  plan.forEach((p, i) => {
    const mgrs = MANAGERS.filter((m) => m.dept === p.dept);
    const hm = mgrs.length ? mgrs[i % mgrs.length] : HEADS[p.dept];
    REQS.push({
      id: 'JR-' + (2601 + i),
      title: p.title,
      dept: p.dept,
      grade: p.grade as Grade,
      site: p.site,
      openings: p.open,
      filled: 0,
      priority: p.pri as Requisition['priority'],
      status: i === 11 ? 'On Hold' : i === 8 ? 'Closed' : 'Open',
      hiringManagerId: hm.id,
      recruiterId: EMP.filter((e) => e.dept === 'HR' && e.status === 'Active')[i % 4].id,
      openedOn: ymd(addDays(TODAY, -ri(12, 150))),
      budgetMin: GRADES[p.grade as Grade].min,
      budgetMax: GRADES[p.grade as Grade].max,
      type: 'Full-time',
      desc:
        'We are looking for a ' +
        p.title +
        ' to join the ' +
        deptOf(p.dept).name +
        ' team at our ' +
        siteOf(p.site).name +
        '. You will work closely with cross-functional teams to build and scale products used by enterprise customers.',
      must: uniq([pick(SKILLS), pick(SKILLS), pick(SKILLS)]),
      exp: p.grade === 'L1' ? '0-1 yrs' : p.grade === 'L2' ? '2-4 yrs' : p.grade === 'L3' ? '5-8 yrs' : '8-12 yrs',
    });
  });
})();

export const reqOf = (id: string): Requisition | undefined => REQS.find((r) => r.id === id);

export interface Offer {
  ctc: number;
  grade: Grade;
  status: 'Sent' | 'Negotiating' | 'Accepted';
  sentOn: string;
  doj: string;
  site: string;
}

export interface CandNote {
  by: string;
  on: string;
  text: string;
}

export interface Candidate {
  id: string;
  name: string;
  reqId: string;
  stage: string;
  email: string;
  phone: string;
  source: string;
  appliedOn: string;
  exp: string;
  current: string;
  ctcCur: number;
  ctcExp: number;
  notice: string;
  rating: number;
  skills: string[];
  loc: string;
  resume: string;
  notes: CandNote[];
  offer: Offer | null;
}

export const CANDS: Candidate[] = [];

(function genCands() {
  REQS.forEach((r) => {
    const n = r.status === 'Closed' ? 6 : ri(5, 12);
    for (let i = 0; i < n; i++) {
      const g = chance(0.55) ? 'M' : 'F';
      const nm = pick(g === 'M' ? FIRST_M : FIRST_F) + ' ' + pick(LAST);
      const stg =
        r.status === 'Closed'
          ? pick(['hired', 'rejected', 'rejected'])
          : pick([
              'applied', 'applied', 'applied', 'screen', 'screen', 'tech', 'tech',
              'manager', 'hr', 'offer', 'hired', 'rejected', 'rejected',
            ]);
      const applied = ymd(addDays(TODAY, -ri(2, 90)));
      const cur =
        Math.round(ri(Math.round(GRADES[r.grade].min * 0.72), Math.round(GRADES[r.grade].max * 0.9)) / 10000) * 10000;

      const expRange: Record<Grade, [number, number]> = {
        L1: [0, 1], L2: [2, 5], L3: [5, 9], L4: [8, 14], L5: [12, 20], L6: [15, 25],
      };

      CANDS.push({
        id: uid('C'),
        name: nm,
        reqId: r.id,
        stage: stg,
        email: nm.toLowerCase().replace(/\s+/g, '.') + '@' + pick(['gmail.com', 'outlook.com', 'yahoo.in']),
        phone: '+91 ' + ri(70, 99) + ri(10000000, 99999999),
        source: pick(SOURCES),
        appliedOn: applied,
        exp: ri(expRange[r.grade][0], expRange[r.grade][1]) + ' yrs',
        current: pick(['Infosys', 'TCS', 'Zoho', 'Freshworks', 'Wipro', 'Cognizant', 'Accenture', 'Razorpay', 'PhonePe', 'Startup']),
        ctcCur: cur,
        ctcExp: Math.round((cur * (1.15 + rnd() * 0.4)) / 10000) * 10000,
        notice: pick(['Immediate', '15 days', '30 days', '60 days', '90 days']),
        rating: ri(2, 5),
        skills: uniq([pick(SKILLS), pick(SKILLS), pick(SKILLS)]),
        loc: pick(['Chennai', 'Bengaluru', 'Hyderabad', 'Coimbatore', 'Pune']),
        resume: nm.replace(/\s+/g, '_') + '_Resume.pdf',
        notes: [],
        offer: null,
      });
    }
  });

  CANDS.filter((c) => c.stage === 'offer' || c.stage === 'hired').forEach((c) => {
    const r = reqOf(c.reqId)!;
    c.offer = {
      ctc: ri(GRADES[r.grade].min, GRADES[r.grade].max),
      grade: r.grade,
      status: c.stage === 'hired' ? 'Accepted' : pick(['Sent', 'Sent', 'Negotiating', 'Accepted'] as Offer['status'][]),
      sentOn: ymd(addDays(TODAY, -ri(3, 40))),
      doj: ymd(addDays(TODAY, ri(-20, 55))),
      site: r.site,
    };
  });

  CANDS.forEach((c) => {
    if (c.stage === 'hired') {
      const r = reqOf(c.reqId);
      if (r) r.filled++;
    }
  });
})();

export interface Interview {
  id: string;
  candId: string;
  reqId: string;
  round: string;
  date: string;
  time: string;
  panelId: string;
  mode: string;
  status: 'Scheduled' | 'Completed' | 'No Show';
  verdict: string | null;
  feedback: string;
}

export const INTERVIEWS: Interview[] = [];

(function genIvs() {
  CANDS.filter((c) => ['tech', 'manager', 'hr', 'offer', 'hired'].includes(c.stage)).forEach((c) => {
    const r = reqOf(c.reqId)!;
    const rounds = ['Technical Round 1', 'Technical Round 2', 'Manager Round', 'HR Discussion'];
    const nr = c.stage === 'tech' ? 1 : c.stage === 'manager' ? 2 : 3;
    for (let i = 0; i < nr; i++) {
      const when = addDays(TODAY, ri(-30, 9));
      const done = when < TODAY;
      INTERVIEWS.push({
        id: uid('IV'),
        candId: c.id,
        reqId: c.reqId,
        round: rounds[i],
        date: ymd(when),
        time: pick(['10:00', '11:30', '14:00', '15:30', '16:30']),
        panelId:
          i === 2
            ? r.hiringManagerId
            : pick(EMP.filter((e) => e.dept === r.dept && e.status === 'Active' && e.grade >= 'L3')).id,
        mode: pick(['Google Meet', 'MS Teams', 'In-person']),
        status: done ? pick(['Completed', 'Completed', 'Completed', 'No Show'] as Interview['status'][]) : 'Scheduled',
        verdict: done ? pick(['Strong Hire', 'Hire', 'Hire', 'No Hire', 'Hold']) : null,
        feedback: done
          ? pick([
              'Solid fundamentals, good problem solving. Recommend proceeding.',
              'Communication is good, depth in system design is average.',
              'Great culture fit, hands-on with the stack we use.',
              'Struggled with DS/Algo round, not a fit for this level.',
            ])
          : '',
      });
    }
  });
})();
