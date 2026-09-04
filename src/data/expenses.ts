/* Shares the RNG stream with engagement — this import fixes the draw order. */
import './engagement';

import { sum } from '../lib/collections';
import { addDays, MONL, monthKey, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, rnd, uid } from '../lib/rng';
import { ACTIVE } from './employees';
import { PROJECTS } from './org';

export interface ExpCat {
  id: string;
  n: string;
  /** Per-claim policy cap; anything above is flagged. */
  limit: number;
  ic: string;
  proof: boolean;
  c: string;
}

export const EXP_CATS: ExpCat[] = [
  { id: 'AIR', n: 'Air Travel', limit: 25000, ic: '✈️', proof: true, c: 'var(--s1)' },
  { id: 'HOTEL', n: 'Hotel / Stay', limit: 6000, ic: '🏨', proof: true, c: 'var(--s2)' },
  { id: 'LOCAL', n: 'Local Travel / Cab', limit: 2500, ic: '🚕', proof: true, c: 'var(--s3)' },
  { id: 'MEAL', n: 'Meals (per day)', limit: 800, ic: '🍽️', proof: false, c: 'var(--s4)' },
  { id: 'CLIENT', n: 'Client Entertainment', limit: 10000, ic: '🤝', proof: true, c: 'var(--s5)' },
  { id: 'NET', n: 'Broadband / Internet', limit: 1500, ic: '🌐', proof: true, c: 'var(--s7)' },
  { id: 'MOB', n: 'Mobile Bill', limit: 1000, ic: '📱', proof: true, c: 'var(--s6)' },
  { id: 'LEARN', n: 'Learning & Certification', limit: 40000, ic: '🎓', proof: true, c: 'var(--s8)' },
  { id: 'RELOC', n: 'Relocation', limit: 75000, ic: '📦', proof: true, c: 'var(--s1)' },
  { id: 'FUEL', n: 'Fuel & Mileage', limit: 6000, ic: '⛽', proof: true, c: 'var(--s2)' },
];

export const expCat = (id: string): ExpCat => EXP_CATS.find((c) => c.id === id) || EXP_CATS[0];

export interface ExpItem {
  id: string;
  cat: string;
  date: string;
  amount: number;
  merchant: string;
  desc: string;
  receipt: string | null;
  project: string | null;
  overLimit?: boolean;
}

export type ClaimStatus = 'Submitted' | 'Approved' | 'Reimbursed' | 'Rejected';

export interface Claim {
  id: string;
  empId: string;
  title: string;
  items: ExpItem[];
  total: number;
  status: ClaimStatus;
  submittedOn: string;
  approverId: string | null;
  actedOn: string | null;
  reimbursedOn: string | null;
  /** Payroll month the reimbursement rides out with. */
  payrollMonth: string | null;
  note: string;
}

export const CLAIMS: Claim[] = [];

