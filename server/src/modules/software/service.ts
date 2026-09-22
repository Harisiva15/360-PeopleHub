/**
 * The software estate.
 *
 * Every figure the screen reads is derived in the query — seats assigned,
 * dormant seats, idle spend, whether the product is over-allocated. None of
 * them is stored, because all of them move when somebody opens a tool or
 * leaves the company, and a stored count is only ever right on the day it was
 * written.
 *
 * Two rules the service holds that SQL cannot:
 *
 * Seats cannot be cut below the people already holding one. The database will
 * let you write the smaller number; what it cannot know is that doing so
 * leaves somebody with a seat the company is not paying for.
 *
 * A seat the asset register issued is returned in the asset register. Revoking
 * only this copy would leave the two registers disagreeing about who has what,
 * which is the exact failure the `asset_id` column exists to prevent.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class SoftwareError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SoftwareError';
    this.code = code;
  }
}

/** A seat nobody has touched for this long is the one worth reclaiming. */
const DORMANT_DAYS = 60;
/** A renewal this close is one you can still decide about. */
const RENEWAL_WINDOW = 90;

export interface SoftwareProduct {
  id: string; n: string; vendor: string; cat: string; plan: string;
  seats: number; unitCost: number; billing: string; renewsOn: string;
  ownerId: string | null; status: string; sso: boolean;
  holdsPersonalData: boolean; notes: string;
}

export interface SoftwareRow {
  product: SoftwareProduct;
  assigned: number; free: number; dormant: number;
  annualCost: number; wastedCost: number;
  renewsInDays: number; overAllocated: boolean;
}

export interface SoftwareFilter {
  q?: string | undefined; cat?: string | undefined; vendor?: string | undefined;
  status?: string | undefined; ownerId?: string | undefined;
  renewingWithin?: number | undefined; hasDormant?: boolean | undefined;
}

export interface SoftwareDraft {
  n: string; vendor: string; cat: string; plan?: string | undefined;
  seats: number; unitCost: number; billing?: string | undefined;
  renewsOn: string; ownerId?: string | null | undefined; status?: string | undefined;
  sso?: boolean | undefined; holdsPersonalData?: boolean | undefined;
  notes?: string | undefined;
}

interface Row {
  id: string; name: string; vendor: string; category: string; plan: string;
  seats: number; unit_cost_pa: string; billing: string; renews_on: string;
  owner_id: string | null; status: string; sso: boolean;
  holds_personal_data: boolean; notes: string;
  assigned: string; dormant: string; renews_in: string;
}

/*
 * One query, one pass. The seat counts come from a lateral rather than two
 * correlated subqueries so the table is touched once — an estate of twenty
 * products with nine hundred seats should not be twenty-one queries.
 */
const PROJECTION = `
  SELECT p.id, p.name, p.vendor, p.category, p.plan, p.seats,
         p.unit_cost_pa::text, p.billing, p.renews_on::text, p.owner_id,
         p.status, p.sso, p.holds_personal_data, p.notes,
         c.assigned::text, c.dormant::text,
         (p.renews_on - CURRENT_DATE)::text AS renews_in
    FROM software_product p
    LEFT JOIN LATERAL (
      SELECT count(*) AS assigned,
             count(*) FILTER (
               WHERE s.last_used_on IS NULL
                  OR s.last_used_on <= CURRENT_DATE - ${DORMANT_DAYS}
             ) AS dormant
        FROM software_seat s WHERE s.product_id = p.id
    ) c ON TRUE`;

function toRow(r: Row): SoftwareRow {
  const assigned = Number(r.assigned);
  const dormant = Number(r.dormant);
  const unit = Number(r.unit_cost_pa);
  /*
   * Idle spend is the unassigned seats plus the assigned ones nobody opens.
   * Separating them would invite the reading that one of the two is free.
   */
  const idle = Math.max(0, r.seats - assigned) + dormant;
  return {
    product: {
      id: r.id, n: r.name, vendor: r.vendor, cat: r.category, plan: r.plan,
      seats: r.seats, unitCost: unit, billing: r.billing, renewsOn: r.renews_on,
      ownerId: r.owner_id, status: r.status, sso: r.sso,
      holdsPersonalData: r.holds_personal_data, notes: r.notes,
    },
    assigned,
    free: Math.max(0, r.seats - assigned),
    dormant,
    annualCost: r.seats * unit,
    wastedCost: idle * unit,
    renewsInDays: Number(r.renews_in),
    overAllocated: assigned > r.seats,
  };
}

const mayBrowse = (caller: Caller) => {
  if (caller.role === 'employee') {
    throw new SoftwareError('Your role cannot browse the software estate', 'forbidden');
  }
};

const mayWrite = (caller: Caller) => {
  if (caller.role !== 'admin') {
    throw new SoftwareError('Only an administrator can change the estate', 'forbidden');
  }
};

