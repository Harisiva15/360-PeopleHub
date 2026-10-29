/**
 * Attendance — punches and regularisation.
 *
 * A punch records when someone started, when they stopped, how long that was
 * net of their break, whether they were late, the work mode they chose, and —
 * since 0018 — where they were.
 *
 * **Two things this service refuses to take from the client.**
 *
 * *Whether the punch was inside the fence.* The coordinates are accepted; every
 * verdict drawn from them is recomputed here. A browser can post
 * `geoOk: true` from anywhere, and this decides whether a day is paid, so the
 * client's own answer is discarded rather than trusted. Distance is Haversine
 * in SQL against the site's centre.
 *
 * *Whether the punch was late.* That depends on the employee's shift and the
 * timezone it is measured in — someone in Chennai on the US shift is judged
 * against New York. Only the server knows their shift.
 *
 * `geo_ok` is nullable on purpose: NULL is "nothing to measure against" — no
 * fence on the site, or no fix from the device — and FALSE is a real exception
 * somebody has to explain. Collapsing them would make every work-from-home
 * punch look like a violation.
 */

import { reaches } from '../../auth/can.ts';
import { classifyMany } from '../calendar/service.ts';
import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class AttendanceError extends Error {
  readonly code: string;

  /**
   * What the screen needs in order to do something about it, structured.
   *
   * `outside_window` is the refusal this exists for. Its message already names
   * the day to raise a correction for, which is enough for a person to read
   * and not enough for a form to fill in — a screen that wanted to open the
   * correction dialog on the right date had to parse the sentence, and a
   * sentence is not an interface. So the date travels beside the message
   * rather than inside it, and the message keeps saying it because the
   * refusal still has to make sense on its own.
   *
   * Reaches the client as `detail` on the error body. Never anything a caller
   * is not already entitled to: this is data the refusal is *about*.
   */
  readonly detail: Record<string, unknown> | undefined;

  constructor(message: string, code: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'AttendanceError';
    this.code = code;
    this.detail = detail;
  }
}

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
  status: string;
  inT: string | null;
  outT: string | null;
  mins: number;
  /** Work mode: a site code, or WFH / CLIENT. */
  site: string;
  lat: number | null;
  lng: number | null;
  /** Metres from the site centre; null when there was no fence to measure against. */
  dist: number | null;
  /** Null means nothing to measure against; false is a real exception. */
  geoOk: boolean | null;
  src: string;
  late: boolean;
  reg: Regularisation | null;
  notes: string;
  /**
   * Punched in, never out, and the shift window has closed. The hours on this
   * day are unknown rather than zero — see `MISSING_PUNCH_OUT`.
   */
  missingPunchOut: boolean;
  /** The zone the times above are rendered in, so a screen can label them. */
  tz: string;
}

const REG_STATUS: Record<string, Regularisation['status']> = {
  pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
};

/**
 * How far either side of a shift a punch still counts.
 *
 * Named here because two places need the same answer and they must not drift:
 * `SHIFT_DATE` decides which instance a punch belongs to, and `WINDOW_CLOSE`
 * below decides when an instance has stopped accepting one — so if these
 * differed, there would be an interval in which a punch out was refused as
 * late and the row was not yet considered unclosed.
 */
const OPENS_BEFORE = "interval '2 hours'";
const CLOSES_AFTER = "interval '4 hours'";

/**
 * When a row's own shift instance stops accepting punches.
 *
 * `COALESCE` covers the flexible shift, which has no hours at all: there is no
 * window to measure, so the day itself is the window and it closes at the end
 * of it. Without that, a flexible shift's `ends_at` is null, the comparison is
 * null, and a forgotten punch out would never be reported as one.
 */
const WINDOW_CLOSE = `
  (((a.work_date
      + CASE WHEN COALESCE(sh.ends_at, TIME '23:59') <= COALESCE(sh.starts_at, TIME '00:00')
             THEN interval '1 day' ELSE interval '0 day' END
      + COALESCE(sh.ends_at, TIME '23:59'))::timestamp AT TIME ZONE sh.timezone)
    + ${CLOSES_AFTER})`;

/**
 * A day somebody punched into and never out of, whose window has since
 * closed.
 *
 * Derived, not stored. There is no `missing_punch_out` column and there should
 * not be one: the condition is entirely a function of the row and its shift,
 * so a column would be a second copy of it that could disagree — and would,
 * the first time a shift's hours were edited. Nothing has to run on a
 * schedule to keep this true either.
 *
 * It matters because the alternative readings are both wrong. The row says
 * status `P` with `worked_minutes` 0, so payroll reads a present day that
 * earned nothing; mark it absent instead and it is a false `A` against
 * somebody who came to work. It is neither — it is a day whose hours are
 * unknown, and this is what says so.
 */
const MISSING_PUNCH_OUT = `
  (a.punch_in IS NOT NULL AND a.punch_out IS NULL AND now() > ${WINDOW_CLOSE})`;

/**
 * Punch times are rendered in the shift's timezone, not the server's or the
 * reader's. A 09:30 start means 09:30 where the shift is measured.
 *
 * ## The row's shift, not the employee's
 *
 * The join is on `COALESCE(a.shift_id, e.shift_id)`. It was `e.shift_id`, the
 * employee's *current* shift, which meant moving somebody from the IST shift
 * to the US shift silently re-rendered every punch they had ever made in New
 * York time — a 09:30 IST start would read as 23:00 the previous day, and the
 * history would change under them with no edit to it.
 *
 * `attendance.shift_id` is written at punch time precisely so the row can say
 * which shift it was measured against. The `COALESCE` is for rows imported or
 * created before it was set.
 */
const PROJECTION = `
  SELECT a.id, a.employee_id, a.work_date, a.status,
         to_char(a.punch_in  AT TIME ZONE sh.timezone, 'HH24:MI') AS in_t,
         to_char(a.punch_out AT TIME ZONE sh.timezone, 'HH24:MI') AS out_t,
         a.worked_minutes, s.code AS site_code, a.source, a.late, a.notes,
         a.latitude, a.longitude, a.distance_m, a.geo_ok,
         sh.timezone AS shift_tz,
         ${MISSING_PUNCH_OUT} AS missing_punch_out,
         r.status AS reg_status, r.reason AS reg_reason, r.raised_on AS reg_raised,
         to_char(r.requested_in  AT TIME ZONE sh.timezone, 'HH24:MI') AS reg_in,
         to_char(r.requested_out AT TIME ZONE sh.timezone, 'HH24:MI') AS reg_out
    FROM attendance a
    JOIN employee e ON e.id = a.employee_id
    JOIN shift sh ON sh.id = COALESCE(a.shift_id, e.shift_id)
    LEFT JOIN site s ON s.id = a.site_id
    LEFT JOIN regularisation r ON r.attendance_id = a.id`;

