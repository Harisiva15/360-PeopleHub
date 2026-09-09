/**
 * Payroll arithmetic — salary structures and tax, per country.
 *
 * Kept separate from the service because these are pure functions over
 * numbers, and that is the only reason they can be checked properly. A payroll
 * rule buried inside a database transaction can only be tested by running a
 * payroll; here it is `structureFor(1200000, 'IN')` and an expected answer.
 *
 * These mirror the rules the browser prototype used, moved server-side because
 * a salary structure is not something a client should be deriving: the same
 * CTC has to break down identically for the payslip, the cost report and the
 * leave-encashment liability, and three copies in three screens will not.
 *
 * The figures are the statutory ones as configured for FY 2026-27. They belong
 * in a table before this is trusted for filings; they are constants here
 * because the tenant configuration to hold them does not exist yet, and a
 * wrong constant in one place is better than a wrong constant in four.
 */

export type Country = 'IN' | 'US' | 'GB' | 'AE' | 'CA';

export interface Line {
  k: string;
  a: number;
  tag?: string;
}

export interface Structure {
  ctc: number;
  ccy: string;
  country: Country;
  /** Paid to the employee; `earnings[0]` is always the basic/base component. */
  earnings: Line[];
  /** Employer-borne costs sitting on top of gross. */
  benefits: Line[];
  grossA: number;
  pfEmpr: number;
  gratuity: number;
  medIns: number;
}

/** Monthly wage ceiling for statutory PF in India. */
export const PF_WAGE_CAP = 15000;

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

const CCY: Record<Country, string> = {
  IN: 'INR', US: 'USD', GB: 'GBP', AE: 'AED', CA: 'CAD',
};

/** Break an annual CTC into the country's statutory salary structure. */
export function structureFor(ctc: number, country: Country): Structure {
  if (country === 'IN') {
    const basicA = Math.round(ctc * 0.4);
    const hraA = Math.round(basicA * 0.5);
    const ltaA = Math.round(basicA * 0.08);
    const pfEmpr = Math.round(Math.min(basicA / 12, PF_WAGE_CAP) * 0.12) * 12;
    const gratuity = Math.round(basicA * 0.0481);
    const medIns = 12000;
    const special = ctc - basicA - hraA - ltaA - pfEmpr - gratuity - medIns;
    return {
      ctc, ccy: 'INR', country,
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
      pfEmpr, gratuity, medIns,
    };
  }

  if (country === 'AE') {
    const basicA = Math.round(ctc * 0.6);
    const housing = Math.round(ctc * 0.25);
    const transport = Math.round(ctc * 0.1);
    const other = ctc - basicA - housing - transport;
    const gratuity = Math.round((basicA * 21) / 365);
    return {
      ctc, ccy: 'AED', country,
      earnings: [
        { k: 'Basic Salary', a: basicA, tag: 'basic' },
        { k: 'Housing Allowance', a: housing, tag: 'housing' },
        { k: 'Transport Allowance', a: transport, tag: 'transport' },
        { k: 'Other Allowance', a: other, tag: 'other' },
      ],
      benefits: [
        { k: 'End-of-Service Gratuity Accrual', a: gratuity },
        { k: 'Medical Insurance (DHA)', a: 4200 },
      ],
      grossA: ctc, pfEmpr: 0, gratuity, medIns: 4200,
    };
  }

  if (country === 'US') {
    const base = Math.round(ctc / 1.225 / 100) * 100;
    const fica = Math.round(base * 0.0765);
    const match = Math.round(base * 0.04);
    return {
      ctc, ccy: 'USD', country,
      earnings: [{ k: 'Base Salary', a: base, tag: 'basic' }],
      benefits: [
        { k: 'Employer FICA (Social Security + Medicare)', a: fica },
        { k: '401(k) Safe-Harbour Match (4%)', a: match },
        { k: 'Medical, Dental & Vision Premium', a: 10800 },
        { k: 'FUTA / SUTA', a: 620 },
      ],
      grossA: base, pfEmpr: match, gratuity: 0, medIns: 10800,
    };
  }

  if (country === 'CA') {
    const base = Math.round(ctc / 1.17 / 100) * 100;
    const cpp = Math.round(Math.min(base, 68500) * 0.0595);
    const ei = Math.round(Math.min(base, 63200) * 0.0166 * 1.4);
    return {
      ctc, ccy: 'CAD', country,
      earnings: [{ k: 'Base Salary', a: base, tag: 'basic' }],
      benefits: [
        { k: 'Employer CPP', a: cpp },
        { k: 'Employer EI (1.4×)', a: ei },
        { k: 'Employer Health Tax (Ontario)', a: Math.round(base * 0.0195) },
        { k: 'Group Benefits', a: 4800 },
      ],
      grossA: base, pfEmpr: cpp, gratuity: 0, medIns: 4800,
    };
  }

  const base = Math.round(ctc / 1.19 / 100) * 100;
  const ni = Math.round(Math.max(0, base - 9100) * 0.138);
  const pension = Math.round(Math.max(0, Math.min(base, 50270) - 6240) * 0.03);
  return {
    ctc, ccy: 'GBP', country: 'GB',
    earnings: [{ k: 'Annual Gross Salary', a: base, tag: 'basic' }],
    benefits: [
      { k: 'Employer National Insurance (13.8%)', a: ni },
      { k: 'Employer Pension (3%)', a: pension },
      { k: 'Private Medical Insurance', a: 1200 },
    ],
    grossA: base, pfEmpr: pension, gratuity: 0, medIns: 1200,
  };
}

