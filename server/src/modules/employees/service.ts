/**
 * Employees — the reference vertical slice.
 *
 * Two things this file exists to demonstrate.
 *
 * First, role scope is a SQL predicate, never a filter applied after the rows
 * arrive. RLS keeps other tenants out; it says nothing about which of *this*
 * tenant's people a manager may see, so that is enforced in the query.
 *
 * Second, compensation is omitted from the SELECT when the caller may not see
 * it. Not fetched and hidden — not fetched. A field that never leaves the
 * database cannot leak through a log line, an error payload or a future
 * serialisation bug.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';
import { EMPLOYEE_PROJECTION, scopeClause } from './queries.ts';
import { toEmployee } from './mapper.ts';
import type { Employee, EmployeeRow } from './mapper.ts';

/** Only an admin sees anyone's pay; anyone may see their own. */
const maySeePay = (caller: Caller, subjectId?: string | null): boolean =>
  caller.role === 'admin' || (!!subjectId && subjectId === caller.employeeId);

/** A non-admin with no employee record has no scope at all. */
const hasScope = (caller: Caller): boolean =>
  caller.role === 'admin' || Boolean(caller.employeeId);

async function query(
  caller: Caller,
  where: string,
  params: unknown[],
  showPay: boolean,
): Promise<Employee[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<EmployeeRow>(
      `${EMPLOYEE_PROJECTION} WHERE ${where} ORDER BY e.full_name`,
      params,
    );
    return rows.map((r) => toEmployee(r, showPay));
  });
}

/** Everyone the caller may see. */
export async function listVisibleEmployees(caller: Caller): Promise<Employee[]> {
  if (!hasScope(caller)) return [];
  const scope = scopeClause(caller.role, caller.employeeId);
  return query(caller, `e.status <> 'exited' AND (${scope.sql})`, scope.params,
    caller.role === 'admin');
}

/** Everyone still employed, within the caller's scope. */
export async function listActiveEmployees(caller: Caller): Promise<Employee[]> {
  return listVisibleEmployees(caller);
}

/** Leavers — the directory can switch to them. Admin only; nobody else needs it. */
export async function listExitedEmployees(caller: Caller): Promise<Employee[]> {
  if (caller.role !== 'admin') return [];
  return query(caller, `e.status = 'exited'`, [], true);
}

export async function getEmployee(caller: Caller, id: string): Promise<Employee | null> {
  if (!hasScope(caller)) return null;
  const scope = scopeClause(caller.role, caller.employeeId);
  const rows = await query(
    caller,
    `e.id = $${scope.params.length + 1} AND (${scope.sql})`,
    [...scope.params, id],
    maySeePay(caller, id),
  );
  return rows[0] ?? null;
}

/**
 * Resolve a set of ids in one call.
 *
 * Screens hold rows that reference people by id and need names for them. This
 * exists so a directory is one query rather than one per row — the difference
 * between a page that loads and one that hammers the API.
 */
export async function getEmployeesByIds(caller: Caller, ids: string[]): Promise<Employee[]> {
  if (!hasScope(caller) || ids.length === 0) return [];
  const scope = scopeClause(caller.role, caller.employeeId);
  return query(
    caller,
    `e.id = ANY($${scope.params.length + 1}::uuid[]) AND (${scope.sql})`,
    [...scope.params, ids],
    false,
  );
}

/** Direct reports, or the whole sub-tree when `deep`. */
export async function getTeam(
  caller: Caller,
  managerId: string,
  deep = false,
): Promise<Employee[]> {
  if (!hasScope(caller)) return [];
  const scope = scopeClause(caller.role, caller.employeeId);
  const subtree = deep
    ? `e.id IN (
         WITH RECURSIVE t AS (
           SELECT id FROM employee WHERE manager_id = $${scope.params.length + 1}
           UNION ALL
           SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
         ) SELECT id FROM t
       )`
    : `e.manager_id = $${scope.params.length + 1}`;

  return query(
    caller,
    `e.status <> 'exited' AND ${subtree} AND (${scope.sql})`,
    [...scope.params, managerId],
    caller.role === 'admin',
  );
}

export interface EmployeeProfile {
  employee: Employee;
  managerName: string;
  reports: Employee[];
}

/** The composite behind the profile drawer — one response, not fourteen calls. */
export async function getEmployeeProfile(
  caller: Caller,
  id: string,
): Promise<EmployeeProfile | null> {
  const employee = await getEmployee(caller, id);
  if (!employee) return null;

  const [manager, reports] = await Promise.all([
    employee.managerId ? getEmployee(caller, employee.managerId) : Promise.resolve(null),
    getTeam(caller, id),
  ]);

  return { employee, managerName: manager?.name ?? '', reports };
}

/**
 * Change someone's role.
 *
 * Writes to `employee.app_role` and to the membership, because the membership
 * is what authorises a request — updating only the employee row would change
 * what the screen displays and nothing about what the person can actually do.
 */
export async function setEmployeeRole(
  caller: Caller,
  id: string,
  role: Employee['role'],
): Promise<Employee> {
  if (caller.role !== 'admin') throw new Error('only an admin may change roles');
  if (id === caller.employeeId) throw new Error('you cannot change your own role');

  return withTenant(caller, async (db) => {
    const updated = await db.query('UPDATE employee SET app_role = $1 WHERE id = $2', [role, id]);
    if (updated.rowCount === 0) throw new Error('no such employee');

    // tenant_membership sits outside the isolation policy, so it is filtered
    // by tenant explicitly here.
    await db.query(
      `UPDATE tenant_membership SET role = $1
        WHERE employee_id = $2 AND tenant_id = current_tenant_id()`,
      [role, id]);

    await db.query(
      `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                              subject_table, subject_id, detail)
       SELECT 'access', 'role_changed', 'warning', $1, COALESCE(e.full_name, 'system'),
              'employee', $2, jsonb_build_object('role', $3::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, id, role]);

    const after = await getEmployee(caller, id);
    if (!after) throw new Error('no such employee');
    return after;
  });
}