(function genClaims() {
  const merchants: Record<string, string[]> = {
    AIR: ['IndiGo', 'Air India', 'Akasa Air'],
    HOTEL: ['Taj', 'Novotel', 'Lemon Tree', 'OYO Townhouse'],
    LOCAL: ['Uber', 'Ola', 'Rapido', 'Auto'],
    MEAL: ['Swiggy', 'Zomato', 'Hotel Saravana Bhavan'],
    CLIENT: ['ITC Grand', 'Barbeque Nation'],
    NET: ['ACT Fibernet', 'Airtel Xstream', 'JioFiber'],
    MOB: ['Airtel', 'Jio', 'Vi'],
    LEARN: ['Udemy', 'Coursera', 'AWS Training'],
    RELOC: ['Agarwal Packers', 'Leo Packers'],
    FUEL: ['Indian Oil', 'HP Petrol Pump'],
  };
  const CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'Pune', 'Kolkata'];

  /* claims are built from realistic themes, so line items hang together */
  const THEMES = [
    { k: 'travel', cats: ['AIR', 'HOTEL', 'LOCAL', 'MEAL'], n: [3, 4], title: () => 'Client visit — ' + pick(CITIES) },
    { k: 'bills', cats: ['NET', 'MOB'], n: [1, 2], title: () => 'Monthly internet & mobile' },
    { k: 'learning', cats: ['LEARN'], n: [1, 1], title: () => pick(['AWS certification', 'Kubernetes certification', 'Product management course']) },
    { k: 'reloc', cats: ['RELOC'], n: [1, 1], title: () => 'Relocation to ' + pick(['Chennai', 'Bengaluru', 'Hyderabad']) },
    { k: 'client', cats: ['CLIENT', 'LOCAL', 'MEAL'], n: [1, 3], title: () => 'Customer workshop — ' + pick(CITIES) },
    { k: 'local', cats: ['LOCAL', 'FUEL'], n: [1, 3], title: () => 'Local travel — ' + MONL[ri(0, 11)] },
    { k: 'offsite', cats: ['HOTEL', 'MEAL', 'LOCAL'], n: [2, 4], title: () => pick(['Team offsite — Pondicherry', 'Team offsite — Coorg', 'Quarterly team dinner']) },
  ];

  const descOf: Record<string, string> = {
    travel: 'Project travel', bills: 'Monthly bill', learning: 'Approved training',
    reloc: 'Relocation on joining', client: 'Customer meeting', local: 'Local commute', offsite: 'Team event',
  };

  ACTIVE().forEach((e) => {
    if (!chance(0.55)) return;
    const n = ri(1, 3);
    for (let i = 0; i < n; i++) {
      const raised = addDays(TODAY, -ri(1, 100));
      const th = pick(THEMES);
      const items: ExpItem[] = Array.from({ length: ri(th.n[0], th.n[1]) }, () => {
        const c = expCat(pick(th.cats));
        return {
          id: uid('EX'),
          cat: c.id,
          date: ymd(addDays(raised, -ri(0, 10))),
          amount: Math.round((c.limit * (0.3 + rnd() * 0.85)) / 10) * 10,
          merchant: pick(merchants[c.id]),
          desc: descOf[th.k],
          receipt: c.proof ? 'receipt_' + ri(10000, 99999) + '.pdf' : null,
          project: th.k === 'travel' || th.k === 'client' ? pick(PROJECTS).id : null,
        };
      });
      items.forEach((it) => {
        it.overLimit = it.amount > expCat(it.cat).limit;
      });

      const total = sum(items, (it) => it.amount);
      const st: ClaimStatus = pick([
        'Submitted', 'Submitted', 'Approved', 'Approved',
        'Reimbursed', 'Reimbursed', 'Reimbursed', 'Rejected',
      ] as ClaimStatus[]);

      CLAIMS.push({
        id: 'EXP-' + (4200 + CLAIMS.length),
        empId: e.id,
        title: th.title(),
        items,
        total,
        status: st,
        submittedOn: ymd(raised),
        approverId: e.managerId,
        actedOn: st === 'Submitted' ? null : ymd(addDays(raised, ri(1, 5))),
        reimbursedOn: st === 'Reimbursed' ? ymd(addDays(raised, ri(6, 20))) : null,
        payrollMonth: st === 'Reimbursed' ? monthKey(addDays(raised, 20)) : null,
        note: st === 'Rejected' ? 'Receipt not legible — please re-upload and resubmit.' : '',
      });
    }
  });
})();

export interface Advance {
  id: string;
  empId: string;
  amount: number;
  reason: string;
  requestedOn: string;
  status: 'Pending' | 'Approved' | 'Settled';
  settled: number;
}

export const ADVANCES: Advance[] = [];

(function genAdv() {
  ACTIVE()
    .filter(() => chance(0.09))
    .forEach((e) => {
      ADVANCES.push({
        id: 'ADV-' + (300 + ADVANCES.length),
        empId: e.id,
        amount: ri(10, 60) * 1000,
        reason: pick(['Client travel to Singapore', 'Relocation advance', 'Conference travel — Delhi', 'Onsite deployment travel']),
        requestedOn: ymd(addDays(TODAY, -ri(5, 70))),
        status: pick(['Pending', 'Approved', 'Approved', 'Settled'] as Advance['status'][]),
        settled: 0,
      });
    });
  ADVANCES.forEach((a) => {
    if (a.status === 'Settled') a.settled = a.amount;
  });
})();
