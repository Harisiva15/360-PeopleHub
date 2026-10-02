/**
 * Tenant configuration — sites, holidays and leave entitlements.
 *
 * Small in method count and disproportionately important: setting a leave
 * entitlement reprices every balance already open against it. That is the kind
 * of write that looks like a settings change and behaves like a bulk update,
 * so it happens in one transaction and reports what it touched.
 *
 * The one site write is the geo-fence, restored with 0018. It sets a centre
 * and a radius and nothing else — the old version also pushed the site's shift
 * to everyone based there, which since 0015 would overwrite the US-shift people
 * sitting in the Chennai office. A fence move is a fence move.
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
  lat: number | null;
  lng: number | null;
  /** Fence radius in metres; null means the site is not fenced. */
  radius: number | null;
  tz: string;
  shift: string;
  /**
   * What kind of place this is (0044). Optional so that anything constructing
   * a Site without it — the demo dataset, an older client — still typechecks.
   */
  kind?: 'headquarters' | 'office' | 'client' | 'remote' | undefined;
  /** At most one per tenant, enforced by a partial unique index. */
  headquarters?: boolean | undefined;
  state?: string | undefined;
  postcode?: string | undefined;
  /** A closed location is still named on old records; no form offers it. */
  active?: boolean | undefined;
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
  lat: r.latitude === null ? null : Number(r.latitude),
  lng: r.longitude === null ? null : Number(r.longitude),
  radius: r.fence_radius_m === null ? null : Number(r.fence_radius_m),
  kind: r.kind as Site['kind'],
  headquarters: Boolean(r.is_headquarters),
  state: (r.state as string) ?? '',
  postcode: (r.postal_code as string) ?? '',
  tz: (r.timezone as string) ?? 'Asia/Kolkata',
  shift: (r.shift_code as string) ?? 'GEN',
  /* Absent from a row selected before this column was read: treat as open. */
  active: r.active === undefined ? true : Boolean(r.active),
});

/*
 * Every column a Site is built from, in one place.
 *
 * It had been written out at each call site, and the copies drifted: a fence
 * move re-read the row without `kind`, `state`, `postal_code` or the
 * headquarters flag, so saving a fence silently handed the caller a location
 * that had stopped being head office and had no state.
 */
const SITE_COLUMNS =
  `SELECT s.code, s.name, s.city, s.country, s.address, s.timezone,
          s.latitude, s.longitude, s.fence_radius_m, sh.code AS shift_code,
          s.kind, s.is_headquarters, s.state, s.postal_code, s.active
     FROM site s
     LEFT JOIN shift sh ON sh.id = s.default_shift_id`;

/** One audit row per configuration write, with the actor's name resolved. */
async function audit(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  caller: Caller,
  action: string,
  siteCode: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                            subject_table, detail)
     SELECT 'config', $2, $1, COALESCE(e.full_name, 'system'), 'site',
            $4::jsonb || jsonb_build_object('site', $3::text)
       FROM employee e WHERE e.id = $1`,
    [caller.employeeId, action, siteCode, JSON.stringify(detail)]);
}

/**
 * Every location, closed ones included.
 *
 * Closed sites are returned because a screen still has to resolve the code on
 * an old attendance row to a name. `active` says which are open, and the forms
 * offer only those — see `useSites` on the client.
 */
export async function listSites(caller: Caller): Promise<Site[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${SITE_COLUMNS} ORDER BY s.active DESC, s.name`);
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

export interface FenceUpdate {
  lat: number;
  lng: number;
  radius: number;
}

/**
 * Move a site's geo-fence.
 *
 * A zero radius is refused: it would flag every punch at that site as outside
 * the fence, which reads as a system fault rather than a policy change. A
 * remote work mode cannot be fenced at all — WFH and CLIENT are not places the
 * company has a perimeter for.
 */
