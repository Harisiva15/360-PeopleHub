/**
 * Employees — the reference vertical slice.
 *
 * Two things this file exists to demonstrate.
 *
 * First, role scope is a SQL predicate here, never a filter applied after the
 * fact. RLS keeps other tenants out; it says nothing about which of *this*
 * tenant's employees a manager may see, so that is enforced below.
 *
 * Second, compensation and national identifiers are omitted from the query
 * when the caller may not see them. Not fetched and hidden — not fetched. A
 * field that never leaves the database cannot leak through a log line, an
 * error payload or a future serialisation bug.
 */

import { withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export interface EmployeeSummary {
  id: string;
  code: string;
  name: string;
  designation: string | null;
  departmentId: string | null;
  siteId: string | null;
  managerId: string | null;
  status: string;
  /** Present only when the caller may see compensation. */
  ctc?: string;
  currency?: string;
}

/** Who the caller may see, as a predicate rather than a post-filter. */
function scopePredicate(caller: Caller): { sql: string; params: unknown[] } {
  switch (caller.role) {
    case 'admin':
      return { sql: 'TRUE', params: [] };

    case 'manager':
      // Themselves plus everyone beneath them, to any depth.
      return {
        sql: `e.id = $1 OR e.id IN (
                WITH RECURSIVE reports AS (
                  SELECT id FROM employee WHERE manager_id = $1
                  UNION ALL
                  SELECT child.id FROM employee child
                    JOIN reports r ON child.manager_id = r.id
                )
                SELECT id FROM reports
              )`,
        params: [caller.employeeId],
      };

    case 'employee':
      return { sql: 'e.id = $1', params: [caller.employeeId] };
  }
}

/** May this caller see money and national identifiers? */
const maySeeCompensation = (caller: Caller, subjectId: string | null): boolean =>
  caller.role === 'admin' || (subjectId !== null && subjectId === caller.employeeId);

export async function listVisibleEmployees(caller: Caller): Promise<EmployeeSummary[]> {
  if (caller.role !== 'admin' && !caller.employeeId) {
    // A non-admin login with no employee record has no scope at all. Returning
    // everything here would be the bug.
    return [];
  }

  const scope = scopePredicate(caller);
  const showMoney = caller.role === 'admin';

  return withTenantReadOnly(caller, async (db: TenantClient) => {
    const { rows } = await db.query(
      `SELECT e.id,
              e.code,
              e.full_name,
              e.designation,
              e.department_id,
              e.site_id,
              e.manager_id,
              e.status
              ${showMoney ? ', e.ctc, e.currency' : ''}
         FROM employee e
        WHERE e.status <> 'exited'
          AND (${scope.sql})
        ORDER BY e.full_name`,
      scope.params,
    );

    return rows.map((r): EmployeeSummary => ({
      id: r.id,
      code: r.code,
      name: r.full_name,
      designation: r.designation,
      departmentId: r.department_id,
      siteId: r.site_id,
      managerId: r.manager_id,
      status: r.status,
      ...(showMoney ? { ctc: r.ctc, currency: r.currency } : {}),
    }));
  });
}

export interface EmployeeProfile extends EmployeeSummary {
  workEmail: string;
  joinedOn: string;
  managerName: string | null;
  reports: EmployeeSummary[];
  /** Masked hints only — never the identifier itself. */
  identifiers: { kind: string; hint: string | null }[];
}

export async function getEmployeeProfile(
  caller: Caller,
  employeeId: string,
): Promise<EmployeeProfile | null> {
  const scope = scopePredicate(caller);
  const showMoney = maySeeCompensation(caller, employeeId);

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT e.id, e.code, e.full_name, e.designation, e.department_id, e.site_id,
              e.manager_id, e.status, e.work_email, e.joined_on,
              m.full_name AS manager_name
              ${showMoney ? ', e.ctc, e.currency' : ''}
         FROM employee e
         LEFT JOIN employee m ON m.id = e.manager_id
        WHERE e.id = $${scope.params.length + 1}
          AND (${scope.sql})`,
      [...scope.params, employeeId],
    );

    const row = rows[0];
    if (!row) return null;

    const reports = await db.query(
      `SELECT id, code, full_name, designation, department_id, site_id, manager_id, status
         FROM employee WHERE manager_id = $1 AND status <> 'exited' ORDER BY full_name`,
      [employeeId],
    );

    // Hints only. The encrypted value is never selected here; a caller who
    // genuinely needs it goes through a separate, audited endpoint.
    const identifiers = await db.query(
      `SELECT kind, value_hint FROM employee_identifier WHERE employee_id = $1 ORDER BY kind`,
      [employeeId],
    );

    return {
      id: row.id,
      code: row.code,
      name: row.full_name,
      designation: row.designation,
      departmentId: row.department_id,
      siteId: row.site_id,
      managerId: row.manager_id,
      status: row.status,
      workEmail: row.work_email,
      joinedOn: row.joined_on,
      managerName: row.manager_name,
      ...(showMoney ? { ctc: row.ctc, currency: row.currency } : {}),
      reports: reports.rows.map((r): EmployeeSummary => ({
        id: r.id,
        code: r.code,
        name: r.full_name,
        designation: r.designation,
        departmentId: r.department_id,
        siteId: r.site_id,
        managerId: r.manager_id,
        status: r.status,
      })),
      identifiers: identifiers.rows.map((r) => ({ kind: r.kind, hint: r.value_hint })),
    };
  });
}
