/* Shares the RNG stream with timesheets — this import fixes the draw order. */
import './timesheet';

import { sum } from '../lib/collections';
import { addDays, monthKey, TODAY, ymd } from '../lib/dates';
import { chance, ri } from '../lib/rng';
import { ATT_IDX } from './attendance';
import { BASE_CCY, toBase } from './countries';
import { ACTIVE } from './employees';
import { siteOf } from './org';
import {
  comp,
  PF_WAGE_CAP,
  salaryStructure,
  taxCA,
  taxGB,
  taxNewRegime,
  taxOldRegime,
  taxUS,
} from './salary';
import type { CountryId, CurrencyId } from '../types/country';
import type { Employee } from '../types/employee';

/* ============================================================
   Pay runs
   ============================================================ */

export interface PayRun {
  /** Period as `YYYY-MM`. */
  mk: string;
  status: 'Draft' | 'Paid';
  runOn: string | null;
  paidOn: string | null;
  by: string;
  locked: boolean;
}

export const PAYRUNS: PayRun[] = [];

(function genRuns() {
  for (let i = 7; i >= 0; i--) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - i, 1);
    const isCur = i === 0;
    PAYRUNS.push({
      mk: monthKey(d),
      status: isCur ? 'Draft' : 'Paid',
      runOn: isCur ? null : ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
      paidOn: isCur ? null : ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
      by: 'Balaji Srinivasan',
      locked: !isCur,
    });
  }
})();

/** The month currently open for processing. */
export const CUR_RUN = PAYRUNS[PAYRUNS.length - 1];

/* ============================================================
   Tax declarations (Form 12BB)
   ============================================================ */

export type DeclStatus = 'Draft' | 'Submitted' | 'Verified';

export interface Declaration {
  regime: 'New' | 'Old';
  status: DeclStatus;
  submittedOn: string | null;
  items: Record<string, number | string>;
  proofs: string;
}

export const DECL: Record<string, Declaration> = {};

(function genDecl() {
  ACTIVE().forEach((e) => {
    const st: DeclStatus = chance(0.62) ? 'Submitted' : chance(0.5) ? 'Draft' : 'Verified';
    const s = salaryStructure(e);
    DECL[e.id] = {
      regime: chance(0.68) ? 'New' : 'Old',
      status: st,
      submittedOn: st === 'Draft' ? null : ymd(addDays(TODAY, -ri(20, 120))),
      items: {
        '80C_pf': Math.round(Math.min(s.earnings[0].a / 12, PF_WAGE_CAP) * 0.12 * 12),
        '80C_elss': chance(0.5) ? ri(10, 80) * 1000 : 0,
        '80C_lic': chance(0.55) ? ri(5, 40) * 1000 : 0,
        '80C_tuition': chance(0.3) ? ri(10, 60) * 1000 : 0,
        '80D_self': chance(0.6) ? ri(5, 25) * 1000 : 0,
        '80D_parents': chance(0.35) ? ri(10, 50) * 1000 : 0,
        '80CCD1B': chance(0.4) ? 50000 : 0,
        '80E': chance(0.15) ? ri(20, 90) * 1000 : 0,
        '80G': chance(0.18) ? ri(2, 25) * 1000 : 0,
        hra_rent: e.site !== 'WFH' && chance(0.7) ? ri(12, 45) * 1000 : 0,
        home_loan: chance(0.22) ? ri(60, 200) * 1000 : 0,
        landlord_pan: '',
      },
      proofs: st === 'Verified' ? 'All proofs verified' : st === 'Submitted' ? 'Proofs pending upload' : '',
    };
  });
})();

export interface DeclTotals {
  c80: number;
  d80: number;
  nps: number;
  e80: number;
  g80: number;
  /** Annualised rent paid, used for the HRA exemption. */
  hra: number;
  loan: number;
  total: number;
}

