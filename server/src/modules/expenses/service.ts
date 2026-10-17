/**
 * Expense claims and travel advances.
 *
 * **The total comes from the items, never from the caller.** Same argument as
 * the timesheet total and the payslip net: this is the number that gets paid,
 * so it is summed in SQL from the rows that justify it. A claim whose total
 * disagrees with its receipts is the shape of an expense fraud, and it should
 * not be representable.
 *
 * **Over-limit is flagged, not blocked.** The schema says so and it is right:
 * a hotel over the cap on a night when nothing cheaper existed is a legitimate
 * claim, and a system that refuses it just moves the conversation to email
 * where nobody can audit it. The flag is computed server-side against the
 * category ceiling so the approver sees it whether or not the claimant
 * mentioned it.
 *
 * **Only an approved claim can be reimbursed**, and reimbursement attaches to
 * the payroll cycle it rides out with. The schema enforces the end state; this
 * refuses the transition with a sentence, which is the difference between a
 * usable error and a 500.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class ExpenseError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ExpenseError';
    this.code = code;
  }
}

const TO_STATUS: Record<string, string> = {
  draft: 'Submitted', submitted: 'Submitted', approved: 'Approved',
  rejected: 'Rejected', reimbursed: 'Reimbursed',
};
const FROM_STATUS: Record<string, string> = {
  Submitted: 'submitted', Approved: 'approved',
  Rejected: 'rejected', Reimbursed: 'reimbursed',
};

export interface ExpItem {
  id: string;
  cat: string;
  date: string;
  amount: number;
  merchant: string;
  desc: string;
  receipt: string | null;
  project: string | null;
  overLimit?: boolean;
}

export interface Claim {
  id: string;
  empId: string;
  title: string;
  items: ExpItem[];
  total: number;
  status: string;
  submittedOn: string;
  approverId: string | null;
  actedOn: string | null;
  reimbursedOn: string | null;
  payrollMonth: string | null;
  note: string;
}

export interface Advance {
  id: string;
  empId: string;
  amount: number;
  reason: string;
  requestedOn: string;
  status: string;
  settled: number;
}

const CLAIM_PROJECTION = `
  SELECT c.id, c.employee_id, c.title, c.status, c.submitted_on, c.approver_id,
         c.acted_on, c.reimbursed_on, c.note, c.total_amount,
         to_char(r.period_month, 'YYYY-MM') AS payroll_month,
         COALESCE(i.items, '[]'::jsonb) AS items
    FROM expense_claim c
    LEFT JOIN pay_run r ON r.id = c.reimbursed_in_run
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'id', it.id, 'cat', cat.code, 'date', it.spent_on,
               'amount', it.amount::float8, 'merchant', COALESCE(it.merchant, ''),
               'desc', COALESCE(it.description, ''), 'receipt', NULL,
               'project', p.code, 'overLimit', it.over_limit)
             ORDER BY it.spent_on, it.id) AS items
        FROM expense_item it
        JOIN expense_category cat ON cat.id = it.category_id
        LEFT JOIN project p ON p.id = it.project_id
       WHERE it.claim_id = c.id
    ) i ON true`;

const toClaim = (r: Record<string, unknown>): Claim => ({
  id: r.id as string,
  empId: r.employee_id as string,
  title: r.title as string,
  items: (r.items as ExpItem[]).map((it) => ({ ...it, amount: Number(it.amount) })),
  total: Number(r.total_amount ?? 0),
  status: TO_STATUS[r.status as string] ?? 'Submitted',
  submittedOn: (r.submitted_on as string) ?? '',
  approverId: (r.approver_id as string | null) ?? null,
  actedOn: (r.acted_on as string | null) ?? null,
  reimbursedOn: (r.reimbursed_on as string | null) ?? null,
  payrollMonth: (r.payroll_month as string | null) ?? null,
  note: (r.note as string) ?? '',
});

/** Money claims are private: own, then team, then everything for an admin. */
function scope(caller: Caller, column: string, params: unknown[]): string {
  if (caller.role === 'admin') return '';
  params.push(caller.employeeId);
  const p = `$${params.length}`;
  if (caller.role === 'employee') return `${column} = ${p}`;
  return `(${column} = ${p} OR ${column} IN (
     WITH RECURSIVE t AS (
       SELECT id FROM employee WHERE manager_id = ${p}
       UNION ALL SELECT c2.id FROM employee c2 JOIN t ON c2.manager_id = t.id
     ) SELECT id FROM t))`;
}

async function loadClaim(db: TenantClient, id: string): Promise<Claim> {
  const { rows } = await db.query(`${CLAIM_PROJECTION} WHERE c.id = $1`, [id]);
  if (!rows[0]) throw new ExpenseError('no such expense claim', 'not_found');
  return toClaim(rows[0]);
}

