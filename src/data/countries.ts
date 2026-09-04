import { clamp } from '../lib/format';
import { ri } from '../lib/rng';
import type { Country, CountryId, CurrencyId, Grade } from '../types/country';

/**
 * Legal entities the group employs through. `fx` converts local currency into
 * the INR reporting base; `bands` are market salary ranges in local currency.
 */
export const COUNTRIES: Country[] = [
  {
    id: 'IN', name: 'India', short: 'India', flag: '🇮🇳', cur: 'INR', sym: '₹', fx: 1, factor: 1, grouping: 'lakh',
    entity: '360VHM Technology Private Limited', reg: 'CIN U72900TN2014PTC098231 · PAN AAFC3600Q · TAN CHEA13600B',
    addr: 'Prestige Palladium, 5th Floor, OMR, Perungudi, Chennai 600096',
    payFreq: 'Monthly', payDay: '1st of following month', fy: 'Apr–Mar', tz: 'Asia/Kolkata',
    struct: 'IN', empTax: 'TDS (Section 192)',
    statutory: [
      { k: 'Provident Fund', d: '12% of basic, capped at ₹15,000 wages — employee and employer', due: '15th' },
      { k: 'ESI', d: '0.75% employee / 3.25% employer where gross ≤ ₹21,000', due: '15th' },
      { k: 'Professional Tax', d: 'State slab, ₹200–₹208 per month', due: '15th–20th' },
      { k: 'TDS', d: 'Section 192 monthly average method', due: '7th' },
      { k: 'Gratuity', d: '15/26 × last basic × years, after 5 years', due: 'On exit' }
    ],
    leaveSet: ['CL', 'SL', 'EL', 'CO', 'ML', 'PL', 'LOP'], noticeDays: 60, probationDays: 180,
    bands: { L1: [450000, 750000], L2: [750000, 1300000], L3: [1300000, 2100000], L4: [2100000, 3400000], L5: [3400000, 5500000], L6: [5500000, 9000000] }, holidays: 'IN', wage: 'Cost to Company (CTC)'
  },
  {
    id: 'US', name: 'United States', short: 'USA', flag: '🇺🇸', cur: 'USD', sym: '$', fx: 84.2, factor: 3.6, grouping: 'western',
    entity: '360VHM Technology Inc.', reg: 'EIN 84-3921745 · Delaware C-Corp · NJ SUI 023-441-882',
    addr: '2 Tower Center Boulevard, Suite 1101, East Brunswick, NJ 08816',
    payFreq: 'Semi-monthly', payDay: '15th and last working day', fy: 'Jan–Dec', tz: 'America/New_York',
    struct: 'US', empTax: 'Federal + State withholding',
    statutory: [
      { k: 'Social Security (FICA)', d: '6.2% employee + 6.2% employer up to the wage base', due: 'Per pay run' },
      { k: 'Medicare', d: '1.45% each, plus 0.9% additional above $200,000', due: 'Per pay run' },
      { k: 'Federal income tax', d: 'Withheld per Form W-4, percentage method', due: 'Semi-weekly deposit' },
      { k: 'State income tax', d: 'By work state — NJ, TX (nil), CA, NY', due: 'State schedule' },
      { k: 'FUTA / SUTA', d: 'Employer unemployment insurance', due: 'Quarterly (Form 940 / 941)' },
      { k: '401(k)', d: 'Employee deferral with 4% employer safe-harbour match', due: 'Per pay run' }
    ],
    leaveSet: ['PTO', 'SICK', 'FMLA', 'LOP'], noticeDays: 14, probationDays: 90,
    bands: { L1: [58000, 78000], L2: [80000, 115000], L3: [118000, 158000], L4: [162000, 205000], L5: [210000, 275000], L6: [280000, 420000] }, holidays: 'US', wage: 'Annual base salary'
  },
  {
    id: 'CA', name: 'Canada', short: 'Canada', flag: '🇨🇦', cur: 'CAD', sym: 'C$', fx: 61.8, factor: 2.6, grouping: 'western',
    entity: '360VHM Technology Canada Inc.', reg: 'BN 79210 4471 RP0001 · Ontario',
    addr: '5140 Yonge Street, Suite 1600, Toronto, ON M2N 6L7',
    payFreq: 'Bi-weekly', payDay: 'Every second Friday', fy: 'Jan–Dec', tz: 'America/Toronto',
    struct: 'CA', empTax: 'Federal + Provincial withholding',
    statutory: [
      { k: 'CPP', d: '5.95% employee and employer above the basic exemption', due: 'Per pay run' },
      { k: 'EI', d: '1.66% employee, 1.4× employer', due: 'Per pay run' },
      { k: 'Federal income tax', d: 'Withheld per Form TD1', due: 'Monthly remittance' },
      { k: 'Provincial tax', d: 'Ontario / British Columbia rates', due: 'Monthly remittance' },
      { k: 'EHT', d: 'Employer Health Tax, Ontario 1.95%', due: 'Monthly' }
    ],
    leaveSet: ['VAC', 'SICK', 'STAT', 'LOP'], noticeDays: 30, probationDays: 90,
    bands: { L1: [56000, 74000], L2: [76000, 106000], L3: [108000, 142000], L4: [146000, 185000], L5: [190000, 245000], L6: [250000, 360000] }, holidays: 'CA', wage: 'Annual base salary'
  },
  {
    id: 'AE', name: 'United Arab Emirates', short: 'UAE', flag: '🇦🇪', cur: 'AED', sym: 'AED', fx: 22.9, factor: 2.2, grouping: 'western',
    entity: '360VHM Technology FZ-LLC', reg: 'Licence 94021 · Dubai Internet City Free Zone',
    addr: 'Building 3, Dubai Internet City, PO Box 500254, Dubai',
    payFreq: 'Monthly', payDay: 'Last working day', fy: 'Jan–Dec', tz: 'Asia/Dubai',
    struct: 'AE', empTax: 'No personal income tax',
    statutory: [
      { k: 'Wage Protection System', d: 'Salary file lodged with MOHRE through the bank each month', due: 'By the 15th' },
      { k: 'End-of-service gratuity', d: '21 days per year for years 1–5, 30 days thereafter', due: 'On exit' },
      { k: 'GPSSA pension', d: '5% employee / 12.5% employer — UAE and GCC nationals only', due: 'Monthly' },
      { k: 'Medical insurance', d: 'Mandatory employer-funded cover (DHA/DOH)', due: 'Annual renewal' }
    ],
    leaveSet: ['ANN', 'SICK', 'HAJJ', 'LOP'], noticeDays: 30, probationDays: 180,
    bands: { L1: [126000, 186000], L2: [192000, 288000], L3: [294000, 432000], L4: [438000, 612000], L5: [618000, 864000], L6: [870000, 1440000] }, holidays: 'AE', wage: 'Total monthly package'
  },
  {
    id: 'GB', name: 'United Kingdom', short: 'UK', flag: '🇬🇧', cur: 'GBP', sym: '£', fx: 106.4, factor: 2.8, grouping: 'western',
    entity: '360VHM Technology UK Ltd', reg: 'Company 11482903 · PAYE 120/QZ48155',
    addr: '30 Churchill Place, Canary Wharf, London E14 5RE',
    payFreq: 'Monthly', payDay: '28th', fy: 'Apr–Mar', tz: 'Europe/London',
    struct: 'GB', empTax: 'PAYE',
    statutory: [
      { k: 'PAYE income tax', d: 'Personal allowance £12,570, then 20% / 40% / 45%', due: '22nd (RTI on or before payday)' },
      { k: 'National Insurance', d: '8% employee above the primary threshold, 13.8% employer', due: '22nd' },
      { k: 'Pension auto-enrolment', d: '5% employee / 3% employer on qualifying earnings', due: 'Per pay run' },
      { k: 'Apprenticeship Levy', d: '0.5% of pay bill above £3m', due: 'Monthly' },
      { k: 'Statutory pay', d: 'SSP, SMP, SPP administered through payroll', due: 'As applicable' }
    ],
    leaveSet: ['ANN', 'SICK', 'MAT', 'LOP'], noticeDays: 30, probationDays: 180,
    bands: { L1: [29000, 39000], L2: [40000, 58000], L3: [60000, 86000], L4: [88000, 118000], L5: [120000, 155000], L6: [160000, 260000] }, holidays: 'GB', wage: 'Annual gross salary'
  }
];

