import { addDays, hhmm, isWeekend, parseYmd, TODAY, ymd } from '../lib/dates';
import { distM } from '../lib/format';
import { chance, pick, rnd } from '../lib/rng';
import { ACTIVE } from './employees';
import { HOLIDAY_MAP, siteOf } from './org';

/** How far back attendance history is generated. */
export const ATT_DAYS = 165;

/** P present · W work from home · A absent · L leave · H holiday · O weekly off. */
export type AttStatus = 'P' | 'W' | 'A' | 'L' | 'H' | 'O';

export interface Regularisation {
  status: 'Pending' | 'Approved' | 'Rejected';
  reason: string;
  raised: string;
  inT: string;
  outT: string;
}

export interface AttRecord {
  id: string;
  empId: string;
  date: string;
  status: AttStatus;
  inT: string | null;
  outT: string | null;
  /** Worked minutes, excluding the break. */
  mins: number;
  lat: number | null;
  lng: number | null;
  /** Metres from the site centre; null when there is no fence to measure against. */
  dist: number | null;
  site: string;
  geoOk: boolean;
  src: string;
  late: boolean;
  /** A raised regularisation request, when the day was missed. */
  reg: Regularisation | null;
  notes: string;
}

export const ATT: AttRecord[] = [];
/** empId -> date -> record, for O(1) day lookups. */
export const ATT_IDX: Record<string, Record<string, AttRecord>> = {};

const jitter = (base: number, m: number): number => base + (rnd() - 0.5) * m;

(function genAttendance() {
  ACTIVE().forEach((e) => {
    ATT_IDX[e.id] = {};
    const wfhBias =
      e.site === 'WFH' ? 0.9 : e.dept === 'ENG' || e.dept === 'PROD' ? 0.26 : e.dept === 'SUP' ? 0.12 : 0.18;

    for (let i = ATT_DAYS; i >= 0; i--) {
      const d = addDays(TODAY, -i);
      const ds = ymd(d);
      if (ds < e.doj) continue;

      const rec: AttRecord = {
        id: 'A-' + e.id + '-' + ds,
        empId: e.id,
        date: ds,
        status: 'P',
        inT: null,
        outT: null,
        mins: 0,
        lat: null,
        lng: null,
        dist: null,
        site: e.site,
        geoOk: true,
        src: 'Web',
        late: false,
        reg: null,
        notes: '',
      };

      if (HOLIDAY_MAP[ds]) {
        rec.status = 'H';
        rec.notes = HOLIDAY_MAP[ds];
      } else if (isWeekend(d)) {
        rec.status = 'O';
      } else {
        const r = rnd();
        if (r < 0.045) rec.status = 'L';
        else if (r < 0.058) rec.status = 'A';
        else if (r < 0.058 + wfhBias) rec.status = 'W';
        else rec.status = 'P';
      }

      if (rec.status === 'P' || rec.status === 'W') {
        const base = e.site === 'HYD' ? 600 : 570;
        const inMin = Math.round(jitter(base + (rec.status === 'W' ? 8 : 0), 70));
        const work = Math.round(jitter(535, 90));
        rec.inT = hhmm(inMin);
        rec.outT = hhmm(inMin + work + 45);
        rec.mins = work;
        rec.late = inMin > base + 20;

        /* home sites have no fence, so WFH punches are placed near the base office */
        const homeSite = siteOf(e.site === 'WFH' ? 'CHN' : e.site);

        if (rec.status === 'W') {
          rec.site = 'WFH';
          rec.src = pick(['Mobile', 'Web']);
          rec.geoOk = true;
          rec.lat = +jitter(homeSite.lat!, 0.11).toFixed(5);
          rec.lng = +jitter(homeSite.lng!, 0.11).toFixed(5);
          rec.dist = null;
        } else if (chance(0.03)) {
          rec.site = 'CLIENT';
          rec.src = 'Mobile';
          const s = siteOf(e.site);
          rec.lat = +jitter(s.lat!, 0.16).toFixed(5);
          rec.lng = +jitter(s.lng!, 0.16).toFixed(5);
          rec.dist = distM(s.lat!, s.lng!, rec.lat, rec.lng);
          rec.geoOk = true;
          rec.notes = 'Client visit';
        } else {
          const s = homeSite;
          const off = chance(0.055) ? 0.0075 : 0.0028;
          rec.lat = +jitter(s.lat!, off).toFixed(5);
          rec.lng = +jitter(s.lng!, off).toFixed(5);
          rec.dist = distM(s.lat!, s.lng!, rec.lat, rec.lng);
          rec.geoOk = rec.dist <= s.radius;
          rec.src = pick(['Biometric', 'Mobile', 'Mobile', 'Web']);
          if (!rec.geoOk) rec.notes = 'Outside geo-fence — flagged';
        }

        if (rec.mins < 420 && chance(0.5)) rec.notes = rec.notes || 'Short hours';
      }

      if (rec.status === 'A' && chance(0.45)) {
        rec.reg = {
          status: pick(['Pending', 'Pending', 'Approved', 'Rejected']),
          reason: pick([
            'Forgot to punch in',
            'Biometric device down',
            'On client call from home',
            'Network issue at site',
            'Travel to client location',
          ]),
          raised: ds,
          inT: '09:35',
          outT: '18:40',
        };
      }

      ATT.push(rec);
      ATT_IDX[e.id][ds] = rec;
    }
  });
})();

export const attOf = (id: string, date: string): AttRecord | undefined => ATT_IDX[id]?.[date];

export function attRange(id: string, from: string, to: string): AttRecord[] {
  const out: AttRecord[] = [];
  const m = ATT_IDX[id] || {};
  for (let d = parseYmd(from); ymd(d) <= to; d = addDays(d, 1)) {
    const r = m[ymd(d)];
    if (r) out.push(r);
  }
  return out;
}

/** All of an employee's records inside a `YYYY-MM` month. */
export function monthAtt(id: string, mk: string): AttRecord[] {
  return Object.values(ATT_IDX[id] || {}).filter((r) => r.date.slice(0, 7) === mk);
}