/** Applies each section's statutory cap. */
export function declTotals(empId: string): DeclTotals {
  const d = DECL[empId];
  if (!d) return { c80: 0, d80: 0, nps: 0, e80: 0, g80: 0, hra: 0, loan: 0, total: 0 };
  const i = d.items as Record<string, number>;
  const c80 = Math.min(150000, i['80C_pf'] + i['80C_elss'] + i['80C_lic'] + i['80C_tuition']);
  const d80 = Math.min(100000, i['80D_self'] + i['80D_parents']);
  const nps = Math.min(50000, i['80CCD1B']);
  const e80 = i['80E'];
  const g80 = Math.round(i['80G'] * 0.5);
  const loan = Math.min(200000, i.home_loan);
  return { c80, d80, nps, e80, g80, hra: i.hra_rent * 12, loan, total: c80 + d80 + nps + e80 + g80 + loan };
}

/** Least of: HRA received, rent over 10% of basic, or 50/40% of basic. */
export function hraExempt(e: Employee, annualRent: number): number {
  const s = salaryStructure(e);
  if (!annualRent) return 0;
  const metro = ['CHN', 'BLR', 'HYD'].includes(e.site);
  return Math.max(0, Math.min(comp(s, 1), annualRent - 0.1 * comp(s, 0), (metro ? 0.5 : 0.4) * comp(s, 0)));
}

/** Annual tax liability, applying the employee's declared regime in India. */
export function annualTaxFor(e: Employee): number {
  const s = salaryStructure(e);
  const cty = e.country || 'IN';
  if (cty === 'IN') {
    const d = DECL[e.id] || { regime: 'New' };
    if (d.regime === 'Old') {
      const t = declTotals(e.id);
      return taxOldRegime(s.grossA - hraExempt(e, t.hra), t.c80 + t.d80 + t.nps + t.e80 + t.g80 + t.loan).total;
    }
    return taxNewRegime(s.grossA).total;
  }
  if (cty === 'US') return taxUS(s.grossA, siteOf(e.site).id === 'DAL' ? 'TX' : 'NJ').total;
  if (cty === 'CA') return taxCA(s.grossA).total;
  if (cty === 'GB') return taxGB(s.grossA).total;
  return 0;
}

/* ============================================================
   Payslip
   ============================================================ */

export interface PayInput {
  bonus: number;
  arrears: number;
  incentive: number;
  other: number;
  reimb: number;
}

const NO_INPUT: PayInput = { bonus: 0, arrears: 0, incentive: 0, other: 0, reimb: 0 };

/*
 * Off-cycle inputs and loan recovery are generated by modules that must draw
 * from the RNG stream *after* this one, so importing them here would reorder
 * the dataset. They install themselves through these hooks instead, which
 * mirrors the prototype's `typeof PAY_INPUTS !== 'undefined'` guards.
 */
let payInputHook: (empId: string, mk: string) => PayInput = () => NO_INPUT;
let loanEmiHook: (empId: string, mk: string) => number = () => 0;

export const setPayInputHook = (f: typeof payInputHook): void => {
  payInputHook = f;
};
export const setLoanEmiHook = (f: typeof loanEmiHook): void => {
  loanEmiHook = f;
};

export interface PayLine {
  k: string;
  a: number;
  tag?: string;
}

export interface Statutory {
  pf: number;
  esi: number;
  pt: number;
  tax: number;
}

export interface Payslip {
  empId: string;
  mk: string;
  /** Days in the month. */
  dim: number;
  /** Unapproved absent days, docked from pay. */
  lop: number;
  payDays: number;
  earn: PayLine[];
  gross: number;
  ded: PayLine[];
  totalDed: number;
  reimb: number;
  net: number;
  /** Employer-side contributions, for cost reporting. */
  pfER: number;
  esiER: number;
  regime: string | null;
  annualTax: number;
  statutory: Statutory;
  country: CountryId;
  ccy: CurrencyId;
  ctcMonthly: number;
}

