/* Shares the RNG stream with loans — this import fixes the draw order. */
import './loans';

import { sum } from '../lib/collections';
import { chance, rnd } from '../lib/rng';
import { ACTIVE } from './employees';
import { comp, salaryStructure } from './salary';
import type { Grade } from '../types/country';

export interface InsurancePolicy {
  id: string;
  n: string;
  insurer: string;
  covers: string;
  /** Sum assured by grade. */
  sum: Record<Grade, number>;
  premiumEmployer: string;
  ic: string;
}

export const INSURANCE: InsurancePolicy[] = [
  {
    id: 'GMC', n: 'Group Medical Insurance', insurer: 'ICICI Lombard',
    covers: 'Self + spouse + 2 children + parents',
    sum: { L1: 300000, L2: 400000, L3: 500000, L4: 750000, L5: 1000000, L6: 1500000 },
    premiumEmployer: '100% for self & family', ic: '🏥',
  },
  {
    id: 'GPA', n: 'Group Personal Accident', insurer: 'Bajaj Allianz', covers: 'Self',
    sum: { L1: 1000000, L2: 1500000, L3: 2000000, L4: 3000000, L5: 5000000, L6: 7500000 },
    premiumEmployer: '100%', ic: '🛡️',
  },
  {
    id: 'GTL', n: 'Group Term Life', insurer: 'HDFC Life', covers: 'Self',
    sum: { L1: 2000000, L2: 3000000, L3: 4000000, L4: 6000000, L5: 10000000, L6: 15000000 },
    premiumEmployer: '100%', ic: '🕊️',
  },
  {
    id: 'OPD', n: 'OPD & Wellness Wallet', insurer: 'Practo Care', covers: 'Self + family',
    sum: { L1: 15000, L2: 15000, L3: 25000, L4: 25000, L5: 40000, L6: 40000 },
    premiumEmployer: '100%', ic: '💊',
  },
];

export const PERKS = [
  { n: 'Annual health check-up', d: 'Fully paid, for employee and spouse', ic: '🩺' },
  { n: 'Employee assistance programme', d: '24×7 confidential counselling, 8 free sessions a year', ic: '🧠' },
  { n: 'Learning wallet', d: '₹40,000 per year for courses, books and conferences', ic: '🎓' },
  { n: 'Work-from-home setup', d: 'One-time ₹25,000 for chair, desk and monitor', ic: '🪑' },
  { n: 'Internet reimbursement', d: '₹1,500 per month against a bill', ic: '🌐' },
  { n: 'Referral bonus', d: '₹40,000 (₹75,000 for L3 and above) after 90 days', ic: '💸' },
  { n: 'Creche & childcare support', d: '₹8,000 per month per child under 6', ic: '🧸' },
  { n: 'Sabbatical', d: 'Up to 3 months unpaid after 5 years of service', ic: '🌴' },
];

export interface FbpComponent {
  id: string;
  n: string;
  /** Annual tax-free ceiling for the component. */
  cap: number;
  note: string;
  ic: string;
}

export const FBP_COMPONENTS: FbpComponent[] = [
  { id: 'fuel', n: 'Fuel & Vehicle Maintenance', cap: 28800, note: 'Tax-free against bills, ₹2,400 per month', ic: '⛽' },
  { id: 'meal', n: 'Meal Card', cap: 26400, note: '₹50 per meal, 2 meals × 22 days — fully tax-free', ic: '🍱' },
  { id: 'telecom', n: 'Telephone & Internet', cap: 24000, note: 'Tax-free against bills', ic: '📱' },
  { id: 'books', n: 'Books & Periodicals', cap: 12000, note: 'Tax-free against bills', ic: '📚' },
  { id: 'lta', n: 'Leave Travel Allowance', cap: 60000, note: 'Exempt twice in a block of 4 years', ic: '🚆' },
  { id: 'prof', n: 'Professional Development', cap: 40000, note: 'Courses, certifications, conferences', ic: '🎯' },
];

export interface FbpPlan {
  /** Budget available to reallocate, carved out of special allowance. */
  pool: number;
  alloc: Record<string, number>;
  status: string;
  /**
   * The last date a revision can take effect within the financial year. After
   * it, the allocation is fixed and the balance is paid as taxable salary.
   */
  lockedOn: string | null;
  /** Set outside India, where the plan does not apply. */
  na?: boolean;
}

export const FBP: Record<string, FbpPlan> = {};

(function genFbp() {
  ACTIVE().forEach((e) => {
    const s = salaryStructure(e);
    if (e.country !== 'IN') {
      FBP[e.id] = { pool: 0, alloc: {}, status: 'Not applicable', lockedOn: null, na: true };
      return;
    }
    const pool = Math.max(0, Math.round(comp(s, 3) * 0.45));
    const alloc: Record<string, number> = {};
    let left = pool;
    FBP_COMPONENTS.forEach((c) => {
      if (!chance(0.55) || left <= 0) {
        alloc[c.id] = 0;
        return;
      }
      const v = Math.min(c.cap, left, Math.round((c.cap * (0.4 + rnd() * 0.6)) / 1200) * 1200);
      alloc[c.id] = v;
      left -= v;
    });
    FBP[e.id] = { pool, alloc, status: chance(0.6) ? 'Declared' : 'Not declared', lockedOn: '2027-03-31' };
  });
})();

export const fbpTotal = (id: string): number => sum(Object.values(FBP[id]?.alloc || {}));
