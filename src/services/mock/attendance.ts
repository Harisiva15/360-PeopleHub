import { TODAY, ymd } from '../../lib/dates';
import { ATT, ATT_IDX, attOf } from '../../data/attendance';
import type { AttRecord } from '../../data/attendance';
import { EMAP } from '../../data/employees';
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
    lat: null, lng: null, dist: null,
    site: e?.site ?? 'CHN',
    geoOk: true, src: 'Web', late: false, reg: null, notes: '',
  };
  ATT.push(row);
  (ATT_IDX[empId] = ATT_IDX[empId] || {})[date] = row;
  return row;
}

/** Everything a punch stamps onto the day, shared by punch-in and punch-out. */
function applyGeo(r: AttRecord, at: PunchAt): void {
  r.lat = at.lat;
  r.lng = at.lng;
  r.site = at.site;
  r.geoOk = at.geoOk;
  r.dist = at.dist;
  r.src = at.src;
  r.status = at.wfh ? 'W' : 'P';
  if (!at.geoOk) r.notes = 'Outside geo-fence — flagged';
}

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
        (r.status === 'A' || (!r.inT && (r.status === 'P' || r.status === 'W')) || r.geoOk === false),
    );
    return ok(rows);
  },

  punchIn(empId, date, at) {
    const r = ensure(empId, date, 'P');
    applyGeo(r, at);
    r.inT = at.at;
    r.late = false;
    return ok(r);
  },

  punchOut(empId, date, at) {
    const r = ensure(empId, date, 'P');
    applyGeo(r, at);
    r.outT = at.at;
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