export function payslip(e: Employee, mk: string): Payslip {
  const s = salaryStructure(e);
  const [Y, M] = mk.split('-').map(Number);
  const dim = new Date(Y, M, 0).getDate();

  const recs = Object.values(ATT_IDX[e.id] || {}).filter((r) => r.date.slice(0, 7) === mk);
  const lop = recs.filter((r) => r.status === 'A' && (!r.reg || r.reg.status !== 'Approved')).length;
  const payDays = dim - lop;
  const f = payDays / dim;

  const earn: PayLine[] = s.earnings.map((x) => ({ k: x.k, tag: x.tag, a: Math.round((x.a / 12) * f) }));
  const basicM = earn[0].a;

  const inp = payInputHook(e.id, mk);
  if (inp.arrears) earn.push({ k: 'Arrears — salary revision', tag: 'arrear', a: inp.arrears });
  if (inp.bonus) earn.push({ k: 'Performance / statutory bonus', tag: 'bonus', a: inp.bonus });
  if (inp.incentive) earn.push({ k: 'Sales incentive', tag: 'incentive', a: inp.incentive });
  if (inp.other) earn.push({ k: 'Overtime payment', tag: 'ot', a: inp.other });

  const gross = sum(earn, (x) => x.a);
  const cty: CountryId = e.country || 'IN';
  const annualGross = s.grossA;
  const ded: PayLine[] = [];
  let pfER = 0;
  let esiER = 0;
  let regime: string | null = null;
  let annualTax = 0;
  let statutory: Statutory = { pf: 0, esi: 0, pt: 0, tax: 0 };

  if (cty === 'IN') {
    const pfEE = Math.round(Math.min(basicM, PF_WAGE_CAP) * 0.12);
    pfER = pfEE;
    const esiEE = gross <= 21000 ? Math.round(gross * 0.0075) : 0;
    esiER = gross <= 21000 ? Math.round(gross * 0.0325) : 0;
    const ptax = gross > 15000 ? siteOf(e.site === 'WFH' ? 'CHN' : e.site).ptax : gross > 10000 ? 130 : 0;
    const d = DECL[e.id] || { regime: 'New' };
    regime = d.regime;
    if (d.regime === 'Old') {
      const t = declTotals(e.id);
      annualTax = taxOldRegime(annualGross - hraExempt(e, t.hra), t.c80 + t.d80 + t.nps + t.e80 + t.g80 + t.loan).total;
    } else annualTax = taxNewRegime(annualGross).total;
    const tds = Math.round(annualTax / 12);
    ded.push({ k: 'Provident Fund (Employee)', a: pfEE });
    if (esiEE) ded.push({ k: 'ESI (Employee)', a: esiEE });
    ded.push({ k: 'Professional Tax', a: ptax });
    ded.push({ k: 'Income Tax (TDS)', a: tds });
    statutory = { pf: pfEE + pfER, esi: esiEE + esiER, pt: ptax, tax: tds };
  } else if (cty === 'US') {
    const st = siteOf(e.site).id === 'DAL' ? 'TX' : 'NJ';
    const t = taxUS(annualGross, st);
    const ss = Math.round(Math.min(gross, 168600 / 12) * 0.062);
    const mc = Math.round(gross * 0.0145);
    const k401 = Math.round(gross * 0.05);
    const health = 900;
    annualTax = t.total;
    ded.push({ k: 'Federal Income Tax', a: Math.round(t.federal / 12) });
    if (t.state) ded.push({ k: st + ' State Income Tax', a: Math.round(t.state / 12) });
    ded.push({ k: 'Social Security', a: ss });
    ded.push({ k: 'Medicare', a: mc });
    ded.push({ k: '401(k) Deferral (5%)', a: k401 });
    ded.push({ k: 'Medical / Dental / Vision', a: health });
    pfER = Math.round(gross * 0.04);
    esiER = ss + mc;
    statutory = { pf: k401 + pfER, esi: (ss + mc) * 2, pt: 0, tax: Math.round(t.total / 12) };
  } else if (cty === 'CA') {
    const t = taxCA(annualGross);
    const cpp = Math.round(Math.max(0, gross - 3500 / 12) * 0.0595);
    const ei = Math.round(gross * 0.0166);
    annualTax = t.total;
    ded.push({ k: 'Federal Income Tax', a: Math.round(t.federal / 12) });
    ded.push({ k: 'Ontario Provincial Tax', a: Math.round(t.provincial / 12) });
    ded.push({ k: 'CPP Contribution', a: cpp });
    ded.push({ k: 'Employment Insurance', a: ei });
    pfER = cpp;
    esiER = Math.round(ei * 1.4);
    statutory = { pf: cpp * 2, esi: ei + esiER, pt: Math.round(gross * 0.0195), tax: Math.round(t.total / 12) };
  } else if (cty === 'GB') {
    const t = taxGB(annualGross);
    const ni = Math.round(Math.max(0, gross - 1048) * 0.08);
    const pen = Math.round(Math.max(0, Math.min(gross, 4189) - 520) * 0.05);
    annualTax = t.total;
    ded.push({ k: 'PAYE Income Tax', a: Math.round(t.total / 12) });
    ded.push({ k: 'National Insurance (Class 1)', a: ni });
    ded.push({ k: 'Pension — Auto Enrolment (5%)', a: pen });
    pfER = Math.round(pen * 0.6);
    esiER = Math.round(Math.max(0, gross - 758) * 0.138);
    statutory = { pf: pen + pfER, esi: ni + esiER, pt: 0, tax: Math.round(t.total / 12) };
  } else if (cty === 'AE') {
    /* no personal income tax; GPSSA applies to UAE and GCC nationals only */
    annualTax = 0;
    statutory = { pf: 0, esi: 0, pt: 0, tax: 0 };
  }

  const emi = loanEmiHook(e.id, mk);
  if (emi) ded.push({ k: 'Loan / advance recovery', a: emi });

  const totalDed = sum(ded, (x) => x.a);
  const reimb = inp.reimb || 0;

  return {
    empId: e.id,
    mk,
    dim,
    lop,
    payDays,
    earn,
    gross,
    ded,
    totalDed,
    reimb,
    net: gross - totalDed + reimb,
    pfER,
    esiER,
    regime,
    annualTax,
    statutory,
    country: cty,
    ccy: e.ccy || 'INR',
    ctcMonthly: Math.round(e.ctc / 12),
  };
}