const toRecord = (r: Record<string, unknown>): AttRecord => ({
  id: r.id as string,
  empId: r.employee_id as string,
  date: r.work_date as string,
  status: r.status as string,
  inT: (r.in_t as string | null) ?? null,
  outT: (r.out_t as string | null) ?? null,
  mins: Number(r.worked_minutes ?? 0),
  site: (r.site_code as string) ?? '',
  lat: r.latitude === null ? null : Number(r.latitude),
  lng: r.longitude === null ? null : Number(r.longitude),
  dist: r.distance_m === null ? null : Number(r.distance_m),
  geoOk: r.geo_ok === null ? null : Boolean(r.geo_ok),
  src: (r.source as string) ?? 'web',
  late: Boolean(r.late),
  reg: r.reg_status
    ? {
        status: REG_STATUS[r.reg_status as string] ?? 'Pending',
        reason: (r.reg_reason as string) ?? '',
        raised: r.reg_raised as string,
        inT: (r.reg_in as string) ?? '',
        outT: (r.reg_out as string) ?? '',
      }
    : null,
  notes: (r.notes as string) ?? '',
  missingPunchOut: Boolean(r.missing_punch_out),
  tz: (r.shift_tz as string) ?? '',
});

/** Who the caller may see attendance for. */
async function maySee(db: TenantClient, caller: Caller, empId: string): Promise<boolean> {
  if (reaches(caller, 'attendance', 'read', 'all')) return true;
  if (empId === caller.employeeId) return true;
  if (!caller.hasReports) return false;
  const r = await db.query(
    `WITH RECURSIVE t AS (
       SELECT id FROM employee WHERE manager_id = $1
       UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
     ) SELECT 1 FROM t WHERE id = $2`, [caller.employeeId, empId]);
  return (r.rowCount ?? 0) > 0;
}

export interface PunchAt {
  /**
   * Work mode: an office site code, or WFH / CLIENT. A mode the caller states
   * rather than a place the server measures — unrecognised codes fall back to
   * the employee's own site rather than being refused, because a punch is
   * worth more than the label on it.
   */
  site?: string;
  /**
   * Where the device says it is. Everything derived from this — the distance
   * and the fence verdict — is recomputed here; a `geoOk` in the request body
   * is ignored.
   */
  lat?: number | null;
  lng?: number | null;
  src?: string;
  /** ISO instant. Defaults to now; a client clock is not authoritative. */
  at?: string;
}

/** WFH records a W day rather than P; every other mode is a present day. */
const WFH = 'WFH';

/**
 * The resolved work mode, the distance from its fence, the lateness verdict,
 * and the break to deduct — all from the employee's own configuration.
 *
 * Haversine inline rather than via the earthdistance extension: one formula is
 * cheaper than a dependency, and at these distances it is far more accurate
 * than the phone that produced the fix.
 */
/**
 * The window to measure an employee's day against, with a default for every
 * way of not having one.
 *
 * ## Why a default exists at all
 *
 * `employee.shift_id` is `NOT NULL` — 0015 backfilled it and then made it so,
 * with the reasoning that "a person with no shift has no hours to be measured
 * against, and the honest options are to reject their punch or silently pick a
 * default. Neither is good, so the column stops being optional." That is still
 * true and this does not weaken it: the column stays `NOT NULL`.
 *
 * What is *not* guaranteed is a usable window. `shift.starts_at` and
 * `shift.ends_at` are both nullable — a flexible shift has no fixed hours —
 * and a null in either makes every interval below null, so no window contains
 * the punch and the person is refused. A refusal for a reason the employee
 * cannot see or fix is a nightly correction for their manager, which is the
 * cost this whole feature exists to remove. So there is always a window.
 *
 * ## Each level is a whole window, not a column
 *
 * Tempting to `COALESCE` per column. Wrong: it would take the start from one
 * shift and the zone from another, and produce a window nobody defined —
 * 09:00 New York against an India shift's zone, say. So each candidate must
 * carry a complete window or it does not qualify, and the first that does
 * wins outright.
 *
 * 1. the employee's own shift
 * 2. their site's `default_shift_id`
 * 3. any active shift whose `region` is the site's country, lowest code first
 *    so the answer is the same on every call
 * 4. 09:00–18:00 in the site's own zone (`site.timezone` is `NOT NULL`)
 * 5. 09:00–18:00 IST, for an employee with no site — `site_id` is nullable
 *
 * Levels 2–5 are defensive today: every employee has a shift with a window.
 * They are tested anyway, because "cannot happen" is how the first one got
 * written.
 */
const EFFECTIVE_SHIFT = `
  eff AS (
    SELECT timezone, starts_at, ends_at, grace_minutes, break_minutes, site_id
      FROM (
        SELECT 1 AS pri, sh.timezone, sh.starts_at, sh.ends_at,
               sh.grace_minutes, sh.break_minutes, e.site_id
          FROM employee e JOIN shift sh ON sh.id = e.shift_id
         WHERE e.id = $1 AND sh.starts_at IS NOT NULL AND sh.ends_at IS NOT NULL
        UNION ALL
        SELECT 2, dsh.timezone, dsh.starts_at, dsh.ends_at,
               dsh.grace_minutes, dsh.break_minutes, e.site_id
          FROM employee e
          JOIN site s ON s.id = e.site_id
          JOIN shift dsh ON dsh.id = s.default_shift_id
         WHERE e.id = $1 AND dsh.starts_at IS NOT NULL AND dsh.ends_at IS NOT NULL
        UNION ALL
        SELECT 3, rsh.timezone, rsh.starts_at, rsh.ends_at,
               rsh.grace_minutes, rsh.break_minutes, e.site_id
          FROM employee e
          JOIN site s ON s.id = e.site_id
          JOIN LATERAL (
            SELECT x.timezone, x.starts_at, x.ends_at, x.grace_minutes, x.break_minutes
              FROM shift x
             WHERE x.region = s.country AND x.active
               AND x.starts_at IS NOT NULL AND x.ends_at IS NOT NULL
             ORDER BY x.code
             LIMIT 1
          ) rsh ON true
         WHERE e.id = $1
        UNION ALL
        SELECT 4, s.timezone, TIME '09:00', TIME '18:00', 10, 60, e.site_id
          FROM employee e JOIN site s ON s.id = e.site_id
         WHERE e.id = $1
        UNION ALL
        SELECT 5, 'Asia/Kolkata', TIME '09:00', TIME '18:00', 10, 60, e.site_id
          FROM employee e
         WHERE e.id = $1
      ) candidates
     ORDER BY pri
     LIMIT 1
  )`;

