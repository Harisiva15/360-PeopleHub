/* Shares the RNG stream with onboarding — this import fixes the draw order. */
import './onboarding';

import { sortBy } from '../lib/collections';
import { addDays, nextOccur, parseYmd, TODAY, yearsSince, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE } from './employees';
import type { Asset } from '../types/asset';

export interface Announcement {
  id: string;
  title: string;
  body: string;
  by: string;
  dept: string;
  on: string;
  /** Pinned posts stay at the top and feed the notification tray. */
  pin: boolean;
  tag: string;
}

export const ANNOUNCE: Announcement[] = [
  {
    id: 'AN1',
    title: 'Deepavali 2026 holiday — 8 November',
    body: 'The office will remain closed on Sunday, 8 November for Deepavali. Client-facing support teams will follow the rotational roster shared by your manager. Wishing everyone a safe and bright festival!',
    by: 'Priya Raghavan', dept: 'All', on: ymd(addDays(TODAY, -2)), pin: true, tag: 'Holiday',
  },
  {
    id: 'AN2',
    title: 'H1 FY27 appraisal cycle opens 1 September',
    body: 'Self-appraisal forms will be available from 1 September. Managers must complete reviews by 20 September. Increment letters go out with the October payroll.',
    by: 'Priya Raghavan', dept: 'All', on: ymd(addDays(TODAY, -5)), pin: true, tag: 'Policy',
  },
  {
    id: 'AN3',
    title: 'Investment proof submission — window closes 31 January',
    body: 'Employees on the Old Tax Regime must upload rent receipts, 80C and 80D proofs in the Tax Declaration module. Unverified declarations will be dropped from February TDS computation.',
    by: 'Balaji Srinivasan', dept: 'All', on: ymd(addDays(TODAY, -9)), pin: false, tag: 'Payroll',
  },
  {
    id: 'AN4',
    title: 'New geo-fence radius at Bengaluru office',
    body: 'The Bengaluru geo-fence has been widened to 220 m to cover the new Block C entrance. Please re-punch through the mobile app if you get a fence warning.',
    by: 'Karthik Shetty', dept: 'All', on: ymd(addDays(TODAY, -12)), pin: false, tag: 'Attendance',
  },
  {
    id: 'AN5',
    title: 'Atlas 4.0 released to production 🎉',
    body: 'Huge thanks to the Platform and QA teams for a zero-downtime release. 41 features, 118 bug fixes and a 22% latency improvement.',
    by: 'Ravi Natarajan', dept: 'ENG', on: ymd(addDays(TODAY, -15)), pin: false, tag: 'Announcement',
  },
  {
    id: 'AN6',
    title: 'POSH & InfoSec refresher training — mandatory',
    body: 'All employees must complete the annual POSH and Information Security refresher on the LMS before 30 September. Completion is tracked against your probation/appraisal record.',
    by: 'Priya Raghavan', dept: 'All', on: ymd(addDays(TODAY, -20)), pin: false, tag: 'Compliance',
  },
  {
    id: 'AN7',
    title: 'Referral bonus increased to ₹75,000 for L3+ roles',
    body: 'For all senior engineering and SRE openings, the referral bonus is now ₹75,000 payable after the referred employee completes 90 days.',
    by: 'Priya Raghavan', dept: 'All', on: ymd(addDays(TODAY, -26)), pin: false, tag: 'Hiring',
  },
];

export interface Celebration {
  kind: 'birthday' | 'anniversary';
  empId: string;
  date: string;
  inDays: number;
  years?: number;
}

/** Birthdays and work anniversaries falling within the next `days` days. */
export function celebrations(days: number): Celebration[] {
  const out: Celebration[] = [];
  ACTIVE().forEach((e) => {
    const b = nextOccur(e.dob);
    const a = nextOccur(e.doj);
    const db = Math.round((b.getTime() - TODAY.getTime()) / 86400000);
    const da = Math.round((a.getTime() - TODAY.getTime()) / 86400000);

    if (db <= days) out.push({ kind: 'birthday', empId: e.id, date: ymd(b), inDays: db });

    /*
     * A 29 February joining date rolls forward to 1 March in a non-leap year,
     * which is not the anniversary — skip those rather than mark them early.
     */
    const dateHeld = ymd(a).slice(5) === e.doj.slice(5);
    if (da <= days && yearsSince(e.doj) >= 1 && dateHeld) {
      out.push({
        kind: 'anniversary',
        empId: e.id,
        date: ymd(a),
        inDays: da,
        years: yearsSince(e.doj) + (da === 0 ? 0 : 1),
      });
    }
  });
  return sortBy(out, (x) => x.inDays);
}

/* ---------- assets & documents ---------- */

export const ASSET_TYPES = [
  'MacBook Pro 14"', 'Dell Latitude 5440', 'ThinkPad T14', 'iPhone 14',
  'Dell 24" Monitor', 'Logitech MX Keys', 'Headset — Jabra Evolve', 'YubiKey',
];


export const ASSETS: Asset[] = [];
ACTIVE().forEach((e) => {
  const n = ri(1, 3);
  for (let i = 0; i < n; i++)
    ASSETS.push({
      id: uid('AST'),
      empId: e.id,
      type: pick(ASSET_TYPES),
      serial: 'SN' + ri(100000, 999999),
      issued: ymd(addDays(parseYmd(e.doj), ri(0, 6))),
      status: 'Assigned',
    });
});

export const DOC_TYPES = [
  'Offer Letter', 'Appointment Letter', 'PAN Card', 'Aadhaar',
  'Degree Certificate', 'Previous Relieving Letter', 'Form 16 (FY 2025-26)', 'NDA',
];

export interface EmpDoc {
  id: string;
  empId: string;
  type: string;
  on: string;
  verified: boolean;
}

export const DOCS: EmpDoc[] = [];
ACTIVE().forEach((e) =>
  DOC_TYPES.forEach((t) => {
    if (chance(0.82))
      DOCS.push({
        id: uid('DOC'),
        empId: e.id,
        type: t,
        on: ymd(addDays(parseYmd(e.doj), ri(-5, 30))),
        verified: chance(0.85),
      });
  }),
);
