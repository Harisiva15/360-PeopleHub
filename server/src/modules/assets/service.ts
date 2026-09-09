/**
 * IT assets — the register, the request queue, and custody.
 *
 * **Every allocation and return writes an `asset_movement` row.** The register
 * alone can only answer "who has this laptop now"; the question that actually
 * gets asked is "who had it in March", usually after something has gone wrong.
 * The mock kept no history at all, so the answer was unrecoverable. Here the
 * movement is written in the same transaction as the status change — a custody
 * trail with gaps is worse than none, because it looks complete.
 *
 * **Allocation is `SELECT ... FOR UPDATE` then check.** Two admins issuing the
 * same laptop is the obvious race, and reading the status before the
 * transaction takes the row would let both of them win. The schema's
 * `CHECK ((status = 'assigned') = (employee_id IS NOT NULL))` catches the
 * corrupt end state, but a clear refusal is better than a constraint violation.
 *
 * **Book value is depreciated in SQL**, straight-line over the category's
 * useful life, floored at zero. It is a figure finance reconciles against, so
 * it is computed once here rather than in each screen that shows it.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class AssetError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'AssetError';
    this.code = code;
  }
}

export type AssetStatus = 'Assigned' | 'In stock' | 'In repair' | 'Retired' | 'Lost';

const TO_STATUS: Record<string, AssetStatus> = {
  assigned: 'Assigned', in_stock: 'In stock', in_repair: 'In repair',
  retired: 'Retired', lost: 'Lost',
};

const TO_REQ_STATUS: Record<string, string> = {
  pending: 'Pending', approved: 'Approved', rejected: 'Rejected', fulfilled: 'Fulfilled',
};
const FROM_REQ_STATUS: Record<string, string> = {
  Pending: 'pending', Approved: 'approved', Rejected: 'rejected', Fulfilled: 'fulfilled',
};

export interface Asset {
  id: string;
  empId: string | null;
  type: string;
  serial: string;
  issued: string | null;
  status: AssetStatus;
  cat?: string;
  cost?: number;
  vendor?: string;
  tag?: string;
  purchased?: string;
  warrantyEnd?: string;
  site?: string;
  condition?: string;
  retiredOn?: string;
  disposal?: string;
}

export interface AssetRequest {
  id: string;
  empId: string;
  type: string;
  cat: string;
  cost: number;
  reason: string;
  note: string;
  raisedOn: string;
  status: string;
  entitled: boolean;
  needsFinance: boolean;
  managerId: string | null;
  approvedBy: string | null;
  approvedOn: string | null;
  rejectReason: string | null;
  fulfilledOn: string | null;
  assetId: string | null;
}

export interface AssetKPI {
  total: number;
  assigned: number;
  stock: number;
  repair: number;
  retired: number;
  gross: number;
  net: number;
  dep: number;
  outOfWarranty: number;
  eol: number;
  unassigned: number;
  recovery: number;
}

const ASSET_PROJECTION = `
  SELECT a.id, a.employee_id, a.model, a.serial_number, a.assigned_on, a.status,
         c.code AS cat_code, a.purchase_cost, a.vendor_name, a.tag,
         a.purchased_on, a.warranty_ends_on, s.code AS site_code, a.condition,
         a.retired_on, a.disposal_note
    FROM asset a
    JOIN asset_category c ON c.id = a.category_id
    LEFT JOIN site s ON s.id = a.site_id`;

const toAsset = (r: Record<string, unknown>): Asset => ({
  id: r.id as string,
  empId: (r.employee_id as string | null) ?? null,
  type: r.model as string,
  serial: (r.serial_number as string) ?? '',
  issued: (r.assigned_on as string | null) ?? null,
  status: TO_STATUS[r.status as string] ?? 'In stock',
  cat: (r.cat_code as string) ?? '',
  cost: r.purchase_cost === null ? 0 : Number(r.purchase_cost),
  vendor: (r.vendor_name as string) ?? '',
  tag: (r.tag as string) ?? '',
  purchased: (r.purchased_on as string) ?? '',
  warrantyEnd: (r.warranty_ends_on as string) ?? '',
  site: (r.site_code as string) ?? '',
  condition: (r.condition as string) ?? '',
  retiredOn: (r.retired_on as string) ?? '',
  disposal: (r.disposal_note as string) ?? '',
});

const REQUEST_PROJECTION = `
  SELECT r.id, r.employee_id, r.model, c.code AS cat_code, r.estimated_cost,
         r.reason, r.status, r.raised_on, r.entitled, r.needs_finance,
         e.manager_id, r.approver_id, r.approved_on, r.reject_reason,
         r.fulfilled_on, r.asset_id
    FROM asset_request r
    JOIN asset_category c ON c.id = r.category_id
    JOIN employee e ON e.id = r.employee_id`;

const toRequest = (r: Record<string, unknown>): AssetRequest => ({
  id: r.id as string,
  empId: r.employee_id as string,
  type: (r.model as string) ?? '',
  cat: r.cat_code as string,
  cost: r.estimated_cost === null ? 0 : Number(r.estimated_cost),
  reason: r.reason as string,
  note: '',
  raisedOn: r.raised_on as string,
  status: TO_REQ_STATUS[r.status as string] ?? 'Pending',
  entitled: Boolean(r.entitled),
  needsFinance: Boolean(r.needs_finance),
  managerId: (r.manager_id as string | null) ?? null,
  approvedBy: (r.approver_id as string | null) ?? null,
  approvedOn: (r.approved_on as string | null) ?? null,
  rejectReason: (r.reject_reason as string | null) ?? null,
  fulfilledOn: (r.fulfilled_on as string | null) ?? null,
  assetId: (r.asset_id as string | null) ?? null,
});

/**
 * What the caller may see.
 *
 * An employee sees the kit issued to them and nothing else — an asset register
 * is a list of what is worth stealing and who has it, so it is not a directory.
 */
