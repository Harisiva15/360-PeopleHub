import { TODAY, ymd } from '../../lib/dates';
import { ATT, ATT_IDX, attOf } from '../../data/attendance';
import type { AttRecord } from '../../data/attendance';
import { EMAP } from '../../data/employees';
import { siteOf } from '../../data/org';
import { distM } from '../../lib/format';
import type { AttendanceService, PunchAt } from '../contracts';
import { ok } from './util';

/** A regularised day is credited a standard 8h15m of work. */
const REGULARISED_MINS = 495;

/** Unpaid break deducted from the punch-in to punch-out span. */
const BREAK_MINS = 45;

const toMins = (hhmm: string) => {
  const [h, m] = hhmm.split(':');
  return +h * 60 + +m;
};

/** Find the day's record, creating a blank one if the employee never punched. */
function ensure(empId: string, date: string, status: AttRecord['status']): AttRecord {
  const found = attOf(empId, date);
  if (found) return found;
  const e = EMAP[empId];
  const row: AttRecord = {
    id: 'A-' + empId + '-' + date,
    empId, date, status,
    inT: null, outT: null, mins: 0,
    site: e?.site ?? 'CHN',
    lat: null, lng: null, dist: null, geoOk: null,
    src: 'Web', late: false, reg: null, notes: '',
  };
  ATT.push(row);
  (ATT_IDX[empId] = ATT_IDX[empId] || {})[date] = row;
  return row;
}

/** Everything a punch stamps onto the day, shared by punch-in and punch-out. */
function applyMode(r: AttRecord, at: PunchAt): void {
  r.site = at.site;
  r.src = at.src;
  r.status = at.site === 'WFH' ? 'W' : 'P';
  r.lat = at.lat;
  r.lng = at.lng;

  /*
   * The mock measures the fence too, so the demo behaves like the product.
   * A remote mode is never fenced — WFH and CLIENT are not places the company
   * has a perimeter for — which is why geoOk stays null rather than true.
   */
  const site = siteOf(at.site);
  if (site.remote || site.lat == null || !site.radius || at.lat == null || at.lng == null) {
    r.dist = null;
    r.geoOk = null;
  } else {
    r.dist = distM(site.lat, site.lng!, at.lat, at.lng);
    r.geoOk = r.dist <= site.radius;
    if (!r.geoOk) r.notes = 'Outside the geo-fence — flagged for review';
  }
}

/**
 * The clock time an instant reads as, for the mock's display fields.
 *
 * The mock has no shift timezone to resolve against, so it uses the browser's
 * — which is what it was effectively doing before, when the client sent a
 * wall-clock string straight through.
 */
const hhmm = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

/**
 * The location notice, mirroring the server's wording.
 *
 * Duplicated rather than imported because the mock cannot reach the server —
 * and the duplication is the point of the version number: if these drift, the
 * acknowledgement recorded against version 1 no longer describes what anybody
 * was shown.
 */
const NOTICE = {
  version: 1,
  title: 'Checking in records where you are',
  body: [
    'When you check in at an office, the app asks your browser for your position '
    + 'and stores it against that punch, with how far you were from the site.',
    'It is used to confirm attendance at a site and to settle disputes about it. '
    + 'A punch outside the boundary is flagged for review, never refused.',
    'Working from home or at a client site never asks for a position at all.',
    'You can decline. Your punches still work and still count — they are simply '
    + 'recorded without a location.',
    'Positions are cleared after 24 months. The punch itself is kept, because it '
    + 'is a payroll record.',
  ],
} as const;

let noticeAck: string | null = null;

export const attendanceService: AttendanceService = {
  list(q) {
    let out = ATT.slice();
    if (q.empIds) {
      const want = new Set(q.empIds);
      out = out.filter((r) => want.has(r.empId));
    }
    if (q.from) out = out.filter((r) => r.date >= q.from!);
    if (q.to) out = out.filter((r) => r.date <= q.to!);
    if (q.regularisedOnly) out = out.filter((r) => !!r.reg);
    return ok(out);
  },

  forDay(empId, date) {
    return ok(attOf(empId, date) ?? null);
  },

  regularisable(empId, since) {
    const rows = Object.values(ATT_IDX[empId] || {}).filter(
      (r) =>
        r.date >= since &&
        (r.status === 'A' || (!r.inT && (r.status === 'P' || r.status === 'W'))
          || r.geoOk === false),
    );
    return ok(rows);
  },

  locationNotice() {
    return ok({ ...NOTICE, acknowledgedAt: noticeAck });
  },

  acknowledgeLocationNotice() {
    /* Keeps the original date, the way the server's ON CONFLICT DO NOTHING does. */
    noticeAck = noticeAck ?? new Date().toISOString();
    return ok({ ...NOTICE, acknowledgedAt: noticeAck });
  },

  punchIn(empId, date, at) {
    const r = ensure(empId, date, 'P');
    applyMode(r, at);
    r.inT = hhmm(at.at);
    r.late = false;
    return ok(r);
  },

  punchOut(empId, date, at) {
    const r = ensure(empId, date, 'P');
    applyMode(r, at);
    r.outT = hhmm(at.at);
    if (r.inT) r.mins = Math.max(0, toMins(r.outT) - toMins(r.inT) - BREAK_MINS);
    return ok(r);
  },

  raiseRegularisation(empId, date, inT, outT, reason) {
    const r = ensure(empId, date, 'A');
    r.reg = { status: 'Pending', reason, raised: ymd(TODAY), inT, outT };
    return ok(r);
  },

  actOnRegularisation(empId, date, decision) {
    const r = attOf(empId, date);
    if (!r || !r.reg) return Promise.reject(new Error('No regularisation on ' + date));
    if (r.reg.status !== 'Pending') return Promise.reject(new Error('Already ' + r.reg.status.toLowerCase()));
    r.reg.status = decision;
    if (decision === 'Approved') {
      r.status = 'P';
      r.inT = r.reg.inT;
      r.outT = r.reg.outT;
      r.mins = REGULARISED_MINS;
    }
    return ok(r);
  },
};
