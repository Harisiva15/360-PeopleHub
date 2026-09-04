/* Shares the RNG stream with letters — this import fixes the draw order. */
import './letters';

import { sortBy, sum, uniq } from '../lib/collections';
import { addDays, daysBetween, monthKey, parseYmd, TODAY, yearsSince, ymd } from '../lib/dates';
import { clamp, pct } from '../lib/format';
import { chance, pick, ri, rnd, uid } from '../lib/rng';
import { bandFor, countryOf, localBand, toBase } from './countries';
import { ACTIVE } from './employees';
import { FIRST_F, FIRST_M, PROJECTS, SKILLS } from './org';
import { salaryStructure } from './salary';
import type { CountryId, CurrencyId } from '../types/country';

export const INDUSTRIES = [
  'Banking & Financial Services', 'Insurance', 'Healthcare & Life Sciences', 'Retail & E-commerce',
  'Telecom', 'Manufacturing', 'Public Sector', 'Energy & Utilities',
];

export const ENGAGE_TYPES = ['Time & Material', 'Fixed Price', 'Managed Service', 'Staff Augmentation'];

export const WORK_AUTH_US = ['US Citizen', 'Green Card', 'H1-B', 'GC-EAD', 'TN', 'OPT-EAD', 'H4-EAD'];

export interface SubStage {
  id: string;
  n: string;
  c: string;
}

/** The client-side submission funnel, in order. */
export const SUB_STAGES: SubStage[] = [
  { id: 'submitted', n: 'Submitted', c: 'var(--s1)' },
  { id: 'client', n: 'Client Review', c: 'var(--s4)' },
  { id: 'interview', n: 'Client Interview', c: 'var(--s7)' },
  { id: 'selected', n: 'Selected', c: 'var(--s6)' },
  { id: 'placed', n: 'Placed', c: 'var(--s3)' },
  { id: 'rejected', n: 'Rejected', c: 'var(--s8)' },
];

export const subStage = (id: string): SubStage => SUB_STAGES.find((s) => s.id === id) || SUB_STAGES[0];

/* ---------------- clients ---------------- */

export interface ClientContact {
  n: string;
  r: string;
  e: string;
}

export interface Client {
  id: string;
  name: string;
  country: CountryId;
  ccy: CurrencyId;
  industry: string;
  tier: 'Platinum' | 'Gold' | 'Silver' | 'Bronze';
  /** Net payment days agreed in the MSA. */
  paymentTerms: number;
  since: string;
  msaSigned: string;
  msaExpiry: string;
  creditLimit: number;
  ownerId: string;
  deliveryHeadId: string;
  status: 'Active' | 'Prospect';
  engagement: string;
  /** Vendor management system the client sources through, if any. */
  vms: string | null;
  contacts: ClientContact[];
  nps: number;
  riskFlag: boolean;
}

export const CLIENTS: Client[] = [];

(function genClients() {
  const seed: [string, CountryId, string, Client['tier'], number, number][] = [
    ['Meridian Financial Group', 'US', 'Banking & Financial Services', 'Platinum', 45, 2019],
    ['Northwind Insurance', 'US', 'Insurance', 'Gold', 60, 2020],
    ['CareLink Health Systems', 'US', 'Healthcare & Life Sciences', 'Platinum', 45, 2018],
    ['RetailOne Group', 'GB', 'Retail & E-commerce', 'Gold', 30, 2021],
    ['Transit Global Logistics', 'US', 'Manufacturing', 'Silver', 60, 2022],
    ['Emirates National Bank', 'AE', 'Banking & Financial Services', 'Gold', 45, 2021],
    ['Maple Telecom', 'CA', 'Telecom', 'Silver', 45, 2022],
    ['Aurora Energy Partners', 'US', 'Energy & Utilities', 'Silver', 60, 2023],
    ['Bharat Digital Services', 'IN', 'Public Sector', 'Gold', 60, 2020],
    ['Kensington Asset Management', 'GB', 'Banking & Financial Services', 'Silver', 30, 2023],
    ['Summit Pharma', 'US', 'Healthcare & Life Sciences', 'Bronze', 45, 2024],
    ['Nile Retail Holdings', 'AE', 'Retail & E-commerce', 'Bronze', 30, 2024],
  ];

  seed.forEach((c, i) => {
    const cty = c[1];
    CLIENTS.push({
      id: 'CL-' + (1000 + i),
      name: c[0],
      country: cty,
      ccy: countryOf(cty).cur,
      industry: c[2],
      tier: c[3],
      paymentTerms: c[4],
      since: c[5] + '-0' + ri(1, 9) + '-1' + ri(0, 9),
      msaSigned: c[5] + '-0' + ri(1, 9) + '-15',
      /* MSAs renew on expiry, so the live term always ends ahead of today */
      msaExpiry: TODAY.getFullYear() + (TODAY.getMonth() < 3 ? 0 : 1) + ri(0, 3) + '-03-31',
      creditLimit: localBand(ri(80, 400) * 100000, cty, 'L5') * 4,
      ownerId: pick(ACTIVE().filter((e) => e.dept === 'SALES' && e.grade >= 'L3')).id,
      deliveryHeadId: pick(ACTIVE().filter((e) => e.dept === 'ENG' && ['L4', 'L5'].includes(e.grade))).id,
      status: i === 11 ? 'Prospect' : 'Active',
      engagement: pick(ENGAGE_TYPES),
      vms: cty === 'US' && chance(0.5) ? pick(['SAP Fieldglass', 'Beeline', 'Coupa']) : null,
      contacts: [
        {
          n: pick(['Michael Grant', 'Sarah Whitfield', 'David Chen', 'Priya Nair', "James O'Connor", 'Aisha Rahman', 'Robert Klein']),
          r: 'Hiring Manager',
          e: 'hm@' + c[0].toLowerCase().split(' ')[0] + '.com',
        },
        {
          n: pick(['Linda Park', 'Tom Bradley', 'Nisha Verma', 'Andrew Scott']),
          r: 'Procurement / VMS',
          e: 'vendor@' + c[0].toLowerCase().split(' ')[0] + '.com',
        },
      ],
      nps: ri(6, 10),
      riskFlag: chance(0.15),
    });
  });
})();