/* ============================================================
   Run totals
   ============================================================ */

export interface CountryTotals {
  count: number;
  gross: number;
  net: number;
  ded: number;
  ccy: CurrencyId;
  grossLocal: number;
  netLocal: number;
}

export interface PayrollTotals {
  count: number;
  gross: number;
  ded: number;
  net: number;
  pf: number;
  tds: number;
  esi: number;
  pt: number;
  lop: number;
  byCountry: Record<string, CountryTotals>;
  base: CurrencyId;
}

const PT_CACHE: Record<string, PayrollTotals> = {};

/** Call after mutating anything a payslip reads. */
export function clearPayrollCache(): void {
  Object.keys(PT_CACHE).forEach((k) => delete PT_CACHE[k]);
}

/** Whole-run totals for a month, consolidated into the INR reporting base. */
export function payrollTotals(mk: string): PayrollTotals {
  if (PT_CACHE[mk]) return PT_CACHE[mk];

  const list = ACTIVE().filter((e) => e.doj <= mk + '-28');
  let gross = 0;
  let ded = 0;
  let net = 0;
  let pf = 0;
  let tds = 0;
  let esi = 0;
  let pt = 0;
  let lop = 0;
  const byCountry: Record<string, CountryTotals> = {};

  list.forEach((e) => {
    const p = payslip(e, mk);
    const cc = e.ccy || 'INR';
    const b = (v: number) => toBase(v, cc);
    gross += b(p.gross);
    ded += b(p.totalDed);
    net += b(p.net);
    lop += p.lop;
    pf += b(p.statutory.pf);
    tds += b(p.statutory.tax);
    esi += b(p.statutory.esi);
    pt += b(p.statutory.pt);

    const k = e.country || 'IN';
    const t =
      byCountry[k] ||
      (byCountry[k] = { count: 0, gross: 0, net: 0, ded: 0, ccy: cc, grossLocal: 0, netLocal: 0 });
    t.count++;
    t.gross += b(p.gross);
    t.net += b(p.net);
    t.ded += b(p.totalDed);
    t.grossLocal += p.gross;
    t.netLocal += p.net;
  });

  const out: PayrollTotals = { count: list.length, gross, ded, net, pf, tds, esi, pt, lop, byCountry, base: BASE_CCY };
  PT_CACHE[mk] = out;
  return out;
}
