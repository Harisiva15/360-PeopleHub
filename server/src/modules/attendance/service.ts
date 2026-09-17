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

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class AttendanceError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'AttendanceError';
    this.code = code;
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
}

const REG_STATUS: Record<string, Regularisation['status']> = {
  pending: 'Pending', approved: 'Approved', rejected: 'Rejected',
};

/**
 * Punch times are rendered in the shift's timezone, not the server's or the
 * reader's. A 09:30 start means 09:30 where the shift is measured.
 */
const PROJECTION = `
  SELECT a.id, a.employee_id, a.work_date, a.status,
         to_char(a.punch_in  AT TIME ZONE sh.timezone, 'HH24:MI') AS in_t,
         to_char(a.punch_out AT TIME ZONE sh.timezone, 'HH24:MI') AS out_t,
         a.worked_minutes, s.code AS site_code, a.source, a.late, a.notes,
         a.latitude, a.longitude, a.distance_m, a.geo_ok,
         r.status AS reg_status, r.reason AS reg_reason, r.raised_on AS reg_raised,
         to_char(r.requested_in  AT TIME ZONE sh.timezone, 'HH24:MI') AS reg_in,
         to_char(r.requested_out AT TIME ZONE sh.timezone, 'HH24:MI') AS reg_out
    FROM attendance a
    JOIN employee e ON e.id = a.employee_id
    JOIN shift sh ON sh.id = e.shift_id
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
});

/** Who the caller may see attendance for. */
async function maySee(db: TenantClient, caller: Caller, empId: string): Promise<boolean> {
  if (caller.role === 'admin') return true;
  if (empId === caller.employeeId) return true;
  if (caller.role !== 'manager') return false;
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
const DERIVE = `
  WITH me AS (
    SELECT e.id, e.site_id, sh.timezone, sh.starts_at, sh.grace_minutes, sh.break_minutes
      FROM employee e JOIN shift sh ON sh.id = e.shift_id
     WHERE e.id = $1
  ), resolved AS (
    SELECT me.*, COALESCE(
             (SELECT s.id FROM site s WHERE s.code = $3::text AND s.active),
             me.site_id) AS punch_site_id
      FROM me
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

async function reload(db: TenantClient, empId: string, date: string): Promise<AttRecord> {
  const { rows } = await db.query(
    `${PROJECTION} WHERE a.employee_id = $1 AND a.work_date = $2`, [empId, date]);
  if (!rows[0]) throw new AttendanceError('no attendance for that day', 'not_found');
  return toRecord(rows[0]);
}

export async function punchIn(
  caller: Caller,
  empId: string,
  date: string,
  at: PunchAt,
): Promise<AttRecord> {
  if (empId !== caller.employeeId && caller.role !== 'admin') {
    throw new AttendanceError('you can only punch for yourself', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const when = at.at ?? new Date().toISOString();
    const { rows } = await db.query(DERIVE,
      [empId, when, at.site ?? null, at.lat ?? null, at.lng ?? null]);
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
      [empId, date, at.site === WFH ? 'W' : 'P', when, d.site_id, at.src ?? 'web', d.is_late,
        at.lat ?? null, at.lng ?? null, remote ? null : d.distance_m, geoOk]);

    return reload(db, empId, date);
  });
}

export async function punchOut(
  caller: Caller,
  empId: string,
  date: string,
  at: PunchAt,
): Promise<AttRecord> {
  if (empId !== caller.employeeId && caller.role !== 'admin') {
    throw new AttendanceError('you can only punch for yourself', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const when = at.at ?? new Date().toISOString();
    const { rows } = await db.query(DERIVE,
      [empId, when, at.site ?? null, at.lat ?? null, at.lng ?? null]);
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
     */
    await db.query(
      `UPDATE attendance
          SET punch_out = $3::timestamptz,
              worked_minutes = GREATEST(0,
                EXTRACT(EPOCH FROM ($3::timestamptz - punch_in))::int / 60 - $4::int),
              updated_at = now()
        WHERE employee_id = $1 AND work_date = $2`,
      [empId, date, when, d.break_minutes ?? 0]);

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
  if (caller.role === 'employee') {
    params.push(caller.employeeId);
    where.push(`a.employee_id = $${params.length}`);
  } else if (caller.role === 'manager') {
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
    return rows.map(toRecord);
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
  if (empId !== caller.employeeId && caller.role !== 'admin') {
    throw new AttendanceError('you can only regularise your own attendance', 'forbidden');
  }
  if (!reason.trim()) throw new AttendanceError('say why the day needs correcting', 'invalid');

  return withTenant(caller, async (db) => {
    const att = await db.query(
      `SELECT a.id, e.manager_id FROM attendance a
         JOIN employee e ON e.id = a.employee_id
        WHERE a.employee_id = $1 AND a.work_date = $2`, [empId, date]);
    if (!att.rows[0]) throw new AttendanceError('no attendance record for that day', 'not_found');

    // Times arrive as HH:MM in the shift's timezone and are stored as instants.
    await db.query(
      `INSERT INTO regularisation
         (attendance_id, employee_id, requested_in, requested_out, reason, approver_id)
       SELECT $1, $2,
              ($3::date + $4::time) AT TIME ZONE sh.timezone,
              ($3::date + $5::time) AT TIME ZONE sh.timezone,
              $6, $7
         FROM employee e JOIN shift sh ON sh.id = e.shift_id WHERE e.id = $2`,
      [att.rows[0].id, empId, date, inT, outT, reason, att.rows[0].manager_id]);

    return reload(db, empId, date);
  });
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
  if (caller.role === 'employee') {
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
      await db.query(
        `UPDATE attendance a
            SET punch_in = $2, punch_out = $3, status = 'P', late = false,
                geo_ok = NULL,
                worked_minutes = GREATEST(0,
                  EXTRACT(EPOCH FROM ($3::timestamptz - $2::timestamptz))::int / 60
                  - COALESCE(sh.break_minutes, 0)),
                notes = 'Regularised', updated_at = now()
           FROM employee e JOIN shift sh ON sh.id = e.shift_id
          WHERE a.id = $1 AND e.id = a.employee_id`,
        [r.rows[0].attendance_id, r.rows[0].requested_in, r.rows[0].requested_out]);
    }

    return reload(db, empId, date);
  });
}
