import { parseYmd, TODAY, ymd } from '../../lib/dates';
import { ATT, ATT_IDX, attOf } from '../../data/attendance';
import type { AttRecord } from '../../data/attendance';
import { clearPayrollCache } from '../../data/payroll';
import { EMAP } from '../../data/employees';
import { siteOf } from '../../data/org';
import { shiftCodeForSite, shiftOf } from '../../data/shifts';
import { distM } from '../../lib/format';
import type { AttendanceService, PunchAt } from '../contracts';
import { classifyDemoDays } from './calendar';
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
    src: 'web', late: false, reg: null, notes: '',
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

  /*
   * Days worth correcting: the rows that need fixing, and the working days
   * with no row at all.
   *
   * The second half used to be missing here as it was on the server, and the
   * screen builds its date list from this — so the commonest correction of
   * all, a day somebody forgot entirely, could not be chosen.
   *
   * Through `classifyDemoDays`, which is the demo's own answer to "was this
   * person expected in", holidays, weekly offs and employment dates included.
   * A weekend test written here would be a second answer to that question and
   * the two would drift, which is the mistake the roster screen already made
   * once with `getUTCDay()`.
   */
  regularisable(empId, since) {
    const rows = Object.values(ATT_IDX[empId] || {}).filter(
      (r) =>
        r.date >= since &&
        (r.status === 'A' || (!r.inT && (r.status === 'P' || r.status === 'W'))
          || r.geoOk === false),
    );

    /* Today is excluded: a working day is not missing attendance until it is
       over, and offering it invites a request that contradicts the punch the
       person is about to make. */
    const today = ymd(TODAY);
    const have = new Set(Object.values(ATT_IDX[empId] || {}).map((r) => r.date));
    const e = EMAP[empId];
    const profile = e ? shiftOf(shiftCodeForSite(e.site)) : undefined;

    const missing: AttRecord[] = classifyDemoDays(empId, since, today)
      .filter((d) => d.workingDay && d.date < today && !have.has(d.date))
      .map((d) => ({
        /* No row, so no id. The screens key on the date, which is one per
           person per day on the server by the table's own constraint. */
        id: '', empId, date: d.date, status: 'A',
        inT: null, outT: null, mins: 0, site: '', lat: null, lng: null,
        dist: null, geoOk: null, src: 'system', late: false, reg: null,
        notes: '', missingPunchOut: false, tz: profile?.tz ?? 'Asia/Kolkata',
      } as AttRecord));

    return ok([...rows, ...missing].sort((a, b) => b.date.localeCompare(a.date)));
  },

  /*
   * Days punched into and never out of.
   *
   * Derived here as it is on the server — a row with a punch in, no punch out,
   * and a work date before today — so there is no flag to go stale and the day
   * leaves the list the moment it is closed or regularised.
   *
   * **The scope is not mirrored, and cannot be.** The server answers "mine,
   * plus my line" from the caller; these contract methods carry no caller, as
   * the note on the shift profiles in `misc.ts` sets out. So an explicit
   * `empId` behaves exactly as the server does, and omitting it returns
   * everybody rather than one reporting line. The screens always pass their
   * own id for the banner; the manager queue is the one place the demo is
   * broader than the product, and the server narrows it.
   *
   * `tz` comes from the profile the employee's location implies, which is the
   * same rule `shiftCodeForSite` states — the demo's attendance fixtures carry
   * no shift reference of their own, and inventing one per row would be
   * inventing the thing the server reads back.
   */
  unclosed(empId) {
    const today = ymd(TODAY);
    const rows = empId
      ? Object.values(ATT_IDX[empId] || {}).map((r) => [empId, r])
      : Object.entries(ATT_IDX).flatMap(
        ([id, byDate]) => Object.values(byDate).map((r) => [id, r] as const));

    const open = (rows as [string, AttRecord][])
      .filter(([, r]) => r.inT && !r.outT && r.date < today)
      .map(([id, r]) => {
        const e = EMAP[id];
        const profile = e ? shiftOf(shiftCodeForSite(e.site)) : undefined;
        return {
          empId: id,
          empCode: e?.code ?? '',
          empName: e?.name ?? '',
          date: r.date,
          inT: r.inT ?? '',
          tz: profile?.tz ?? 'Asia/Kolkata',
          daysOpen: Math.max(0, Math.round(
            (parseYmd(today).getTime() - parseYmd(r.date).getTime()) / 86_400_000)),
        };
      });

    /* Newest first, as the server orders them. */
    return ok(open.sort((a, b) => b.date.localeCompare(a.date)));
  },

  locationNotice() {
    return ok({ ...NOTICE, acknowledgedAt: noticeAck });
  },

  acknowledgeLocationNotice() {
    /* Keeps the original date, the way the server's ON CONFLICT DO NOTHING does. */
    noticeAck = noticeAck ?? new Date().toISOString();
    return ok({ ...NOTICE, acknowledgedAt: noticeAck });
  },

  /*
   * Each of the four writes below ends with `clearPayrollCache()`, and that is
   * not housekeeping — a payslip is derived from attendance.
   *
   * `payslip()` counts a month's unexcused absences and prorates every earnings
   * line by `(daysInMonth - lop) / daysInMonth`. A day that stops being an
   * absence therefore changes that person's gross, their PF, their tax and the
   * run's totals. `payrollTotals()` memoises a whole month in `PT_CACHE`, which
   * is populated once at module load, so without invalidation the register
   * recomputes while the cycle total does not and the two stop reconciling.
   *
   * That is not hypothetical. `checks/services.ts` approves a regularisation on
   * 2026-09-15 and then reconciles the register against the cycle total; from 1
   * October 2026, when September became the last paid run, the two disagreed by
   * 3,122 — one day of one employee's September gross, 90,520 against 93,642.
   * `clearPayrollCache()` had existed since the cache was written, carrying the
   * instruction "call after mutating anything a payslip reads", and nothing in
   * the codebase called it.
   *
   * In the app the same staleness shows as a payroll total that does not move
   * when an approval should have moved it.
   *
   * Always *after* the mutation, never before: a refused regularisation must not
   * throw away a cache it never invalidated.
   */

  punchIn(empId, date, at) {
    const r = ensure(empId, date, 'P');
    applyMode(r, at);
    r.inT = hhmm(at.at);
    r.late = false;
    clearPayrollCache();
    return ok(r);
  },

  punchOut(empId, date, at) {
    const r = ensure(empId, date, 'P');
    applyMode(r, at);
    r.outT = hhmm(at.at);
    if (r.inT) r.mins = Math.max(0, toMins(r.outT) - toMins(r.inT) - BREAK_MINS);
    clearPayrollCache();
    return ok(r);
  },

  raiseRegularisation(empId, date, inT, outT, reason) {
    const r = ensure(empId, date, 'A');
    r.reg = { status: 'Pending', reason, raised: ymd(TODAY), inT, outT };
    /*
     * Raising one does not credit the day, so this cannot change a figure
     * today. It is invalidated anyway because `ensure` will have *created* the
     * record if the person had none for that date, and an invented absence is
     * exactly the kind of change a payslip reads.
     */
    clearPayrollCache();
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
    clearPayrollCache();
    return ok(r);
  },
};
