/* Shares the RNG stream with WhatsApp — this import fixes the draw order. */
import './whatsapp';

import { sum } from '../lib/collections';
import { addDays, daysBetween, parseYmd, TODAY, ymd } from '../lib/dates';
import { clamp } from '../lib/format';
import { chance, pick, ri, uid } from '../lib/rng';
import { ASSETS } from './announcements';
import { ACTIVE, EMAP } from './employees';
import { SITES } from './org';
import { EXITS } from './exit';
import type { Asset } from '../types/asset';

export interface AssetCat {
  id: string;
  n: string;
  /** Useful life in years, used for depreciation and refresh cycles. */
  life: number;
  c: string;
}

export const ASSET_CATS: AssetCat[] = [
  { id: 'LAPTOP', n: 'Laptops', life: 4, c: 'var(--s1)' },
  { id: 'MOBILE', n: 'Mobile devices', life: 3, c: 'var(--s2)' },
  { id: 'DISPLAY', n: 'Monitors & displays', life: 5, c: 'var(--s3)' },
  { id: 'PERIPH', n: 'Peripherals', life: 3, c: 'var(--s4)' },
  { id: 'SECURITY', n: 'Security keys', life: 5, c: 'var(--s7)' },
  { id: 'LICENCE', n: 'Software licences', life: 1, c: 'var(--s5)' },
];

export const acatOf = (id?: string): AssetCat => ASSET_CATS.find((c) => c.id === id) || ASSET_CATS[0];

export interface AssetModel {
  t: string;
  cat: string;
  cost: number;
  vendor: string;
}

export const ASSET_MODELS: AssetModel[] = [
  { t: 'MacBook Pro 14"', cat: 'LAPTOP', cost: 235000, vendor: 'Redington India' },
  { t: 'MacBook Air 13"', cat: 'LAPTOP', cost: 118000, vendor: 'Redington India' },
  { t: 'Dell Latitude 5440', cat: 'LAPTOP', cost: 92000, vendor: 'Dell Technologies' },
  { t: 'ThinkPad T14', cat: 'LAPTOP', cost: 104000, vendor: 'Lenovo India' },
  { t: 'iPhone 14', cat: 'MOBILE', cost: 68000, vendor: 'Ingram Micro' },
  { t: 'Samsung Galaxy S23', cat: 'MOBILE', cost: 54000, vendor: 'Ingram Micro' },
  { t: 'Dell 24" Monitor', cat: 'DISPLAY', cost: 17500, vendor: 'Dell Technologies' },
  { t: 'LG 27" 4K Monitor', cat: 'DISPLAY', cost: 32000, vendor: 'Redington India' },
  { t: 'Logitech MX Keys', cat: 'PERIPH', cost: 9500, vendor: 'Ingram Micro' },
  { t: 'Headset — Jabra Evolve', cat: 'PERIPH', cost: 12500, vendor: 'Ingram Micro' },
  { t: 'Docking Station', cat: 'PERIPH', cost: 14500, vendor: 'Dell Technologies' },
  { t: 'YubiKey', cat: 'SECURITY', cost: 5200, vendor: 'CDW' },
  { t: 'Microsoft 365 E5', cat: 'LICENCE', cost: 5400, vendor: 'Microsoft' },
  { t: 'JetBrains All Products', cat: 'LICENCE', cost: 24000, vendor: 'JetBrains' },
  { t: 'Figma Organisation', cat: 'LICENCE', cost: 13500, vendor: 'Figma' },
];

export const modelOf = (t: string): AssetModel => ASSET_MODELS.find((m) => m.t === t) || ASSET_MODELS[0];

const warrantyFrom = (purchased: string, years: number): string => {
  const p = parseYmd(purchased);
  return ymd(new Date(p.getFullYear() + years, p.getMonth(), p.getDate()));
};

