/**
 * Flexible benefits.
 *
 * A budget carved out of special allowance that somebody may re-point at
 * components with their own tax treatment — fuel, meals, telecom. Declaring
 * moves money from taxable salary into tax-free heads, so the two ceilings
 * matter and neither is advisory.
 *
 * **Two ceilings, refused rather than trimmed.** The pool is what the person
 * has to spend; each component has its own statutory annual cap. Going over
 * either is refused with the number, not silently clipped — somebody who typed
 * 40,000 against a 28,800 cap should be told, not handed 28,800 and left to
 * discover it in March.
 *
 * **Locked means locked.** After `locks_on` the allocation is fixed for the
 * year and the unallocated balance is paid as taxable salary. Payroll has
 * already been computing against it by then, so a late revision would mean
 * re-running months that are closed.
 *
 * **Outside India it does not apply.** FBP is an Indian salary-structuring
 * device. A US or UK employee gets `na: true` rather than an empty plan, so
 * the screen says "not applicable here" instead of "you have nothing".
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import { EMPLOYEE_PROJECTION } from '../employees/queries.ts';
import { toEmployee } from '../employees/mapper.ts';
import type { Employee } from '../employees/mapper.ts';

export class BenefitsError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'BenefitsError';
    this.code = code;
  }
}

export interface FbpPlan {
  pool: number;
  alloc: Record<string, number>;
  status: string;
  lockedOn: string | null;
  na?: boolean;
}

export interface FbpRow {
  employee: Employee;
  plan: FbpPlan;
  allocated: number;
}

const TO_STATUS: Record<string, string> = {
  not_applicable: 'Not Applicable', not_declared: 'Not Declared',
  declared: 'Declared', locked: 'Locked',
};

function assertOwnOrAdmin(caller: Caller, empId: string): void {
  if (caller.role === 'admin') return;
  if (caller.employeeId !== empId) {
    throw new BenefitsError('a benefits plan is only visible to its owner and finance', 'forbidden');
  }
}

/** The financial year a date falls in, per the tenant's configured start month. */
async function fyStart(db: TenantClient): Promise<string> {
  const { rows } = await db.query(
    `SELECT make_date(
              CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= t.fiscal_year_start_month
                   THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
                   ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END,
              t.fiscal_year_start_month, 1) AS fy
       FROM tenant t WHERE t.id = current_tenant_id()`);
  if (!rows[0]) throw new BenefitsError('tenant not found', 'not_found');
  return rows[0].fy as string;
}

/**
 * The pool somebody is entitled to.
 *
 * Derived from the salary structure rather than stored per person: the pool is
 * a slice of special allowance, and a stored figure would drift the moment
 * somebody's salary was revised. Capped so the plan cannot swallow the whole
 * allowance — there has to be salary left to pay.
 */
const POOL_SHARE = 0.4;