/*
 * `me` was `employee JOIN shift ON shift.id = employee.shift_id`, which gave
 * this query a null `starts_at` for a flexible shift and so a null `is_late`.
 * It reads the resolved window instead, which always has one.
 */
const DERIVE = `
  WITH ${EFFECTIVE_SHIFT},
  resolved AS (
    SELECT eff.*, COALESCE(
             (SELECT s.id FROM site s WHERE s.code = $3::text AND s.active),
             eff.site_id) AS punch_site_id
      FROM eff
  )
  SELECT resolved.punch_site_id AS site_id,
         resolved.timezone,
         (($2::timestamptz AT TIME ZONE resolved.timezone)::time
            > (resolved.starts_at + (resolved.grace_minutes || ' minutes')::interval)) AS is_late,
         resolved.break_minutes,
         s.fence_radius_m,
         CASE WHEN s.latitude IS NULL OR $4::numeric IS NULL THEN NULL
              ELSE round(6371000 * acos(least(1, greatest(-1,
                     cos(radians($4::numeric)) * cos(radians(s.latitude))
                     * cos(radians(s.longitude) - radians($5::numeric))
                   + sin(radians($4::numeric)) * sin(radians(s.latitude))))))
         END AS distance_m
    FROM resolved LEFT JOIN site s ON s.id = resolved.punch_site_id`;

/**
 * How a punch was made, as the one set the column will accept.
 *
 * Migration 0004 closed this set in the schema:
 *
 *     source text NOT NULL DEFAULT 'web'
 *       CHECK (source IN ('web','mobile','biometric','kiosk','import','system'))
 *
 * and the punch handler passed `at.src` straight into it. The web client sends
 * `'Web'`. Postgres refused every insert with 23514, the route answered 500,
 * and the screen said nothing at all — so production reached this point with
 * zero attendance rows ever written, which read as "check-in records no time
 * and no location" because there was no row to carry either.
 *
 * Normalised rather than rejected: the case of a client's label is not a thing
 * worth failing a morning over, and 'Biometric' means 'biometric'. An
 * unrecognised value does become 'web' — the column's own default — because the
 * alternative is refusing a punch over a field nobody reads for anything but a
 * display label.
 *
 * Validated here rather than left to the constraint, so the one place that
 * knows the permitted set is the one place that writes the column. The
 * constraint stays as the backstop it is meant to be.
 */
const ATTENDANCE_SOURCES = [
  'web', 'mobile', 'biometric', 'kiosk', 'import', 'system',
] as const;

function sourceOf(src: string | undefined | null): string {
  const s = (src ?? '').trim().toLowerCase();
  return (ATTENDANCE_SOURCES as readonly string[]).includes(s) ? s : 'web';
}

/**
 * The moment a punch happened, as something `timestamptz` will accept.
 *
 * The client used to send a bare 'HH:MM' here, which Postgres rejected outright
 * — so every live punch came back a 500 with a datetime parse error behind it,
 * and the one thing everybody does every morning did not work at all. A
 * wall-clock time cannot be resolved into an instant anyway once shifts carry
 * timezones: 09:20 is on time in Chennai and four hours early against New York
 * hours, and the string alone does not say which.
 *
 * Rejected here rather than in the database, so a bad value is a 400 naming
 * the field instead of a 500 naming a column.
 */
function instantOf(at: string | undefined): string {
  if (!at) return new Date().toISOString();
  const t = Date.parse(at);
  if (Number.isNaN(t)) {
    throw new AttendanceError(
      `punch time must be an ISO-8601 instant, not ${JSON.stringify(at)}`, 'invalid');
  }
  return new Date(t).toISOString();
}

/**
 * The current version of the location notice.
 *
 * Bumped when the wording below changes materially. An acknowledgement of
 * version 1 does not cover version 2 — which is the whole reason the row
 * records a version rather than just a date.
 */
export const LOCATION_NOTICE_VERSION = 1;

/**
 * What somebody is told before their position is ever recorded.
 *
 * Kept on the server so the wording that was acknowledged and the wording that
 * is shown cannot drift apart — a notice held only in the screen could be
 * edited without anybody's acknowledgement ceasing to be claimed as valid.
 */
