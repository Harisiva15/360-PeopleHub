/*
 * Does the server's payroll arithmetic agree with the prototype's?
 *
 * The rules were ported from `src/data/salary.ts` to
 * `server/src/modules/payroll/rules.ts` so a salary structure stops being
 * derived in the browser. A port is exactly the kind of change that looks
 * finished and is off by a rounding step, and payroll is the worst place to
 * find that out — so both implementations are run over the same inputs and
 * compared, rather than the new one being checked against numbers I typed out
 * by hand from the old one.
 *
 *   vite-node checks/payroll-rules.ts
 */

import {
  dailyRate, salaryStructure, taxCA, taxGB, taxNewRegime, taxOldRegime, taxUS,
} from '../src/data/salary';
import type { Employee } from '../src/types/employee';
import type { CountryId } from '../src/types/country';
import * as server from '../server/src/modules/payroll/rules.ts';

let failed = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed += 1;
    console.error(`  FAIL  ${label}\n        server: ${JSON.stringify(got)}\n        proto:  ${JSON.stringify(want)}`);
  }
  return ok;
};

/** The prototype's structure function needs an Employee; only three fields matter. */
const fakeEmployee = (ctc: number, country: CountryId): Employee =>
  ({ ctc, country, site: 'CHN' } as Employee);

const COUNTRIES: CountryId[] = ['IN', 'US', 'GB', 'AE', 'CA'];
const CTCS = [450_000, 900_000, 1_200_000, 2_400_000, 5_000_000, 12_000_000];

console.log('\npayroll rules: server vs prototype\n');

let compared = 0;
for (const country of COUNTRIES) {
  for (const ctc of CTCS) {
    const a = server.structureFor(ctc, country as server.Country);
    const b = salaryStructure(fakeEmployee(ctc, country));
    compared += 1;

    check(`${country} ${ctc} — gross`, a.grossA, b.grossA);
    check(`${country} ${ctc} — earnings`, a.earnings, b.earnings);
    check(`${country} ${ctc} — benefits`, a.benefits, b.benefits);
    check(`${country} ${ctc} — employer PF`, a.pfEmpr, b.pfEmpr);
    check(`${country} ${ctc} — gratuity`, a.gratuity, b.gratuity);
    check(`${country} ${ctc} — currency`, a.ccy, b.ccy);
    check(`${country} ${ctc} — daily rate`, server.dailyRateFor(a), dailyRate(fakeEmployee(ctc, country)));
  }
}
console.log(`  ok    ${compared} salary structures match across ${COUNTRIES.length} countries`);

/* ---- tax engines ---- */
const INCOMES = [300_000, 700_000, 1_150_000, 1_250_000, 2_000_000, 4_000_000, 9_000_000];
for (const income of INCOMES) {
  check(`new regime ${income}`, server.taxNewRegime(income), taxNewRegime(income));
  check(`old regime ${income}`, server.taxOldRegime(income, 150_000), taxOldRegime(income, 150_000));
  check(`US ${income}`, server.taxUS(income, 'NJ'), taxUS(income, 'NJ'));
  check(`CA ${income}`, server.taxCA(income), taxCA(income));
  check(`GB ${income} tax`, server.taxGB(income).tax, taxGB(income).tax);
}
console.log(`  ok    ${INCOMES.length} incomes priced identically in every tax engine`);

/* ---- the rebate boundaries, which are where a slab port goes wrong ---- */
check('new regime: 12L taxable is nil', server.taxNewRegime(1_275_000).total, 0);
check('new regime: a rupee over is not', server.taxNewRegime(1_275_001).total > 0, true);
check('old regime: 5L taxable is nil', server.taxOldRegime(550_000, 0).total, 0);
check('old regime: a rupee over is not', server.taxOldRegime(550_001, 0).total > 0, true);
console.log('  ok    rebate boundaries hold on both sides');

/* ---- HRA exemption: the least of the three tests ---- */
check('HRA — capped by the allowance itself',
  server.hraExemption(480_000, 240_000, 1_000_000, true), 240_000);
check('HRA — capped by rent less 10% of basic',
  server.hraExemption(480_000, 240_000, 200_000, true), 152_000);
check('HRA — capped at 40% of basic outside a metro',
  server.hraExemption(480_000, 240_000, 1_000_000, false), 192_000);
check('HRA — no rent, no exemption', server.hraExemption(480_000, 240_000, 0, true), 0);
console.log('  ok    HRA exemption takes the least of the three statutory tests');

/* ---- a month, end to end ---- */
const s = server.structureFor(1_200_000, 'IN');
const full = server.monthlySlip(s, 1);
check('a full month nets gross less deductions',
  full.net, full.gross - full.totalDeductions);
const half = server.monthlySlip(s, 0.5);
check('loss of pay scales every earning line, not just the total',
  half.earnings.every((l, i) => l.a === Math.round((s.earnings[i]?.a ?? l.a * 2) / 12 * 0.5)
    || l.tag === 'arrear' || l.tag === 'bonus'),
  true);
check('half a month is about half the gross',
  Math.abs(half.gross - full.gross / 2) <= s.earnings.length, true);

const withLoan = server.monthlySlip(s, 1, { loanEmi: 5000 });
check('a loan EMI is deducted', withLoan.totalDeductions - full.totalDeductions, 5000);
check('and does not change gross', withLoan.gross, full.gross);

const withReimb = server.monthlySlip(s, 1, { reimb: 3000 });
check('a reimbursement adds to net without being taxed',
  [withReimb.net - full.net, withReimb.gross - full.gross], [3000, 0]);
console.log('  ok    a month computes, scales and nets correctly');

console.log(failed
  ? `\n${failed} payroll rule check(s) FAILED`
  : '\nthe server payroll rules match the prototype exactly');
process.exit(failed ? 1 : 0);
