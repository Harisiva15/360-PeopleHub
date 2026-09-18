/**
 * Staff loans and salary advances.
 *
 * Small, and one of the two writes matters: sanctioning a loan puts it into
 * recovery, which means payroll starts deducting an EMI from somebody's salary.
 * That is the same class of decision as approving overtime, so it gets the same
 * treatment — a lock, a status check, and a refusal to sign your own.
 *
 * **`outstanding` is set on sanction, not derived.** The schema has
 * `loan_repayment`, one row per EMI actually recovered, and the balance could
 * be computed from it. It is stored instead because payroll needs to know what
 * to deduct *before* the repayment row exists, and a figure that only becomes
 * correct after the run is not much use to the run.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class LoanError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'LoanError';
    this.code = code;
  }
}

export interface Loan {
  id: string;
  empId: string;
  type: string;
  principal: number;
  tenure: number;
  emi: number;
  paidN: number;
  outstanding: number;
  sanctionedOn: string;
  status: 'Active' | 'Closed' | 'Pending Approval' | 'Rejected';
  reason: string;
}

const TO_STATUS: Record<string, Loan['status']> = {
  pending: 'Pending Approval', active: 'Active', closed: 'Closed',
  rejected: 'Rejected', written_off: 'Closed',
};

const PROJECTION = `
  SELECT l.id, l.employee_id, lt.name AS type_name, l.principal, l.tenure_months,
         l.emi, l.instalments_paid, l.outstanding, l.sanctioned_on, l.status,
         COALESCE(l.reason, '') AS reason
    FROM loan l
    JOIN loan_type lt ON lt.id = l.loan_type_id`;

const toLoan = (r: Record<string, unknown>): Loan => ({
  id: r.id as string,
  empId: r.employee_id as string,
  type: r.type_name as string,
  principal: Number(r.principal),
  tenure: Number(r.tenure_months),
  emi: Number(r.emi),
  paidN: Number(r.instalments_paid),
  outstanding: Number(r.outstanding),
  /* Never sanctioned means no date; the screens render the empty string. */
  sanctionedOn: (r.sanctioned_on as string | null) ?? '',
  status: TO_STATUS[r.status as string] ?? 'Pending Approval',
  reason: (r.reason as string) ?? '',
});

/**
 * A loan says what somebody earns and what they owe, so it is not team-visible
 * the way overtime is. Your own, or everything if you are finance.
 */
function scope(caller: Caller, params: unknown[]): string {
  if (caller.role === 'admin') return '';
  if (!caller.employeeId) throw new LoanError('this login has no employee record', 'forbidden');
  params.push(caller.employeeId);
  return `l.employee_id = $${params.length}`;
}

export async function listLoans(caller: Caller, status?: string): Promise<Loan[]> {
  const params: unknown[] = [];
  const where: string[] = [];

  const scoped = scope(caller, params);
  if (scoped) where.push(scoped);

  if (status) {
    const stored = Object.keys(TO_STATUS).filter((k) => TO_STATUS[k] === status);
    if (!stored.length) throw new LoanError(`unknown status: ${status}`, 'invalid');
    params.push(stored);
    where.push(`l.status = ANY($${params.length}::text[])`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY l.requested_on DESC, l.id`, params);
    return rows.map(toLoan);
  });
}

/**
 * Sanction a loan.
 *
 * Recovery starts from the next payroll cycle, which is why this stamps
 * `sanctioned_on` rather than taking a date: a loan sanctioned with a
 * backdated start would have payroll owing instalments nobody deducted.
 */
export async function approveLoan(caller: Caller, id: string): Promise<Loan> {
  if (caller.role !== 'admin' || !caller.employeeId) {
    throw new LoanError('only finance may sanction a loan', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const cur = await db.query(
      'SELECT id, employee_id, status, principal FROM loan WHERE id = $1 FOR UPDATE', [id]);
    const row = cur.rows[0];
    if (!row) throw new LoanError('no such loan', 'not_found');
    if (row.status !== 'pending') {
      throw new LoanError(`that loan is already ${row.status}`, 'already_decided');
    }
    if (row.employee_id === caller.employeeId) {
      throw new LoanError('you cannot sanction your own loan', 'self_approval');
    }

    await db.query(
      `UPDATE loan
          SET status = 'active', sanctioned_on = CURRENT_DATE, approver_id = $2,
              outstanding = principal
        WHERE id = $1`, [id, caller.employeeId]);

    await db.query(
      `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                              subject_table, subject_id, detail)
       SELECT 'payroll', 'loan_sanctioned', 'notice', $1, e.full_name, 'loan', $2,
              jsonb_build_object('principal', $3::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, id, String(row.principal)]);

    const back = await db.query(`${PROJECTION} WHERE l.id = $1`, [id]);
    return toLoan(back.rows[0]!);
  });
}
