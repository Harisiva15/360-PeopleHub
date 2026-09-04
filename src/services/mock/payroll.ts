import { ACTIVE, EMAP } from '../../data/employees';
import { CUR_RUN, DECL, PAYRUNS, payrollTotals, payslip } from '../../data/payroll';
import { BANK_BATCHES, COMPLIANCE_PAYS, PAY_INPUTS } from '../../data/payinputs';
import { LOANS, loanEmiFor } from '../../data/loans';
import { comp, compAllow, dailyRate, salaryStructure } from '../../data/salary';
import type { CompRow, PayrollService, RegisterRow } from '../contracts';
import { ok } from './util';

/** Everyone who was on the books in time to be paid for that cycle. */
const paidIn = (mk: string) => ACTIVE().filter((e) => e.doj <= mk + '-28');

export const payrollService: PayrollService = {
  runs() {
    return ok(PAYRUNS.slice());
  },

  currentRun() {
    return ok(CUR_RUN);
  },

  totals(mk) {
    return ok(payrollTotals(mk));
  },

  totalsFor(mks) {
    const out: Record<string, ReturnType<typeof payrollTotals>> = {};
    mks.forEach((mk) => { out[mk] = payrollTotals(mk); });
    return ok(out);
  },

  register(mk) {
    const rows: RegisterRow[] = paidIn(mk).map((e) => ({
      employee: e,
      payslip: payslip(e, mk),
      loanEmi: loanEmiFor(e.id, mk),
    }));
    return ok(rows);
  },

  payslip(empId, mk) {
    const e = EMAP[empId];
    if (!e) return Promise.reject(new Error('No such employee: ' + empId));
    return ok(payslip(e, mk));
  },

  payslipHistory(empId) {
    const e = EMAP[empId];
    if (!e) return Promise.reject(new Error('No such employee: ' + empId));
    const runs = PAYRUNS.filter((r) => r.status === 'Paid' && r.mk >= e.doj.slice(0, 7));
    return ok(runs.map((run) => ({ run, payslip: payslip(e, run.mk) })));
  },

  dailyRates(empIds) {
    const out: Record<string, number> = {};
    empIds.forEach((id) => {
      const e = EMAP[id];
      if (e) out[id] = dailyRate(e);
    });
    return ok(out);
  },

  structure(empId) {
    const e = EMAP[empId];
    if (!e) return Promise.reject(new Error('No such employee: ' + empId));
    return ok(salaryStructure(e));
  },

  inputs(mk) {
    return ok(PAY_INPUTS[mk] || (PAY_INPUTS[mk] = {}));
  },

  compensation() {
    const rows: CompRow[] = ACTIVE().map((e) => {
      const s = salaryStructure(e);
      return { employee: e, salary: s, basicAnnual: comp(s, 0), allowanceAnnual: compAllow(s) };
    });
    return ok(rows);
  },

  declarations() {
    return ok(DECL);
  },

  bankBatches() {
    return ok(BANK_BATCHES.slice());
  },

  compliancePayments() {
    return ok(COMPLIANCE_PAYS.slice());
  },

  activeLoans() {
    return ok(LOANS.filter((l) => l.status === 'Active'));
  },

  /** A cycle is processed once; re-running a paid month is refused. */
  processRun(mk) {
    const run = PAYRUNS.find((r) => r.mk === mk);
    if (!run) return Promise.reject(new Error('No payroll cycle for ' + mk));
    if (run.status === 'Paid') return Promise.reject(new Error(mk + ' has already been paid'));
    run.status = 'Paid';
    return ok(run);
  },
};