export const currencyFor = (country: Country): string => CCY[country] ?? 'INR';

/* ---- tax engines, annual ---- */

/** India new regime — 75,000 standard deduction, rebate up to 12L. */
export function taxNewRegime(income: number) {
  const t = Math.max(0, income - 75000);
  const tax0 = slabTax(t, [
    [400000, 0], [800000, 0.05], [1200000, 0.1], [1600000, 0.15],
    [2000000, 0.2], [2400000, 0.25], [Infinity, 0.3],
  ]);
  const tax = t <= 1200000 ? 0 : tax0;
  return { taxable: t, tax: Math.round(tax), cess: Math.round(tax * 0.04), total: Math.round(tax * 1.04) };
}

/** India old regime — 50,000 standard deduction plus declared investments. */
export function taxOldRegime(income: number, deductions = 0) {
  const t = Math.max(0, income - 50000 - deductions);
  const tax0 = slabTax(t, [[250000, 0], [500000, 0.05], [1000000, 0.2], [Infinity, 0.3]]);
  const tax = t <= 500000 ? 0 : tax0;
  return { taxable: t, tax: Math.round(tax), cess: Math.round(tax * 0.04), total: Math.round(tax * 1.04) };
}

export function taxUS(income: number, state?: string) {
  const t = Math.max(0, income - 14600);
  const fed = slabTax(t, [
    [11600, 0.1], [47150, 0.12], [100525, 0.22], [191950, 0.24],
    [243725, 0.32], [609350, 0.35], [Infinity, 0.37],
  ]);
  const rates: Record<string, number> = { NJ: 0.055, NY: 0.0625, CA: 0.08, TX: 0, FL: 0, WA: 0 };
  const rate = rates[state ?? ''];
  const st = t * (rate == null ? 0.05 : rate);
  return { taxable: t, federal: Math.round(fed), state: Math.round(st), total: Math.round(fed + st) };
}

export function taxCA(income: number) {
  const t = Math.max(0, income - 15705);
  const fed = slabTax(t, [[55867, 0.15], [111733, 0.205], [173205, 0.26], [246752, 0.29], [Infinity, 0.33]]);
  const on = slabTax(t, [[51446, 0.0505], [102894, 0.0915], [150000, 0.1116], [220000, 0.1216], [Infinity, 0.1316]]);
  return { taxable: t, federal: Math.round(fed), provincial: Math.round(on), total: Math.round(fed + on) };
}

/** UK PAYE — the personal allowance tapers away above 100,000. */
export function taxGB(income: number) {
  const pa = income > 100000 ? Math.max(0, 12570 - (income - 100000) / 2) : 12570;
  const t = Math.max(0, income - pa);
  return { taxable: t, tax: Math.round(slabTax(t, [[37700, 0.2], [112570, 0.4], [Infinity, 0.45]])), total: 0 };
}

