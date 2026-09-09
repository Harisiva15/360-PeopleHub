/**
 * Turning an approved person into an employee record.
 *
 * Two flows end here — a manager's joining request being approved, and an
 * onboarding journey completing — and they have to produce the same thing.
 * When this logic lived inside the joiners service, the second flow would have
 * grown its own copy, and the copies would have drifted at the first change:
 * one of them assigning a shift, the other not; one opening leave balances,
 * the other leaving a new joiner unable to apply for leave.
 *
 * So it lives here, takes an open transaction, and does the whole job or none
 * of it. The caller owns the transaction because provisioning is never the
 * only thing happening — the request or the journey has to be marked in the
 * same commit, or a refresh shows an employee created twice.
 */

import type { TenantClient } from '../../tenancy/context.ts';

export class ProvisionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ProvisionError';
    this.code = code;
  }
}

export interface ProvisionSpec {
  fullName: string;
  workEmail: string;
  joinedOn: string;
  /** Uuids, already resolved by the caller. Null where unknown. */
  departmentId?: string | null;
  siteId?: string | null;
  gradeId?: string | null;
  managerId?: string | null;
  designation?: string | null;
  employmentType?: string | null;
  /** Supplied by a request that carried one; generated otherwise. */
  code?: string | null;
}

/**
 * Create the employee, and open their leave balances.
 *
 * Returns the new id and the code actually used, because the caller usually
 * needs to write both into whatever record it is closing.
 */
export async function provisionEmployee(
  db: TenantClient,
  spec: ProvisionSpec,
): Promise<{ id: string; code: string }> {
  const entity = await db.query(
    'SELECT id, country FROM legal_entity WHERE is_default LIMIT 1');
  if (!entity.rows[0]) throw new ProvisionError('no default legal entity configured', 'invalid');

  /*
   * Everyone needs a shift, and the honest default is the one matching the
   * employing entity's country rather than whatever sorts first.
   */
  const shift = await db.query(
    `SELECT id FROM shift WHERE region = $1
      UNION ALL SELECT id FROM shift WHERE code = 'IN' LIMIT 1`, [entity.rows[0].country]);
  if (!shift.rows[0]) throw new ProvisionError('no shift configured to assign', 'invalid');

  // A code is generated when none was carried in. Sequential per tenant, so it
  // cannot collide with codes already in use.
  const code = spec.code ?? (await db.query(
    `SELECT 'VHM' || lpad((COALESCE(max(substring(code from '\\d+$')::int), 0) + 1)::text, 3, '0') AS next
       FROM employee WHERE code ~ '^VHM\\d+$'`)).rows[0].next as string;

  let id: string;
  try {
    const emp = await db.query(
      `INSERT INTO employee
         (code, full_name, work_email, legal_entity_id, joined_on, department_id,
          site_id, grade_id, shift_id, designation, manager_id, employment_type,
          app_role, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'employee',$13)
       RETURNING id`,
      [code, spec.fullName, spec.workEmail, entity.rows[0].id, spec.joinedOn,
        spec.departmentId ?? null, spec.siteId ?? null, spec.gradeId ?? null,
        shift.rows[0].id, spec.designation ?? null, spec.managerId ?? null,
        spec.employmentType ?? 'permanent',
        entity.rows[0].country === 'IN' ? 'INR' : 'USD']);
    id = emp.rows[0].id as string;
  } catch (e) {
    // The unique indexes on code and work email are the authority; this turns
    // them into something the caller can show rather than a 500.
    if ((e as { code?: string }).code === '23505') {
      throw new ProvisionError(
        'an employee already exists with that code or work email', 'duplicate');
    }
    throw e;
  }

  // Opening leave balances, or their first application has nothing to debit.
  await db.query(
    `INSERT INTO leave_balance (employee_id, leave_type_id, year_start, quota)
     SELECT $1, lt.id,
            make_date(CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= t.fiscal_year_start_month
                           THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
                           ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END,
                      t.fiscal_year_start_month, 1),
            lt.annual_quota
       FROM leave_type lt, tenant t
      WHERE lt.active AND t.id = current_tenant_id()
      ON CONFLICT DO NOTHING`, [id]);

  return { id, code };
}
