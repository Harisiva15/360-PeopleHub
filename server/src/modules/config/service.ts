/**
 * Tenant configuration — sites, holidays and leave entitlements.
 *
 * Small in method count and disproportionately important: setting a leave
 * entitlement reprices every balance already open against it. That is the kind
 * of write that looks like a settings change and behaves like a bulk update,
 * so it happens in one transaction and reports what it touched.
 *
 * There is no site write. A site used to own a geo-fence and a default shift
 * that was pushed to everyone based there; 0016 removed the fence, and since
 * 0015 the shift is a regional tag on the employee — pushing a site shift would
 * now overwrite the US-shift people sitting in the Chennai office. So a site is
 * a label here: a name, a city, an address, a timezone.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class ConfigError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/** Matches the frontend's `Site`, which is keyed by code rather than uuid. */
export interface Site {
  id: string;
  name: string;
  city: string;
  country: string;
  addr: string;
  /** WFH and CLIENT are work modes rather than places, and have no address. */
  remote: boolean;
  tz: string;
  shift: string;
}

export interface Holiday {
  d: string;
  n: string;
  opt: boolean;
}

/** Codes that name a way of working rather than a building. */
const REMOTE_MODES = new Set(['WFH', 'CLIENT']);

const toSite = (r: Record<string, unknown>): Site => ({
  // The screens key sites by code; the uuid stays server-side.
  id: r.code as string,
  name: r.name as string,
  city: (r.city as string) ?? '',
  country: r.country as string,
  addr: (r.address as string) ?? '',
  remote: REMOTE_MODES.has(r.code as string),
  tz: (r.timezone as string) ?? 'Asia/Kolkata',
  shift: (r.shift_code as string) ?? 'GEN',
});

export async function listSites(caller: Caller): Promise<Site[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT s.code, s.name, s.city, s.country, s.address, s.timezone,
              sh.code AS shift_code
         FROM site s
         LEFT JOIN shift sh ON sh.id = s.default_shift_id
        WHERE s.active
        ORDER BY s.name`);
    return rows.map(toSite);
  });
}

export async function listHolidays(caller: Caller): Promise<Holiday[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT observed_on, name, optional FROM holiday ORDER BY observed_on`);
    return rows.map((r) => ({ d: r.observed_on as string, n: r.name as string, opt: r.optional as boolean }));
  });
}

/**
 * Set an entitlement, and reprice the balances already open against it.
 *
 * Changing next year's quota without touching this year's balances is the
 * behaviour people expect from a config screen and the wrong one for leave:
 * the entitlement *is* the balance. So both move together, and the count of
 * repriced rows is returned so the caller can say what happened.
 */
export async function setLeaveQuota(
  caller: Caller,
  typeCode: string,
  quota: number,
): Promise<{ type: string; quota: number; repriced: number }> {
  if (caller.role !== 'admin') throw new ConfigError('only an admin may change quotas', 'forbidden');
  if (quota < 0) throw new ConfigError('a quota cannot be negative', 'invalid');

  return withTenant(caller, async (db) => {
    const type = await db.query(
      'UPDATE leave_type SET annual_quota = $1 WHERE code = $2 RETURNING id, name',
      [quota, typeCode]);
    if (type.rowCount === 0) throw new ConfigError('no such leave type', 'not_found');

    // Only the current leave year: closed years are history and repricing them
    // would rewrite balances people have already been paid encashment on.
    const repriced = await db.query(
      `UPDATE leave_balance lb
          SET quota = $1, updated_at = now()
         FROM tenant t
        WHERE lb.leave_type_id = $2
          AND t.id = current_tenant_id()
          AND lb.year_start = make_date(
                CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= t.fiscal_year_start_month
                     THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
                     ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END,
                t.fiscal_year_start_month, 1)`,
      [quota, type.rows[0].id]);

    await db.query(
      `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                              subject_table, detail)
       SELECT 'config', 'leave_quota_changed', $1, COALESCE(e.full_name, 'system'), 'leave_type',
              jsonb_build_object('type', $2::text, 'quota', $3::text, 'repriced', $4::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, typeCode, String(quota), String(repriced.rowCount ?? 0)]);

    return { type: type.rows[0].name as string, quota, repriced: repriced.rowCount ?? 0 };
  });
}

/** Add a holiday. Two mandatory holidays cannot share a date. */
export async function addHoliday(
  caller: Caller,
  date: string,
  name: string,
  optional: boolean,
): Promise<Holiday[]> {
  if (caller.role !== 'admin') throw new ConfigError('only an admin may add holidays', 'forbidden');

  return withTenant(caller, async (db) => {
    try {
      await db.query(
        'INSERT INTO holiday (observed_on, name, optional) VALUES ($1, $2, $3)',
        [date, name, optional]);
    } catch (e) {
      // The partial unique index is the authority; this turns it into a
      // message rather than a 500.
      if ((e as { code?: string }).code === '23505') {
        throw new ConfigError('that date already has a holiday', 'duplicate');
      }
      throw e;
    }
    const { rows } = await db.query(
      'SELECT observed_on, name, optional FROM holiday ORDER BY observed_on');
    return rows.map((r) => ({ d: r.observed_on as string, n: r.name as string, opt: r.optional as boolean }));
  });
}