/**
 * HRA exemption — the least of the three statutory tests.
 *
 * Metro status changes the third test from 40% to 50% of basic, which is worth
 * real money, so it is a parameter rather than an assumption.
 */
export function hraExemption(
  basicA: number, hraA: number, rentPaidA: number, metro: boolean,
): number {
  if (rentPaidA <= 0) return 0;
  return Math.max(0, Math.round(Math.min(
    hraA,
    rentPaidA - basicA * 0.1,
    basicA * (metro ? 0.5 : 0.4),
  )));
}

export interface Statutory { pf: number; esi: number; pt: number; tax: number }

export interface MonthlySlip {
  earnings: Line[];
  deductions: Line[];
  employer: Line[];
  gross: number;
  totalDeductions: number;
  reimbursements: number;
  net: number;
  pfER: number;
  esiER: number;
  annualTax: number;
  statutory: Statutory;
}

export interface MonthlyInputs {
  bonus?: number;
  arrears?: number;
  incentive?: number;
  other?: number;
  reimb?: number;
  /** Loan EMI recovered this month. */
  loanEmi?: number;
}

/**
 * One month's payslip for a structure.
 *
 * `payFraction` is paid days over days in month — loss of pay scales every
 * earning line, not just the total, because a payslip has to show what was
 * actually paid against each component.
 */