export async function updateFence(
  caller: Caller,
  siteCode: string,
  patch: FenceUpdate,
): Promise<Site> {
  if (caller.role !== 'admin') {
    throw new ConfigError('only an admin may change a fence', 'forbidden');
  }
  if (!Number.isFinite(patch.lat) || !Number.isFinite(patch.lng)) {
    throw new ConfigError('a fence needs a latitude and a longitude', 'invalid');
  }
  if (Math.abs(patch.lat) > 90 || Math.abs(patch.lng) > 180) {
    throw new ConfigError('that is not a point on the earth', 'invalid');
  }
  if (!(patch.radius > 0)) {
    throw new ConfigError('a fence radius must be greater than zero', 'invalid');
  }
  if (REMOTE_MODES.has(siteCode)) {
    throw new ConfigError('a remote work mode cannot be fenced', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const updated = await db.query(
      `UPDATE site SET latitude = $1, longitude = $2, fence_radius_m = $3
        WHERE code = $4 RETURNING id`,
      [patch.lat, patch.lng, patch.radius, siteCode]);
    if (updated.rowCount === 0) throw new ConfigError('no such site', 'not_found');

    await db.query(
      `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                              subject_table, detail)
       SELECT 'config', 'fence_moved', $1, COALESCE(e.full_name, 'system'), 'site',
              jsonb_build_object('site', $2::text, 'radius', $3::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, siteCode, String(patch.radius)]);

    const { rows } = await db.query(`${SITE_COLUMNS} WHERE s.code = $1`, [siteCode]);
    return toSite(rows[0]!);
  });
}

/* ------------------------------------------------------------------ *
 * Locations
 *
 * A site is referenced by employees, attendance, requisitions and shifts, so
 * there is no delete — closing an office is `active = false`, and the rules
 * below are the ones that keep the remaining rows meaning something.
 * ------------------------------------------------------------------ */

export interface SiteDraft {
  code: string;
  name: string;
  city?: string;
  state?: string;
  country: string;
  address?: string;
  postcode?: string;
  timezone?: string;
  kind: 'headquarters' | 'office' | 'client' | 'remote';
}

export type SitePatch = Partial<Omit<SiteDraft, 'code'>>;

const KINDS = new Set(['headquarters', 'office', 'client', 'remote']);

/**
 * What a location must say about itself before it is worth storing.
 *
 * The schema refuses a bad `kind` and two head offices; these are the things it
 * cannot see — a blank name, a code that is not a code, a country that is not
 * two letters. Saying so here means the person gets a sentence rather than a
 * constraint violation.
 */
function checkDraft(d: SiteDraft | SitePatch, partial: boolean): void {
  const need = (v: unknown) => typeof v === 'string' && v.trim() !== '';

  if (!partial) {
    const full = d as SiteDraft;
    if (!need(full.code)) throw new ConfigError('a location needs a code', 'invalid');
    if (!/^[A-Z0-9]{2,10}$/.test(full.code.trim().toUpperCase())) {
      throw new ConfigError('a code is 2–10 letters or digits, such as BLR', 'invalid');
    }
    if (!need(full.name)) throw new ConfigError('a location needs a name', 'invalid');
    if (!need(full.country)) throw new ConfigError('a location needs a country', 'invalid');
  }
  if (d.name !== undefined && !need(d.name)) {
    throw new ConfigError('a location needs a name', 'invalid');
  }
  if (d.country !== undefined && !/^[A-Z]{2}$/.test(String(d.country).trim().toUpperCase())) {
    throw new ConfigError('a country is a two-letter code, such as IN', 'invalid');
  }
  if (d.kind !== undefined && !KINDS.has(d.kind)) {
    throw new ConfigError('a location is a headquarters, office, client site or remote', 'invalid');
  }
}

/**
 * Make this site head office, and no other.
 *
 * `site_one_headquarters` permits exactly one active flagged row per tenant, so
 * promoting without demoting fails the index rather than moving the flag. Both
 * columns move together because `site_headquarters_is_consistent` refuses them
 * apart — the old head office becomes an ordinary office, which is what it is.
 *
 * Runs inside the caller's transaction, so a failure anywhere after it leaves
 * the company with the head office it started with.
 */
async function nominateHeadquarters(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }> },
  code: string,
): Promise<void> {
  await db.query(
    `UPDATE site SET is_headquarters = false, kind = 'office'
      WHERE is_headquarters AND code <> $1`, [code]);
  await db.query(
    `UPDATE site SET is_headquarters = true, kind = 'headquarters' WHERE code = $1`, [code]);
}

/** Open a location. Admin only — this is what every posting screen offers. */
export async function createSite(caller: Caller, draft: SiteDraft): Promise<Site> {
  if (caller.role !== 'admin') {
    throw new ConfigError('only an admin may add a location', 'forbidden');
  }
  checkDraft(draft, false);

  const code = draft.code.trim().toUpperCase();
  const country = draft.country.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const clash = await db.query('SELECT 1 FROM site WHERE code = $1', [code]);
    if (clash.rowCount) throw new ConfigError(`${code} is already a location`, 'conflict');

    const { rows } = await db.query(
      `INSERT INTO site (code, name, city, state, country, address, postal_code,
                         timezone, kind, is_headquarters, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'Asia/Kolkata'), $9, false, true)
       RETURNING id`,
      [code, draft.name.trim(), draft.city?.trim() ?? null, draft.state?.trim() ?? null,
        country, draft.address?.trim() ?? null, draft.postcode?.trim() ?? null,
        draft.timezone?.trim() || null,
        /* Head office is set below, so the demotion and promotion stay one step. */
        draft.kind === 'headquarters' ? 'office' : draft.kind]);
    if (!rows[0]) throw new ConfigError('the location was not created', 'invalid');

    if (draft.kind === 'headquarters') await nominateHeadquarters(db, code);

    await audit(db, caller, 'site_created', code,
      { name: draft.name.trim(), kind: draft.kind });

    const back = await db.query(`${SITE_COLUMNS} WHERE s.code = $1`, [code]);
    return toSite(back.rows[0]!);
  });
}

/** Change a location's details. The code is its identity and does not move. */
export async function updateSite(
  caller: Caller, siteCode: string, patch: SitePatch,
): Promise<Site> {
  if (caller.role !== 'admin') {
    throw new ConfigError('only an admin may change a location', 'forbidden');
  }
  checkDraft(patch, true);

  return withTenant(caller, async (db) => {
    const found = await db.query(
      'SELECT kind, active FROM site WHERE code = $1', [siteCode]);
    if (!found.rows[0]) throw new ConfigError('no such location', 'not_found');
    const was = found.rows[0] as { kind: string; active: boolean };

    if (patch.kind === 'headquarters' && !was.active) {
      throw new ConfigError('a closed location cannot be head office', 'invalid');
    }
    if (was.kind === 'headquarters' && patch.kind !== undefined && patch.kind !== 'headquarters') {
      throw new ConfigError(
        'nominate another location as head office first — the company must have one',
        'invalid');
    }

    /*
     * `kind` is written by nominateHeadquarters when head office is involved,
     * so it is left out of this statement to keep one writer per column.
     */
    const movesHq = patch.kind === 'headquarters' && was.kind !== 'headquarters';
    await db.query(
      `UPDATE site
          SET name        = COALESCE($2, name),
              city        = COALESCE($3, city),
              state       = COALESCE($4, state),
              country     = COALESCE($5, country),
              address     = COALESCE($6, address),
              postal_code = COALESCE($7, postal_code),
              timezone    = COALESCE($8, timezone),
              kind        = CASE WHEN $9::text IS NULL OR $10::boolean THEN kind ELSE $9 END
        WHERE code = $1`,
      [siteCode, patch.name?.trim() ?? null, patch.city?.trim() ?? null,
        patch.state?.trim() ?? null, patch.country?.trim().toUpperCase() ?? null,
        patch.address?.trim() ?? null, patch.postcode?.trim() ?? null,
        patch.timezone?.trim() ?? null, patch.kind ?? null, movesHq]);

    if (movesHq) await nominateHeadquarters(db, siteCode);

    await audit(db, caller, 'site_updated', siteCode,
      { fields: Object.keys(patch).join(', ') });

    const back = await db.query(`${SITE_COLUMNS} WHERE s.code = $1`, [siteCode]);
    return toSite(back.rows[0]!);
  });
}

/**
 * Close a location, or open it again.
 *
 * Closing is refused while anyone is still posted there. A closed site drops
 * out of `listSites`, so every screen that resolves a code to a name would
 * start printing a dash for people who work at a real office — the record would
 * be wrong rather than merely out of date. Move them, then close it.
 *
 * Head office cannot be closed at all: `site_one_headquarters` only counts
 * active rows, so closing it would leave the company with no registered
 * address and no error to say so.
 */
export async function setSiteActive(
  caller: Caller, siteCode: string, active: boolean,
): Promise<Site> {
  if (caller.role !== 'admin') {
    throw new ConfigError('only an admin may open or close a location', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const found = await db.query(
      'SELECT id, is_headquarters FROM site WHERE code = $1', [siteCode]);
    if (!found.rows[0]) throw new ConfigError('no such location', 'not_found');
    const row = found.rows[0] as { id: string; is_headquarters: boolean };

    if (!active) {
      if (row.is_headquarters) {
        throw new ConfigError(
          'head office cannot be closed — nominate another location first', 'invalid');
      }
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM employee
          WHERE site_id = $1 AND status <> 'exited'`, [row.id]);
      const n = (rows[0] as { n: number }).n;
      if (n > 0) {
        throw new ConfigError(
          `${n} ${n === 1 ? 'person is' : 'people are'} still posted here — `
          + 'move them before closing it', 'conflict');
      }
    }

    await db.query('UPDATE site SET active = $2 WHERE code = $1', [siteCode, active]);
    await audit(db, caller, active ? 'site_reopened' : 'site_closed', siteCode, {});

    const back = await db.query(`${SITE_COLUMNS} WHERE s.code = $1`, [siteCode]);
    return toSite(back.rows[0]!);
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

/* ------------------------------------------------------------------ *
 * Departments
 * ------------------------------------------------------------------ */

/**
 * The department list, and the four operations on it.
 *
 * The `department` table has been there since 0002 and eight rows sit in it,
 * referenced by employees, job titles, requisitions and six other tables.
 * Nothing exposed it. The Settings screen rendered `DEPTS` from
 * `src/data/org.ts` instead — a client-side constant that happened to look
 * plausible and had no connection to what the company actually has. A screen
 * showing eight invented departments beside a database holding eight real ones
 * is the kind of wrong that never announces itself.
 */
export interface Department {
  id: string;
  code: string;
  name: string;
  colour: string | null;
  headId: string | null;
  headName: string;
  parentId: string | null;
  active: boolean;
  /** Active employees in it. What makes a delete unsafe. */
  headcount: number;
  /**
   * The business unit it belongs to, or null where none is assigned.
   *
   * Null is a real state rather than missing data: departments predate
   * business units and are never assigned one implicitly. Carried as the code,
   * because that is what the rest of the product keys a unit by.
   */
  businessUnitCode: string | null;
  /** Resolved for display, so a list does not need a second request. */
  businessUnitName: string | null;
}

export interface DepartmentDraft {
  code: string;
  name: string;
  colour?: string | null;
  headId?: string | null;
  parentId?: string | null;
  /**
   * A business unit code, or null to leave it unassigned.
   *
   * Absent and null differ on a patch: absent leaves the assignment alone,
   * null clears it. Collapsing the two would make leave this as it is and
   * remove this the same request.
   */
  businessUnitCode?: string | null;
}

const DEPT_COLUMNS = `
  SELECT d.id, d.code, d.name, d.colour, d.head_employee_id, d.parent_id, d.active,
         b.code AS business_unit_code, b.name AS business_unit_name,
         COALESCE(h.full_name, '') AS head_name,
         (SELECT count(*)::int FROM employee e
           WHERE e.department_id = d.id AND e.status <> 'exited') AS headcount
    FROM department d
    LEFT JOIN employee h ON h.id = d.head_employee_id
    LEFT JOIN business_unit b ON b.id = d.business_unit_id`;

const toDepartment = (r: Record<string, unknown>): Department => ({
  id: r.id as string,
  code: r.code as string,
  name: r.name as string,
  colour: (r.colour as string | null) ?? null,
  headId: (r.head_employee_id as string | null) ?? null,
  headName: r.head_name as string,
  parentId: (r.parent_id as string | null) ?? null,
  active: Boolean(r.active),
  headcount: Number(r.headcount),
  businessUnitCode: (r.business_unit_code as string | null) ?? null,
  businessUnitName: (r.business_unit_name as string | null) ?? null,
});

export async function listDepartments(caller: Caller): Promise<Department[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${DEPT_COLUMNS} ORDER BY d.name`);
    return rows.map(toDepartment);
  });
}

/** Shaping the organisation is an administrator's, as the rest of settings is. */
function mayShape(caller: Caller, verb: string) {
  if (caller.role !== 'admin') {
    throw new ConfigError(`only an admin may ${verb} a department`, 'forbidden');
  }
}

function checkDepartment(d: Partial<DepartmentDraft>, patching: boolean) {
  if (!patching || d.code !== undefined) {
    if (!d.code?.trim()) throw new ConfigError('a department needs a code', 'invalid');
    if (!/^[A-Z0-9_-]{2,12}$/.test(d.code.trim().toUpperCase())) {
      throw new ConfigError(
        'a department code is 2-12 characters: letters, digits, hyphen or underscore',
        'invalid');
    }
  }
  if (!patching || d.name !== undefined) {
    if (!d.name?.trim()) throw new ConfigError('a department needs a name', 'invalid');
  }
}

async function deptAudit(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  caller: Caller,
  action: string,
  code: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                            subject_table, detail)
     SELECT 'config', $2, $1, COALESCE(e.full_name, 'system'), 'department',
            $4::jsonb || jsonb_build_object('department', $3::text)
       FROM employee e WHERE e.id = $1`,
    [caller.employeeId, action, code, JSON.stringify(detail)]);
}

