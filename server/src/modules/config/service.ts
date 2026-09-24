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
}

export interface DepartmentDraft {
  code: string;
  name: string;
  colour?: string | null;
  headId?: string | null;
  parentId?: string | null;
}

const DEPT_COLUMNS = `
  SELECT d.id, d.code, d.name, d.colour, d.head_employee_id, d.parent_id, d.active,
         COALESCE(h.full_name, '') AS head_name,
         (SELECT count(*)::int FROM employee e
           WHERE e.department_id = d.id AND e.status <> 'exited') AS headcount
    FROM department d
    LEFT JOIN employee h ON h.id = d.head_employee_id`;

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

    const { rows } = await db.query(
      `INSERT INTO department (code, name, colour, head_employee_id, parent_id, active)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [code, draft.name.trim(), draft.colour ?? null,
        draft.headId ?? null, draft.parentId ?? null]);

    await deptAudit(db, caller, 'department_created', code, { name: draft.name.trim() });
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
      'SELECT id FROM department WHERE code = $1', [code]);
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

    await db.query(
      `UPDATE department
          SET name   = COALESCE($2, name),
              colour = CASE WHEN $5::boolean THEN $3 ELSE colour END,
              head_employee_id = CASE WHEN $6::boolean THEN $4 ELSE head_employee_id END,
              parent_id = CASE WHEN $8::boolean THEN $7 ELSE parent_id END,
              active = COALESCE($9, active)
        WHERE id = $1`,
      [found.id, patch.name?.trim() ?? null, patch.colour ?? null, patch.headId ?? null,
        patch.colour !== undefined, patch.headId !== undefined,
        patch.parentId ?? null, patch.parentId !== undefined, patch.active ?? null]);

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