async function planFor(
  db: TenantClient,
  empId: string,
  create: boolean,
): Promise<{ plan: FbpPlan; allocated: number }> {
  const fy = await fyStart(db);

  const ctx = await db.query(
    `SELECT COALESCE(le.country, 'IN') AS country,
            COALESCE(ss.annual_ctc, e.ctc, 0) AS ctc
       FROM employee e
       LEFT JOIN legal_entity le ON le.id = e.legal_entity_id
       LEFT JOIN LATERAL (
         SELECT x.annual_ctc FROM salary_structure x
          WHERE x.employee_id = e.id AND x.valid_to IS NULL
          ORDER BY x.valid_from DESC LIMIT 1
       ) ss ON true
      WHERE e.id = $1`, [empId]);
  if (!ctx.rows[0]) throw new BenefitsError('no such employee', 'not_found');

  /* FBP is an Indian device. Elsewhere the plan exists but does not apply. */
  if (ctx.rows[0].country !== 'IN') {
    return {
      plan: { pool: 0, alloc: {}, status: 'Not Applicable', lockedOn: null, na: true },
      allocated: 0,
    };
  }

  /* Special allowance is what is left after the fixed heads; 40% of it is the
     pool. Both figures come from the same structure the payslip is built on. */
  const ctc = Number(ctx.rows[0].ctc);
  const basic = Math.round(ctc * 0.4);
  const special = Math.max(0, ctc - basic - Math.round(basic * 0.5) - Math.round(basic * 0.08));
  const pool = Math.round((special * POOL_SHARE) / 12) * 12;

  if (create) {
    await db.query(
      `INSERT INTO fbp_plan (employee_id, fy_start, pool, locks_on)
       VALUES ($1, $2, $3, ($2::date + interval '9 months')::date)
       ON CONFLICT (tenant_id, employee_id, fy_start)
       DO UPDATE SET pool = EXCLUDED.pool`, [empId, fy, pool]);
  }

  const { rows } = await db.query(
    `SELECT p.id, p.pool, p.status, p.locks_on, p.declared_on
       FROM fbp_plan p WHERE p.employee_id = $1 AND p.fy_start = $2`, [empId, fy]);
  const row = rows[0];

  if (!row) {
    /* Nothing declared and nothing created — the entitlement, with no choices. */
    return { plan: { pool, alloc: {}, status: 'Not Declared', lockedOn: null }, allocated: 0 };
  }

  const alloc = await db.query(
    `SELECT c.code, a.amount FROM fbp_allocation a
       JOIN fbp_component c ON c.id = a.component_id
      WHERE a.plan_id = $1`, [row.id]);

  const map: Record<string, number> = {};
  let allocated = 0;
  for (const a of alloc.rows) {
    map[a.code as string] = Number(a.amount);
    allocated += Number(a.amount);
  }

  /*
   * Locked is a date passing, not a column somebody remembered to set. Deriving
   * it means a plan cannot sit in 'declared' past its own deadline because no
   * job ran.
   */
  const locked = row.locks_on !== null && (row.locks_on as string) < new Date().toISOString().slice(0, 10);

  return {
    plan: {
      pool: Number(row.pool),
      alloc: map,
      status: locked ? 'Locked' : (TO_STATUS[row.status as string] ?? 'Not Declared'),
      lockedOn: (row.locks_on as string | null) ?? null,
    },
    allocated,
  };
}

/** What each person has allocated, for the payroll and compensation views. */
export async function fbpTotals(
  caller: Caller,
  empIds: string[],
): Promise<Record<string, number>> {
  if (!empIds.length) return {};
  if (caller.role !== 'admin') {
    const mine = empIds.filter((id) => id === caller.employeeId);
    if (mine.length !== empIds.length) {
      throw new BenefitsError('only finance may see everyone\'s allocation', 'forbidden');
    }
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT p.employee_id, COALESCE(sum(a.amount), 0) AS allocated
         FROM fbp_plan p
         LEFT JOIN fbp_allocation a ON a.plan_id = p.id
        WHERE p.employee_id = ANY($1::uuid[]) AND p.fy_start = $2
        GROUP BY p.employee_id`, [empIds, await fyStart(db)]);
    return Object.fromEntries(rows.map((r) => [r.employee_id as string, Number(r.allocated)]));
  });
}

export async function fbpPlan(caller: Caller, empId: string): Promise<FbpRow> {
  assertOwnOrAdmin(caller, empId);
  return withTenantReadOnly(caller, async (db) => {
    const emp = await db.query(`${EMPLOYEE_PROJECTION} WHERE e.id = $1`, [empId]);
    if (!emp.rows[0]) throw new BenefitsError('no such employee', 'not_found');
    const { plan, allocated } = await planFor(db, empId, false);
    return {
      employee: toEmployee(emp.rows[0] as never, caller.role === 'admin'),
      plan,
      allocated,
    };
  });
}

/** The tracker across the workforce. Finance only. */
export async function fbpRows(caller: Caller): Promise<FbpRow[]> {
  if (caller.role !== 'admin') {
    throw new BenefitsError('only finance may see the declaration tracker', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${EMPLOYEE_PROJECTION} WHERE e.status <> 'exited' ORDER BY e.code`);
    const out: FbpRow[] = [];
    for (const r of rows) {
      const { plan, allocated } = await planFor(db, r.id as string, false);
      out.push({ employee: toEmployee(r as never, true), plan, allocated });
    }
    return out;
  });
}