/** Recompute the claim total from its items. */
async function retotal(db: TenantClient, id: string): Promise<void> {
  await db.query(
    `UPDATE expense_claim c
        SET total_amount = COALESCE(
              (SELECT sum(i.amount) FROM expense_item i WHERE i.claim_id = c.id), 0)
      WHERE c.id = $1`, [id]);
}

export interface ClaimQuery {
  empIds?: string[];
  status?: string;
}

export async function listClaims(caller: Caller, q: ClaimQuery = {}): Promise<Claim[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  const scoped = scope(caller, 'c.employee_id', params);
  if (scoped) where.push(scoped);
  if (q.empIds?.length) {
    params.push(q.empIds);
    where.push(`c.employee_id = ANY($${params.length}::uuid[])`);
  }
  if (q.status && FROM_STATUS[q.status]) {
    params.push(FROM_STATUS[q.status]);
    where.push(`c.status = $${params.length}`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${CLAIM_PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.submitted_on DESC NULLS LAST, c.id`, params);
    return rows.map(toClaim);
  });
}

export interface NewClaim {
  empId: string;
  title: string;
  item: {
    cat: string;
    date: string;
    amount: number;
    merchant?: string;
    desc?: string;
    project?: string | null;
  };
}

/**
 * Raise a claim, always for yourself.
 *
 * A claim names a person and an amount to pay them; letting one be filed on
 * somebody else's behalf is how money is claimed in a colleague's name.
 */
export async function submitClaim(caller: Caller, draft: NewClaim): Promise<Claim> {
  if (draft.empId && draft.empId !== caller.employeeId && caller.role !== 'admin') {
    throw new ExpenseError('you can only claim for yourself', 'forbidden');
  }
  const amount = Number(draft.item?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ExpenseError('an expense needs an amount above zero', 'invalid');
  }
  if (!draft.item?.date) throw new ExpenseError('say when the expense was incurred', 'invalid');

  return withTenant(caller, async (db) => {
    const empId = draft.empId || caller.employeeId;
    const cat = await db.query(
      'SELECT id, limit_amount FROM expense_category WHERE code = $1 AND active',
      [draft.item.cat]);
    if (!cat.rows[0]) throw new ExpenseError(`no such expense category: ${draft.item.cat}`, 'invalid');

    const project = draft.item.project
      ? (await db.query('SELECT id FROM project WHERE code = $1', [draft.item.project])).rows[0]?.id
      : null;

    // Flagged, not blocked — the approver decides whether it was justified.
    const ceiling = cat.rows[0].limit_amount;
    const overLimit = ceiling !== null && amount > Number(ceiling);

    const claim = await db.query(
      `INSERT INTO expense_claim (employee_id, title, currency, status, submitted_on, approver_id)
       SELECT $1, $2, t.base_currency, 'submitted', CURRENT_DATE, e.manager_id
         FROM tenant t, employee e
        WHERE t.id = current_tenant_id() AND e.id = $1
       RETURNING id`,
      [empId, draft.title?.trim() || 'Expense claim']);
    const id = claim.rows[0].id as string;

    await db.query(
      `INSERT INTO expense_item
         (claim_id, category_id, spent_on, amount, merchant, description, project_id, over_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, cat.rows[0].id, draft.item.date, amount, draft.item.merchant ?? null,
        draft.item.desc ?? null, project ?? null, overLimit]);

    await retotal(db, id);
    return loadClaim(db, id);
  });
}

/** Who may decide a claim: a manager above the claimant, or an admin. */
async function assertMayDecide(
  db: TenantClient,
  caller: Caller,
  claimantId: string,
): Promise<void> {
  if (caller.role === 'employee') {
    throw new ExpenseError('only a manager or admin may decide a claim', 'forbidden');
  }
  if (claimantId === caller.employeeId) {
    throw new ExpenseError('you cannot decide your own claim', 'self_approval');
  }
  if (caller.role === 'admin') return;
  const r = await db.query(
    `WITH RECURSIVE t AS (
       SELECT id FROM employee WHERE manager_id = $1
       UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
     ) SELECT 1 FROM t WHERE id = $2`, [caller.employeeId, claimantId]);
  if ((r.rowCount ?? 0) === 0) {
    throw new ExpenseError('that person is not in your team', 'forbidden');
  }
}

async function decide(
  caller: Caller,
  id: string,
  to: 'approved' | 'rejected',
  note: string,
): Promise<Claim> {
  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT employee_id, status FROM expense_claim WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new ExpenseError('no such expense claim', 'not_found');
    await assertMayDecide(db, caller, rows[0].employee_id as string);

    if (!['submitted', 'draft'].includes(rows[0].status as string)) {
      throw new ExpenseError(
        `that claim is already ${TO_STATUS[rows[0].status as string]?.toLowerCase()}`,
        'not_pending');
    }

    await db.query(
      `UPDATE expense_claim
          SET status = $2, approver_id = $3, acted_on = CURRENT_DATE, note = $4
        WHERE id = $1`, [id, to, caller.employeeId, note]);
    return loadClaim(db, id);
  });
}