/* enrich every seeded asset, then add unassigned stock and retired kit */
(function enrichAssets() {
  ASSETS.forEach((a) => {
    const m = modelOf(a.type);
    const e = a.empId ? EMAP[a.empId] : undefined;
    a.cat = m.cat;
    a.cost = m.cost;
    a.vendor = m.vendor;

    /*
     * Kit is refreshed on cycle, so what someone holds is never older than its
     * category life — re-date the issue to the current cycle, not the joining date.
     */
    const life = acatOf(m.cat).life;
    a.issued =
      parseYmd(a.issued!) > addDays(TODAY, -life * 365) ? a.issued : ymd(addDays(TODAY, -ri(30, life * 365 - 60)));
    a.purchased = ymd(addDays(parseYmd(a.issued!), -ri(5, 90)));
    a.warrantyEnd = warrantyFrom(a.purchased, m.cat === 'LICENCE' ? 1 : 3);
    a.site = e ? e.site : 'CHN';
    a.country = e ? e.country : 'IN';
    a.condition = chance(0.78) ? 'Good' : chance(0.6) ? 'Fair' : 'Needs repair';
    a.status = a.condition === 'Needs repair' && chance(0.4) ? 'In repair' : 'Assigned';
    a.tag = 'AT-' + ri(10000, 99999);
  });

  /*
   * Every employee gets exactly one company laptop — issue one to anyone the
   * seed missed, and take back duplicates so the register reconciles.
   */
  ACTIVE().forEach((e) => {
    const laptops = ASSETS.filter((a) => a.empId === e.id && a.cat === 'LAPTOP' && a.status === 'Assigned');
    if (laptops.length === 0) {
      const m = pick(ASSET_MODELS.filter((z) => z.cat === 'LAPTOP'));
      const issued = parseYmd(e.doj) > addDays(TODAY, -4 * 365) ? e.doj : ymd(addDays(TODAY, -ri(30, 1400)));
      const purchased = ymd(addDays(parseYmd(issued), -ri(5, 90)));
      ASSETS.push({
        id: uid('AST'), empId: e.id, type: m.t, cat: m.cat, cost: m.cost, vendor: m.vendor,
        serial: 'SN' + ri(100000, 999999), tag: 'AT-' + ri(10000, 99999),
        purchased, issued, warrantyEnd: warrantyFrom(purchased, 3),
        site: e.site, country: e.country,
        condition: chance(0.85) ? 'Good' : 'Fair', status: 'Assigned',
      });
    } else if (laptops.length > 1) {
      laptops.slice(1).forEach((a) => {
        a.empId = null;
        a.issued = null;
        a.status = 'In stock';
      });
    }
  });

  /* spare stock held by IT */
  for (let i = 0; i < 42; i++) {
    const m = pick(ASSET_MODELS);
    const purchased = ymd(addDays(TODAY, -ri(20, 700)));
    ASSETS.push({
      id: uid('AST'), empId: null, type: m.t, cat: m.cat, cost: m.cost, vendor: m.vendor,
      serial: 'SN' + ri(100000, 999999), tag: 'AT-' + ri(10000, 99999),
      purchased, issued: null, warrantyEnd: warrantyFrom(purchased, 3),
      site: pick(SITES).id, country: 'IN', condition: pick(['Good', 'Good', 'Fair']),
      status: chance(0.82) ? 'In stock' : 'In repair',
    });
  }

  /* kit recovered from leavers */
  EXITS.filter((x) => x.lwd <= ymd(TODAY)).forEach((x) => {
    if (!chance(0.7)) return;
    const m = pick(ASSET_MODELS.filter((z) => z.cat !== 'LICENCE'));
    const purchased = ymd(addDays(parseYmd(x.lwd), -ri(400, 1400)));
    ASSETS.push({
      id: uid('AST'), empId: null, type: m.t, cat: m.cat, cost: m.cost, vendor: m.vendor,
      serial: 'SN' + ri(100000, 999999), tag: 'AT-' + ri(10000, 99999),
      purchased, issued: null, recoveredFrom: x.empId, recoveredOn: x.lwd,
      warrantyEnd: warrantyFrom(purchased, 3),
      site: EMAP[x.empId]?.site ?? 'CHN', country: EMAP[x.empId]?.country ?? 'IN',
      condition: pick(['Good', 'Fair', 'Fair', 'Needs repair']),
      status: chance(0.55) ? 'In stock' : 'Retired',
    });
  });

  /* end-of-life write-offs — kit already replaced and disposed of */
  for (let i = 0; i < 26; i++) {
    const m = pick(ASSET_MODELS.filter((z) => z.cat !== 'LICENCE'));
    const purchased = ymd(addDays(TODAY, -ri(5, 8) * 365));
    ASSETS.push({
      id: uid('AST'), empId: null, type: m.t, cat: m.cat, cost: m.cost, vendor: m.vendor,
      serial: 'SN' + ri(100000, 999999), tag: 'AT-' + ri(10000, 99999),
      purchased, issued: null, warrantyEnd: warrantyFrom(purchased, 3),
      site: pick(SITES).id, country: 'IN', condition: pick(['Fair', 'Needs repair']),
      status: 'Retired', retiredOn: ymd(addDays(TODAY, -ri(10, 400))),
      disposal: pick([
        'Recycled — certified e-waste', 'Sold to staff at written-down value',
        'Returned to vendor buy-back', 'Destroyed — data-bearing device',
      ]),
    });
  }
})();