export const clientOf = (id: string): Client => CLIENTS.find((c) => c.id === id) || CLIENTS[0];

/* ---------------- rate cards ---------------- */

export const RATE_ROLES = [
  'Software Engineer', 'Senior Software Engineer', 'Tech Lead', 'Architect', 'QA Engineer', 'SDET',
  'DevOps Engineer', 'SRE', 'Data Engineer', 'Business Analyst', 'Scrum Master', 'Project Manager',
];

export interface RateCard {
  id: string;
  clientId: string;
  role: string;
  ccy: CurrencyId;
  unit: 'per day' | 'per hour';
  billRate: number;
  /** Floor margin the deal desk will approve, as a percentage. */
  minMargin: number;
  location: CountryId;
  effective: string;
}

export const RATE_CARDS: RateCard[] = [];

(function genRates() {
  CLIENTS.forEach((c) => {
    /* prevailing contract bill rates: hourly outside India, daily in India */
    const base: Record<string, [number, number]> = {
      US: [68, 168], GB: [52, 118], CA: [60, 140], AE: [150, 360], IN: [7500, 27000],
    };
    const b = base[c.country];
    RATE_ROLES.forEach((r, i) => {
      const lvl = i / (RATE_ROLES.length - 1);
      const bill = Math.round(
        (b[0] + lvl * (b[1] - b[0])) * (c.tier === 'Platinum' ? 1.08 : c.tier === 'Gold' ? 1.0 : 0.94),
      );
      RATE_CARDS.push({
        id: uid('RC'),
        clientId: c.id,
        role: r,
        ccy: c.ccy,
        unit: c.country === 'IN' ? 'per day' : 'per hour',
        billRate: bill,
        minMargin: c.tier === 'Platinum' ? 18 : c.tier === 'Gold' ? 22 : 26,
        location: c.country,
        effective: '2026-04-01',
      });
    });
  });
})();

export const rateFor = (clientId: string, role: string): RateCard =>
  RATE_CARDS.find((r) => r.clientId === clientId && r.role === role) ||
  RATE_CARDS.find((r) => r.clientId === clientId)!;

/* ---------------- statements of work ---------------- */

export interface Sow {
  id: string;
  clientId: string;
  title: string;
  type: string;
  ccy: CurrencyId;
  start: string;
  end: string;
  value: number;
  /** Value consumed to date. */
  burned: number;
  headcount: number;
  filled: number;
  status: 'Active' | 'Renewal Due' | 'Expired';
  po: string;
  signedBy: string;
  ownerId: string;
  billingCycle: string;
}

export const SOWS: Sow[] = [];