export const LOCATION_NOTICE = {
  version: LOCATION_NOTICE_VERSION,
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

export interface LocationNotice {
  version: number;
  title: string;
  body: readonly string[];
  /** When this person acknowledged this version, or null if they have not. */
  acknowledgedAt: string | null;
}

/** Has this person been shown the current notice, and when. */
export async function locationNotice(caller: Caller): Promise<LocationNotice> {
  if (!caller.employeeId) {
    throw new AttendanceError('this login has no employee record', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT acknowledged_at FROM location_notice
        WHERE employee_id = $1 AND notice_version = $2`,
      [caller.employeeId, LOCATION_NOTICE_VERSION]);
    return {
      ...LOCATION_NOTICE,
      acknowledgedAt: (rows[0]?.acknowledged_at as string | undefined) ?? null,
    };
  });
}

/**
 * Record that this person was shown it.
 *
 * Idempotent, and it does not overwrite: re-acknowledging keeps the original
 * date, because when somebody was first told is the fact that matters. The
 * caller is the session — acknowledging on behalf of somebody else is exactly
 * the thing this record exists to make impossible.
 */
export async function acknowledgeLocationNotice(caller: Caller): Promise<LocationNotice> {
  if (!caller.employeeId) {
    throw new AttendanceError('this login has no employee record', 'forbidden');
  }
  return withTenant(caller, async (db) => {
    await db.query(
      `INSERT INTO location_notice (employee_id, notice_version)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id, employee_id, notice_version) DO NOTHING`,
      [caller.employeeId, LOCATION_NOTICE_VERSION]);
    const { rows } = await db.query(
      `SELECT acknowledged_at FROM location_notice
        WHERE employee_id = $1 AND notice_version = $2`,
      [caller.employeeId, LOCATION_NOTICE_VERSION]);
    return {
      ...LOCATION_NOTICE,
      acknowledgedAt: (rows[0]?.acknowledged_at as string | undefined) ?? null,
    };
  });
}

/** Whether this person has been told, inside a transaction already open. */
async function hasSeenNotice(db: TenantClient, empId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM location_notice
      WHERE employee_id = $1 AND notice_version = $2`,
    [empId, LOCATION_NOTICE_VERSION]);
  return Boolean(rowCount);
}

async function reload(db: TenantClient, empId: string, date: string): Promise<AttRecord> {
  const { rows } = await db.query(
    `${PROJECTION} WHERE a.employee_id = $1 AND a.work_date = $2`, [empId, date]);
  if (!rows[0]) throw new AttendanceError('no attendance for that day', 'not_found');
  return toRecord(rows[0]);
}

/**
 * Punch in.
 *
 * Takes no date. The day a punch belongs to is `shiftInstanceAt`'s answer,
 * derived from the instant in the shift's own zone — see "which day a punch
 * belongs to" below for why the client's calendar day was wrong twice a day
 * for anyone working a shift measured in another zone.
 */
export async function punchIn(
  caller: Caller,
  empId: string,
  at: PunchAt,
): Promise<AttRecord> {
  if (empId !== caller.employeeId && !reaches(caller, 'attendance', 'read', 'all')) {
    throw new AttendanceError('you can only punch for yourself', 'forbidden');
  }

  const when = instantOf(at.at);

  return withTenant(caller, async (db) => {
    const date = await workDateFor(db, empId, when);
    /*
     * No notice, no position. The punch itself goes through either way — an
     * employee who has not read a dialog still worked the day, and refusing it
     * would be a payroll fault dressed as a privacy control. What is withheld
     * is the collection, and it is withheld here rather than in the screen, so
     * a client that sends coordinates anyway achieves nothing.
     */
    const told = await hasSeenNotice(db, empId);
    const lat = told ? at.lat ?? null : null;
    const lng = told ? at.lng ?? null : null;

    const { rows } = await db.query(DERIVE,
      [empId, when, at.site ?? null, lat, lng]);
    const d = rows[0];
    if (!d) throw new AttendanceError('no such employee', 'not_found');

    const existing = await db.query(
      'SELECT id, punch_in FROM attendance WHERE employee_id = $1 AND work_date = $2 FOR UPDATE',
      [empId, date]);
    if (existing.rows[0]?.punch_in) {
      throw new AttendanceError('you have already checked in today', 'already_in');
    }

    /*
     * Null when there is nothing to measure against — a site with no fence, or
     * a punch with no fix. A remote work mode is never fenced: WFH and CLIENT
     * are places the company does not have a perimeter for.
     */
    const remote = at.site === WFH || at.site === 'CLIENT';
    const geoOk = remote || d.distance_m === null || d.fence_radius_m === null
      ? null
      : Number(d.distance_m) <= Number(d.fence_radius_m);

    await db.query(
      `INSERT INTO attendance
         (employee_id, work_date, status, punch_in, site_id, shift_id, source, late,
          latitude, longitude, distance_m, geo_ok)
       SELECT $1, $2, $3, $4::timestamptz, $5, e.shift_id, $6, $7, $8, $9, $10, $11
         FROM employee e WHERE e.id = $1
       ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE
         SET punch_in = EXCLUDED.punch_in, status = EXCLUDED.status,
             source = EXCLUDED.source, late = EXCLUDED.late,
             latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
             distance_m = EXCLUDED.distance_m, geo_ok = EXCLUDED.geo_ok,
             updated_at = now()`,
      [empId, date, at.site === WFH ? 'W' : 'P', when, d.site_id, sourceOf(at.src), d.is_late,
        lat, lng, remote ? null : d.distance_m, geoOk]);

    return reload(db, empId, date);
  });
}

/**
 * Punch out.
 *
 * Takes no date, for the same reason as `punchIn` — and this is the direction
 * that was actually broken: a punch out at 03:30 IST on a US shift arrived
 * with the browser's "tomorrow", found no `punch_in` under that date, and
 * refused with "you have not checked in today". The shift could not be closed
 * at all.
 */
export async function punchOut(
  caller: Caller,
  empId: string,
  at: PunchAt,
): Promise<AttRecord> {
  if (empId !== caller.employeeId && !reaches(caller, 'attendance', 'read', 'all')) {
    throw new AttendanceError('you can only punch for yourself', 'forbidden');
  }

  const when = instantOf(at.at);

  return withTenant(caller, async (db) => {
    /*
     * The open day first, because closing one is a different question from
     * opening one: this punch belongs to the day it was opened against, not to
     * whatever the employee's shift says now. See `OPEN_DAY`.
     */
    const open = await openDayFor(db, empId, when);
    const date = open ? open.workDate : await workDateFor(db, empId, when);
    /*
     * No notice, no position. The punch itself goes through either way — an
     * employee who has not read a dialog still worked the day, and refusing it
     * would be a payroll fault dressed as a privacy control. What is withheld
     * is the collection, and it is withheld here rather than in the screen, so
     * a client that sends coordinates anyway achieves nothing.
     */
    const told = await hasSeenNotice(db, empId);
    const lat = told ? at.lat ?? null : null;
    const lng = told ? at.lng ?? null : null;

    const { rows } = await db.query(DERIVE,
      [empId, when, at.site ?? null, lat, lng]);
    const d = rows[0];
    if (!d) throw new AttendanceError('no such employee', 'not_found');

    const existing = await db.query(
      'SELECT id, punch_in FROM attendance WHERE employee_id = $1 AND work_date = $2 FOR UPDATE',
      [empId, date]);
    if (!existing.rows[0]?.punch_in) {
      throw new AttendanceError('you have not checked in today', 'no_punch_in');
    }

    /*
     * Worked minutes exclude the shift's break. Computed in SQL from the two
     * stored instants rather than from a client-supplied duration, so a slow
     * phone clock cannot lengthen anyone's day.
     *
     * The break comes from the day's *own* shift where one was resolved, and
     * only otherwise from `DERIVE`, which reads the employee's current one.
     * They are the same number on every ordinary day and differ exactly when
     * somebody was moved mid-shift — and deducting the new roster's hour from
     * a day worked on the old one's is the kind of error nobody finds, because
     * the total still looks plausible.
     */
    await db.query(
      `UPDATE attendance
          SET punch_out = $3::timestamptz,
              worked_minutes = GREATEST(0,
                EXTRACT(EPOCH FROM ($3::timestamptz - punch_in))::int / 60 - $4::int),
              updated_at = now()
        WHERE employee_id = $1 AND work_date = $2`,
      [empId, date, when, open?.breakMinutes ?? d.break_minutes ?? 0]);

    return reload(db, empId, date);
  });
}

export async function attendanceForDay(
  caller: Caller,
  empId: string,
  date: string,
): Promise<AttRecord | null> {
  return withTenantReadOnly(caller, async (db) => {
    if (!(await maySee(db, caller, empId))) return null;
    const { rows } = await db.query(
      `${PROJECTION} WHERE a.employee_id = $1 AND a.work_date = $2`, [empId, date]);
    return rows[0] ? toRecord(rows[0]) : null;
  });
}

/** A day somebody punched into and never out of. */
export interface UnclosedDay {
  empId: string;
  empCode: string;
  empName: string;
  date: string;
  /** The punch in, in the row's own shift zone. */
  inT: string;
  tz: string;
  /** Whole days since the window closed, so the stalest sorts first. */
  daysOpen: number;
}

const UNCLOSED = `
  SELECT a.employee_id, e.code AS emp_code, e.full_name AS emp_name,
         to_char(a.work_date, 'YYYY-MM-DD') AS work_date,
         to_char(a.punch_in AT TIME ZONE sh.timezone, 'HH24:MI') AS in_t,
         sh.timezone AS tz,
         GREATEST(0, (EXTRACT(EPOCH FROM (now() - ${WINDOW_CLOSE})) / 86400)::int)
           AS days_open
    FROM attendance a
    JOIN employee e ON e.id = a.employee_id
    JOIN shift sh ON sh.id = COALESCE(a.shift_id, e.shift_id)`;

/**
 * Every day still open: the employee's own banner, and the manager's queue.
 *
 * One function for both, because the two differ only in what the caller is
 * allowed to see and that is already decided by the grant — the same scoping
 * `listAttendance` uses, in the same order, so that `empId` narrows what the
 * caller can see and can never widen it.
 *
 * Shaped as a read so nothing has to run on a schedule: there is no job that
 * sweeps for forgotten punches and no state for it to get wrong. A day stops
 * appearing here the moment somebody closes it or a correction is approved.
 */
export async function unclosedDays(
  caller: Caller,
  opts: { empId?: string } = {},
): Promise<UnclosedDay[]> {
  const where: string[] = [MISSING_PUNCH_OUT];
  const params: unknown[] = [];

  if (!reaches(caller, 'attendance', 'read', 'team')) {
    params.push(caller.employeeId);
    where.push(`a.employee_id = $${params.length}`);
  } else if (caller.hasReports) {
    params.push(caller.employeeId);
    where.push(`(a.employee_id = $${params.length} OR a.employee_id IN (
       WITH RECURSIVE t AS (
         SELECT id FROM employee WHERE manager_id = $${params.length}
         UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
       ) SELECT id FROM t))`);
  }
  if (opts.empId) {
    params.push(opts.empId);
    where.push(`a.employee_id = $${params.length}`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${UNCLOSED} WHERE ${where.join(' AND ')} ORDER BY a.work_date DESC`, params);
    return rows.map((r) => ({
      empId: r.employee_id as string,
      empCode: (r.emp_code as string) ?? '',
      empName: (r.emp_name as string) ?? '',
      date: r.work_date as string,
      inT: (r.in_t as string) ?? '',
      tz: (r.tz as string) ?? '',
      daysOpen: Number(r.days_open ?? 0),
    }));
  });
}

export interface AttendanceQuery {
  empIds?: string[];
  from?: string;
  to?: string;
  regularisedOnly?: boolean;
}

export async function listAttendance(
  caller: Caller,
  q: AttendanceQuery = {},
): Promise<AttRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  // Scope first and unconditionally: empIds narrows what the caller can
  // already see, it never widens it.
  if (!reaches(caller, 'attendance', 'read', 'team')) {
    params.push(caller.employeeId);
    where.push(`a.employee_id = $${params.length}`);
  } else if (caller.hasReports) {
    params.push(caller.employeeId);
    where.push(`(a.employee_id = $${params.length} OR a.employee_id IN (
       WITH RECURSIVE t AS (
         SELECT id FROM employee WHERE manager_id = $${params.length}
         UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
       ) SELECT id FROM t))`);
  }
  if (q.empIds?.length) {
    params.push(q.empIds);
    where.push(`a.employee_id = ANY($${params.length}::uuid[])`);
  }
  if (q.from) { params.push(q.from); where.push(`a.work_date >= $${params.length}`); }
  if (q.to) { params.push(q.to); where.push(`a.work_date <= $${params.length}`); }
  if (q.regularisedOnly) where.push('r.id IS NOT NULL');

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.work_date DESC`, params);
    return rows.map(toRecord);
  });
}