/**
 * Turn a business unit code into its id, for a department assignment.
 *
 * The caller has already separated the three cases before reaching here:
 * `undefined` means the request did not mention the assignment, `null` means
 * clear it, and a code means set it. This only handles the third.
 *
 * **An unknown code and another tenant's code give the same answer.** Under row
 * level security the other tenant's unit does not exist for this caller, so
 * there is nothing to distinguish — and saying anything more specific would
 * confirm that it exists somewhere.
 *
 * **An inactive unit is refused**, which is the convention locations and projects
 * already follow: an inactive row stays readable so older records resolve, and is
 * not offered for new work. A department already pointing at a unit that is later
 * deactivated keeps pointing at it — withdrawing a unit must not rewrite the
 * departments that named it while it was open.
 */
async function resolveBusinessUnit(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  code: string,
): Promise<string> {
  const key = code.trim().toUpperCase();
  const { rows } = await db.query(
    'SELECT id, active FROM business_unit WHERE code = $1', [key]);
  const unit = rows[0];
  if (!unit) throw new ConfigError(`no such business unit: ${key}`, 'invalid');
  if (!unit.active) {
    throw new ConfigError(
      `${key} is inactive and cannot be assigned — activate it first`, 'invalid');
  }
  return unit.id as string;
}

export async function createDepartment(
  caller: Caller,
  draft: DepartmentDraft,
): Promise<Department> {
  mayShape(caller, 'add');
  checkDepartment(draft, false);
  const code = draft.code.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const clash = await db.query('SELECT 1 FROM department WHERE code = $1', [code]);
    if (clash.rowCount) throw new ConfigError(`${code} is already a department`, 'conflict');

    /*
     * Absent and null both mean unassigned on a create — there is nothing to
     * leave alone yet. A code is resolved first, so an unknown or inactive unit
     * refuses the request before a department exists under it.
     */
    const unitId = draft.businessUnitCode
      ? await resolveBusinessUnit(db, draft.businessUnitCode)
      : null;

    const { rows } = await db.query(
      `INSERT INTO department (code, name, colour, head_employee_id, parent_id, active,
                               business_unit_id)
       VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
      [code, draft.name.trim(), draft.colour ?? null,
        draft.headId ?? null, draft.parentId ?? null, unitId]);

    await deptAudit(db, caller, 'department_created', code,
      { name: draft.name.trim(), businessUnit: draft.businessUnitCode ?? null });
    const back = await db.query(`${DEPT_COLUMNS} WHERE d.id = $1`, [rows[0]!.id]);
    return toDepartment(back.rows[0]!);
  });
}

export async function updateDepartment(
  caller: Caller,
  code: string,
  patch: Partial<DepartmentDraft> & { active?: boolean },
): Promise<Department> {
  mayShape(caller, 'change');
  checkDepartment(patch, true);

  return withTenant(caller, async (db) => {
    const { rows: [found] } = await db.query(
      `SELECT d.id, d.business_unit_id, b.code AS business_unit_code
         FROM department d
         LEFT JOIN business_unit b ON b.id = d.business_unit_id
        WHERE d.code = $1`, [code]);
    if (!found) throw new ConfigError('no such department', 'not_found');

    /*
     * A department cannot be its own parent, at any depth. Without this a
     * two-step cycle detaches a branch from the tree, and the org chart
     * recurses over it until it gives up.
     */
    if (patch.parentId) {
      if (patch.parentId === found.id) {
        throw new ConfigError('a department cannot report to itself', 'invalid');
      }
      const { rows: loop } = await db.query(
        `WITH RECURSIVE up AS (
           SELECT id, parent_id FROM department WHERE id = $1
           UNION ALL
           SELECT d.id, d.parent_id FROM department d JOIN up ON d.id = up.parent_id
         ) SELECT 1 FROM up WHERE parent_id = $2`, [patch.parentId, found.id]);
      if (loop.length) {
        throw new ConfigError('that would make the department report to itself', 'invalid');
      }
    }

    /*
     * Absent leaves the assignment alone, null clears it, a code sets it — the
     * same three-way the colour, head and parent above already use. Resolved
     * before the UPDATE, so an unknown or inactive unit refuses the whole patch
     * rather than applying the rest of it.
     */
    const touchUnit = patch.businessUnitCode !== undefined;
    /*
     * Re-sending the unit the department already has is allowed, even when that
     * unit has since been deactivated.
     *
     * The rule is that an inactive unit cannot be *newly* assigned — not that a
     * department naming one can never be edited again. Without this exception,
     * deactivating a unit would quietly make every department under it
     * unsaveable: the edit form sends the whole record, so renaming such a
     * department would be refused over a field nobody touched.
     */
    const sameAsNow = typeof patch.businessUnitCode === 'string'
      && patch.businessUnitCode.trim().toUpperCase() === found.business_unit_code;

    let unitId: string | null = null;
    if (touchUnit && patch.businessUnitCode !== null) {
      unitId = sameAsNow
        ? (found.business_unit_id as string)
        : await resolveBusinessUnit(db, patch.businessUnitCode as string);
    }

    await db.query(
      `UPDATE department
          SET name   = COALESCE($2, name),
              colour = CASE WHEN $5::boolean THEN $3 ELSE colour END,
              head_employee_id = CASE WHEN $6::boolean THEN $4 ELSE head_employee_id END,
              parent_id = CASE WHEN $8::boolean THEN $7 ELSE parent_id END,
              active = COALESCE($9, active),
              business_unit_id = CASE WHEN $11::boolean THEN $10 ELSE business_unit_id END
        WHERE id = $1`,
      [found.id, patch.name?.trim() ?? null, patch.colour ?? null, patch.headId ?? null,
        patch.colour !== undefined, patch.headId !== undefined,
        patch.parentId ?? null, patch.parentId !== undefined, patch.active ?? null,
        unitId, touchUnit]);

    await deptAudit(db, caller, 'department_updated', code, { ...patch });
    const back = await db.query(`${DEPT_COLUMNS} WHERE d.id = $1`, [found.id]);
    return toDepartment(back.rows[0]!);
  });
}

/**
 * Remove a department, but only when nothing depends on it.
 *
 * Ten tables carry a department reference and none of them cascade, so a
 * delete would either fail on a constraint deep inside the transaction or,
 * where the column is nullable, quietly strip the department off employment
 * records and requisitions that still mean it.
 *
 * The dependents are therefore counted first and the refusal names them. This
 * is what "semantically safe" comes to: a department nobody is in and nothing
 * points at is a typo worth removing; one with people in it is an
 * organisational change, and the way to record that is to move the people and
 * deactivate it, which is what `active` is for. The refusal says so rather
 * than leaving the administrator to guess.
 */
export async function removeDepartment(caller: Caller, code: string): Promise<Department> {
  mayShape(caller, 'remove');

  return withTenant(caller, async (db) => {
    const { rows: [found] } = await db.query(`${DEPT_COLUMNS} WHERE d.code = $1`, [code]);
    if (!found) throw new ConfigError('no such department', 'not_found');
    const dept = toDepartment(found);

    /* Every table that points at a department, counted in one round trip. */
    const { rows: [deps] } = await db.query(
      `SELECT
         (SELECT count(*)::int FROM employee            WHERE department_id = $1) AS employees,
         (SELECT count(*)::int FROM employment_record   WHERE department_id = $1) AS history_records,
         (SELECT count(*)::int FROM job_title           WHERE department_id = $1) AS job_titles,
         (SELECT count(*)::int FROM requisition         WHERE department_id = $1) AS requisitions,
         (SELECT count(*)::int FROM onboarding_journey  WHERE department_id = $1) AS onboarding_journeys,
         (SELECT count(*)::int FROM joining_request     WHERE department_id = $1) AS joining_requests,
         (SELECT count(*)::int FROM announcement        WHERE department_id = $1) AS announcements,
         (SELECT count(*)::int FROM ticket_category     WHERE owning_department_id = $1) AS ticket_queues,
         (SELECT count(*)::int FROM survey_response     WHERE department_id = $1) AS survey_responses,
         (SELECT count(*)::int FROM department          WHERE parent_id = $1) AS child_departments`,
      [dept.id]);

    const blocking = Object.entries(deps as Record<string, number>)
      .filter(([, n]) => Number(n) > 0)
      .map(([what, n]) => `${n} ${what.replace(/_/g, ' ')}`);

    if (blocking.length) {
      throw new ConfigError(
        `${code} still has ${blocking.join(', ')}. Move them first, or deactivate the `
        + 'department instead of removing it, which keeps its history readable.',
        'conflict');
    }

    await db.query('DELETE FROM department WHERE id = $1', [dept.id]);
    await deptAudit(db, caller, 'department_removed', code, { name: dept.name });
    return dept;
  });
}

/* ------------------------------------------------------------------ *
 * Grade bands
 * ------------------------------------------------------------------ */

/**
 * The company's grade ladder.
 *
 * Read-only, and it exists because the promotion form needs the real bands.
 * The frontend has a `GRADES` constant in `src/data/org.ts` that was the only
 * source until now, and it had already drifted: it puts L4 at a maximum of
 * 3,400,000 where the database says 3,500,000, and L6 at 9,000,000 against
 * 12,000,000. Offering those on a form that then posts a grade *code* would
 * show the wrong band and, for a company that had renamed one, offer a code
 * the server would refuse.
 *
 * Everyone may read it. A band is not confidential — it is on the job advert —
 * and the employee's own profile already shows which one they are on.
 */
export interface GradeBand {
  code: string;
  label: string;
  rank: number;
  minCtc: number | null;
  maxCtc: number | null;
}

export async function listGrades(caller: Caller): Promise<GradeBand[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT code, label, rank, min_ctc, max_ctc
         FROM grade_band ORDER BY rank, code`);
    return rows.map((r) => ({
      code: r.code as string,
      label: r.label as string,
      rank: Number(r.rank),
      minCtc: r.min_ctc === null ? null : Number(r.min_ctc),
      maxCtc: r.max_ctc === null ? null : Number(r.max_ctc),
    }));
  });
}