(function genSows() {
  CLIENTS.filter((c) => c.status === 'Active').forEach((c) => {
    const n = ri(1, 2);
    for (let k = 0; k < n; k++) {
      const start = addDays(TODAY, -ri(60, 600));
      const months = pick([6, 9, 12, 12, 18, 24]);
      const end = ymd(new Date(start.getFullYear(), start.getMonth() + months, start.getDate()));
      const hc = ri(3, 22);
      const value = localBand(hc * ri(9, 22) * 100000, c.country, 'L4');
      const burnedPct = clamp(
        daysBetween(ymd(start), ymd(TODAY)) / Math.max(1, daysBetween(ymd(start), end)),
        0,
        1,
      );
      SOWS.push({
        id: 'SOW-' + (7100 + SOWS.length),
        clientId: c.id,
        title: pick([
          'Core Platform Modernisation', 'Digital Channel Build-out', 'Cloud Migration Programme',
          'Data Platform Engineering', 'Application Managed Services', 'QA Automation Programme',
          'Integration & API Layer', 'Customer 360 Programme',
        ]),
        type: pick(ENGAGE_TYPES),
        ccy: c.ccy,
        start: ymd(start),
        end,
        value,
        burned: Math.round(value * burnedPct * (0.85 + rnd() * 0.3)),
        headcount: hc,
        filled: 0,
        status: end < ymd(TODAY) ? 'Expired' : daysBetween(ymd(TODAY), end) < 60 ? 'Renewal Due' : 'Active',
        po: 'PO-' + ri(100000, 999999),
        signedBy: pick(c.contacts).n,
        ownerId: c.deliveryHeadId,
        billingCycle: pick(['Monthly', 'Monthly', 'Bi-weekly']),
      });
    }
  });
})();

export const sowOf = (id: string): Sow | undefined => SOWS.find((s) => s.id === id);

/* ---------------- consultants & bench ---------------- */

export interface Consultant {
  id: string;
  /** Set for internal staff; null for vendor-supplied consultants. */
  empId: string | null;
  external: boolean;
  vendorId: string | null;
  name: string;
  country: CountryId;
  ccy: CurrencyId;
  role: string;
  skills: string[];
  exp: number;
  workAuth: string;
  engagement: string;
  costPerDay: number;
  status: 'Assigned' | 'Placed' | 'Bench' | 'Internal';
  availableFrom: string | null;
  benchSince: string | null;
  placementId?: string;
  rolledOffFrom?: string | null;
  redeployment?: string;
  internalProject?: string;
}

export const CONSULTANTS: Consultant[] = [];

(function genConsultants() {
  /* internal billable staff from the delivery departments */
  const pool = ACTIVE().filter((e) => ['ENG', 'QA', 'DEVOPS'].includes(e.dept) && e.grade !== 'L5' && e.grade !== 'L6');
  pool.forEach((e) => {
    if (!chance(0.8)) return;
    CONSULTANTS.push({
      id: 'CON-' + (5000 + CONSULTANTS.length),
      empId: e.id,
      external: false,
      vendorId: null,
      name: e.name,
      country: e.country,
      ccy: e.ccy,
      role: pick(RATE_ROLES),
      skills: e.skills,
      exp: Math.max(1, yearsSince(e.doj) + ri(1, 6)),
      workAuth: e.workAuth || (e.country === 'IN' ? 'Indian National' : 'Work Permit'),
      engagement: e.empType === 'Contract' ? 'C2C' : 'W2 / Payroll',
      costPerDay: Math.round(salaryStructure(e).ctc / 220),
      status: 'Assigned',
      availableFrom: null,
      benchSince: null,
    });
  });

  /* external consultants supplied by vendors */
  const first = FIRST_M.concat(FIRST_F);
  const extNames = ['Miller', 'Johnson', 'Patel', 'Nguyen', 'Garcia', 'Kowalski', 'Okafor', 'Silva', 'Haddad', 'Novak'];
  for (let i = 0; i < 58; i++) {
    const cty = pick(['US', 'US', 'US', 'GB', 'CA'] as CountryId[]);
    const role = pick(RATE_ROLES);
    CONSULTANTS.push({
      id: 'CON-' + (5000 + CONSULTANTS.length),
      empId: null,
      external: true,
      vendorId: null,
      name: pick(first) + ' ' + pick(extNames),
      country: cty,
      ccy: countryOf(cty).cur,
      role,
      skills: uniq([pick(SKILLS), pick(SKILLS), pick(SKILLS)]),
      exp: ri(3, 16),
      workAuth: cty === 'US' ? pick(WORK_AUTH_US) : 'Work Permit',
      engagement: pick(['C2C', 'C2C', '1099', 'W2 (Vendor)']),
      costPerDay: Math.round((bandFor(cty, 'L3')[0] / 220) * (0.8 + rnd() * 0.5)),
      status: 'Assigned',
      availableFrom: null,
      benchSince: null,
    });
  }
})();

export const conOf = (id: string): Consultant | undefined => CONSULTANTS.find((c) => c.id === id);

/** Work locations offered, kept consistent with where the client sits. */
const LOC_BY_COUNTRY: Record<string, string[]> = {
  US: ['Remote (US)', 'Remote (US)', 'East Brunswick, NJ', 'Dallas, TX', 'Hybrid — 3 days onsite, NJ', 'Hybrid — 3 days onsite, TX'],
  GB: ['Remote (UK)', 'London', 'Hybrid — 3 days onsite, London'],
  CA: ['Remote (Canada)', 'Toronto', 'Hybrid — 3 days onsite, Toronto'],
  AE: ['Dubai', 'Dubai', 'Hybrid — 3 days onsite, Dubai'],
  IN: ['Remote (India)', 'Chennai', 'Bengaluru', 'Hyderabad', 'Hybrid — 3 days onsite, Chennai'],
};

