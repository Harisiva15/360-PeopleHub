/*
 * Last in the RNG chain, after the derived lifecycle stages.
 */
import './lifecycleStages';

import { sortBy, sum } from '../lib/collections';
import { addDays, daysBetween, parseYmd, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE, EMAP } from './employees';
import { ASSETS } from './assets';

/**
 * The software estate — subscriptions and who sits on them.
 *
 * **A licence is not a laptop, and modelling it as one loses the question you
 * bought the module to answer.** The asset register already holds a row per
 * physical thing, with a serial, a warranty and a depreciation curve. Software
 * has none of those: it is a seat count you renew, and the thing worth knowing
 * is how many of those seats nobody has opened in two months and what that
 * costs. So this is its own register, shaped around seats and renewals.
 *
 * The two registers are not allowed to drift. Three products — Microsoft 365,
 * JetBrains and Figma — already have rows in the asset register under the
 * LICENCE category, because IT issued them as kit. Their seats here are read
 * off those rows rather than generated, so the same person holds the same seat
 * in both places by construction. Everything else is software that was never
 * in the asset register at all, which is most of it.
 */

export const SOFTWARE_CATS = [
  'Productivity', 'Engineering', 'Design', 'Security', 'Sales & marketing',
  'Finance', 'People',
] as const;
export type SoftwareCat = (typeof SOFTWARE_CATS)[number];

export type SoftwareStatus = 'Active' | 'Trial' | 'Cancelled';
export type Billing = 'Annual' | 'Monthly';

export interface SoftwareProduct {
  id: string;
  n: string;
  vendor: string;
  cat: SoftwareCat;
  plan: string;
  /** Seats the company is paying for, which is not the same as seats in use. */
  seats: number;
  /** Rupees per seat per year, however it is billed. */
  unitCost: number;
  billing: Billing;
  renewsOn: string;
  /** The person who signs for it — not the administrator who records it. */
  ownerId: string | null;
  status: SoftwareStatus;
  /** Whether sign-in goes through the company identity provider. */
  sso: boolean;
  /** True where the vendor holds employee personal data. */
  holdsPersonalData: boolean;
  notes: string;
}

export interface SoftwareSeat {
  id: string;
  productId: string;
  empId: string;
  assignedOn: string;
  /** Null where the seat has been paid for and never opened. */
  lastUsedOn: string | null;
  /** The asset row this seat mirrors, where IT issued it as kit. */
  assetId: string | null;
}

export const SOFTWARE: SoftwareProduct[] = [];
export const SEATS: SoftwareSeat[] = [];

/**
 * A seat nobody has touched for this long is the one worth reclaiming.
 *
 * Two months rather than two weeks: plenty of real tools are opened once a
 * quarter on purpose, and a threshold that flags those turns the whole list
 * into noise somebody learns to scroll past.
 */
export const DORMANT_DAYS = 60;

/** A renewal this close is one you can still decide about. */
export const RENEWAL_WINDOW = 90;

/* ---------------- the catalogue ---------------- */

/**
 * What the company buys, and roughly who it is for.
 *
 * `to` names the departments the tool is bought for, which is what makes the
 * seat generation below produce a believable estate rather than a uniform
 * sprinkle — Figma belongs to designers, and a register where every department
 * holds the same share of every product answers no question anybody has.
 */