/* ============================================================
   Business units
   ============================================================ */

/**
 * A P&L or operating division — the level above a department.
 *
 * Keyed by `code` on the wire, as sites and departments are, because that is
 * what an administrator quotes and what a URL can carry. The uuid stays
 * server-side.
 */
export interface BusinessUnit {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessUnitDraft {
  code?: string;
  name?: string;
  description?: string | null;
}

const BU_COLUMNS = `
  SELECT b.id, b.code, b.name, b.description, b.active,
         b.created_at, b.updated_at
    FROM business_unit b`;

const toBusinessUnit = (r: Record<string, unknown>): BusinessUnit => ({
  /*
   * `id` is the code, matching Site and Department: the screens key rows by it
   * and the uuid is of no use to them.
   */
  id: r.code as string,
  code: r.code as string,
  name: r.name as string,
  description: (r.description as string | null) ?? null,
  active: Boolean(r.active),
  createdAt: new Date(r.created_at as string).toISOString(),
  updatedAt: new Date(r.updated_at as string).toISOString(),
});

/** Shaping the organisation is an administrator's, as the rest of settings is. */
function mayShapeUnit(caller: Caller, verb: string): void {
  if (caller.role !== 'admin') {
    throw new ConfigError(`only an admin may ${verb} a business unit`, 'forbidden');
  }
}

/**
 * Two to sixteen characters, upper case, letters, digits and hyphens.
 *
 * The same shape is a CHECK constraint on the table, so a code this accepts and
 * the database refuses cannot exist. Narrow because it is quoted aloud and typed
 * into forms.
 */
const BU_CODE = /^[A-Z0-9][A-Z0-9-]{1,15}$/;

function checkUnit(d: BusinessUnitDraft, patching: boolean): {
  code: string | null;
  name: string;
  description: string | null;
} {
  let code: string | null = null;
  if (!patching) {
    if (!d.code?.trim()) throw new ConfigError('a business unit needs a code', 'invalid');
    code = d.code.trim().toUpperCase();
    if (!BU_CODE.test(code)) {
      throw new ConfigError(
        'a code is 2-16 letters, digits or hyphens, such as RETAIL or BU-01', 'invalid');
    }
  } else if (d.code !== undefined) {
    /*
     * Refused rather than ignored. The code is the identity every other screen
     * and URL uses, so silently dropping a rename would leave the caller
     * believing it had happened.
     */
    throw new ConfigError(
      'a code cannot be changed - create a unit under the new code instead', 'invalid');
  }

  if (!d.name?.trim()) throw new ConfigError('a business unit needs a name', 'invalid');
  if (d.name.trim().length > 120) {
    throw new ConfigError('a name is at most 120 characters', 'invalid');
  }

  const description = d.description?.trim() ? d.description.trim() : null;
  if (description && description.length > 500) {
    throw new ConfigError('a description is at most 500 characters', 'invalid');
  }

  return { code, name: d.name.trim(), description };
}

/** One audit row per business-unit write, with the actor's name resolved. */
async function unitAudit(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  caller: Caller,
  action: string,
  code: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                            subject_table, detail)
     SELECT 'config', $2, $1, COALESCE(e.full_name, 'system'), 'business_unit',
            $4::jsonb || jsonb_build_object('businessUnit', $3::text)
       FROM employee e WHERE e.id = $1`,
    [caller.employeeId, action, code, JSON.stringify(detail)]);
}

/**
 * Every business unit, inactive ones included.
 *
 * Readable by any role. A unit's name is not sensitive, and a screen showing
 * which one a person belongs to has to resolve the code to something better than
 * a dash. Inactive units come back because an older record may still name one;
 * `active` says which may be chosen, and the forms offer only those.
 */
export async function listBusinessUnits(caller: Caller): Promise<BusinessUnit[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${BU_COLUMNS} ORDER BY b.active DESC, b.name`);
    return rows.map(toBusinessUnit);
  });
}