/* ---------------- requirements ---------------- */

export interface StaffingRequirement {
  id: string;
  clientId: string;
  sowId: string;
  title: string;
  role: string;
  skills: string[];
  location: string;
  ccy: CurrencyId;
  billRate: number;
  unit: 'per day' | 'per hour';
  /** Cap on how many profiles the client will look at. */
  maxSubmissions: number;
  positions: number;
  filled: number;
  priority: string;
  receivedOn: string;
  closeBy: string;
  recruiterId: string;
  source: string;
  vms: string | null;
  status: 'Open' | 'Filled' | 'Closed';
  duration: string;
}

export const REQUIREMENTS: StaffingRequirement[] = [];

/*
 * Generated across a 15-month history so the funnel has depth: older
 * requirements are mostly filled or closed, recent ones still open.
 */
(function genReqs2() {
  SOWS.forEach((s) => {
    const c = clientOf(s.clientId);
    /* demand roughly tracks the size of the engagement */
    const n = clamp(Math.round(s.headcount / 3.4) + ri(0, 1), 1, 6);
    for (let i = 0; i < n; i++) {
      const role = pick(RATE_ROLES);
      const rc = rateFor(c.id, role);
      /* spread demand across the life of the SOW, weighted to the recent past */
      const age = chance(0.42) ? ri(1, 60) : ri(61, 430);
      const received = addDays(TODAY, -age);
      const pos = age > 120 ? ri(1, 3) : ri(1, 4);
      REQUIREMENTS.push({
        id: 'REQ-' + (3100 + REQUIREMENTS.length),
        clientId: c.id,
        sowId: s.id,
        title:
          role + ' — ' +
          pick(['Payments', 'Core Banking', 'Claims', 'Digital Channels', 'Data Platform', 'Cloud Platform', 'Order Management', 'Fraud & Risk', 'Customer 360']),
        role,
        skills: uniq([pick(SKILLS), pick(SKILLS), pick(SKILLS), pick(SKILLS)]),
        location: pick(LOC_BY_COUNTRY[c.country] || LOC_BY_COUNTRY.US),
        ccy: c.ccy,
        billRate: Math.round(rc.billRate * (0.92 + rnd() * 0.2)),
        unit: rc.unit,
        maxSubmissions: ri(4, 7),
        positions: pos,
        filled: 0,
        priority: pick(['Critical', 'High', 'High', 'Medium']),
        receivedOn: ymd(received),
        closeBy: ymd(addDays(received, ri(20, 60))),
        recruiterId: pick(ACTIVE().filter((e) => e.dept === 'HR')).id,
        source: c.vms ? pick(['VMS', 'VMS', 'Direct']) : 'Direct',
        vms: c.vms,
        status: 'Open',
        duration: pick(['6 months', '12 months', '12 months + extension', 'Contract to hire']),
      });
    }
  });
})();

export const reqOf2 = (id: string): StaffingRequirement | undefined => REQUIREMENTS.find((r) => r.id === id);

/* ---------------- vendors ---------------- */

export interface VendorMetrics {
  sub2int: number;
  int2plc: number;
  speed: number;
  fallout: number;
  compliance: number;
}

export interface Vendor {
  id: string;
  name: string;
  country: CountryId;
  type: string;
  tier: string;
  ccy: CurrencyId;
  contact: string;
  email: string;
  msaSigned: string;
  msaExpiry: string;
  insuranceExpiry: string;
  w9: boolean;
  coi: boolean;
  paymentTerms: number;
  markup: number;
  subs: number;
  interviews: number;
  placements: number;
  fallouts: number;
  avgSubmitDays: number;
  status: string;
  onboarded: string;
  /** Composite 0-100 scorecard, set in a second pass. */
  score?: number;
  metrics?: VendorMetrics;
}

export const VENDORS: Vendor[] = [];