function scope(caller: Caller, column: string, params: unknown[]): string {
  if (caller.role === 'admin') return '';
  params.push(caller.employeeId);
  const p = `$${params.length}`;
  if (caller.role === 'employee') return `${column} = ${p}`;
  return `(${column} = ${p} OR ${column} IN (
     WITH RECURSIVE t AS (
       SELECT id FROM employee WHERE manager_id = ${p}
       UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
     ) SELECT id FROM t))`;
}

export async function listAssets(caller: Caller): Promise<Asset[]> {
  const params: unknown[] = [];
  const where = scope(caller, 'a.employee_id', params);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${ASSET_PROJECTION} ${where ? `WHERE ${where}` : ''} ORDER BY a.tag`, params);
    return rows.map(toAsset);
  });
}

export async function listRequests(caller: Caller): Promise<AssetRequest[]> {
  const params: unknown[] = [];
  const where = scope(caller, 'r.employee_id', params);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${REQUEST_PROJECTION} ${where ? `WHERE ${where}` : ''} ORDER BY r.raised_on DESC`, params);
    return rows.map(toRequest);
  });
}

export async function listOpenRequests(caller: Caller): Promise<AssetRequest[]> {
  const params: unknown[] = [];
  const where = scope(caller, 'r.employee_id', params);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${REQUEST_PROJECTION}
        WHERE r.status IN ('pending', 'approved') ${where ? `AND ${where}` : ''}
        ORDER BY r.raised_on`, params);
    return rows.map(toRequest);
  });
}

/** Kit a leaver still holds — the exit clearance checklist. */
export async function pendingRecovery(caller: Caller): Promise<Asset[]> {
  if (caller.role === 'employee') return [];
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${ASSET_PROJECTION}
        JOIN employee holder ON holder.id = a.employee_id
       WHERE a.status = 'assigned' AND holder.status IN ('exited', 'on_notice')
       ORDER BY holder.full_name, a.tag`);
    return rows.map(toAsset);
  });
}

/**
 * Register health.
 *
 * Depreciation is straight-line from the purchase date over the category's
 * useful life. `GREATEST(0, ...)` matters: an asset past its life has a book
 * value of zero, not a negative one that would quietly offset the rest.
 */