/** One unit by code, or null. Readable by any role, for the same reason. */
export async function getBusinessUnit(
  caller: Caller,
  code: string,
): Promise<BusinessUnit | null> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${BU_COLUMNS} WHERE b.code = $1`, [code.trim().toUpperCase()]);
    return rows[0] ? toBusinessUnit(rows[0]) : null;
  });
}

export async function createBusinessUnit(
  caller: Caller,
  draft: BusinessUnitDraft,
): Promise<BusinessUnit> {
  mayShapeUnit(caller, 'add');
  const v = checkUnit(draft, false);
  const code = v.code!;

  return withTenant(caller, async (db) => {
    const clash = await db.query('SELECT 1 FROM business_unit WHERE code = $1', [code]);
    if (clash.rowCount) {
      throw new ConfigError(`${code} is already a business unit`, 'conflict');
    }
    /*
     * A duplicate name is refused as well. The unique is on the code, so two
     * units called the same thing is not a database error — it is
     * indistinguishable on screen, which makes it a data-entry mistake worth
     * catching. Compared case-insensitively, because Retail and retail are the
     * same name to a reader.
     */
    const sameName = await db.query(
      'SELECT code FROM business_unit WHERE lower(name) = lower($1)', [v.name]);
    if (sameName.rowCount) {
      throw new ConfigError(
        `${sameName.rows[0]!.code} is already called ${v.name}`, 'conflict');
    }

    await db.query(
      `INSERT INTO business_unit (code, name, description, active)
       VALUES ($1, $2, $3, true)`,
      [code, v.name, v.description]);

    await unitAudit(db, caller, 'business_unit_created', code,
      { name: v.name, description: v.description });

    const back = await db.query(`${BU_COLUMNS} WHERE b.code = $1`, [code]);
    return toBusinessUnit(back.rows[0]!);
  });
}

/**
 * Change a unit's name or description.
 *
 * Not its code, and not its active flag: the code is the identity, and
 * activation is its own call so that renaming and withdrawing from use cannot be
 * confused in one request.
 */
export async function updateBusinessUnit(
  caller: Caller,
  code: string,
  patch: BusinessUnitDraft,
): Promise<BusinessUnit> {
  mayShapeUnit(caller, 'change');
  const v = checkUnit(patch, true);
  const key = code.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const sameName = await db.query(
      'SELECT code FROM business_unit WHERE lower(name) = lower($1) AND code <> $2',
      [v.name, key]);
    if (sameName.rowCount) {
      throw new ConfigError(
        `${sameName.rows[0]!.code} is already called ${v.name}`, 'conflict');
    }

    const updated = await db.query(
      `UPDATE business_unit
          SET name = $2, description = $3, updated_at = now()
        WHERE code = $1`,
      [key, v.name, v.description]);
    if (updated.rowCount === 0) throw new ConfigError('no such business unit', 'not_found');

    await unitAudit(db, caller, 'business_unit_updated', key,
      { name: v.name, description: v.description });

    const back = await db.query(`${BU_COLUMNS} WHERE b.code = $1`, [key]);
    return toBusinessUnit(back.rows[0]!);
  });
}

/**
 * Activate or deactivate a unit.
 *
 * There is no delete. A unit that stops trading still appears on everything
 * recorded while it did, so `active = false` withdraws it from the forms and
 * leaves the history legible — the same rule sites and departments follow.
 */
export async function setBusinessUnitActive(
  caller: Caller,
  code: string,
  active: boolean,
): Promise<BusinessUnit> {
  mayShapeUnit(caller, 'activate or deactivate');
  if (typeof active !== 'boolean') {
    throw new ConfigError('a business unit is either active or inactive', 'invalid');
  }
  const key = code.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const updated = await db.query(
      'UPDATE business_unit SET active = $2, updated_at = now() WHERE code = $1',
      [key, active]);
    if (updated.rowCount === 0) throw new ConfigError('no such business unit', 'not_found');

    await unitAudit(db, caller,
      active ? 'business_unit_activated' : 'business_unit_deactivated', key, { active });

    const back = await db.query(`${BU_COLUMNS} WHERE b.code = $1`, [key]);
    return toBusinessUnit(back.rows[0]!);
  });
}

/* ------------------------------------------------------------------ *
 * Legal entities
 *
 * The registered company a person is employed by, and the one that files for
 * them. `legal_entity` has existed since 0002 and three tables have carried a
 * NOT NULL reference to it ever since — `employee`, `pay_run` and
 * `compliance_payment` — but nothing in the product could create, read or edit
 * one. Only `scripts/seed.mjs` could, which meant a tenant onboarded any other
 * way could not run payroll, submit an expense or create an employee: three
 * services refuse outright with 'no default legal entity configured', and the
 * product offered no way to fix that.
 *
 * So this is CRUD over columns that already exist. No migration: every field
 * below is a column 0002 created, and the one rule the schema does not hold —
 * exactly one default per tenant — is held here, the same way `site` holds
 * exactly one head office.
 *
 * **It is deliberately not the top of the organisation chart.** Nothing points
 * at a legal entity except an employee and the two payroll tables; a business
 * unit does not and must not. The entity answers "which registered company, and
 * therefore whose statutory rules", and every existing read of it wants
 * `country` or `currency`. A department's P&L is a different dimension, which is
 * why `business_unit` and `legal_entity` are siblings under the tenant.
 * ------------------------------------------------------------------ */

/**
 * A legal entity, keyed by code as `Site` and `Department` are.
 *
 * `code` is what an administrator quotes and what a URL carries; the uuid stays
 * on the server. Every optional identifier is carried as `null` rather than an
 * empty string, because "not recorded" and "recorded as blank" are different
 * things on a statutory filing.
 */
export interface LegalEntity {
  code: string;
  legalName: string;
  /** ISO 3166-1 alpha-2. Drives which statutory rules apply to its people. */
  country: string;
  /** ISO 4217. The currency its payroll is denominated in. */
  currency: string;
  registeredAddress: string | null;
  taxId: string | null;
  registrationId: string | null;
  pfCode: string | null;
  esiCode: string | null;
  /** The one the product falls back to when nothing names an entity. */
  isDefault: boolean;
  /** Employees currently employed by it. What makes a change consequential. */
  headcount: number;
}

export interface LegalEntityDraft {
  code?: string;
  legalName?: string;
  country?: string;
  currency?: string;
  registeredAddress?: string | null;
  taxId?: string | null;
  registrationId?: string | null;
  pfCode?: string | null;
  esiCode?: string | null;
}

/*
 * Every column a LegalEntity is built from, in one place — the lesson
 * SITE_COLUMNS records, where hand-written copies drifted and a read came back
 * missing the headquarters flag.
 *
 * `country` and `currency` are char(2) and char(3) and the foreign keys to
 * `country` and `currency` guarantee a value of exactly that width, so there is
 * no padding to strip — they come back as the codes they are.
 */
const LE_COLUMNS = `
  SELECT l.code, l.legal_name, l.country, l.currency,
         l.registered_address, l.tax_id, l.registration_id, l.pf_code, l.esi_code,
         l.is_default,
         (SELECT count(*)::int FROM employee e
           WHERE e.legal_entity_id = l.id AND e.status <> 'exited') AS headcount
    FROM legal_entity l`;

const toLegalEntity = (r: Record<string, unknown>): LegalEntity => ({
  code: r.code as string,
  legalName: r.legal_name as string,
  country: r.country as string,
  currency: r.currency as string,
  registeredAddress: (r.registered_address as string | null) ?? null,
  taxId: (r.tax_id as string | null) ?? null,
  registrationId: (r.registration_id as string | null) ?? null,
  pfCode: (r.pf_code as string | null) ?? null,
  esiCode: (r.esi_code as string | null) ?? null,
  isDefault: Boolean(r.is_default),
  headcount: Number(r.headcount),
});

/** Same code shape as a location: `IN01` and `BLR` are both 2–10 of these. */
const LE_CODE = /^[A-Z0-9]{2,10}$/;

/** Configuring the tenant is an administrator's, as the rest of settings is. */
function mayShapeEntity(caller: Caller, verb: string): void {
  if (caller.role !== 'admin') {
    throw new ConfigError(`only an admin may ${verb} a legal entity`, 'forbidden');
  }
}

/**
 * Normalise and refuse what the schema cannot see.
 *
 * `legal_entity` carries no CHECK constraints at all, so unlike a business unit
 * there is no second line of defence here: a blank name or a three-letter
 * country reaches the column unchallenged. The country and currency references
 * are real foreign keys, but a violation arrives as 23503 and reads as "this
 * request refers to something that does not exist" — true, and useless. These
 * say which field and what was expected.
 */
function checkEntity(d: LegalEntityDraft, partial: boolean): void {
  const need = (v: unknown) => typeof v === 'string' && v.trim() !== '';

  if (!partial) {
    if (!need(d.code)) throw new ConfigError('a legal entity needs a code', 'invalid');
    if (!LE_CODE.test(d.code!.trim().toUpperCase())) {
      throw new ConfigError(
        'a legal entity code is 2-10 letters or digits, such as IN01', 'invalid');
    }
    if (!need(d.legalName)) {
      throw new ConfigError('a legal entity needs its registered name', 'invalid');
    }
    if (!need(d.country)) throw new ConfigError('a legal entity needs a country', 'invalid');
    if (!need(d.currency)) throw new ConfigError('a legal entity needs a currency', 'invalid');
  }
  /* On a patch each field is only checked when it is actually being set. */
  if (d.legalName !== undefined && !need(d.legalName)) {
    throw new ConfigError('a legal entity needs its registered name', 'invalid');
  }
  if (d.country !== undefined && !/^[A-Z]{2}$/.test(String(d.country).trim().toUpperCase())) {
    throw new ConfigError('a country is a two-letter code, such as IN', 'invalid');
  }
  if (d.currency !== undefined && !/^[A-Z]{3}$/.test(String(d.currency).trim().toUpperCase())) {
    throw new ConfigError('a currency is a three-letter code, such as INR', 'invalid');
  }
}

/** An optional identifier: absent leaves it, blank clears it, text records it. */
const optional = (v: string | null | undefined): string | null =>
  v === undefined || v === null ? null : (v.trim() || null);

async function entityAudit(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  caller: Caller,
  action: string,
  code: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                            subject_table, detail)
     SELECT 'config', $2, $1, COALESCE(e.full_name, 'system'), 'legal_entity',
            $4::jsonb || jsonb_build_object('legalEntity', $3::text)
       FROM employee e WHERE e.id = $1`,
    [caller.employeeId, action, code, JSON.stringify(detail)]);
}