const CATALOGUE: {
  n: string; vendor: string; cat: SoftwareCat; plan: string;
  unitCost: number; to: string[]; reach: number; sso: boolean; pii?: boolean;
}[] = [
  { n: 'Microsoft 365 E5', vendor: 'Microsoft', cat: 'Productivity', plan: 'E5', unitCost: 5400, to: [], reach: 1, sso: true, pii: true },
  { n: 'Slack', vendor: 'Salesforce', cat: 'Productivity', plan: 'Business+', unitCost: 1100, to: [], reach: 0.94, sso: true },
  { n: 'Zoom', vendor: 'Zoom', cat: 'Productivity', plan: 'Business', unitCost: 1600, to: [], reach: 0.42, sso: true },
  { n: 'Atlassian Jira & Confluence', vendor: 'Atlassian', cat: 'Engineering', plan: 'Premium', unitCost: 1450, to: ['ENG', 'PROD', 'QA', 'DEVOPS'], reach: 0.9, sso: true },
  { n: 'GitHub Enterprise', vendor: 'GitHub', cat: 'Engineering', plan: 'Enterprise Cloud', unitCost: 1750, to: ['ENG', 'QA'], reach: 0.95, sso: true },
  { n: 'JetBrains All Products', vendor: 'JetBrains', cat: 'Engineering', plan: 'All Products Pack', unitCost: 24000, to: ['ENG'], reach: 0.55, sso: false },
  { n: 'Datadog', vendor: 'Datadog', cat: 'Engineering', plan: 'Pro', unitCost: 6800, to: ['ENG', 'DEVOPS'], reach: 0.35, sso: true },
  { n: 'Postman', vendor: 'Postman', cat: 'Engineering', plan: 'Professional', unitCost: 1150, to: ['ENG', 'QA'], reach: 0.6, sso: false },
  { n: 'Figma Organisation', vendor: 'Figma', cat: 'Design', plan: 'Organisation', unitCost: 13500, to: ['PROD'], reach: 0.8, sso: true },
  { n: 'Adobe Creative Cloud', vendor: 'Adobe', cat: 'Design', plan: 'All Apps', unitCost: 47000, to: ['PROD', 'SALES'], reach: 0.3, sso: true },
  { n: '1Password', vendor: 'AgileBits', cat: 'Security', plan: 'Business', unitCost: 700, to: [], reach: 0.88, sso: true, pii: true },
  { n: 'CrowdStrike Falcon', vendor: 'CrowdStrike', cat: 'Security', plan: 'Falcon Pro', unitCost: 4900, to: [], reach: 1, sso: true },
  { n: 'Salesforce Sales Cloud', vendor: 'Salesforce', cat: 'Sales & marketing', plan: 'Enterprise', unitCost: 13800, to: ['SALES'], reach: 0.85, sso: true, pii: true },
  { n: 'HubSpot Marketing Hub', vendor: 'HubSpot', cat: 'Sales & marketing', plan: 'Professional', unitCost: 8200, to: ['SALES'], reach: 0.4, sso: false, pii: true },
  { n: 'LinkedIn Recruiter', vendor: 'Microsoft', cat: 'People', plan: 'Corporate', unitCost: 74000, to: ['HR'], reach: 0.5, sso: false, pii: true },
  { n: 'Zoho Books', vendor: 'Zoho', cat: 'Finance', plan: 'Premium', unitCost: 3600, to: ['FIN'], reach: 0.8, sso: false, pii: true },
  { n: 'Razorpay X', vendor: 'Razorpay', cat: 'Finance', plan: 'Business', unitCost: 2400, to: ['FIN'], reach: 0.5, sso: false, pii: true },
  { n: 'Notion', vendor: 'Notion Labs', cat: 'Productivity', plan: 'Business', unitCost: 1500, to: [], reach: 0.35, sso: false },
];

/** The products the asset register also holds, matched by the model name on the row. */
const ALSO_KIT: Record<string, string> = {
  'Microsoft 365 E5': 'Microsoft 365 E5',
  'JetBrains All Products': 'JetBrains All Products',
  'Figma Organisation': 'Figma Organisation',
};

(function genSoftware() {
  const owners = ACTIVE().filter((e) => /Manager|Head|Lead|Director/i.test(e.designation));

  CATALOGUE.forEach((c) => {
    /* Renewals land through the year rather than all on 1 April. */
    const renewsOn = ymd(addDays(TODAY, ri(-40, 320)));
    const p: SoftwareProduct = {
      id: uid('SW'),
      n: c.n,
      vendor: c.vendor,
      cat: c.cat,
      plan: c.plan,
      seats: 0,
      unitCost: c.unitCost,
      billing: chance(0.75) ? 'Annual' : 'Monthly',
      renewsOn,
      ownerId: owners.length ? pick(owners).id : null,
      status: chance(0.94) ? 'Active' : 'Trial',
      sso: c.sso,
      holdsPersonalData: c.pii ?? false,
      notes: '',
    };
    SOFTWARE.push(p);

    /* Who it is for. An empty `to` means the whole company. */
    const audience = ACTIVE().filter((e) => !c.to.length || c.to.includes(e.dept));
    const kitName = ALSO_KIT[c.n];

    /*
     * Where the asset register already issued this product, its rows are the
     * seats. Generating a second, independent set would give two registers
     * that disagree about who holds a Figma licence, and the first person to
     * notice would be right to distrust both.
     */
    const fromKit = kitName
      ? ASSETS.filter((a) => a.type === kitName && a.empId && a.status === 'Assigned')
      : [];

    const held = new Set<string>();
    fromKit.forEach((a) => {
      if (held.has(a.empId!)) return;
      held.add(a.empId!);
      SEATS.push({
        id: uid('SEAT'),
        productId: p.id,
        empId: a.empId!,
        assignedOn: a.issued ?? ymd(addDays(TODAY, -ri(60, 700))),
        lastUsedOn: null,
        assetId: a.id,
      });
    });

    audience.forEach((e) => {
      if (held.has(e.id) || !chance(c.reach)) return;
      held.add(e.id);
      SEATS.push({
        id: uid('SEAT'),
        productId: p.id,
        empId: e.id,
        assignedOn: ymd(addDays(TODAY, -ri(20, 900))),
        lastUsedOn: null,
        assetId: null,
      });
    });

    /*
     * Seats bought, which is deliberately not seats used. Buying in blocks and
     * leaving headroom is what every company does, and a register where the
     * two numbers always match cannot show the thing it exists to show.
     */
    const used = held.size;
    const block = c.unitCost > 20000 ? 5 : 25;
    p.seats = Math.max(used, Math.ceil((used + ri(0, block)) / block) * block);
  });

  /*
   * When each seat was last opened.
   *
   * Assigned long ago and never opened is the expensive case, so it is drawn
   * separately rather than as the tail of a distribution — a seat somebody
   * took in January and has not touched since is exactly what the dormant
   * figure is for.
   */
  SEATS.forEach((s) => {
    const assignedDays = daysBetween(s.assignedOn, ymd(TODAY));
    if (chance(0.06) && assignedDays > 120) {
      s.lastUsedOn = null;
      return;
    }
    const ago = chance(0.78)
      ? ri(0, 20)
      : chance(0.6) ? ri(21, 75) : ri(76, Math.max(80, Math.min(assignedDays, 400)));
    const day = ymd(addDays(TODAY, -Math.min(ago, assignedDays)));
    s.lastUsedOn = day < s.assignedOn ? s.assignedOn : day;
  });
})();