export async function assetKpi(caller: Caller): Promise<AssetKPI> {
  if (caller.role === 'employee') {
    throw new AssetError('only a manager or admin may see the register summary', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `WITH v AS (
         SELECT a.status, a.purchase_cost, a.warranty_ends_on, a.purchased_on,
                c.useful_life_months,
                COALESCE(a.purchase_cost, 0) AS gross,
                GREATEST(0, COALESCE(a.purchase_cost, 0) - (
                  COALESCE(a.purchase_cost, 0) / c.useful_life_months
                  * LEAST(c.useful_life_months,
                          GREATEST(0, (EXTRACT(YEAR FROM age(CURRENT_DATE, a.purchased_on)) * 12
                                     + EXTRACT(MONTH FROM age(CURRENT_DATE, a.purchased_on)))::int))
                )) AS net
           FROM asset a JOIN asset_category c ON c.id = a.category_id
          WHERE a.purchased_on IS NOT NULL
       ), all_assets AS (SELECT status FROM asset)
       SELECT (SELECT count(*) FROM all_assets)::int AS total,
              (SELECT count(*) FROM all_assets WHERE status = 'assigned')::int AS assigned,
              (SELECT count(*) FROM all_assets WHERE status = 'in_stock')::int AS stock,
              (SELECT count(*) FROM all_assets WHERE status = 'in_repair')::int AS repair,
              (SELECT count(*) FROM all_assets WHERE status = 'retired')::int AS retired,
              COALESCE((SELECT sum(gross) FROM v), 0) AS gross,
              COALESCE((SELECT sum(net) FROM v), 0) AS net,
              (SELECT count(*) FROM asset
                WHERE warranty_ends_on IS NOT NULL AND warranty_ends_on < CURRENT_DATE
                  AND status <> 'retired')::int AS out_of_warranty,
              (SELECT count(*) FROM v WHERE net = 0 AND status <> 'retired')::int AS eol,
              (SELECT count(*) FROM employee e
                WHERE e.status <> 'exited'
                  AND NOT EXISTS (
                    SELECT 1 FROM asset a JOIN asset_category c ON c.id = a.category_id
                     WHERE a.employee_id = e.id AND a.status = 'assigned'
                       AND c.code = 'LAPTOP'))::int AS unassigned,
              (SELECT count(*) FROM asset a JOIN employee h ON h.id = a.employee_id
                WHERE a.status = 'assigned'
                  AND h.status IN ('exited', 'on_notice'))::int AS recovery`);

    const r = rows[0];
    const gross = Number(r.gross);
    const net = Number(r.net);
    return {
      total: r.total, assigned: r.assigned, stock: r.stock, repair: r.repair,
      retired: r.retired,
      gross: Math.round(gross),
      net: Math.round(net),
      dep: Math.round(gross - net),
      outOfWarranty: r.out_of_warranty,
      eol: r.eol,
      unassigned: r.unassigned,
      recovery: r.recovery,
    };
  });
}

async function reloadAsset(db: TenantClient, id: string): Promise<Asset> {
  const { rows } = await db.query(`${ASSET_PROJECTION} WHERE a.id = $1`, [id]);
  if (!rows[0]) throw new AssetError('no such asset', 'not_found');
  return toAsset(rows[0]);
}

/**
 * Issue an asset to someone.
 *
 * If they have an approved request open for this category, it is marked
 * fulfilled by this asset in the same transaction — which is what the schema's
 * `CHECK ((status = 'fulfilled') = (asset_id IS NOT NULL))` insists on, and
 * what stops a queue of approved requests that were quietly satisfied months
 * ago from still looking open.
 */
export async function allocate(caller: Caller, assetId: string, empId: string): Promise<Asset> {
  if (caller.role === 'employee') {
    throw new AssetError('only a manager or admin may issue an asset', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT status, category_id, employee_id FROM asset WHERE id = $1 FOR UPDATE', [assetId]);
    if (!rows[0]) throw new AssetError('no such asset', 'not_found');
    if (rows[0].status !== 'in_stock') {
      throw new AssetError(
        `that asset is ${TO_STATUS[rows[0].status]?.toLowerCase() ?? rows[0].status}, not in stock`,
        'not_in_stock');
    }

    const holder = await db.query(
      "SELECT status FROM employee WHERE id = $1", [empId]);
    if (!holder.rows[0]) throw new AssetError('no such employee', 'not_found');
    if (holder.rows[0].status === 'exited') {
      throw new AssetError('that person has left', 'invalid');
    }

    await db.query(
      `UPDATE asset
          SET status = 'assigned', employee_id = $2, assigned_on = CURRENT_DATE
        WHERE id = $1`, [assetId, empId]);

    await db.query(
      `INSERT INTO asset_movement (asset_id, kind, from_employee_id, to_employee_id, recorded_by)
       VALUES ($1, 'allocated', NULL, $2, $3)`, [assetId, empId, caller.employeeId]);

    await db.query(
      `UPDATE asset_request r
          SET status = 'fulfilled', asset_id = $1, fulfilled_on = CURRENT_DATE
        WHERE r.id = (
          SELECT id FROM asset_request
           WHERE employee_id = $2 AND status = 'approved'
             AND category_id = $3
           ORDER BY raised_on LIMIT 1)`,
      [assetId, empId, rows[0].category_id]);

    return reloadAsset(db, assetId);
  });
}

