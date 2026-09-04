/* Shares the RNG stream with exits — this import fixes the draw order. */
import './exit';

import { sum } from '../lib/collections';
import { addDays, monthKey, parseYmd, TODAY, ymd } from '../lib/dates';
import { chance, ri } from '../lib/rng';
import { ACTIVE } from './employees';
import { BANKS } from './org';
import { salaryStructure } from './salary';
import { CLAIMS } from './expenses';
import { OVERTIME } from './shifts';
import { PAYRUNS, payrollTotals, setPayInputHook } from './payroll';
import type { PayInput, PayrollTotals } from './payroll';

/** mk -> empId -> off-cycle amounts riding along with that month's run. */
export const PAY_INPUTS: Record<string, Record<string, PayInput>> = {};

const EMPTY: PayInput = { bonus: 0, arrears: 0, incentive: 0, other: 0, reimb: 0 };

export function payInput(empId: string, mk: string): PayInput {
  return PAY_INPUTS[mk]?.[empId] || EMPTY;
}

/* Payroll is generated first, so it reads these through a hook. Installed
   before the batch/compliance generators below, which price whole runs. */
setPayInputHook(payInput);

(function genInputs() {
  PAYRUNS.forEach((r) => {
    PAY_INPUTS[r.mk] = {};
    ACTIVE().forEach((e) => {
      const o: PayInput = { bonus: 0, arrears: 0, incentive: 0, other: 0, reimb: 0 };

      /* April carries revision arrears; October carries the statutory bonus */
      if (r.mk.endsWith('-04') && chance(0.5)) o.arrears = Math.round((e.ctc * 0.02) / 100) * 100;
      if (r.mk.endsWith('-10') && chance(0.9)) o.bonus = Math.round((e.ctc * 0.083) / 100) * 100;
      if (e.dept === 'SALES' && chance(0.5)) o.incentive = ri(10, 90) * 1000;

      const reimb = CLAIMS.filter((c) => c.empId === e.id && c.status === 'Reimbursed' && c.payrollMonth === r.mk);
      o.reimb = sum(reimb, (c) => c.total);

      const ot = OVERTIME.filter(
        (t) => t.empId === e.id && t.status === 'Approved' && t.compensation === 'Overtime Pay' && monthKey(t.date) === r.mk,
      );
      if (ot.length) o.other += Math.round(sum(ot, (t) => t.hours) * (salaryStructure(e).grossA / 365 / 8) * 1.5);

      if (o.bonus || o.arrears || o.incentive || o.other || o.reimb) PAY_INPUTS[r.mk][e.id] = o;
    });
  });
})();

export interface BankBatch {
  mk: string;
  bank: string;
  mode: string;
  count: number;
  amount: number;
  status: string;
  utr: string;
  valueDate: string | null;
  file: string;
}

export const BANK_BATCHES: BankBatch[] = [];

(function genBatches() {
  PAYRUNS.filter((r) => r.status === 'Paid').forEach((r) => {
    BANK_BATCHES.push({
      mk: r.mk,
      bank: BANKS[0],
      mode: 'NEFT bulk upload',
      count: ACTIVE().length,
      amount: payrollTotals(r.mk).net,
      status: 'Paid',
      utr: 'HDFCN' + ri(10000000, 99999999),
      valueDate: r.paidOn,
      file: 'salary_advice_' + r.mk + '.csv',
    });
  });
})();

export interface ComplianceType {
  id: string;
  n: string;
  /** Day of the following month the remittance is due. */
  due: number;
  authority: string;
  /** Which payroll total funds it; null means a flat per-head levy. */
  key: keyof PayrollTotals | null;
}

export const COMPLIANCE_TYPES: ComplianceType[] = [
  { id: 'EPF', n: 'EPF (ECR)', due: 15, authority: 'EPFO Unified Portal', key: 'pf' },
  { id: 'ESI', n: 'ESI Contribution', due: 15, authority: 'ESIC Portal', key: 'esi' },
  { id: 'PT', n: 'Professional Tax', due: 20, authority: 'State Commercial Tax', key: 'pt' },
  { id: 'TDS', n: 'TDS — Section 192', due: 7, authority: 'Income Tax e-Pay', key: 'tds' },
  { id: 'LWF', n: 'Labour Welfare Fund', due: 31, authority: 'State Labour Dept', key: null },
];

export interface CompliancePayment {
  mk: string;
  type: string;
  name: string;
  amount: number;
  dueDate: string;
  authority: string;
  status: 'Paid' | 'Overdue' | 'Scheduled';
  challan: string | null;
  paidOn: string | null;
}

export const COMPLIANCE_PAYS: CompliancePayment[] = [];

(function genCompliance() {
  PAYRUNS.forEach((r) => {
    const t = payrollTotals(r.mk);
    const [Y, M] = r.mk.split('-').map(Number);
    COMPLIANCE_TYPES.forEach((c) => {
      const amt = c.key ? (t[c.key] as number) : ACTIVE().length * 20;
      const dueDate = ymd(new Date(Y, M, Math.min(c.due, new Date(Y, M + 1, 0).getDate())));
      const paid = r.status === 'Paid' && dueDate <= ymd(TODAY);
      COMPLIANCE_PAYS.push({
        mk: r.mk,
        type: c.id,
        name: c.n,
        amount: Math.round(amt),
        dueDate,
        authority: c.authority,
        status: paid ? 'Paid' : dueDate < ymd(TODAY) ? 'Overdue' : 'Scheduled',
        challan: paid ? c.id + '/' + ri(1000000, 9999999) : null,
        paidOn: paid ? ymd(addDays(parseYmd(dueDate), -ri(0, 3))) : null,
      });
    });
  });
})();