export async function listSoftware(
  caller: Caller,
  f: SoftwareFilter = {},
): Promise<SoftwareRow[]> {
  mayBrowse(caller);
  const params: unknown[] = [];
  const where: string[] = [];
  const outer: string[] = [];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (f.cat) where.push(`p.category = ${bind(f.cat)}`);
  if (f.vendor) where.push(`p.vendor = ${bind(f.vendor)}`);
  if (f.status) where.push(`p.status = ${bind(f.status)}`);
  if (f.ownerId) where.push(`p.owner_id = ${bind(f.ownerId)}`);
  if (f.renewingWithin != null) {
    where.push(`p.renews_on BETWEEN CURRENT_DATE AND CURRENT_DATE + ${bind(f.renewingWithin)}::int`);
  }
  if (f.q?.trim()) {
    const p = bind(`%${f.q.trim()}%`);
    where.push(`(p.name ILIKE ${p} OR p.vendor ILIKE ${p} OR p.plan ILIKE ${p})`);
  }
  if (f.hasDormant) outer.push('dormant::int > 0');

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(
      `SELECT * FROM (${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}) q
       ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
       ORDER BY seats * unit_cost_pa::numeric DESC`,
      params,
    );
    return rows.map(toRow);
  });
}

export interface SoftwareSeatRow {
  seat: { id: string; productId: string; empId: string; assignedOn: string;
    lastUsedOn: string | null; assetId: string | null };
  name: string; dept: string; dormant: boolean; daysIdle: number | null;
}

export interface SoftwareDetail extends SoftwareRow {
  seats: SoftwareSeatRow[];
  history: unknown[];
}

export async function getSoftware(caller: Caller, id: string): Promise<SoftwareDetail | null> {
  mayBrowse(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(`${PROJECTION} WHERE p.id = $1`, [id]);
    if (!rows[0]) return null;

    const { rows: seats } = await db.query<{
      id: string; product_id: string; employee_id: string; assigned_on: string;
      last_used_on: string | null; asset_id: string | null;
      name: string; dept_code: string | null; days_idle: string | null;
    }>(
      `SELECT s.id, s.product_id, s.employee_id, s.assigned_on::text,
              s.last_used_on::text, s.asset_id,
              e.full_name AS name, d.code AS dept_code,
              (CURRENT_DATE - s.last_used_on)::text AS days_idle
         FROM software_seat s
         JOIN employee e ON e.id = s.employee_id
         LEFT JOIN department d ON d.id = e.department_id
        WHERE s.product_id = $1
        ORDER BY e.full_name`,
      [id],
    );

    return {
      ...toRow(rows[0]),
      seats: seats.map((s) => ({
        seat: {
          id: s.id, productId: s.product_id, empId: s.employee_id,
          assignedOn: s.assigned_on, lastUsedOn: s.last_used_on, assetId: s.asset_id,
        },
        name: s.name,
        dept: s.dept_code ?? '',
        dormant: s.last_used_on === null || Number(s.days_idle) >= DORMANT_DAYS,
        daysIdle: s.days_idle === null ? null : Number(s.days_idle),
      })),
      history: [],
    };
  });
}

/** What the signed-in person holds — the whole of an employee's view. */
export async function mySoftware(caller: Caller): Promise<{
  seat: { id: string; productId: string; empId: string; assignedOn: string;
    lastUsedOn: string | null; assetId: string | null };
  product: SoftwareProduct; dormant: boolean;
}[]> {
  if (!caller.employeeId) return [];
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row & {
      seat_id: string; assigned_on: string; last_used_on: string | null;
      asset_id: string | null; days_idle: string | null;
    }>(
      `SELECT p.id, p.name, p.vendor, p.category, p.plan, p.seats,
              p.unit_cost_pa::text, p.billing, p.renews_on::text, p.owner_id,
              p.status, p.sso, p.holds_personal_data, p.notes,
              '0' AS assigned, '0' AS dormant, '0' AS renews_in,
              s.id AS seat_id, s.assigned_on::text, s.last_used_on::text, s.asset_id,
              (CURRENT_DATE - s.last_used_on)::text AS days_idle
         FROM software_seat s
         JOIN software_product p ON p.id = s.product_id
        WHERE s.employee_id = $1
        ORDER BY p.name`,
      [caller.employeeId],
    );
    return rows.map((r) => ({
      seat: {
        id: r.seat_id, productId: r.id, empId: caller.employeeId!,
        assignedOn: r.assigned_on, lastUsedOn: r.last_used_on, assetId: r.asset_id,
      },
      product: toRow(r).product,
      dormant: r.last_used_on === null || Number(r.days_idle) >= DORMANT_DAYS,
    }));
  });
}