export const CMAP: Record<string, Country> = {};
COUNTRIES.forEach((c) => (CMAP[c.id] = c));

export const countryOf = (id?: string): Country => CMAP[id ?? ''] || CMAP.IN;

/** Everything rolls up to INR for consolidated reporting. */
export const BASE_CCY: CurrencyId = 'INR';

/* ---- money ---- */
const groupWestern = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function groupLakh(s: string): string {
  let last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  if (rest) last3 = ',' + last3;
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
}

export function money(n?: number | null, ccyId?: string, dec?: boolean): string {
  if (n == null || isNaN(n)) return '—';
  const c = COUNTRIES.find((x) => x.cur === ccyId) || CMAP.IN;
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = dec ? Math.floor(abs) : Math.round(abs);
  const frac = dec ? (abs - whole).toFixed(2).slice(1) : '';
  const s = c.grouping === 'lakh' ? groupLakh(String(whole)) : groupWestern(String(whole));
  const sym = c.sym === 'AED' ? 'AED ' : c.sym;
  return (neg ? '-' : '') + sym + s + frac;
}

/** Compact form — Cr/L for lakh grouping, M/K otherwise. */
export function moneyShort(n: number, ccyId?: string): string {
  const c = COUNTRIES.find((x) => x.cur === ccyId) || CMAP.IN;
  if (c.grouping === 'lakh') {
    return n >= 10000000
      ? c.sym + (n / 10000000).toFixed(2) + ' Cr'
      : n >= 100000
        ? c.sym + (n / 100000).toFixed(1) + ' L'
        : money(n, ccyId);
  }
  const sym = c.sym === 'AED' ? 'AED ' : c.sym;
  return n >= 1000000 ? sym + (n / 1000000).toFixed(2) + 'M' : n >= 1000 ? sym + (n / 1000).toFixed(1) + 'K' : money(n, ccyId);
}