(function genVendors() {
  const seed: [string, CountryId, string, string][] = [
    ['Apex Talent Partners', 'US', 'Staffing', 'Preferred'],
    ['Northgate Technologies', 'US', 'Staffing', 'Preferred'],
    ['Silverline Consulting', 'US', 'Staffing', 'Approved'],
    ['Bluepeak Resourcing', 'GB', 'Staffing', 'Approved'],
    ['Maple Leaf IT', 'CA', 'Staffing', 'Approved'],
    ['Gulf Tech Manpower', 'AE', 'Staffing', 'Trial'],
    ['Zenith Global Services', 'IN', 'Offshore Delivery', 'Preferred'],
    ['Corevance Solutions', 'US', 'Staffing', 'Trial'],
    ['Bridgeway Partners', 'US', 'MSP', 'Approved'],
    ['Tandem Workforce', 'GB', 'Staffing', 'Watchlist'],
  ];

  seed.forEach((v, i) => {
    const subs = ri(6, 40);
    const ints = Math.round(subs * (0.15 + rnd() * 0.35));
    const plc = Math.round(ints * (0.2 + rnd() * 0.45));
    VENDORS.push({
      id: 'VN-' + (400 + i),
      name: v[0],
      country: v[1],
      type: v[2],
      tier: v[3],
      ccy: countryOf(v[1]).cur,
      contact: pick(['Rachel Adams', 'Vikas Menon', 'Daniel Foster', 'Sunita Rao', 'Peter Zhang', 'Omar Faisal']),
      email: 'partners@' + v[0].toLowerCase().replace(/[^a-z]/g, '') + '.com',
      msaSigned: '20' + ri(19, 25) + '-0' + ri(1, 9) + '-12',
      msaExpiry: '2027-0' + ri(1, 9) + '-30',
      insuranceExpiry: ymd(addDays(TODAY, ri(-40, 300))),
      w9: chance(0.85),
      coi: chance(0.8),
      paymentTerms: pick([30, 45, 45, 60]),
      markup: ri(8, 22),
      subs,
      interviews: ints,
      placements: plc,
      fallouts: Math.round(plc * (rnd() * 0.2)),
      avgSubmitDays: +(1 + rnd() * 5).toFixed(1),
      status: v[3] === 'Watchlist' ? 'Under Review' : 'Active',
      onboarded: '20' + ri(19, 25) + '-0' + ri(1, 9) + '-01',
    });
  });

  /* scorecard: conversion, speed, retention and paperwork */
  VENDORS.forEach((v) => {
    const sub2int = pct(v.interviews, Math.max(1, v.subs));
    const int2plc = pct(v.placements, Math.max(1, v.interviews));
    const speed = clamp(100 - (v.avgSubmitDays - 1) * 18, 0, 100);
    const fallout = 100 - pct(v.fallouts, Math.max(1, v.placements));
    const compliance = (v.w9 ? 25 : 0) + (v.coi ? 25 : 0) + (v.insuranceExpiry > ymd(TODAY) ? 50 : 0);
    v.score = Math.round(sub2int * 0.25 + int2plc * 0.3 + speed * 0.2 + fallout * 0.15 + compliance * 0.1);
    v.metrics = { sub2int, int2plc, speed: Math.round(speed), fallout: Math.round(fallout), compliance };
  });

  CONSULTANTS.filter((c) => c.external).forEach((c) => {
    c.vendorId = pick(VENDORS.filter((v) => v.country === c.country || v.type === 'Staffing')).id;
  });
})();

export const vendorOf = (id: string): Vendor | undefined => VENDORS.find((v) => v.id === id);

/* ---------------- submissions & placements ---------------- */

export interface Submission {
  id: string;
  reqId: string;
  consultantId: string;
  conId: string;
  vendorId: string | null;
  clientId: string;
  submittedById: string;
  submittedOn: string;
  ccy: CurrencyId;
  unit: 'per day' | 'per hour';
  billRate: number;
  payRate: number;
  margin: number;
  stage: string;
  /** Right-to-represent, which locks candidate ownership for a period. */
  rtr: { signed: boolean; on: string; validDays: number };
  ownership: { recruiterId: string; until: string };
  feedback: string;
  interviewOn: string | null;
}

export interface Placement {
  id: string;
  submissionId: string;
  consultantId: string;
  conId: string;
  clientId: string;
  sowId: string;
  reqId: string;
  vendorId: string | null;
  role: string;
  location: string;
  ccy: CurrencyId;
  unit: 'per day' | 'per hour';
  billRate: number;
  payRate: number;
  margin: number;
  start: string;
  end: string;
  startOn: string;
  endOn: string;
  extensions: number;
  status: 'Starting' | 'Active' | 'Ending Soon' | 'Completed';
  hoursPerWeek: number;
  /** Timesheet submission compliance, as a percentage. */
  tsCompliance: number;
  poNumber: string;
}

export const SUBMISSIONS: Submission[] = [];
export const PLACEMENTS: Placement[] = [];

/*
 * Built together, oldest requirement first, so a consultant can be placed,
 * roll off when the assignment ends, and then be re-marketed.
 */