export async function softwareStats(caller: Caller) {
  mayBrowse(caller);
  const rows = await listSoftware(caller);
  const live = rows.filter((r) => r.product.status !== 'Cancelled');
  return {
    products: live.length,
    seatsPurchased: live.reduce((n, r) => n + r.product.seats, 0),
    seatsAssigned: live.reduce((n, r) => n + r.assigned, 0),
    dormantSeats: live.reduce((n, r) => n + r.dormant, 0),
    annualSpend: live.reduce((n, r) => n + r.annualCost, 0),
    wastedSpend: live.reduce((n, r) => n + r.wastedCost, 0),
    renewingSoon: live.filter((r) => r.renewsInDays >= 0 && r.renewsInDays <= RENEWAL_WINDOW).length,
    overdue: live.filter((r) => r.renewsInDays < 0).length,
    overAllocated: live.filter((r) => r.overAllocated).length,
    noSso: live.filter((r) => !r.product.sso).length,
  };
}

export async function softwareRenewals(caller: Caller, withinDays = RENEWAL_WINDOW) {
  mayBrowse(caller);
  const rows = await listSoftware(caller);
  return rows
    .filter((r) => r.product.status !== 'Cancelled' && r.renewsInDays <= withinDays)
    .sort((a, b) => a.renewsInDays - b.renewsInDays)
    .map((r) => ({ product: r.product, inDays: r.renewsInDays }));
}

const validate = (d: Partial<SoftwareDraft>) => {
  if (d.n !== undefined && !d.n.trim()) throw new SoftwareError('Give the product a name', 'invalid');
  if (d.vendor !== undefined && !d.vendor.trim()) throw new SoftwareError('Name the vendor', 'invalid');
  if (d.seats !== undefined && (!Number.isFinite(d.seats) || d.seats < 0)) {
    throw new SoftwareError('Seats must be zero or more', 'invalid');
  }
  if (d.unitCost !== undefined && (!Number.isFinite(d.unitCost) || d.unitCost < 0)) {
    throw new SoftwareError('Cost per seat must be zero or more', 'invalid');
  }
};

export async function createSoftware(caller: Caller, d: SoftwareDraft): Promise<SoftwareProduct> {
  mayWrite(caller);
  validate(d);
  if (!d.renewsOn) throw new SoftwareError('Give it a renewal date', 'invalid');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO software_product
         (name, vendor, category, plan, seats, unit_cost_pa, billing, renews_on,
          owner_id, status, sso, holds_personal_data, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [d.n.trim(), d.vendor.trim(), d.cat, d.plan ?? '', d.seats, d.unitCost,
        d.billing ?? 'Annual', d.renewsOn, d.ownerId ?? null, d.status ?? 'Active',
        d.sso ?? false, d.holdsPersonalData ?? false, d.notes ?? ''],
    ).catch((e: { constraint?: string }) => {
      if (e.constraint === 'software_product_name_unique') {
        throw new SoftwareError('That product is already in the register', 'duplicate');
      }
      throw e;
    });
    const made = await getSoftware(caller, rows[0]!.id);
    if (!made) throw new SoftwareError('The product was not created', 'invalid');
    return made.product;
  });
}