export function monthlySlip(
  s: Structure,
  payFraction: number,
  inputs: MonthlyInputs = {},
  opts: { professionalTax?: number; regime?: 'new' | 'old'; oldRegimeDeductions?: number;
          hraExempt?: number; usState?: string } = {},
): MonthlySlip {
  const earnings: Line[] = s.earnings.map((x) => ({
    k: x.k, a: Math.round((x.a / 12) * payFraction), ...(x.tag ? { tag: x.tag } : {}),
  }));
  const basicM = earnings[0]?.a ?? 0;

  if (inputs.arrears) earnings.push({ k: 'Arrears — salary revision', tag: 'arrear', a: inputs.arrears });
  if (inputs.bonus) earnings.push({ k: 'Performance / statutory bonus', tag: 'bonus', a: inputs.bonus });
  if (inputs.incentive) earnings.push({ k: 'Sales incentive', tag: 'incentive', a: inputs.incentive });
  if (inputs.other) earnings.push({ k: 'Overtime payment', tag: 'ot', a: inputs.other });

  const gross = earnings.reduce((a, x) => a + x.a, 0);
  const deductions: Line[] = [];
  const employer: Line[] = [];
  let pfER = 0;
  let esiER = 0;
  let annualTax = 0;
  let statutory: Statutory = { pf: 0, esi: 0, pt: 0, tax: 0 };

  if (s.country === 'IN') {
    const pfEE = Math.round(Math.min(basicM, PF_WAGE_CAP) * 0.12);
    pfER = pfEE;
    const esiEE = gross <= 21000 ? Math.round(gross * 0.0075) : 0;
    esiER = gross <= 21000 ? Math.round(gross * 0.0325) : 0;
    const ptax = gross > 15000 ? (opts.professionalTax ?? 208) : gross > 10000 ? 130 : 0;

    annualTax = opts.regime === 'old'
      ? taxOldRegime(s.grossA - (opts.hraExempt ?? 0), opts.oldRegimeDeductions ?? 0).total
      : taxNewRegime(s.grossA).total;
    const tds = Math.round(annualTax / 12);

    deductions.push({ k: 'Provident Fund (Employee)', a: pfEE, tag: 'statutory' });
    if (esiEE) deductions.push({ k: 'ESI (Employee)', a: esiEE, tag: 'statutory' });
    deductions.push({ k: 'Professional Tax', a: ptax, tag: 'statutory' });
    deductions.push({ k: 'Income Tax (TDS)', a: tds, tag: 'statutory' });
    employer.push({ k: 'Employer PF Contribution', a: pfER });
    if (esiER) employer.push({ k: 'Employer ESI', a: esiER });
    statutory = { pf: pfEE + pfER, esi: esiEE + esiER, pt: ptax, tax: tds };
  } else if (s.country === 'US') {
    const t = taxUS(s.grossA, opts.usState);
    const ss = Math.round(Math.min(gross, 168600 / 12) * 0.062);
    const mc = Math.round(gross * 0.0145);
    annualTax = t.total;
    deductions.push({ k: 'Federal Income Tax', a: Math.round(t.federal / 12), tag: 'statutory' });
    if (t.state) {
      deductions.push({ k: `${opts.usState ?? ''} State Income Tax`.trim(), a: Math.round(t.state / 12), tag: 'statutory' });
    }
    deductions.push({ k: 'Social Security', a: ss, tag: 'statutory' });
    deductions.push({ k: 'Medicare', a: mc, tag: 'statutory' });
    deductions.push({ k: '401(k) Deferral (5%)', a: Math.round(gross * 0.05) });
    deductions.push({ k: 'Medical / Dental / Vision', a: 900 });
    pfER = Math.round(gross * 0.04);
    esiER = ss + mc;
    employer.push({ k: 'Employer FICA', a: esiER });
    employer.push({ k: '401(k) Match', a: pfER });
    statutory = { pf: Math.round(gross * 0.05) + pfER, esi: (ss + mc) * 2, pt: 0, tax: Math.round(t.total / 12) };
  } else if (s.country === 'CA') {
    const t = taxCA(s.grossA);
    const cpp = Math.round(Math.max(0, gross - 3500 / 12) * 0.0595);
    const ei = Math.round(gross * 0.0166);
    annualTax = t.total;
    deductions.push({ k: 'Federal Income Tax', a: Math.round(t.federal / 12), tag: 'statutory' });
    deductions.push({ k: 'Ontario Provincial Tax', a: Math.round(t.provincial / 12), tag: 'statutory' });
    deductions.push({ k: 'CPP Contribution', a: cpp, tag: 'statutory' });
    deductions.push({ k: 'Employment Insurance', a: ei, tag: 'statutory' });
    pfER = cpp;
    esiER = Math.round(ei * 1.4);
    employer.push({ k: 'Employer CPP', a: cpp });
    employer.push({ k: 'Employer EI', a: esiER });
    statutory = { pf: cpp * 2, esi: ei + esiER, pt: Math.round(gross * 0.0195), tax: Math.round(t.total / 12) };
  } else if (s.country === 'GB') {
    const t = taxGB(s.grossA);
    const ni = Math.round(Math.max(0, gross - 1048) * 0.08);
    const pen = Math.round(Math.max(0, Math.min(gross, 4189) - 520) * 0.05);
    annualTax = t.tax;
    deductions.push({ k: 'PAYE Income Tax', a: Math.round(t.tax / 12), tag: 'statutory' });
    deductions.push({ k: 'National Insurance', a: ni, tag: 'statutory' });
    deductions.push({ k: 'Workplace Pension (5%)', a: pen });
    pfER = Math.round(Math.max(0, Math.min(gross, 4189) - 520) * 0.03);
    esiER = Math.round(Math.max(0, gross - 758) * 0.138);
    employer.push({ k: 'Employer National Insurance', a: esiER });
    employer.push({ k: 'Employer Pension', a: pfER });
    statutory = { pf: pen + pfER, esi: ni + esiER, pt: 0, tax: Math.round(t.tax / 12) };
  }
  // AE has no payroll tax and no social insurance for expatriates, so the
  // deduction list is genuinely empty rather than accidentally so.

  if (inputs.loanEmi) {
    deductions.push({ k: 'Staff loan recovery', a: inputs.loanEmi, tag: 'loan' });
  }

  const totalDeductions = deductions.reduce((a, x) => a + x.a, 0);
  const reimbursements = inputs.reimb ?? 0;

  return {
    earnings, deductions, employer, gross, totalDeductions, reimbursements,
    net: gross - totalDeductions + reimbursements,
    pfER, esiER, annualTax, statutory,
  };
}

/**
 * Daily rate for leave encashment and notice recovery.
 *
 * India uses basic + HRA by convention; elsewhere the full gross applies.
 */
export function dailyRateFor(s: Structure): number {
  const basic = s.earnings[0]?.a ?? 0;
  const hra = s.earnings[1]?.a ?? 0;
  return Math.round((s.country === 'IN' ? basic + hra : s.grossA) / 365);
}