/**
 * Make this entity the default, and no other.
 *
 * `site` has `site_one_headquarters` to refuse two head offices; `legal_entity`
 * has no such index, so this transaction is the only thing holding the rule.
 * Demotion comes first and promotion second, both inside the caller's
 * transaction, so there is no moment at which a reader could see two defaults or
 * none — and a failure after this point leaves the tenant with the default it
 * started with.
 *
 * Two concurrent switches are safe without the index: the demotion locks every
 * currently-default row, so the second transaction waits, then re-reads and
 * demotes the first one's winner. They serialise on the row rather than racing.
 */
async function nominateDefault(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  code: string,
): Promise<void> {
  await db.query(
    'UPDATE legal_entity SET is_default = false WHERE is_default AND code <> $1', [code]);
  await db.query(
    'UPDATE legal_entity SET is_default = true WHERE code = $1', [code]);
}

/**
 * Every legal entity, the default first.
 *
 * Readable by every role, as the rest of configuration is: a payslip, a letter
 * and an employee record all show which company employs somebody, and resolving
 * that is not privileged. Only the writes below are an administrator's.
 */
export async function listLegalEntities(caller: Caller): Promise<LegalEntity[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${LE_COLUMNS} ORDER BY l.is_default DESC, l.code`);
    return rows.map(toLegalEntity);
  });
}

export async function getLegalEntity(caller: Caller, code: string): Promise<LegalEntity> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${LE_COLUMNS} WHERE l.code = $1`, [code.trim().toUpperCase()]);
    if (!rows[0]) throw new ConfigError('no such legal entity', 'not_found');
    return toLegalEntity(rows[0]);
  });
}

