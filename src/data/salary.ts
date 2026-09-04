import { sum } from '../lib/collections';
import type { CountryId, CurrencyId } from '../types/country';
import type { Employee } from '../types/employee';

/** Monthly wage ceiling for statutory PF in India. */
export const PF_WAGE_CAP = 15000;

export interface SalaryLine {
  k: string;
  a: number;
  tag?: string;
}

export interface SalaryStructure {
  ctc: number;
  ccy: CurrencyId;
  country: CountryId;
  /** Paid to the employee; `earnings[0]` is always the basic/base component. */
  earnings: SalaryLine[];
  /** Employer-borne costs sitting on top of gross. */
  benefits: SalaryLine[];
  grossA: number;
  pfEmpr: number;
  gratuity: number;
  medIns: number;
}

/** Progressive slab tax. `slabs` is [[upTo, rate], ...] in ascending order. */
export function slabTax(taxable: number, slabs: [number, number][]): number {
  let tax = 0;
  let prev = 0;
  for (const [cap, rate] of slabs) {
    if (taxable > prev) {
      tax += (Math.min(taxable, cap) - prev) * rate;
      prev = cap;
    } else break;
  }
  return Math.max(0, tax);
}

/**
 * Break an annual CTC into the country's statutory salary structure.
 * Each pack mirrors how that jurisdiction actually constructs pay.
 */
export function salaryStructure(e: Employee): SalaryStructure {
  const cty: CountryId = e.country || 'IN';
  const ctc = e.ctc;

  if (cty === 'IN') {
    const basicA = Math.round(ctc * 0.4);
    const hraA = Math.round(basicA * 0.5);
    const ltaA = Math.round(basicA * 0.08);
    const pfEmpr = Math.round(Math.min(basicA / 12, PF_WAGE_CAP) * 0.12) * 12;
    const gratuity = Math.round(basicA * 0.0481);
    const medIns = 12000;
    const special = ctc - basicA - hraA - ltaA - pfEmpr - gratuity - medIns;
    return {
      ctc,
      ccy: 'INR',
      country: cty,
      earnings: [
        { k: 'Basic Salary', a: basicA, tag: 'basic' },
        { k: 'House Rent Allowance', a: hraA, tag: 'hra' },
        { k: 'Leave Travel Allowance', a: ltaA, tag: 'lta' },
        { k: 'Special Allowance', a: special, tag: 'special' },
      ],
      benefits: [
        { k: 'Employer PF Contribution', a: pfEmpr },
        { k: 'Gratuity Accrual', a: gratuity },
        { k: 'Group Medical Insurance', a: medIns },
      ],
      grossA: basicA + hraA + ltaA + special,
      pfEmpr,
      gratuity,
      medIns,
    };
  }

  if (cty === 'AE') {
    const basicA = Math.round(ctc * 0.6);
    const housing = Math.round(ctc * 0.25);
    const transport = Math.round(ctc * 0.1);
    const other = ctc - basicA - housing - transport;
    const gratuity = Math.round((basicA * 21) / 365);
    const medIns = 4200;
    return {
      ctc,
      ccy: 'AED',
      country: cty,
      earnings: [
        { k: 'Basic Salary', a: basicA, tag: 'basic' },
        { k: 'Housing Allowance', a: housing, tag: 'housing' },
        { k: 'Transport Allowance', a: transport, tag: 'transport' },
        { k: 'Other Allowance', a: other, tag: 'other' },
      ],
      benefits: [
        { k: 'End-of-Service Gratuity Accrual', a: gratuity },
        { k: 'Medical Insurance (DHA)', a: medIns },
      ],
      grossA: ctc,
      pfEmpr: 0,
      gratuity,
      medIns,
    };
  }

  if (cty === 'US') {
    const base = Math.round(ctc / 1.225 / 100) * 100;
    const fica = Math.round(base * 0.0765);
    const match = Math.round(base * 0.04);
    const health = 10800;
    return {
      ctc,
      ccy: 'USD',
      country: cty,
      earnings: [{ k: 'Base Salary', a: base, tag: 'basic' }],
      benefits: [
        { k: 'Employer FICA (Social Security + Medicare)', a: fica },
        { k: '401(k) Safe-Harbour Match (4%)', a: match },
        { k: 'Medical, Dental & Vision Premium', a: health },
        { k: 'FUTA / SUTA', a: 620 },
      ],
      grossA: base,
      pfEmpr: match,
      gratuity: 0,
      medIns: health,
    };
  }

  if (cty === 'CA') {
    const base = Math.round(ctc / 1.17 / 100) * 100;
    const cpp = Math.round(Math.min(base, 68500) * 0.0595);
    const ei = Math.round(Math.min(base, 63200) * 0.0166 * 1.4);
    const eht = Math.round(base * 0.0195);
    const health = 4800;
    return {
      ctc,
      ccy: 'CAD',
      country: cty,
      earnings: [{ k: 'Base Salary', a: base, tag: 'basic' }],
      benefits: [
        { k: 'Employer CPP', a: cpp },
        { k: 'Employer EI (1.4×)', a: ei },
        { k: 'Employer Health Tax (Ontario)', a: eht },
        { k: 'Group Benefits', a: health },
      ],
      grossA: base,
      pfEmpr: cpp,
      gratuity: 0,
      medIns: health,
    };
  }

  /* GB */
  const base = Math.round(ctc / 1.19 / 100) * 100;
  const ni = Math.round(Math.max(0, base - 9100) * 0.138);
  const pension = Math.round(Math.max(0, Math.min(base, 50270) - 6240) * 0.03);
  const health = 1200;
  return {
    ctc,
    ccy: 'GBP',
    country: 'GB',
    earnings: [{ k: 'Annual Gross Salary', a: base, tag: 'basic' }],
    benefits: [
      { k: 'Employer National Insurance (13.8%)', a: ni },
      { k: 'Employer Pension (3%)', a: pension },
      { k: 'Private Medical Insurance', a: health },
    ],
    grossA: base,
    pfEmpr: pension,
    gratuity: 0,
    medIns: health,
  };
}