(function genPipeline() {
  /* cheap affinity, used only for seeding — the real scorer lives in the AI layer */
  const affinity = (c: Consultant, r: StaffingRequirement): number => {
    let n = 0;
    r.skills.forEach((k) => {
      if (c.skills.includes(k)) n += 2;
    });
    if (c.role === r.role) n += 3;
    if (c.country === clientOf(r.clientId).country) n += 3;
    return n;
  };

  /* a consultant is free on a date if no placement of theirs spans it */
  const busyUntil: Record<string, string> = {};
  const freeOn = (c: Consultant, d: string) => !busyUntil[c.id] || busyUntil[c.id] < d;

  const ordered = sortBy(REQUIREMENTS, (r) => r.receivedOn);
  ordered.forEach((r) => {
    const cl = clientOf(r.clientId);
    const age = daysBetween(r.receivedOn, ymd(TODAY));

    /* how many of the positions this requirement ever filled */
    const target =
      age > 150
        ? chance(0.82)
          ? r.positions
          : r.positions - 1
        : age > 75
          ? Math.min(r.positions, ri(1, r.positions))
          : age > 30
            ? ri(0, r.positions)
            : chance(0.25)
              ? 1
              : 0;

    /* candidate pool, best fit first, restricted to who was free at the time */
    const subDate = ymd(addDays(parseYmd(r.receivedOn), ri(1, 9)));
    const pool = sortBy(
      CONSULTANTS.filter(
        (c) => freeOn(c, subDate) && (c.country === cl.country || c.country === 'IN' || cl.country === 'IN'),
      ),
      (c) => -affinity(c, r),
    );
    if (!pool.length) {
      r.status = age > 90 ? 'Closed' : 'Open';
      return;
    }

    const nSubs = clamp(target + ri(2, 4), 1, r.maxSubmissions);
    const chosen = pool.slice(0, Math.min(nSubs, pool.length));

    chosen.forEach((c, idx) => {
      const on = ymd(addDays(parseYmd(subDate), idx));
      const bill = Math.round(r.billRate * (0.95 + rnd() * 0.1));
      const pay = Math.round(bill * (0.58 + rnd() * 0.2));
      const placedHere = idx < target;
      /* stage reflects both the outcome and how far the requirement has aged */
      const stage = placedHere
        ? 'placed'
        : age < 12
          ? pick(['submitted', 'submitted', 'client'])
          : age < 30
            ? pick(['submitted', 'client', 'client', 'interview'])
            : pick(['client', 'interview', 'interview', 'selected', 'rejected', 'rejected', 'rejected']);

      const sub: Submission = {
        id: 'SUB-' + (8100 + SUBMISSIONS.length),
        reqId: r.id,
        consultantId: c.id,
        conId: c.id,
        vendorId: c.vendorId,
        clientId: r.clientId,
        submittedById: r.recruiterId,
        submittedOn: on,
        ccy: r.ccy,
        unit: r.unit,
        billRate: bill,
        payRate: pay,
        margin: +(((bill - pay) / bill) * 100).toFixed(1),
        stage,
        rtr: { signed: true, on: ymd(addDays(parseYmd(on), -1)), validDays: 30 },
        ownership: { recruiterId: r.recruiterId, until: ymd(addDays(parseYmd(on), 30)) },
        feedback:
          stage === 'rejected'
            ? pick([
                'Rate above budget', 'Skills mismatch on cloud stack', 'Client selected another candidate',
                'Work authorisation not acceptable', 'Not enough domain experience',
              ])
            : '',
        interviewOn: ['interview', 'selected', 'placed'].includes(stage)
          ? ymd(addDays(parseYmd(on), ri(3, 14)))
          : null,
      };
      SUBMISSIONS.push(sub);
      if (!placedHere) return;

      /* --- the placement --- */
      const start = addDays(parseYmd(on), ri(14, 40));
      const months = pick([6, 12, 12, 12, 18]);
      const end = ymd(new Date(start.getFullYear(), start.getMonth() + months, start.getDate()));
      const today = ymd(TODAY);
      const startY = ymd(start);
      const status: Placement['status'] = startY > today ? 'Starting' : end < today ? 'Completed' : 'Active';

      const pl: Placement = {
        id: 'PL-' + (2200 + PLACEMENTS.length),
        submissionId: sub.id,
        consultantId: c.id,
        conId: c.id,
        clientId: r.clientId,
        sowId: r.sowId,
        reqId: r.id,
        vendorId: c.vendorId,
        role: r.role,
        location: r.location,
        ccy: sub.ccy,
        unit: sub.unit,
        billRate: sub.billRate,
        payRate: sub.payRate,
        margin: sub.margin,
        start: startY,
        end,
        startOn: startY,
        endOn: end,
        extensions: months > 12 ? ri(1, 2) : ri(0, 1),
        status,
        hoursPerWeek: 40,
        tsCompliance: ri(84, 100),
        poNumber: sowOf(r.sowId) ? sowOf(r.sowId)!.po : 'PO-' + ri(100000, 999999),
      };
      PLACEMENTS.push(pl);
      r.filled++;
      const sow = sowOf(r.sowId);
      if (sow) sow.filled++;

      /* the consultant is committed until the assignment ends */
      if (status !== 'Completed') {
        c.status = 'Placed';
        c.placementId = pl.id;
      }
      busyUntil[c.id] = end;
    });

    /* filled requirements close; so do ones the client let lapse */
    r.status = r.filled >= r.positions ? 'Filled' : daysBetween(r.closeBy, ymd(TODAY)) > 25 ? 'Closed' : 'Open';
  });

  /* a slice of the live book sits inside its renewal window */
  sortBy(PLACEMENTS.filter((p) => p.status === 'Active'), (p) => p.end)
    .slice(0, 7)
    .forEach((p) => {
      p.end = ymd(addDays(TODAY, ri(8, 42)));
      p.endOn = p.end;
      p.status = 'Ending Soon';
    });
})();