export const approveClaim = (caller: Caller, id: string): Promise<Claim> =>
  decide(caller, id, 'approved', '');

export const rejectClaim = (caller: Caller, id: string, note: string): Promise<Claim> =>
  decide(caller, id, 'rejected', note);

/**
 * Pay an approved claim out with a payroll cycle.
 *
 * The cycle is named rather than implied: a reimbursement that cannot say
 * which payslip it rode out on is one nobody can reconcile against a bank
 * statement.
 */
export async function reimburseClaim(caller: Caller, id: string): Promise<Claim> {
  if (caller.role !== 'admin') {
    throw new ExpenseError('only an admin may reimburse a claim', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT status FROM expense_claim WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new ExpenseError('no such expense claim', 'not_found');
    if (rows[0].status !== 'approved') {
      throw new ExpenseError('only an approved claim can be reimbursed', 'not_approved');
    }

    const entity = await db.query('SELECT id FROM legal_entity WHERE is_default LIMIT 1');
    if (!entity.rows[0]) throw new ExpenseError('no default legal entity configured', 'invalid');

    // The open cycle, created if this is the first thing to touch the month.
    const run = await db.query(
      `INSERT INTO pay_run (legal_entity_id, period_month)
       VALUES ($1, date_trunc('month', CURRENT_DATE)::date)
       ON CONFLICT (tenant_id, legal_entity_id, period_month) DO UPDATE
         SET period_month = EXCLUDED.period_month
       RETURNING id`, [entity.rows[0].id]);

    await db.query(
      `UPDATE expense_claim
          SET status = 'reimbursed', reimbursed_on = CURRENT_DATE, reimbursed_in_run = $2
        WHERE id = $1`, [id, run.rows[0].id]);

    return loadClaim(db, id);
  });
}

/* ---------- travel advances ---------- */

const ADVANCE_PROJECTION = `
  SELECT a.id, a.employee_id, a.amount, a.reason, a.requested_on, a.status,
         a.settled_amount
    FROM travel_advance a`;

const toAdvance = (r: Record<string, unknown>): Advance => ({
  id: r.id as string,
  empId: r.employee_id as string,
  amount: Number(r.amount),
  reason: r.reason as string,
  requestedOn: r.requested_on as string,
  status: (r.status as string) === 'pending' ? 'Pending'
    : (r.status as string) === 'settled' ? 'Settled' : 'Approved',
  settled: Number(r.settled_amount ?? 0),
});

export async function listAdvances(caller: Caller, empIds?: string[]): Promise<Advance[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  const scoped = scope(caller, 'a.employee_id', params);
  if (scoped) where.push(scoped);
  if (empIds?.length) {
    params.push(empIds);
    where.push(`a.employee_id = ANY($${params.length}::uuid[])`);
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${ADVANCE_PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.requested_on DESC`, params);
    return rows.map(toAdvance);
  });
}

export async function requestAdvance(
  caller: Caller,
  empId: string,
  amount: number,
  reason: string,
): Promise<Advance> {
  if (empId && empId !== caller.employeeId && caller.role !== 'admin') {
    throw new ExpenseError('you can only request an advance for yourself', 'forbidden');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ExpenseError('an advance needs an amount above zero', 'invalid');
  }
  if (!reason?.trim()) throw new ExpenseError('say what the advance is for', 'invalid');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO travel_advance (employee_id, amount, currency, reason)
       SELECT $1, $2, t.base_currency, $3 FROM tenant t WHERE t.id = current_tenant_id()
       RETURNING id`, [empId || caller.employeeId, amount, reason.trim()]);
    const back = await db.query(`${ADVANCE_PROJECTION} WHERE a.id = $1`, [rows[0].id]);
    return toAdvance(back.rows[0]!);
  });
}

export async function approveAdvance(caller: Caller, id: string): Promise<Advance> {
  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT employee_id, status FROM travel_advance WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new ExpenseError('no such advance', 'not_found');
    await assertMayDecide(db, caller, rows[0].employee_id as string);
    if (rows[0].status !== 'pending') {
      throw new ExpenseError(`that advance is already ${rows[0].status}`, 'not_pending');
    }

    await db.query(
      "UPDATE travel_advance SET status = 'approved', approver_id = $2 WHERE id = $1",
      [id, caller.employeeId]);
    const back = await db.query(`${ADVANCE_PROJECTION} WHERE a.id = $1`, [id]);
    return toAdvance(back.rows[0]!);
  });
}