/**
 * Declare an allocation.
 *
 * Replaces the whole set rather than merging: a declaration is a statement
 * about the year, and merging would make "I removed fuel" indistinguishable
 * from "I did not mention fuel".
 */
export async function declareFbp(
  caller: Caller,
  empId: string,
  alloc: Record<string, unknown>,
): Promise<FbpPlan> {
  assertOwnOrAdmin(caller, empId);

  return withTenant(caller, async (db) => {
    const { plan } = await planFor(db, empId, true);
    if (plan.na) {
      throw new BenefitsError(
        'flexible benefits do not apply outside India', 'not_applicable');
    }
    if (plan.status === 'Locked') {
      throw new BenefitsError(
        'the plan is locked for this year — the balance is paid as taxable salary', 'locked');
    }

    const comps = await db.query(
      'SELECT id, code, name, annual_cap FROM fbp_component WHERE active');
    const byCode = new Map(comps.rows.map((c) => [c.code as string, c]));

    let total = 0;
    const clean: { id: string; amount: number }[] = [];

    for (const [code, raw] of Object.entries(alloc)) {
      const comp = byCode.get(code);
      if (!comp) throw new BenefitsError(`not a benefit component: ${code}`, 'invalid');

      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        throw new BenefitsError(`${comp.name} must be a positive amount`, 'invalid');
      }
      const amount = Math.round(n);
      if (amount > Number(comp.annual_cap)) {
        throw new BenefitsError(
          `${comp.name} is capped at ${Number(comp.annual_cap).toLocaleString('en-IN')} `
          + `a year — declared ${amount.toLocaleString('en-IN')}`, 'invalid');
      }
      total += amount;
      if (amount > 0) clean.push({ id: comp.id as string, amount });
    }

    if (total > plan.pool) {
      throw new BenefitsError(
        `that is ${(total - plan.pool).toLocaleString('en-IN')} over your pool of `
        + `${plan.pool.toLocaleString('en-IN')}`, 'invalid');
    }

    const fy = await fyStart(db);
    const { rows } = await db.query(
      'SELECT id FROM fbp_plan WHERE employee_id = $1 AND fy_start = $2 FOR UPDATE',
      [empId, fy]);
    const planId = rows[0]!.id as string;

    /* The whole set, replaced. See the note above. */
    await db.query('DELETE FROM fbp_allocation WHERE plan_id = $1', [planId]);
    for (const a of clean) {
      await db.query(
        'INSERT INTO fbp_allocation (plan_id, component_id, amount) VALUES ($1, $2, $3)',
        [planId, a.id, a.amount]);
    }
    await db.query(
      `UPDATE fbp_plan SET status = 'declared', declared_on = CURRENT_DATE WHERE id = $1`,
      [planId]);

    return (await planFor(db, empId, false)).plan;
  });
}

/**
 * Group cover, summed across the workforce.
 *
 * Sum assured is a multiple of CTC by grade rather than a stored figure,
 * because that is how the policy is actually written and a stored number would
 * be wrong the day after a revision.
 */
export async function insuranceCover(
  caller: Caller,
): Promise<{ totalSumAssured: number; covered: number }> {
  if (caller.role !== 'admin') {
    throw new BenefitsError('only finance may see the group cover', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS covered,
              COALESCE(sum(COALESCE(ss.annual_ctc, e.ctc, 0) * 3), 0) AS sum_assured
         FROM employee e
         LEFT JOIN LATERAL (
           SELECT x.annual_ctc FROM salary_structure x
            WHERE x.employee_id = e.id AND x.valid_to IS NULL
            ORDER BY x.valid_from DESC LIMIT 1
         ) ss ON true
        WHERE e.status <> 'exited'`);
    return {
      totalSumAssured: Number(rows[0]!.sum_assured),
      covered: Number(rows[0]!.covered),
    };
  });
}