export const assetAge = (a: Asset): number => Math.max(0, daysBetween(a.purchased!, ymd(TODAY)) / 365);

/** Straight-line depreciation down to a 5% residual. */
export function bookValue(a: Asset): number {
  const life = acatOf(a.cat).life;
  const dep = clamp(assetAge(a) / life, 0, 1);
  return Math.round(a.cost! * (1 - dep * 0.95));
}

export const assetDep = (a: Asset): number => a.cost! - bookValue(a);
export const inWarranty = (a: Asset): boolean => a.warrantyEnd! >= ymd(TODAY);
export const assetEol = (a: Asset): boolean => assetAge(a) >= acatOf(a.cat).life;

export const ASSET_STATUS_BADGE: Record<string, string> = {
  Assigned: 'good', 'In stock': 'info', 'In repair': 'warn', Retired: 'mute', Lost: 'crit',
};

/**
 * Assets a leaver still holds — drives the exit clearance checklist.
 *
 * Once an exit is settled the kit is back and the recovery is closed, so
 * settled leavers drop out. (The prototype compared against 'Completed', which
 * is not one of the three exit statuses, so its filter excluded nobody and
 * settled leavers stayed on the list for ever.)
 */
export function pendingRecovery(): Asset[] {
  const leaving = new Set(EXITS.filter((x) => x.status !== 'Settled').map((x) => x.empId));
  return ASSETS.filter((a) => a.status === 'Assigned' && a.empId && leaving.has(a.empId));
}

export function assetKPI() {
  const live = ASSETS.filter((a) => a.status !== 'Retired');
  return {
    total: ASSETS.length,
    assigned: ASSETS.filter((a) => a.status === 'Assigned').length,
    stock: ASSETS.filter((a) => a.status === 'In stock').length,
    repair: ASSETS.filter((a) => a.status === 'In repair').length,
    retired: ASSETS.filter((a) => a.status === 'Retired').length,
    gross: sum(ASSETS, (a) => a.cost!),
    net: sum(live, bookValue),
    dep: sum(live, assetDep),
    outOfWarranty: ASSETS.filter((a) => !inWarranty(a) && a.status === 'Assigned').length,
    eol: ASSETS.filter((a) => assetEol(a) && a.status === 'Assigned').length,
    unassigned: ACTIVE().filter((e) => !ASSETS.some((a) => a.empId === e.id && a.cat === 'LAPTOP')).length,
    recovery: pendingRecovery().length,
  };
}

export { ASSETS };
