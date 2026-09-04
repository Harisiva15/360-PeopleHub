/* Shares the RNG stream with the asset register — this import fixes the draw order. */
import './assets';

import { sum } from '../lib/collections';
import { addDays, daysBetween, parseYmd, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ASSETS } from './announcements';
import { ACTIVE, empName } from './employees';
import { ASSET_MODELS, bookValue } from './assets';
import type { Asset } from '../types/asset';
import type { Employee } from '../types/employee';
import type { Grade } from '../types/country';

/** What each grade may hold, and what needs a second approval. */
export const ASSET_POLICY = {
  entitlement: {
    L1: ['Dell Latitude 5440', 'Dell 24" Monitor', 'Headset — Jabra Evolve'],
    L2: ['Dell Latitude 5440', 'Dell 24" Monitor', 'Headset — Jabra Evolve', 'Logitech MX Keys'],
    L3: ['ThinkPad T14', 'Dell 24" Monitor', 'Headset — Jabra Evolve', 'Logitech MX Keys', 'Docking Station'],
    L4: ['MacBook Air 13"', 'LG 27" 4K Monitor', 'Headset — Jabra Evolve', 'Logitech MX Keys', 'Docking Station', 'YubiKey'],
    L5: ['MacBook Pro 14"', 'LG 27" 4K Monitor', 'Headset — Jabra Evolve', 'Logitech MX Keys', 'Docking Station', 'YubiKey', 'iPhone 14'],
    L6: ['MacBook Pro 14"', 'LG 27" 4K Monitor', 'Headset — Jabra Evolve', 'Logitech MX Keys', 'Docking Station', 'YubiKey', 'iPhone 14'],
  } as Record<Grade, string[]>,
  /** Anything dearer than this also needs Finance sign-off. */
  approvalOver: 25000,
  refreshYears: { LAPTOP: 4, MOBILE: 3, DISPLAY: 5, PERIPH: 3, SECURITY: 5, LICENCE: 1 } as Record<string, number>,
  damageRecovery: 'Written-down value, capped at one month of basic salary',
  wfhAllowance: 15000,
  byodAllowed: false,
};

export const entitledTo = (e: Employee): string[] =>
  ASSET_POLICY.entitlement[e.grade] || ASSET_POLICY.entitlement.L2;

export const isEntitled = (e: Employee, type: string): boolean => entitledTo(e).includes(type);

export const REQ_REASONS = [
  'New joiner provisioning', 'Refresh — past useful life', 'Device fault',
  'Damaged or lost', 'Additional equipment', 'Role change', 'Work from home setup',
];

export interface AssetRequest {
  id: string;
  empId: string;
  type: string;
  cat: string;
  cost: number;
  reason: string;
  note: string;
  raisedOn: string;
  status: string;
  /** Whether the item falls inside the requester's grade entitlement. */
  entitled: boolean;
  needsFinance: boolean;
  managerId: string | null;
  approvedBy: string | null;
  approvedOn: string | null;
  rejectReason: string | null;
  fulfilledOn: string | null;
  assetId: string | null;
}

export const ASSET_REQS: AssetRequest[] = [];

(function genAssetReqs() {
  const pool = ACTIVE();
  for (let i = 0; i < 34; i++) {
    const e = pick(pool);
    const m = pick(ASSET_MODELS);
    const on = ymd(addDays(TODAY, -ri(0, 55)));
    const needsFin = m.cost > ASSET_POLICY.approvalOver;
    const ent = isEntitled(e, m.t);
    const age = daysBetween(on, ymd(TODAY));

    /* older requests have worked their way through; recent ones are still open */
    const st =
      age > 25
        ? pick(['Fulfilled', 'Fulfilled', 'Fulfilled', 'Rejected'])
        : age > 10
          ? pick(['Fulfilled', 'Approved', 'Approved', 'Rejected'])
          : pick(['Pending manager', 'Pending manager', 'Pending IT', needsFin ? 'Pending finance' : 'Approved']);

    ASSET_REQS.push({
      id: 'AR-' + (400 + i),
      empId: e.id,
      type: m.t,
      cat: m.cat,
      cost: m.cost,
      reason: pick(REQ_REASONS),
      note: '',
      raisedOn: on,
      status: st,
      entitled: ent,
      needsFinance: needsFin,
      managerId: e.managerId,
      approvedBy: ['Approved', 'Fulfilled'].includes(st) ? empName(e.managerId || '') : null,
      approvedOn: ['Approved', 'Fulfilled'].includes(st) ? ymd(addDays(parseYmd(on), ri(1, 5))) : null,
      rejectReason:
        st === 'Rejected'
          ? ent
            ? pick(['Existing device still within refresh cycle', 'Budget deferred to next quarter'])
            : 'Outside grade entitlement — approval not granted'
          : null,
      fulfilledOn: st === 'Fulfilled' ? ymd(addDays(parseYmd(on), ri(3, 14))) : null,
      assetId: null,
    });
  }
  ASSET_REQS.sort((a, b) => b.raisedOn.localeCompare(a.raisedOn));
})();

export const arOpen = (): AssetRequest[] => ASSET_REQS.filter((r) => r.status.startsWith('Pending'));

export const ASSET_REQ_BADGE: Record<string, string> = {
  Fulfilled: 'good', Approved: 'info', Rejected: 'crit',
};

export interface AssetTransfer {
  id: string;
  assetId: string;
  fromId: string;
  toId: string | null;
  on: string;
  reason: string;
  condition: string;
  approvedBy: string;
}

/** Transfer history — an asset can move between people. */
export const ASSET_XFER: AssetTransfer[] = [];

(function genXfer() {
  ASSETS.filter((a) => a.status === 'Assigned' && chance(0.12))
    .slice(0, 24)
    .forEach((a) => {
      const from = pick(ACTIVE().filter((e) => e.id !== a.empId));
      ASSET_XFER.push({
        id: uid('AX'),
        assetId: a.id,
        fromId: from.id,
        toId: a.empId,
        on: ymd(addDays(TODAY, -ri(15, 300))),
        reason: pick(['Team change', 'Upgrade swap', 'Backfill after exit', 'Project reallocation']),
        condition: pick(['Good', 'Good', 'Fair']),
        approvedBy: 'IT Service Desk',
      });
    });
})();

export const xferOf = (assetId: string): AssetTransfer[] => ASSET_XFER.filter((x) => x.assetId === assetId);

export interface AssetClearance {
  held: Asset[];
  clear: boolean;
  value: number;
  blocking: string | null;
}

/** IT cannot sign off an exit while kit is still outstanding. */
export function assetClearance(empId: string): AssetClearance {
  const held = ASSETS.filter((a) => a.empId === empId && a.status === 'Assigned');
  return {
    held,
    clear: held.length === 0,
    value: sum(held, bookValue),
    blocking: held.length ? held.map((a) => a.type).join(', ') : null,
  };
}