/* ---------------- what the register can tell you ---------------- */

export const productOf = (id: string) => SOFTWARE.find((p) => p.id === id);

export const seatsOf = (productId: string) =>
  sortBy(SEATS.filter((s) => s.productId === productId), (s) => EMAP[s.empId]?.name ?? s.empId);

export const seatsHeldBy = (empId: string) => SEATS.filter((s) => s.empId === empId);

/** A seat nobody has opened in `DORMANT_DAYS`, or has never opened at all. */
export const isDormant = (s: SoftwareSeat, asOf = ymd(TODAY)): boolean =>
  !s.lastUsedOn || daysBetween(s.lastUsedOn, asOf) >= DORMANT_DAYS;

/** Per-seat cost is annual, so a monthly plan still has an annual figure. */
export const annualCost = (p: SoftwareProduct): number => p.seats * p.unitCost;

/**
 * What the unused seats cost a year.
 *
 * Seats you pay for and nobody holds, plus seats somebody holds and never
 * opens. Both are money, and separating them would invite the reading that one
 * of them is free.
 */
export function wastedCost(p: SoftwareProduct, asOf = ymd(TODAY)): number {
  const seats = seatsOf(p.id);
  const idle = Math.max(0, p.seats - seats.length) + seats.filter((s) => isDormant(s, asOf)).length;
  return idle * p.unitCost;
}

/** Days until it renews; negative where the date has passed and nobody acted. */
export const renewsInDays = (p: SoftwareProduct, asOf = ymd(TODAY)): number =>
  daysBetween(asOf, p.renewsOn);

/**
 * More people hold seats than the company bought.
 *
 * This is a real state, not a data error — a team adds people faster than
 * procurement adds seats — and it is the one condition that costs money the
 * moment the vendor audits, so it is derived rather than flagged by hand.
 */
export const isOverAllocated = (p: SoftwareProduct): boolean => seatsOf(p.id).length > p.seats;

export function softwareKPI(asOf = ymd(TODAY)) {
  const live = SOFTWARE.filter((p) => p.status !== 'Cancelled');
  const seats = SEATS.filter((s) => live.some((p) => p.id === s.productId));
  return {
    products: live.length,
    seatsPurchased: sum(live, (p) => p.seats),
    seatsAssigned: seats.length,
    dormantSeats: seats.filter((s) => isDormant(s, asOf)).length,
    annualSpend: sum(live, annualCost),
    wastedSpend: sum(live, (p) => wastedCost(p, asOf)),
    renewingSoon: live.filter((p) => {
      const d = renewsInDays(p, asOf);
      return d >= 0 && d <= RENEWAL_WINDOW;
    }).length,
    overdue: live.filter((p) => renewsInDays(p, asOf) < 0).length,
    overAllocated: live.filter(isOverAllocated).length,
    noSso: live.filter((p) => !p.sso).length,
  };
}

/** The renewal calendar, soonest first, for the next year. */
export const renewalCalendar = (asOf = ymd(TODAY)) =>
  sortBy(
    SOFTWARE.filter((p) => p.status !== 'Cancelled'
      && parseYmd(p.renewsOn) <= addDays(TODAY, 365)),
    (p) => p.renewsOn,
  ).map((p) => ({ product: p, inDays: renewsInDays(p, asOf) }));
