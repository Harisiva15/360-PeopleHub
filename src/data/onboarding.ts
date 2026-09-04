/* Shares the RNG stream with the ATS — this import fixes the draw order. */
import './ats';

import { addDays, parseYmd, TODAY, ymd } from '../lib/dates';
import { chance, pick } from '../lib/rng';
import { CANDS, reqOf } from './ats';
import { EMP } from './employees';
import { TITLES } from './org';

export interface OnbTask {
  k: string;
  n: string;
  owner: string;
  /** Days relative to the joining date; negative is pre-boarding. */
  day: number;
  due: string;
  done: boolean;
  doneOn: string | null;
}

/** The standard joining checklist, offset around day zero. */
export const ONB_TEMPLATE = [
  { k: 'offer_accept', n: 'Offer accepted', owner: 'HR', day: -30 },
  { k: 'docs', n: 'Document collection (ID, education, experience)', owner: 'Candidate', day: -14 },
  { k: 'bgv', n: 'Background verification initiated', owner: 'HR', day: -12 },
  { k: 'itasset', n: 'IT asset allocation (laptop, accessories)', owner: 'IT', day: -3 },
  { k: 'accounts', n: 'Email, VPN and tool accounts created', owner: 'IT', day: -2 },
  { k: 'joining', n: 'Joining formalities & Form 11/2 signed', owner: 'HR', day: 0 },
  { k: 'induction', n: 'Company induction & policy walkthrough', owner: 'HR', day: 0 },
  { k: 'payroll', n: 'Payroll, PF/UAN and bank setup', owner: 'Finance', day: 1 },
  { k: 'buddy', n: 'Buddy assigned & team introduction', owner: 'Manager', day: 1 },
  { k: 'goals', n: 'Probation goals & 30-60-90 plan set', owner: 'Manager', day: 5 },
  { k: 'training', n: 'Mandatory compliance training (POSH, InfoSec)', owner: 'Employee', day: 7 },
  { k: 'confirm', n: 'Probation confirmation review', owner: 'Manager', day: 180 },
];

export interface OnbDoc {
  n: string;
  ok: boolean;
}

export interface Onboarding {
  id: string;
  candId: string;
  name: string;
  reqId: string;
  dept: string;
  designation: string;
  site: string;
  doj: string;
  managerId: string;
  buddyId: string;
  ctc: number;
  status: 'Pre-boarding' | 'In Progress' | 'Completed';
  bgv: string;
  tasks: OnbTask[];
  docs: OnbDoc[];
}

export const ONBOARD: Onboarding[] = [];

(function genOnb() {
  const hires = CANDS.filter((c) => c.stage === 'hired' && c.offer).slice(0, 10);
  hires.forEach((c, i) => {
    const r = reqOf(c.reqId)!;
    const doj = c.offer!.doj;
    const started = doj <= ymd(TODAY);

    const tasks: OnbTask[] = ONB_TEMPLATE.map((t) => {
      const due = ymd(addDays(parseYmd(doj), t.day));
      const done = due < ymd(TODAY) ? chance(0.85) : false;
      return { ...t, due, done, doneOn: done ? due : null };
    });

    ONBOARD.push({
      id: 'ONB-' + (100 + i),
      candId: c.id,
      name: c.name,
      reqId: c.reqId,
      dept: r.dept,
      designation: TITLES[r.dept][r.grade],
      site: r.site,
      doj,
      managerId: r.hiringManagerId,
      buddyId: pick(EMP.filter((e) => e.dept === r.dept && e.status === 'Active')).id,
      ctc: c.offer!.ctc,
      status: started ? (tasks.every((t) => t.done) ? 'Completed' : 'In Progress') : 'Pre-boarding',
      bgv: pick(['Clear', 'Clear', 'In Progress', 'Insufficiency']),
      tasks,
      docs: [
        { n: 'PAN Card', ok: chance(0.9) },
        { n: 'Aadhaar', ok: chance(0.9) },
        { n: 'Degree Certificate', ok: chance(0.8) },
        { n: 'Relieving Letter', ok: chance(0.7) },
        { n: 'Last 3 Payslips', ok: chance(0.75) },
        { n: 'Cancelled Cheque', ok: chance(0.85) },
      ],
    });
  });
})();