/**
 * Register a legal entity.
 *
 * **The first one in a tenant becomes the default.** That is not a new rule
 * invented here: `payroll`, `expenses` and `people/provision` each refuse to
 * work with 'no default legal entity configured', and `seed.mjs` has always
 * written `is_default = true` on the entity it creates. Creating the first entity
 * without defaulting it would leave a tenant able to hold an entity and still
 * unable to run payroll — a regression against behaviour that already exists.
 */
export async function createLegalEntity(
  caller: Caller,
  draft: LegalEntityDraft,
): Promise<LegalEntity> {
  mayShapeEntity(caller, 'add');
  checkEntity(draft, false);

  const code = draft.code!.trim().toUpperCase();
  const country = draft.country!.trim().toUpperCase();
  const currency = draft.currency!.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const clash = await db.query('SELECT 1 FROM legal_entity WHERE code = $1', [code]);
    if (clash.rowCount) {
      throw new ConfigError(`${code} is already a legal entity`, 'conflict');
    }

    /* Counted inside the transaction, so two concurrent firsts cannot both win. */
    const { rows: [existing] } = await db.query(
      'SELECT count(*)::int AS n FROM legal_entity');
    const first = Number(existing!.n) === 0;

    await db.query(
      `INSERT INTO legal_entity (code, legal_name, country, currency, registered_address,
                                 tax_id, registration_id, pf_code, esi_code, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [code, draft.legalName!.trim(), country, currency,
        optional(draft.registeredAddress), optional(draft.taxId),
        optional(draft.registrationId), optional(draft.pfCode), optional(draft.esiCode),
        first]);

    await entityAudit(db, caller, 'legal_entity_created', code,
      { legalName: draft.legalName!.trim(), country, currency, isDefault: first });

    const { rows } = await db.query(`${LE_COLUMNS} WHERE l.code = $1`, [code]);
    return toLegalEntity(rows[0]!);
  });
}

/**
 * Change a legal entity.
 *
 * The code cannot move. Three tables carry a NOT NULL reference to the row and
 * the code is what an administrator quotes, so renaming is what `legalName` is
 * for — and a code change is refused rather than ignored, because silently
 * dropping it would tell the caller the rename succeeded.
 *
 * `is_default` is not settable here. Moving the default is a different act from
 * correcting an address, and it has its own call for the same reason
 * `/config/sites/:code/active` is separate from editing a site.
 */
export async function updateLegalEntity(
  caller: Caller,
  code: string,
  patch: LegalEntityDraft,
): Promise<LegalEntity> {
  mayShapeEntity(caller, 'change');
  checkEntity(patch, true);

  const key = code.trim().toUpperCase();
  if (patch.code !== undefined && patch.code.trim().toUpperCase() !== key) {
    throw new ConfigError(
      'a legal entity code cannot change — every employee and pay run joins on it',
      'invalid');
  }

  return withTenant(caller, async (db) => {
    const { rows: [found] } = await db.query(
      'SELECT id FROM legal_entity WHERE code = $1', [key]);
    if (!found) throw new ConfigError('no such legal entity', 'not_found');

    /*
     * Absent leaves a field alone; present replaces it. The same three-way the
     * rest of this module uses, expressed with a boolean flag per column so a
     * null can mean "clear this identifier" rather than "do not touch it".
     */
    await db.query(
      `UPDATE legal_entity
          SET legal_name = COALESCE($2, legal_name),
              country  = COALESCE($3, country),
              currency = COALESCE($4, currency),
              registered_address = CASE WHEN $6::boolean THEN $5 ELSE registered_address END,
              tax_id          = CASE WHEN $8::boolean  THEN $7  ELSE tax_id END,
              registration_id = CASE WHEN $10::boolean THEN $9  ELSE registration_id END,
              pf_code         = CASE WHEN $12::boolean THEN $11 ELSE pf_code END,
              esi_code        = CASE WHEN $14::boolean THEN $13 ELSE esi_code END
        WHERE id = $1`,
      [found.id,
        patch.legalName?.trim() ?? null,
        patch.country?.trim().toUpperCase() ?? null,
        patch.currency?.trim().toUpperCase() ?? null,
        optional(patch.registeredAddress), patch.registeredAddress !== undefined,
        optional(patch.taxId), patch.taxId !== undefined,
        optional(patch.registrationId), patch.registrationId !== undefined,
        optional(patch.pfCode), patch.pfCode !== undefined,
        optional(patch.esiCode), patch.esiCode !== undefined]);

    await entityAudit(db, caller, 'legal_entity_updated', key, { ...patch });

    const { rows } = await db.query(`${LE_COLUMNS} WHERE l.code = $1`, [key]);
    return toLegalEntity(rows[0]!);
  });
}

/**
 * Move the default to this entity.
 *
 * There is no way to clear the default to none, and that is the point: payroll,
 * expenses and employee provisioning each stop working without one. The default
 * moves, it does not toggle.
 */
export async function setDefaultLegalEntity(
  caller: Caller,
  code: string,
): Promise<LegalEntity> {
  mayShapeEntity(caller, 'change the default for');

  const key = code.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const { rows: [found] } = await db.query(
      'SELECT is_default FROM legal_entity WHERE code = $1', [key]);
    if (!found) throw new ConfigError('no such legal entity', 'not_found');

    if (!found.is_default) {
      await nominateDefault(db, key);
      await entityAudit(db, caller, 'legal_entity_default_changed', key, { isDefault: true });
    }

    const { rows } = await db.query(`${LE_COLUMNS} WHERE l.code = $1`, [key]);
    return toLegalEntity(rows[0]!);
  });
}

/* ------------------------------------------------------------------ *
 * The tenant's own profile
 *
 * `tenant` is the tenancy root. It is in `check-schema`'s GLOBAL_TABLES, has no
 * row level security, and 0010 granted `app_rw` SELECT on it and nothing else —
 * alongside `country`, `currency` and `fx_rate`. Nothing has written to it in
 * fifty-three migrations outside the seed.
 *
 * **Because RLS is off here, the `WHERE id = current_tenant_id()` below is not
 * belt-and-braces — it is the only thing scoping these statements.** Everywhere
 * else in this module the policy would still refuse a row from another tenant if
 * the predicate were dropped. Not here. That is why the tenant id is never taken
 * from a caller-supplied value, and why the update names its one column instead
 * of spreading a patch.
 *
 * Migration 0053 grants UPDATE on `display_name` and no other column, so the
 * dangerous ones are unreachable in the database rather than by convention: if
 * this code were ever wrong about which column it writes, PostgreSQL refuses the
 * statement. Read-only here means read-only there.
 * ------------------------------------------------------------------ */

/**
 * What the product knows about the tenant it is running for.
 *
 * Every field is read-only except `displayName`. They are returned together
 * because the Company Profile screen shows them together, and showing them is
 * the point: an administrator should be able to see the fiscal year and the data
 * region their contract commits them to without being offered a control that
 * would be refused.
 */
export interface TenantProfile {
  /** The trading name. The one field an administrator may change. */
  displayName: string;
  /** Read-only. The registered name lives on `legal_entity` as well — see 2e. */
  legalName: string;
  /** Read-only. The URL identity, and how a login finds its tenant. */
  slug: string;
  /** Read-only. 'trial' | 'active' | 'suspended' | 'closed'. */
  status: string;
  /** Read-only. Statutory defaults follow it. */
  homeCountry: string;
  /** Read-only. Several modules store amounts that assume it. */
  baseCurrency: string;
  /** Read-only. 1-12. Decides which leave year a quota change reprices. */
  fiscalYearStartMonth: number;
  /** Read-only. A residency commitment in a customer contract. */
  dataRegion: string;
  createdAt: string;
}

/** The only mutable field, named rather than spread. */
export interface TenantProfileDraft {
  displayName: string;
}

const TENANT_COLUMNS = `
  SELECT t.display_name, t.legal_name, t.slug::text AS slug, t.status,
         t.home_country, t.base_currency, t.fiscal_year_start_month,
         t.data_region, t.created_at
    FROM tenant t`;

const toTenantProfile = (r: Record<string, unknown>): TenantProfile => ({
  displayName: r.display_name as string,
  legalName: r.legal_name as string,
  slug: r.slug as string,
  status: r.status as string,
  homeCountry: r.home_country as string,
  baseCurrency: r.base_currency as string,
  fiscalYearStartMonth: Number(r.fiscal_year_start_month),
  dataRegion: r.data_region as string,
  createdAt: (r.created_at as Date).toISOString(),
});

/**
 * The tenant this request is for.
 *
 * Readable by every role, as the rest of configuration is — the product shows
 * the company's name in its header, and resolving that is not privileged. The
 * route is still only reachable by an administrator, because the whole settings
 * module is; this says nothing about that, it just does not add a second rule.
 */
export async function readTenantProfile(caller: Caller): Promise<TenantProfile> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${TENANT_COLUMNS} WHERE t.id = current_tenant_id()`);
    /* Unreachable in practice: current_tenant_id() raises before this. */
    if (!rows[0]) throw new ConfigError('no tenant in context', 'not_found');
    return toTenantProfile(rows[0]);
  });
}