/** Take an asset back. The custody trail records who it came from. */
export async function markReturned(caller: Caller, assetId: string): Promise<Asset> {
  if (caller.role === 'employee') {
    throw new AssetError('only a manager or admin may take an asset back', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT status, employee_id FROM asset WHERE id = $1 FOR UPDATE', [assetId]);
    if (!rows[0]) throw new AssetError('no such asset', 'not_found');
    if (rows[0].status !== 'assigned') {
      throw new AssetError('that asset is not issued to anyone', 'not_assigned');
    }

    await db.query(
      `UPDATE asset
          SET status = 'in_stock', employee_id = NULL, assigned_on = NULL
        WHERE id = $1`, [assetId]);

    await db.query(
      `INSERT INTO asset_movement (asset_id, kind, from_employee_id, to_employee_id, recorded_by)
       VALUES ($1, 'returned', $2, NULL, $3)`,
      [assetId, rows[0].employee_id, caller.employeeId]);

    return reloadAsset(db, assetId);
  });
}

export interface NewAssetRequest {
  cat: string;
  type: string;
  reason: string;
  cost?: number;
}

/** Above this, a manager's approval is not enough on its own. */
const FINANCE_THRESHOLD = 25000;

/**
 * Ask for kit.
 *
 * Always for yourself. An asset request names a person and a cost, and letting
 * one be raised on somebody else's behalf is how a request appears in a
 * manager's queue that the employee never made.
 */
export async function requestAsset(
  caller: Caller,
  draft: NewAssetRequest,
): Promise<AssetRequest> {
  if (!draft.type?.trim()) throw new AssetError('say which item you need', 'invalid');
  if (!draft.reason?.trim()) throw new AssetError('give a reason for the request', 'invalid');

  return withTenant(caller, async (db) => {
    const cat = await db.query(
      'SELECT id FROM asset_category WHERE code = $1', [draft.cat]);
    if (!cat.rows[0]) throw new AssetError(`no such asset category: ${draft.cat}`, 'invalid');

    const cost = Number(draft.cost ?? 0);
    const { rows } = await db.query(
      `INSERT INTO asset_request
         (employee_id, category_id, model, reason, estimated_cost, needs_finance)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [caller.employeeId, cat.rows[0].id, draft.type.trim(), draft.reason.trim(),
        cost || null, cost > FINANCE_THRESHOLD]);

    const back = await db.query(`${REQUEST_PROJECTION} WHERE r.id = $1`, [rows[0].id]);
    return toRequest(back.rows[0]!);
  });
}

/**
 * Approve or reject a request.
 *
 * 'Fulfilled' is deliberately not settable here. A fulfilled request names the
 * asset that fulfilled it — that is a schema CHECK, not a preference — so
 * fulfilment happens by issuing an asset, and setting the status alone would
 * be recording an issue that never happened.
 */
export async function actOnRequest(
  caller: Caller,
  id: string,
  status: string,
): Promise<AssetRequest> {
  if (caller.role === 'employee') {
    throw new AssetError('only a manager or admin may decide a request', 'forbidden');
  }
  const to = FROM_REQ_STATUS[status];
  if (!to) throw new AssetError(`unknown status: ${status}`, 'invalid');
  if (to === 'fulfilled') {
    throw new AssetError(
      'a request is fulfilled by issuing an asset, not by setting its status', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT employee_id, status FROM asset_request WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new AssetError('no such asset request', 'not_found');
    if (rows[0].employee_id === caller.employeeId) {
      throw new AssetError('you cannot decide your own request', 'self_approval');
    }
    if (rows[0].status === 'fulfilled') {
      throw new AssetError('that request has already been fulfilled', 'already_fulfilled');
    }

    await db.query(
      `UPDATE asset_request
          SET status = $2, approver_id = $3,
              approved_on = CASE WHEN $2 = 'approved' THEN CURRENT_DATE ELSE approved_on END
        WHERE id = $1`, [id, to, caller.employeeId]);

    const { rows: back } = await db.query(`${REQUEST_PROJECTION} WHERE r.id = $1`, [id]);
    return toRequest(back[0]!);
  });
}