/**
 * Days worth regularising: absent, missing a punch, or outside the fence.
 *
 * The fence exception is back with 0018. It is the one trigger that flags a
 * day for where someone was rather than what they did, which is exactly why it
 * needs a correction path rather than a silent mark against them.
 */
export async function regularisableDays(
  caller: Caller,
  empId: string,
  since: string,
): Promise<AttRecord[]> {
  return withTenantReadOnly(caller, async (db) => {
    if (!(await maySee(db, caller, empId))) return [];
    const { rows } = await db.query(
      `${PROJECTION}
        WHERE a.employee_id = $1 AND a.work_date >= $2
          AND (a.status = 'A' OR a.punch_in IS NULL OR a.punch_out IS NULL
               OR a.geo_ok = false)
          AND (r.id IS NULL OR r.status = 'rejected')
        ORDER BY a.work_date DESC`, [empId, since]);
    const withRows = rows.map(toRecord);

    /*
     * And the days with no row at all, which is the commonest case and was
     * the one missing.
     *
     * This read `FROM attendance`, so "days worth regularising" meant "rows
     * worth regularising" — a day somebody forgot entirely, or whose punch was
     * refused outside the shift window, leaves no row and so was not offered.
     * The screen's date list is built from this, so those days could not be
     * chosen, and the service refused them if they were. Between them that
     * made the most ordinary correction in the product unreachable.
     *
     * `classifyMany` decides which of them count: it is the one thing that
     * knows the person's working pattern, the tenant's holidays and their
     * employment dates, and re-deriving any of that here would be a second
     * answer to the same question. A weekly off and a holiday are not days
     * with attendance missing; `NOT_EMPLOYED` is not either.
     *
     * Today is excluded. A working day is not missing attendance until it is
     * over — offering to correct the day somebody is still in the middle of
     * invites a request that contradicts the punch they are about to make.
     */
    const today = (await db.query<{ d: string }>(
      'SELECT current_date::text AS d')).rows[0]!.d;
    const verdicts = (await classifyMany(db, [empId], since, today))[empId] ?? [];

    /*
     * Every date that has a row at all, asked for separately.
     *
     * Not `withRows.map(r => r.date)`, which is what this was: that is the
     * list *after* the filter above has dropped the days needing nothing. So a
     * day whose correction had been approved fell out of it, the synthetic
     * half below saw no row for that date, and offered it again — a day
     * already corrected, back in the list, for ever. The suite's assertion 6
     * is that case, and it caught this.
     */
    const { rows: existing } = await db.query<{ d: string }>(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS d FROM attendance
        WHERE employee_id = $1 AND work_date >= $2`, [empId, since]);
    const have = new Set(existing.map((r) => r.d));
    const tz = withRows[0]?.tz ?? '';

    const missing: AttRecord[] = verdicts
      .filter((v) => v.workingDay && v.date < today && !have.has(v.date))
      .map((v) => ({
        /* No row, so no id. The screens key on the date, which is unique per
           person per day by the table's own constraint. */
        id: '', empId, date: v.date, status: 'A',
        inT: null, outT: null, mins: 0, site: '', lat: null, lng: null,
        dist: null, geoOk: null, src: 'system', late: false, reg: null,
        notes: '', missingPunchOut: false, tz,
      }));

    return [...withRows, ...missing].sort((a, b) => b.date.localeCompare(a.date));
  });
}

export async function raiseRegularisation(
  caller: Caller,
  empId: string,
  date: string,
  inT: string,
  outT: string,
  reason: string,
): Promise<AttRecord> {
  if (empId !== caller.employeeId && !reaches(caller, 'attendance', 'read', 'all')) {
    throw new AttendanceError('you can only regularise your own attendance', 'forbidden');
  }
  // `reason` is whatever the body carried, which may be nothing at all — a
  // request without it used to reach .trim() on undefined and crash the
  // handler, so a missing field answered 500 instead of saying what was
  // missing.
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new AttendanceError('say why the day needs correcting', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const att = await db.query<{ id: string; manager_id: string | null }>(
      `SELECT a.id, e.manager_id FROM attendance a
         JOIN employee e ON e.id = a.employee_id
        WHERE a.employee_id = $1 AND a.work_date = $2`, [empId, date]);

    /*
     * A day with no attendance row at all is the commonest correction there
     * is, and it was the one case this refused.
     *
     * "no attendance record for that day" is true and useless: the whole point
     * of the request is that nothing was recorded. Somebody who was away from
     * their desk, or whose punch was refused outside the window, or who simply
     * forgot the day entirely has nothing to correct and no way to say so. The
     * demo has always created the row — `ensure(empId, date, 'A')` — so the
     * screen let you raise one and the server refused it, which is how this
     * survived: the divergence hid it.
     *
     * The row is created as it would have looked if the day had been noticed
     * and nothing recorded: `A`, no punches, no minutes, `source = 'system'`
     * because no device produced it. Approving the request is what turns it
     * into a present day, exactly as it does for a row that already existed.
     *
     * **The shift is the employee's current one, and it has to be.** Every
     * other row carries the shift it was *measured* against, stamped at punch
     * time. A day with no row was measured against nothing, so there is no
     * historical answer to preserve and the present assignment is the only one
     * available. That is also the right answer in the case this was found in:
     * somebody moved onto US hours raising corrections for the days they had
     * already been working them.
     */
    const row = att.rows[0] ?? await createDayFor(db, empId, date);

    /*
     * Times arrive as HH:MM in the *day's* timezone and are stored as
     * instants.
     *
     * `COALESCE(a.shift_id, e.shift_id)`, the same rule `PROJECTION` uses, and
     * not `e.shift_id` as this read before. The two differ exactly when
     * somebody has been moved since the day in question — and then the old
     * reading took the hours a person typed while looking at a day rendered in
     * its own zone and stored them in the zone of a shift they are on now. For
     * a move from India to New York that is a 10½ hour error, silently, on the
     * correction meant to fix the day.
     */
    await db.query(
      `INSERT INTO regularisation
         (attendance_id, employee_id, requested_in, requested_out, reason, approver_id)
       SELECT $1, $2,
              ($3::date + $4::time) AT TIME ZONE sh.timezone,
              ($3::date + $5::time) AT TIME ZONE sh.timezone,
              $6, $7
         FROM attendance a
         JOIN employee e ON e.id = a.employee_id
         JOIN shift sh ON sh.id = COALESCE(a.shift_id, e.shift_id)
        WHERE a.id = $1`,
      [row.id, empId, date, inT, outT, reason, row.manager_id]);

    return reload(db, empId, date);
  });
}

/**
 * Open an attendance row for a day that has none, so it can be corrected.
 *
 * Refused for a date in the future and for one outside this person's
 * employment. Neither is a correction: a day that has not happened cannot have
 * been worked, and a day before somebody joined or after they left is not
 * theirs to account for. Without these, a typo in a date field writes a row
 * that every report and every pay run then has to reckon with — and the
 * `UNIQUE (tenant_id, employee_id, work_date)` constraint means it is one row
 * per mistake, quietly, for ever.
 */
async function createDayFor(
  db: TenantClient, empId: string, date: string,
): Promise<{ id: string; manager_id: string | null }> {
  const { rows: emp } = await db.query<{
    manager_id: string | null; too_early: boolean; too_late: boolean; future: boolean;
  }>(
    `SELECT e.manager_id,
            ($2::date < e.joined_on) AS too_early,
            (e.left_on IS NOT NULL AND $2::date > e.left_on) AS too_late,
            ($2::date > (now() AT TIME ZONE COALESCE(sh.timezone, 'UTC'))::date) AS future
       FROM employee e
       LEFT JOIN shift sh ON sh.id = e.shift_id
      WHERE e.id = $1`, [empId, date]);
  const e = emp[0];
  if (!e) throw new AttendanceError('no such employee', 'not_found');
  if (e.future) {
    throw new AttendanceError(
      'That day has not happened yet, so there is nothing to correct.', 'invalid');
  }
  if (e.too_early || e.too_late) {
    throw new AttendanceError(
      'That day falls outside this person\'s employment.', 'invalid');
  }

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO attendance
       (employee_id, work_date, status, site_id, shift_id, source, worked_minutes, late)
     SELECT $1, $2::date, 'A', e.site_id, e.shift_id, 'system', 0, false
       FROM employee e WHERE e.id = $1
     RETURNING id`, [empId, date]);
  return { id: rows[0]!.id, manager_id: e.manager_id };
}

/**
 * Decide a regularisation. Approving rewrites the day as present.
 *
 * That is the whole reason this is a service call and not an UPDATE: the
 * decision and the attendance correction have to commit together, or a day is
 * approved and still counted absent.
 */
export async function actOnRegularisation(
  caller: Caller,
  empId: string,
  date: string,
  decision: 'Approved' | 'Rejected',
): Promise<AttRecord> {
  if (!reaches(caller, 'attendance', 'read', 'team')) {
    throw new AttendanceError('only a manager or admin may decide this', 'forbidden');
  }
  if (empId === caller.employeeId) {
    throw new AttendanceError('you cannot decide your own regularisation', 'self_approval');
  }

  return withTenant(caller, async (db) => {
    if (!(await maySee(db, caller, empId))) {
      throw new AttendanceError('that person is not in your team', 'forbidden');
    }

    const r = await db.query(
      `SELECT r.id, r.attendance_id, r.requested_in, r.requested_out, r.status
         FROM regularisation r
         JOIN attendance a ON a.id = r.attendance_id
        WHERE r.employee_id = $1 AND a.work_date = $2
        FOR UPDATE OF r`, [empId, date]);
    if (!r.rows[0]) throw new AttendanceError('no regularisation for that day', 'not_found');
    if (r.rows[0].status !== 'pending') {
      throw new AttendanceError(`already ${r.rows[0].status}`, 'not_pending');
    }

    await db.query(
      `UPDATE regularisation
          SET status = $1, approver_id = $2, acted_on = CURRENT_DATE
        WHERE id = $3`,
      [decision.toLowerCase(), caller.employeeId, r.rows[0].id]);

    if (decision === 'Approved') {
      /*
       * The break comes from the row's own shift — the same
       * `COALESCE(a.shift_id, e.shift_id)` every other read uses — and not from
       * the employee's current one, which is what this was: the third place
       * that mistake was made. The break is subtracted from the approved
       * hours, so after a shift move it deducted the new roster's break from a
       * day worked on the old one's. That still yields a plausible total,
       * which is why it needs an assertion rather than an eye.
       *
       * As a scalar subquery rather than a join, because an UPDATE's FROM
       * clause may not reference the update target — `COALESCE(a.shift_id, …)`
       * does, and Postgres answers 42P01.
       */
      await db.query(
        `UPDATE attendance a
            SET punch_in = $2, punch_out = $3, status = 'P', late = false,
                geo_ok = NULL,
                worked_minutes = GREATEST(0,
                  EXTRACT(EPOCH FROM ($3::timestamptz - $2::timestamptz))::int / 60
                  - COALESCE((
                      SELECT sh.break_minutes FROM shift sh
                       WHERE sh.id = COALESCE(
                         a.shift_id,
                         (SELECT e.shift_id FROM employee e WHERE e.id = a.employee_id))
                    ), 0)),
                notes = 'Regularised', updated_at = now()
          WHERE a.id = $1`,
        [r.rows[0].attendance_id, r.rows[0].requested_in, r.rows[0].requested_out]);
    }

    return reload(db, empId, date);
  });
}

/* ---------------- which day a punch belongs to ----------------
 *
 * ## The bug this replaces
 *
 * `punchIn` and `punchOut` took the work date as a parameter and the client
 * sent `ymd(TODAY)` — the browser's calendar day. For a shift measured in the
 * same zone as the browser that is right by coincidence. For the US shift
 * worked from Chennai it is wrong twice a day:
 *
 *   * punch in Mon 18:30 IST → the browser says Monday → a Monday row;
 *   * punch out Tue 03:30 IST → the browser says Tuesday → `punchOut` ran
 *     `WHERE work_date = 'Tuesday'`, found no punch_in, and threw
 *     "you have not checked in today". The shift could not be closed at all.
 *
 * And the card read `useDay(empId, ymd(TODAY))`, so at 03:30 the employee saw
 * an empty Tuesday offering "Punch In" — which would have opened a second
 * row and left Monday's open for payroll to read as an absence.
 *
 * ## The rule
 *
 * A punch belongs to the shift *instance* whose window contains it, where the
 * window is `start − 2h … end + 4h` measured in the shift's own zone, and the
 * work date is that instance's start date in that zone.
 *
 * Two things follow for free, which is why the rule is shaped this way rather
 * than special-casing "overnight":
 *
 *   * **A 09:00–18:00 America/New_York shift does not cross midnight in its
 *     own zone.** "Overnight" exists only in IST. Deriving the date in the
 *     shift's zone makes the India-worked US shift ordinary.
 *   * **A shift that genuinely crosses midnight in its own zone** — 22:00 to
 *     06:00, say — is handled by the same arithmetic, because the window's
 *     close rolls to the next day when `ends_at <= starts_at`.
 *
 * ## Why in SQL
 *
 * The arithmetic is `AT TIME ZONE` against a named zone, which is where DST
 * correctness comes from: Postgres knows that 09:00 New York is 13:00 UTC in
 * October and 14:00 UTC in November. Doing it in JavaScript would mean a
 * timezone library and a second source of truth for the same question.
 * Nothing here stores an offset, which is the property that keeps it right
 * across 1 November.
 *
 * ## Candidates
 *
 * Three: the punch's own date in the shift's zone, the day before, and the
 * day after. The day before matters for a punch after midnight on an
 * overnight shift; the day after for a punch in the two hours before a shift
 * that starts just after midnight. A 9h shift's windows are 15h long, so they
 * cannot overlap — but a very long shift's could, and `ORDER BY` the distance
 * to the instance's start picks the nearest, which is the only answer that
 * does not depend on row order.
 */

const SHIFT_DATE = `
  WITH ${EFFECTIVE_SHIFT},
  sh AS (
    SELECT timezone AS tz, starts_at, ends_at FROM eff
  ), base AS (
    SELECT tz, starts_at, ends_at, (($2::timestamptz) AT TIME ZONE tz)::date AS d0
      FROM sh
  ), cand AS (
    SELECT (d0 + o.offs) AS shift_date, tz, starts_at, ends_at
      FROM base, (VALUES (-1), (0), (1)) AS o(offs)
  ), win AS (
    SELECT shift_date,
           ((shift_date + starts_at)::timestamp AT TIME ZONE tz) AS starts,
           ((shift_date + starts_at)::timestamp AT TIME ZONE tz)
             - interval '2 hours' AS opens,
           ((shift_date
              + CASE WHEN ends_at <= starts_at
                     THEN interval '1 day' ELSE interval '0 day' END
              + ends_at)::timestamp AT TIME ZONE tz)
             + interval '4 hours' AS closes
      FROM cand
  )
  SELECT to_char(shift_date, 'YYYY-MM-DD') AS work_date,
         to_char(starts AT TIME ZONE tz, 'YYYY-MM-DD HH24:MI') AS shift_start_local,
         tz
    FROM win, base
   WHERE $2::timestamptz >= opens AND $2::timestamptz <= closes
   ORDER BY abs(EXTRACT(EPOCH FROM ($2::timestamptz - starts)))
   LIMIT 1`;

/** Which shift instance a punch falls in, and the zone it was measured in. */
export interface ShiftInstance {
  /** The instance's start date in the shift's own zone, `YYYY-MM-DD`. */
  workDate: string;
  /** When that instance starts, as wall-clock in the shift's zone. */
  shiftStartLocal: string;
  /** The shift's zone, so a caller can label what it is showing. */
  timezone: string;
}

/**
 * The shift instance a punch at `instant` belongs to, or null when the punch
 * is outside every window.
 *
 * Null is not an error here — it is the answer to "may I punch now", and the
 * callers turn it into one. Returning it rather than throwing keeps this
 * function answerable in a read-only transaction, which is what the card
 * needs in order to decide whether to offer the button at all.
 */
export async function shiftInstanceAt(
  db: TenantClient, employeeId: string, instant: string,
): Promise<ShiftInstance | null> {
  const { rows } = await db.query<{
    work_date: string; shift_start_local: string; tz: string;
  }>(SHIFT_DATE, [employeeId, instant]);
  const r = rows[0];
  if (!r) return null;
  return {
    workDate: r.work_date,
    shiftStartLocal: r.shift_start_local,
    timezone: r.tz,
  };
}

/**
 * The punch's own calendar day in the shift's zone, whether or not any shift
 * instance contains it.
 *
 * This is the date an attendance correction should be raised for when a punch
 * falls outside every window: the employee worked on *some* day, and it is the
 * day the shift's own zone was on at that moment — not the day the browser
 * happened to be on, which is the mistake this whole section exists to undo.
 *
 * It cannot reuse `SHIFT_DATE`, whose `WHERE` discards exactly the rows this
 * needs; `EFFECTIVE_SHIFT` always resolves to a window, so the zone is always
 * available even when nothing matched.
 */
const PUNCH_LOCAL_DATE = `
  WITH ${EFFECTIVE_SHIFT}
  SELECT to_char((($2::timestamptz) AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS local_date,
         timezone AS tz
    FROM eff`;

export async function punchLocalDate(
  db: TenantClient, employeeId: string, instant: string,
): Promise<{ localDate: string; timezone: string } | null> {
  const { rows } = await db.query<{ local_date: string; tz: string }>(
    PUNCH_LOCAL_DATE, [employeeId, instant]);
  const r = rows[0];
  return r ? { localDate: r.local_date, timezone: r.tz } : null;
}

/**
 * Which day to file a punch under, or a refusal that says what to do instead.
 *
 * The one place `punchIn` and `punchOut` decide a work date, so the two cannot
 * disagree — and they did disagree before, which is how a shift could be
 * opened under one date and then not be closable under another.
 *
 * The refusal is deliberate and narrow. `EFFECTIVE_SHIFT` always resolves to
 * a window, so "no shift" and "no schedule" can no longer refuse a punch; the
 * only thing left that can is a punch genuinely nowhere near a shift — more
 * than two hours before one starts, or more than four after one ends. That is
 * a correction, not a punch, so the message names the day to raise it for.
 */
/**
 * The day an *open* punch belongs to, measured against the shift that day was
 * opened on rather than the one the employee is on now.
 *
 * ## Why a punch out cannot ask the same question a punch in does
 *
 * `workDateFor` resolves the window from `employee.shift_id` — what the person
 * is on at this moment. For a punch in that is the only sensible answer. For a
 * punch out it is the wrong one as soon as anything moved underneath it:
 *
 *   * **Somebody was moved onto different hours during their shift.** Prem
 *     punches in at 18:00 IST on the India roster, an administrator moves him
 *     to the US one at 20:00, and at 03:30 his punch out is resolved against
 *     New York, lands on a different work date, finds no `punch_in` there and
 *     is refused with "you have not checked in today". The row stays open for
 *     ever and payroll reads an unclosed day.
 *   * **A shift's own hours were corrected mid-day**, which `updateShift`
 *     allows and which has exactly the same effect.
 *
 * The row already records what it was measured against — `attendance.shift_id`
 * is stamped at punch in — so the answer is there and does not need deriving
 * twice. This reads it back.
 *
 * ## Why it is still bounded by a window
 *
 * An open row from last Tuesday that nobody closed must not swallow today's
 * punch out: that would silently assign tonight's hours to a day eight days
 * ago and produce a 190-hour shift. So the row's own window still has to
 * contain the instant, computed from the row's own shift in the row's own
 * zone, which is the same arithmetic `SHIFT_DATE` uses. A stale open day falls
 * outside it, stays open, and is reported by `unclosedDays` — which is what it
 * is for.
 *
 * Null when there is no open row whose window contains this instant, in which
 * case the caller falls back to `workDateFor` and nothing has changed.
 */
const OPEN_DAY = `
  WITH open AS (
    SELECT a.work_date,
           sh.timezone AS tz, sh.starts_at, sh.ends_at, sh.break_minutes
      FROM attendance a
      JOIN employee e ON e.id = a.employee_id
      JOIN shift sh ON sh.id = COALESCE(a.shift_id, e.shift_id)
     WHERE a.employee_id = $1
       AND a.punch_in IS NOT NULL AND a.punch_out IS NULL
       AND sh.starts_at IS NOT NULL AND sh.ends_at IS NOT NULL
  ), win AS (
    SELECT work_date, break_minutes,
           ((work_date + starts_at)::timestamp AT TIME ZONE tz)
             - interval '2 hours' AS opens,
           ((work_date
              + CASE WHEN ends_at <= starts_at
                     THEN interval '1 day' ELSE interval '0 day' END
              + ends_at)::timestamp AT TIME ZONE tz)
             + interval '4 hours' AS closes
      FROM open
  )
  SELECT to_char(work_date, 'YYYY-MM-DD') AS work_date, break_minutes
    FROM win
   WHERE $2::timestamptz >= opens AND $2::timestamptz <= closes
   ORDER BY work_date DESC
   LIMIT 1`;

async function openDayFor(
  db: TenantClient, empId: string, instant: string,
): Promise<{ workDate: string; breakMinutes: number | null } | null> {
  const { rows } = await db.query<{ work_date: string; break_minutes: number | null }>(
    OPEN_DAY, [empId, instant]);
  const r = rows[0];
  if (!r) return null;
  return { workDate: r.work_date, breakMinutes: r.break_minutes };
}

async function workDateFor(
  db: TenantClient, empId: string, instant: string,
): Promise<string> {
  const inst = await shiftInstanceAt(db, empId, instant);
  if (inst) return inst.workDate;

  const local = await punchLocalDate(db, empId, instant);
  if (!local) throw new AttendanceError('no such employee', 'not_found');
  throw new AttendanceError(
    `This is outside your shift window, so there is no shift to attach it to. `
    + `Request an attendance correction for ${local.localDate}.`,
    'outside_window',
    /*
     * The day in the *shift's* own zone, not the browser's. That is the whole
     * point of `punchLocalDate`: the correction has to be raised for the day
     * the person worked, and for anybody on hours measured in another zone the
     * browser's calendar day is the wrong one twice a day.
     */
    { localDate: local.localDate, tz: local.timezone });
}
