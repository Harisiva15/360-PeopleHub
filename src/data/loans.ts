/* Shares the RNG stream with expenses — this import fixes the draw order. */
import './expenses';

import { sum } from '../lib/collections';
import { addDays, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri } from '../lib/rng';
import { ACTIVE } from './employees';
import { setLoanEmiHook } from './payroll';

export interface LoanType {
  id: string;
  n: string;
  /** Cap on principal, as a multiple of monthly CTC. */
  maxMult: number;
  maxTenure: number;
  rate: number;
}

export const LOAN_TYPES: LoanType[] = [
  { id: 'SALADV', n: 'Salary Advance', maxMult: 1, maxTenure: 6, rate: 0 },
  { id: 'PERSONAL', n: 'Personal Loan', maxMult: 3, maxTenure: 24, rate: 6 },
  { id: 'EMERGENCY', n: 'Medical / Emergency Loan', maxMult: 2, maxTenure: 12, rate: 0 },
];

export interface Loan {
  id: string;
  empId: string;
  type: string;
  principal: number;
  tenure: number;
  emi: number;
  /** Instalments already recovered. */
  paidN: number;
  outstanding: number;
  sanctionedOn: string;
  status: 'Active' | 'Closed' | 'Pending Approval';
  reason: string;
}

export const LOANS: Loan[] = [];

(function genLoans() {
  ACTIVE()
    .filter(() => chance(0.11))
    .forEach((e) => {
      const t = pick(LOAN_TYPES);
      const principal = Math.round(Math.min((e.ctc / 12) * t.maxMult, ri(50, 400) * 1000) / 1000) * 1000;
      const tenure = ri(3, t.maxTenure);
      const emi = Math.round((principal * (1 + t.rate / 100)) / tenure);
      const paidN = ri(0, tenure - 1);
      LOANS.push({
        id: 'LN-' + (7100 + LOANS.length),
        empId: e.id,
        type: t.id,
        principal,
        tenure,
        emi,
        paidN,
        outstanding: Math.max(0, principal - emi * paidN),
        sanctionedOn: ymd(addDays(TODAY, -paidN * 30 - ri(5, 25))),
        status: paidN >= tenure ? 'Closed' : chance(0.12) ? 'Pending Approval' : 'Active',
        reason: pick(['Home renovation', 'Medical emergency in family', 'Child education fee', 'Vehicle purchase', 'Wedding expenses']),
      });
    });
})();

export const activeLoans = (id: string): Loan[] => LOANS.filter((l) => l.empId === id && l.status === 'Active');

/** Total instalment to recover from a given month's payroll. */
export function loanEmiFor(empId: string, mk: string): number {
  return sum(
    LOANS.filter((l) => l.empId === empId && l.status === 'Active' && l.sanctionedOn.slice(0, 7) <= mk),
    (l) => l.emi,
  );
}

/* Payroll is generated before this module, so it picks recovery up by hook. */
setLoanEmiHook(loanEmiFor);