export const subOf = (id: string): Submission | undefined => SUBMISSIONS.find((s) => s.id === id);
export const plOf = (id: string): Placement | undefined => PLACEMENTS.find((p) => p.id === id);

/* ---------------- bench ---------------- */

/*
 * Everyone not on a live assignment is either being marketed or sitting on
 * an internal, non-billable project.
 */
(function genBench() {
  CONSULTANTS.filter((c) => c.status !== 'Placed').forEach((c) => {
    /* how recently they rolled off drives how long they have been idle */
    const last = sortBy(
      PLACEMENTS.filter((p) => p.consultantId === c.id && p.status === 'Completed'),
      (p) => p.end,
    ).slice(-1)[0];
    const idle = last ? Math.max(1, daysBetween(last.end, ymd(TODAY))) : ri(4, 120);

    if (chance(0.66)) {
      c.status = 'Bench';
      c.benchSince = ymd(addDays(TODAY, -Math.min(idle, 150)));
      c.availableFrom = c.benchSince;
      c.rolledOffFrom = last ? clientOf(last.clientId).name : null;
      c.redeployment = pick([
        'Actively marketed', 'Actively marketed', 'In submission',
        'Training / upskilling', 'Awaiting client feedback', 'Not marketed',
      ]);
    } else {
      c.status = 'Internal';
      c.internalProject = pick(PROJECTS.filter((p) => !p.billable)).name;
    }
  });
})();

export const benchList = (): Consultant[] => CONSULTANTS.filter((c) => c.status === 'Bench');
export const benchDays = (c: Consultant): number => (c.benchSince ? daysBetween(c.benchSince, ymd(TODAY)) : 0);
export const benchCost = (c: Consultant): number => benchDays(c) * c.costPerDay;

/* ---------------- invoices ---------------- */

export interface InvoiceLine {
  placementId: string;
  consultant: string | undefined;
  role: string;
  units: number;
  rate: number;
  amount: number;
}

export interface Invoice {
  id: string;
  clientId: string;
  sowId: string;
  /** Billing period as `YYYY-MM`. */
  period: string;
  lines: InvoiceLine[];
  amount: number;
  taxRate: number;
  tax: number;
  total: number;
  ccy: CurrencyId;
  issuedOn: string;
  dueOn: string;
  status: 'Draft' | 'Sent' | 'Paid' | 'Overdue' | 'Disputed';
  paidOn: string | null;
  submittedVia: string;
  dispute: string | null;
}

export const INVOICES: Invoice[] = [];

/*
 * Six months of billing per client, aged so the receivables ledger has a
 * real ageing profile rather than everything settled.
 */