export async function updateSoftware(
  caller: Caller,
  id: string,
  patch: Partial<SoftwareDraft>,
): Promise<SoftwareProduct> {
  mayWrite(caller);
  validate(patch);

  return withTenant(caller, async (db) => {
    if (patch.seats !== undefined) {
      const { rows } = await db.query<{ held: string }>(
        'SELECT count(*)::text AS held FROM software_seat WHERE product_id = $1', [id]);
      const held = Number(rows[0]?.held ?? 0);
      /*
       * Cutting below the holders leaves somebody with a seat the company is
       * not paying for, and nothing on any screen would say so. Revoking the
       * seats is a decision; typing a smaller number should not make it.
       */
      if (patch.seats < held) {
        throw new SoftwareError(
          `${held} people hold a seat — revoke seats before cutting the count to ${patch.seats}`,
          'in_use');
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (patch.n !== undefined) set('name', patch.n.trim());
    if (patch.vendor !== undefined) set('vendor', patch.vendor.trim());
    if (patch.cat !== undefined) set('category', patch.cat);
    if (patch.plan !== undefined) set('plan', patch.plan);
    if (patch.seats !== undefined) set('seats', patch.seats);
    if (patch.unitCost !== undefined) set('unit_cost_pa', patch.unitCost);
    if (patch.billing !== undefined) set('billing', patch.billing);
    if (patch.renewsOn !== undefined) set('renews_on', patch.renewsOn);
    if (patch.ownerId !== undefined) set('owner_id', patch.ownerId);
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.sso !== undefined) set('sso', patch.sso);
    if (patch.holdsPersonalData !== undefined) set('holds_personal_data', patch.holdsPersonalData);
    if (patch.notes !== undefined) set('notes', patch.notes);

    if (sets.length) {
      params.push(id);
      const { rowCount } = await db.query(
        `UPDATE software_product SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      if (!rowCount) throw new SoftwareError('No such product', 'not_found');
    }
    const after = await getSoftware(caller, id);
    if (!after) throw new SoftwareError('No such product', 'not_found');
    return after.product;
  });
}

export async function removeSoftware(caller: Caller, id: string): Promise<SoftwareProduct> {
  mayWrite(caller);
  /* Read it before deleting: the contract hands the removed product back. */
  const existing = await getSoftware(caller, id);
  if (!existing) throw new SoftwareError('No such product', 'not_found');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query<{ held: string }>(
      'SELECT count(*)::text AS held FROM software_seat WHERE product_id = $1', [id]);
    if (Number(rows[0]?.held ?? 0) > 0) {
      throw new SoftwareError(
        `${rows[0]!.held} people still hold a seat — revoke them first`, 'in_use');
    }
    await db.query('DELETE FROM software_product WHERE id = $1', [id]);
    return existing.product;
  });
}

export async function assignSeat(caller: Caller, productId: string, empId: string) {
  mayWrite(caller);
  return withTenant(caller, async (db) => {
    const { rows: p } = await db.query<{ status: string; name: string }>(
      'SELECT status, name FROM software_product WHERE id = $1', [productId]);
    if (!p[0]) throw new SoftwareError('No such product', 'not_found');
    if (p[0].status === 'Cancelled') throw new SoftwareError(`${p[0].name} has been cancelled`, 'invalid');

    const { rows: e } = await db.query<{ status: string; full_name: string }>(
      'SELECT status, full_name FROM employee WHERE id = $1', [empId]);
    if (!e[0]) throw new SoftwareError('No such employee', 'invalid');
    if (e[0].status === 'exited') {
      throw new SoftwareError(`${e[0].full_name} is not an active employee`, 'invalid');
    }

    const { rows } = await db.query<{ id: string; assigned_on: string }>(
      `INSERT INTO software_seat (product_id, employee_id)
       VALUES ($1, $2) RETURNING id, assigned_on::text`,
      [productId, empId],
    ).catch((err: { constraint?: string }) => {
      if (err.constraint === 'software_seat_tenant_id_product_id_employee_id_key') {
        throw new SoftwareError(`${e[0]!.full_name} already holds a seat on ${p[0]!.name}`, 'duplicate');
      }
      throw err;
    });
    return {
      id: rows[0]!.id, productId, empId,
      assignedOn: rows[0]!.assigned_on, lastUsedOn: null, assetId: null,
    };
  });
}

export async function revokeSeat(caller: Caller, seatId: string) {
  return withTenant(caller, async (db) => {
    const { rows } = await db.query<{
      employee_id: string; product_id: string; asset_id: string | null;
      assigned_on: string; last_used_on: string | null; manager_id: string | null;
    }>(
      `SELECT s.employee_id, s.product_id, s.asset_id, s.assigned_on::text,
              s.last_used_on::text, e.manager_id
         FROM software_seat s JOIN employee e ON e.id = s.employee_id
        WHERE s.id = $1`,
      [seatId]);
    const seat = rows[0];
    if (!seat) throw new SoftwareError('No such seat', 'not_found');

    /*
     * A manager taking a seat back from their own line is ordinary
     * housekeeping; making them raise a ticket is how dormant seats pile up.
     * Taking one from outside their line is not theirs to do.
     */
    if (caller.role === 'employee') {
      throw new SoftwareError('Your role cannot revoke a seat', 'forbidden');
    }
    if (caller.role === 'manager') {
      const { rows: ok } = await db.query(
        `WITH RECURSIVE line AS (
           SELECT id FROM employee WHERE manager_id = $1
           UNION ALL SELECT c.id FROM employee c JOIN line ON c.manager_id = line.id
         ) SELECT 1 FROM line WHERE id = $2`,
        [caller.employeeId, seat.employee_id]);
      if (!ok.length) {
        throw new SoftwareError('That seat belongs to somebody outside the people you can see', 'forbidden');
      }
    }

    /*
     * A seat the asset register issued is held there too. Revoking only this
     * copy would leave the two disagreeing — the exact failure `asset_id`
     * exists to prevent — so it refuses and says where to go.
     */
    if (seat.asset_id) {
      throw new SoftwareError('This seat was issued as an asset — return it in the asset register', 'in_use');
    }

    await db.query('DELETE FROM software_seat WHERE id = $1', [seatId]);
    return {
      id: seatId, productId: seat.product_id, empId: seat.employee_id,
      assignedOn: seat.assigned_on, lastUsedOn: seat.last_used_on, assetId: null,
    };
  });
}