/* ---- safe component accessors — structures differ by country ---- */
export const comp = (s: SalaryStructure, i: number): number => (s.earnings[i] ? s.earnings[i].a : 0);
export const compAllow = (s: SalaryStructure): number => sum(s.earnings.slice(1), (x) => x.a);

/**
 * Daily rate for leave encashment and notice recovery. India uses basic + HRA
 * by convention; elsewhere the full gross applies.
 */
export function dailyRate(e: Employee): number {
  const s = salaryStructure(e);
  return Math.round((e.country === 'IN' ? comp(s, 0) + comp(s, 1) : s.grossA) / 365);
}

/* ---- country tax engines (annual) ---- */

export interface INTax {
  taxable: number;
  tax: number;
  cess: number;
  total: number;
}

/** India new regime — ₹75,000 standard deduction, rebate up to ₹12L. */
export function taxNewRegime(income: number): INTax {
  const std = 75000;
  const t = Math.max(0, income - std);
  const tax0 = slabTax(t, [
    [400000, 0], [800000, 0.05], [1200000, 0.1], [1600000, 0.15],
    [2000000, 0.2], [2400000, 0.25], [Infinity, 0.3],
  ]);
  const tax = t <= 1200000 ? 0 : tax0;
  return { taxable: t, tax: Math.round(tax), cess: Math.round(tax * 0.04), total: Math.round(tax * 1.04) };
}

/** India old regime — ₹50,000 standard deduction plus declared investments. */
export function taxOldRegime(income: number, ded?: number): INTax {
  const std = 50000;
  const t = Math.max(0, income - std - (ded || 0));
  const tax0 = slabTax(t, [[250000, 0], [500000, 0.05], [1000000, 0.2], [Infinity, 0.3]]);
  const tax = t <= 500000 ? 0 : tax0;
  return { taxable: t, tax: Math.round(tax), cess: Math.round(tax * 0.04), total: Math.round(tax * 1.04) };
}

export function taxUS(income: number, state?: string) {
  const std = 14600;
  const t = Math.max(0, income - std);
  const fed = slabTax(t, [
    [11600, 0.1], [47150, 0.12], [100525, 0.22], [191950, 0.24],
    [243725, 0.32], [609350, 0.35], [Infinity, 0.37],
  ]);
  const rates: Record<string, number> = { NJ: 0.055, NY: 0.0625, CA: 0.08, TX: 0, FL: 0, WA: 0 };
  const st = t * (rates[state ?? ''] == null ? 0.05 : rates[state ?? '']);
  return { taxable: t, federal: Math.round(fed), state: Math.round(st), total: Math.round(fed + st) };
}

/** Canada — federal plus Ontario provincial. */
export function taxCA(income: number) {
  const t = Math.max(0, income - 15705);
  const fed = slabTax(t, [[55867, 0.15], [111733, 0.205], [173205, 0.26], [246752, 0.29], [Infinity, 0.33]]);
  const on = slabTax(t, [[51446, 0.0505], [102894, 0.0915], [150000, 0.1116], [220000, 0.1216], [Infinity, 0.1316]]);
  return { taxable: t, federal: Math.round(fed), provincial: Math.round(on), total: Math.round(fed + on) };
}

/** UK PAYE — personal allowance tapers away above £100,000. */
export function taxGB(income: number) {
  const pa = income > 100000 ? Math.max(0, 12570 - (income - 100000) / 2) : 12570;
  const t = Math.max(0, income - pa);
  const tax = slabTax(t, [[37700, 0.2], [112570, 0.4], [Infinity, 0.45]]);
  return { taxable: t, tax: Math.round(tax), total: Math.round(tax) };
}
