export type CountryId = 'IN' | 'US' | 'CA' | 'AE' | 'GB';
export type CurrencyId = 'INR' | 'USD' | 'CAD' | 'AED' | 'GBP';
export type Grade = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

export interface StatutoryItem {
  /** Name of the statutory head, e.g. "Provident Fund". */
  k: string;
  /** How it is computed. */
  d: string;
  /** Remittance due date. */
  due: string;
}

export interface Country {
  id: CountryId;
  name: string;
  short: string;
  flag: string;
  cur: CurrencyId;
  sym: string;
  /** Units of INR per unit of `cur` — the reporting base is INR. */
  fx: number;
  /** Rough cost-of-employment multiplier vs India, used when seeding pay. */
  factor: number;
  grouping: 'lakh' | 'western';
  entity: string;
  reg: string;
  addr: string;
  payFreq: string;
  payDay: string;
  fy: string;
  tz: string;
  /** Which salary-structure pack to apply. */
  struct: CountryId;
  empTax: string;
  statutory: StatutoryItem[];
  leaveSet: string[];
  noticeDays: number;
  probationDays: number;
  /** Market band per grade, in local currency: [min, max]. */
  bands: Record<Grade, [number, number]>;
  holidays: CountryId;
  wage: string;
}
