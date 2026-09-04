/* Shares the RNG stream with lifecycle — this import fixes the draw order. */
import './lifecycle';

import { sum } from '../lib/collections';
import { addDays, daysBetween, parseYmd, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri } from '../lib/rng';
import { ACTIVE, CEO, DEMO_EMP, DEMO_MGR, EMAP, HRHEAD } from './employees';
import { siteOf } from './org';
import { dailyRate, PF_WAGE_CAP, salaryStructure, taxNewRegime } from './salary';
import { leaveBalance } from './leave';
import { activeLoans } from './loans';
import { ADVANCES, CLAIMS } from './expenses';

export const EXIT_REASONS = [
  'Better opportunity', 'Higher studies', 'Relocation', 'Compensation',
  'Work-life balance', 'Career growth', 'Personal reasons', 'Manager / team fit',
];

/** Sign-offs required before a full-and-final settlement can be released. */
export const CLEARANCE_DEPTS = [
  { k: 'Reporting Manager', d: 'Knowledge transfer complete, work handed over' },
  { k: 'IT & Systems', d: 'Laptop, accessories and access revoked' },
  { k: 'Finance', d: 'Advances, loans and reimbursements settled' },
  { k: 'Admin & Facilities', d: 'Access card, parking pass and locker returned' },
  { k: 'Human Resources', d: 'Exit interview done, documents issued' },
];

export interface Clearance {
  k: string;
  d: string;
  done: boolean;
  on: string | null;
  owner: string;
}

export interface ExitInterview {
  done: boolean;
  wouldRejoin?: boolean;
  npsToCompany?: number;
  ratings?: Record<string, number>;
  comments?: string;
}

export interface ExitRecord {
  id: string;
  empId: string;
  type: string;
  resignedOn: string;
  noticeDays: number;
  /** Last working day. */
  lwd: string;
  reason: string;
  destination: string;
  status: 'Notice Period' | 'In Clearance' | 'Settled';
  /** Notice days bought out, recovered in the settlement. */
  buyout: number;
  clearance: Clearance[];
  interview: ExitInterview;
}

export const EXITS: ExitRecord[] = [];

(function genExits() {
  /* the three demo identities and the CEO never resign */
  const demoIds = [HRHEAD.id, DEMO_MGR.id, DEMO_EMP.id, CEO.id];
  const leaving = ACTIVE().filter((e) => !demoIds.includes(e.id) && chance(0.05)).slice(0, 7);

  leaving.forEach((e, i) => {
    const resignedOn = addDays(TODAY, -ri(3, 55));
    const notice = e.probation ? 30 : 60;
    const lwd = addDays(resignedOn, notice);
    const started = ymd(lwd) <= ymd(TODAY);

    EXITS.push({
      id: 'EXT-' + (500 + i),
      empId: e.id,
      type: 'Resignation',
      resignedOn: ymd(resignedOn),
      noticeDays: notice,
      lwd: ymd(lwd),
      reason: pick(EXIT_REASONS),
      destination: pick(['Zoho', 'Freshworks', 'Razorpay', 'Amazon', 'A funded start-up', 'Higher studies — abroad', 'Not disclosed']),
      status: started
        ? pick(['In Clearance', 'Settled'] as ExitRecord['status'][])
        : pick(['Notice Period', 'Notice Period', 'Notice Period', 'In Clearance'] as ExitRecord['status'][]),
      buyout: chance(0.25) ? ri(10, 40) : 0,
      clearance: CLEARANCE_DEPTS.map((c) => ({
        ...c,
        done: started ? chance(0.8) : chance(0.25),
        on: null,
        owner: c.k,
      })),
      interview:
        started && chance(0.7)
          ? {
              done: true,
              wouldRejoin: chance(0.7),
              npsToCompany: ri(4, 10),
              ratings: { manager: ri(3, 5), growth: ri(2, 5), comp: ri(2, 4), culture: ri(3, 5), worklife: ri(2, 5) },
              comments: pick([
                'Loved the team and the ownership. Compensation was the main driver for the move.',
                'Great learning curve, but the growth path was not clearly defined.',
                'Manager support was excellent throughout.',
                'Long release cycles took a toll on work-life balance.',
              ]),
            }
          : { done: false },
    });
  });
})();

export const exitOf = (id: string): ExitRecord | undefined => EXITS.find((x) => x.empId === id);

export interface FnF {
  perDay: number;
  payDays: number;
  daysInMonth: number;
  salary: number;
  elDays: number;
  encash: number;
  yrs: number;
  gratuity: number;
  pending: number;
  noticeShort: number;
  loanDue: number;
  advDue: number;
  pf: number;
  ptax: number;
  tds: number;
  gross: number;
  ded: number;
  net: number;
}

/**
 * Full-and-final settlement: pay to the last working day, encashed earned
 * leave and gratuity, less statutory deductions and anything still owed.
 */
export function fnfSettlement(x: ExitRecord): FnF {
  const e = EMAP[x.empId];
  const s = salaryStructure(e);
  const perDay = Math.round(s.grossA / 365);
  const lwd = parseYmd(x.lwd);
  const daysInMonth = new Date(lwd.getFullYear(), lwd.getMonth() + 1, 0).getDate();
  const payDays = lwd.getDate();
  const salary = Math.round(((s.grossA / 12) * payDays) / daysInMonth);

  const el = leaveBalance(e.id, 'EL');
  const elDays = el ? Math.max(0, el.avail) : 0;
  const encash = Math.round(elDays * dailyRate(e));

  /* gratuity vests only after five years of continuous service */
  const yrs = Math.floor(daysBetween(e.doj, x.lwd) / 365);
  const gratuity = yrs >= 5 ? Math.round(((s.earnings[0].a / 12) * 15 * yrs) / 26) : 0;

  const noticeShort = x.buyout ? Math.round(perDay * x.buyout) : 0;
  const loanDue = sum(activeLoans(e.id), (l) => l.outstanding);
  const advDue = sum(
    ADVANCES.filter((a) => a.empId === e.id && a.status === 'Approved'),
    (a) => a.amount - a.settled,
  );
  const pending = sum(
    CLAIMS.filter((c) => c.empId === e.id && c.status === 'Approved'),
    (c) => c.total,
  );

  const gross = salary + encash + gratuity + pending;
  const pf = Math.round(Math.min(((s.earnings[0].a / 12) * payDays) / daysInMonth, PF_WAGE_CAP) * 0.12);
  const ptax = siteOf(e.site === 'WFH' ? 'CHN' : e.site).ptax;
  const tds = Math.round(taxNewRegime(s.grossA).total / 12);
  const ded = pf + ptax + tds + noticeShort + loanDue + advDue;

  return {
    perDay, payDays, daysInMonth, salary, elDays, encash, yrs, gratuity, pending,
    noticeShort, loanDue, advDue, pf, ptax, tds, gross, ded, net: gross - ded,
  };
}