export const fxOf = (ccyId?: string): number => (COUNTRIES.find((x) => x.cur === ccyId) || CMAP.IN).fx;

export const toBase = (amt: number, ccyId?: string): number => Math.round(amt * fxOf(ccyId));
export const fromBase = (amt: number, ccyId?: string): number => Math.round(amt / fxOf(ccyId));

export function bandFor(countryId: string, grade: Grade): [number, number] {
  const c = countryOf(countryId);
  return c.bands?.[grade] || c.bands.L2;
}

/**
 * Map an India-denominated figure onto the equivalent local band, preserving
 * where the person sits within their grade so seniority still tracks abroad.
 */
export function localBand(inrAmount: number, countryId: string, grade?: Grade): number {
  const c = countryOf(countryId);
  if (c.id === 'IN') return inrAmount;
  const b = bandFor(c.id, grade || 'L2');
  const ib = CMAP.IN.bands[grade || 'L2'];
  const posn = clamp((inrAmount - ib[0]) / Math.max(1, ib[1] - ib[0]), 0, 1);
  const v = b[0] + posn * (b[1] - b[0]);
  return Math.round(v / 500) * 500;
}

/* ---- dialling codes — WhatsApp routing needs a country-correct number ---- */
export const DIAL: Record<string, string> = { IN: '+91', US: '+1', CA: '+1', AE: '+971', GB: '+44' };

export function dialFor(cty: CountryId | string): string {
  const c = DIAL[cty] || '+91';
  if (cty === 'US' || cty === 'CA') return c + ' ' + ri(201, 989) + ' ' + ri(200, 999) + ' ' + String(ri(0, 9999)).padStart(4, '0');
  if (cty === 'GB') return c + ' 7' + ri(100, 999) + ' ' + ri(100000, 999999);
  if (cty === 'AE') return c + ' 5' + ri(0, 8) + ' ' + ri(100, 999) + ' ' + ri(1000, 9999);
  return c + ' ' + ri(70, 99) + ri(10000000, 99999999);
}

/* ---- base-currency helpers ---- */
export const mb = (a?: number | null): string => money(a, BASE_CCY);
export const mbS = (a: number): string => moneyShort(a, BASE_CCY);

/** Sum amounts drawn from mixed-currency records into the INR base. */
export function sumBase<T extends { ccy?: string; e?: { ccy?: string } }>(list: readonly T[], f: (x: T) => number): number {
  return list.reduce((t, x) => t + toBase(f(x) || 0, x.ccy || x.e?.ccy || 'INR'), 0);
}