(function genInvoices() {
  const months: string[] = [];
  for (let i = 6; i >= 0; i--) {
    months.push(monthKey(new Date(TODAY.getFullYear(), TODAY.getMonth() - i, 1)));
  }

  CLIENTS.filter((c) => c.status === 'Active').forEach((c) => {
    const pls = PLACEMENTS.filter((p) => p.clientId === c.id && p.status !== 'Starting');
    if (!pls.length) return;

    months.forEach((mk) => {
      /* only bill placements that were live during that month */
      const lines: InvoiceLine[] = pls
        .filter((p) => p.start.slice(0, 7) <= mk && p.end.slice(0, 7) >= mk)
        .map((p) => {
          const units = p.unit === 'per day' ? ri(18, 22) : ri(150, 176);
          return {
            placementId: p.id,
            consultant: conOf(p.consultantId)?.name,
            role: p.role,
            units,
            rate: p.billRate,
            amount: units * p.billRate,
          };
        });
      if (!lines.length) return;

      const amount = sum(lines, (l) => l.amount);
      const taxRate = ({ US: 0, GB: 0.2, CA: 0.13, AE: 0.05, IN: 0.18 } as Record<string, number>)[c.country];
      const tax = Math.round(amount * taxRate);
      const issued = ymd(new Date(+mk.split('-')[0], +mk.split('-')[1], 5));
      const due = ymd(addDays(parseYmd(issued), c.paymentTerms));
      const late = daysBetween(due, ymd(TODAY));

      /* the older the invoice, the more likely it has settled */
      const st: Invoice['status'] =
        issued > ymd(TODAY)
          ? 'Draft'
          : late < 0
            ? chance(0.2)
              ? 'Paid'
              : 'Sent'
            : late < 30
              ? chance(0.58)
                ? 'Paid'
                : chance(0.7)
                  ? 'Overdue'
                  : 'Disputed'
              : late < 75
                ? chance(0.8)
                  ? 'Paid'
                  : chance(0.65)
                    ? 'Overdue'
                    : 'Disputed'
                : chance(0.93)
                  ? 'Paid'
                  : 'Overdue';

      INVOICES.push({
        id: 'INV-' + c.country + '-' + (9000 + INVOICES.length),
        clientId: c.id,
        sowId: pls[0].sowId,
        period: mk,
        lines,
        amount,
        taxRate,
        tax,
        total: amount + tax,
        ccy: c.ccy,
        issuedOn: issued,
        dueOn: due,
        status: st,
        paidOn: st === 'Paid' ? ymd(addDays(parseYmd(due), ri(-10, 14))) : null,
        submittedVia: c.vms || 'Email / AP portal',
        dispute:
          st === 'Disputed'
            ? pick(['Timesheet hours queried for 2 consultants', 'PO number mismatch', 'Rate applied above the agreed card'])
            : null,
      });
    });
  });
})();

/** Days past due; negative means not yet due. */
export const invAgeing = (i: Invoice): number => daysBetween(i.dueOn, ymd(TODAY));

/* ---------------- derived metrics ---------------- */

export interface StaffingKPI {
  placements: number;
  revenueMonthly: number;
  costMonthly: number;
  grossMargin: number;
  bench: number;
  benchCostMonthly: number;
  avgBenchDays: number;
  openReqs: number;
  openPositions: number;
  submissions: number;
  sub2int: number;
  int2place: number;
  fillRate: number;
  utilisation: number;
  /** Outstanding receivables, in the INR base. */
  ar: number;
  arOverdue: number;
  dso: number;
}

/** Monthly run-rate figures use 21 billable days, or 173 hours. */
export function staffingKPI(): StaffingKPI {
  const act = PLACEMENTS.filter((p) => ['Active', 'Ending Soon'].includes(p.status));
  const revenue = sum(act, (p) => toBase(p.billRate * (p.unit === 'per day' ? 21 : 173), p.ccy));
  const cost = sum(act, (p) => toBase(p.payRate * (p.unit === 'per day' ? 21 : 173), p.ccy));
  const bench = benchList();
  const interviewed = SUBMISSIONS.filter((s) => ['interview', 'selected', 'placed'].includes(s.stage)).length;

  return {
    placements: act.length,
    revenueMonthly: revenue,
    costMonthly: cost,
    grossMargin: revenue ? +(((revenue - cost) / revenue) * 100).toFixed(1) : 0,
    bench: bench.length,
    benchCostMonthly: sum(bench, (c) => toBase(c.costPerDay * 21, c.ccy)),
    avgBenchDays: bench.length ? Math.round(sum(bench, benchDays) / bench.length) : 0,
    openReqs: REQUIREMENTS.filter((r) => r.status === 'Open' && r.filled < r.positions).length,
    openPositions: sum(REQUIREMENTS.filter((r) => r.status === 'Open'), (r) => Math.max(0, r.positions - r.filled)),
    submissions: SUBMISSIONS.length,
    sub2int: pct(interviewed, Math.max(1, SUBMISSIONS.length)),
    int2place: pct(SUBMISSIONS.filter((s) => s.stage === 'placed').length, Math.max(1, interviewed)),
    fillRate: pct(
      sum(REQUIREMENTS, (r) => r.filled),
      Math.max(
        1,
        sum(REQUIREMENTS.filter((r) => r.status !== 'Open'), (r) => r.positions) +
          sum(REQUIREMENTS.filter((r) => r.status === 'Open'), (r) => r.positions),
      ),
    ),
    utilisation: pct(act.length, Math.max(1, CONSULTANTS.length)),
    ar: sum(INVOICES.filter((i) => !['Paid', 'Draft'].includes(i.status)), (i) => toBase(i.total, i.ccy)),
    arOverdue: sum(INVOICES.filter((i) => ['Overdue', 'Disputed'].includes(i.status)), (i) => toBase(i.total, i.ccy)),
    dso: Math.round(
      sum(INVOICES.filter((i) => i.paidOn), (i) => daysBetween(i.issuedOn, i.paidOn!)) /
        Math.max(1, INVOICES.filter((i) => i.paidOn).length),
    ),
  };
}