/**
 * Rename what the company calls itself.
 *
 * Only `display_name`, and only by name: there is no patch object to spread and
 * no column list built from a request body, because the one place a mass
 * assignment could reach the tenancy root is exactly the place not to allow one.
 * 0053's column grant means the database agrees.
 *
 * 120 characters is the convention this module already uses for a name — see
 * `checkBusinessUnit`.
 */
export async function updateTenantDisplayName(
  caller: Caller,
  displayName: unknown,
): Promise<TenantProfile> {
  if (caller.role !== 'admin') {
    throw new ConfigError('only an admin may rename the company', 'forbidden');
  }
  if (typeof displayName !== 'string' || !displayName.trim()) {
    throw new ConfigError('the company needs a name', 'invalid');
  }
  /*
   * Trimmed, not rejected for having spaces, and not otherwise normalised: a
   * company name is a proper noun. Unicode, punctuation and case are the
   * customer's to decide, and `text` stores them all — so the only thing taken
   * off is the whitespace a form adds.
   */
  const name = displayName.trim();
  if (name.length > 120) {
    throw new ConfigError('a name is at most 120 characters', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const updated = await db.query(
      'UPDATE tenant SET display_name = $1 WHERE id = current_tenant_id()', [name]);
    if (updated.rowCount === 0) throw new ConfigError('no tenant in context', 'not_found');

    await db.query(
      `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                              subject_table, detail)
       SELECT 'config', 'tenant_display_name_updated', $1,
              COALESCE(e.full_name, 'system'), 'tenant',
              jsonb_build_object('displayName', $2::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, name]);

    const { rows } = await db.query(
      `${TENANT_COLUMNS} WHERE t.id = current_tenant_id()`);
    return toTenantProfile(rows[0]!);
  });
}
