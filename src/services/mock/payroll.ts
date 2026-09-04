import { ACTIVE, EMAP } from '../../data/employees';
import { CUR_RUN, DECL, declTotals, hraExempt, PAYRUNS, payrollTotals, payslip } from '../../data/payroll';
import { BANK_BATCHES, COMPLIANCE_PAYS, PAY_INPUTS } from '../../data/payinputs';
import { LOANS, loanEmiFor } from '../../data/loans';
import { comp, compAllow, dailyRate, salaryStructure, taxNewRegime, taxOldRegime } from '../../data/salary';
import type { CompRow, PayrollService, RegisterRow, TaxRow, TaxSummary } from '../contracts';
import { ok } from './util';
import { TODAY, ymd } from '../../lib/dates';

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

  taxSummary(empId) {
    const e = EMAP[empId];
    if (!e) return Promise.reject(new Error('No such employee: ' + empId));
    const d = DECL[empId];
    if (!d) return Promise.reject(new Error('No declaration on file for ' + empId));
    const salary = salaryStructure(e);
    const totals = declTotals(empId);
    const hraExemption = hraExempt(e, totals.hra);
    /* Both regimes are priced on the same gross, so the comparison is honest. */
    const oldRegime = taxOldRegime(salary.grossA - hraExemption, totals.total);
    const newRegime = taxNewRegime(salary.grossA);
    return ok({
      declaration: d,
      salary,
      totals,
      hraExemption,
      oldRegime,
      newRegime,
      better: oldRegime.total <= newRegime.total ? 'Old' : 'New',
    } as TaxSummary);
  },

  taxRows() {
    const rows: TaxRow[] = ACTIVE().map((e) => {
      const d = DECL[e.id];
      const totals = declTotals(e.id);
      const salary = salaryStructure(e);
      const payable = d.regime === 'Old'
        ? taxOldRegime(salary.grossA - hraExempt(e, totals.hra), totals.total).total
        : taxNewRegime(salary.grossA).total;
      return { employee: e, declaration: d, totals, taxPayable: payable };
    });
    return ok(rows);
  },

  saveDeclaration(empId, items) {
    const d = DECL[empId];
    if (!d) return Promise.reject(new Error('No declaration on file for ' + empId));
    if (d.status === 'Verified') return Promise.reject(new Error('Finance has verified this declaration — raise a ticket to reopen it'));
    /* Only the keys the declaration already carries; the rest are numbers. */
    Object.keys(d.items).forEach((k) => {
      d.items[k] = k === 'landlord_pan' ? String(items[k] ?? '') : Number(items[k]) || 0;
    });
    d.status = 'Submitted';
    d.submittedOn = ymd(TODAY);
    return ok(d);
  },

  setRegime(empId, regime) {
    const d = DECL[empId];
    if (!d) return Promise.reject(new Error('No declaration on file for ' + empId));
    if (d.status === 'Verified') return Promise.reject(new Error('The regime is locked once Finance has verified the proofs'));
    d.regime = regime;
    return ok(d);
  },

  submitProofs(empId) {
    const d = DECL[empId];
    if (!d) return Promise.reject(new Error('No declaration on file for ' + empId));
    d.proofs = 'All proofs uploaded ' + ymd(TODAY);
    return ok(d);
  },

  verifyDeclaration(empId) {
    const d = DECL[empId];
    if (!d) return Promise.reject(new Error('No declaration on file for ' + empId));
    if (d.status === 'Draft') return Promise.reject(new Error('Nothing submitted to verify yet'));
    if (d.status === 'Verified') return Promise.reject(new Error('Already verified'));
    d.status = 'Verified';
    return ok(d);
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
