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

/**
 * Refusals this module makes, typed so the HTTP layer can tell them apart.
 *
 * They were plain Errors, which statusFor does not recognise — so every one of
 * them left as a 500. Two are authorisation refusals, which meant the product
 * answered "internal error" to "you are not allowed to do that": still refused,
 * but reported as our fault and giving the caller nothing to act on.
 */
export class EmployeeError extends Error {
  constructor(message: string, readonly code: 'forbidden' | 'not_found' | 'invalid' = 'invalid') {
    super(message);
  }
}

import { scopeOf, reaches } from '../../auth/can.ts';
import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';
import { EMPLOYEE_PROJECTION, scopeClause } from './queries.ts';
import { toEmployee } from './mapper.ts';
import type { Employee, EmployeeRow } from './mapper.ts';

/**
 * Who sees a salary: compensation's readers, and the person it belongs to.
 *
 * Gated on `compensation`, not on `employees`. The sweep took the module from
 * the file it sits in, and this file is the directory — which asks "may you
 * read the staff list", a different and much more widely held thing than "may
 * you read what people are paid". `profile.ts` had the same defect and was
 * fixed; this copy was missed.
 *
 * It happens to grant the same set today, because exactly the three
 * administrative roles hold `employees` read all and `compensation` read all.
 * That is a coincidence of the current table, not the rule, and it stops being
 * true the moment anybody is given the directory without the payroll.
 */
const maySeePay = (caller: Caller, subjectId?: string | null): boolean =>
  reaches(caller, 'compensation', 'read', 'all') || (!!subjectId && subjectId === caller.employeeId);

/** A non-admin with no employee record has no scope at all. */
const hasScope = (caller: Caller): boolean =>
  reaches(caller, 'employees', 'read', 'all') || Boolean(caller.employeeId);

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
  const scope = scopeClause(scopeOf(caller, 'employees', 'read'), caller.employeeId);
  /*
   * Which rows is the directory's question; whether they carry a salary is
   * compensation's. This passed the directory scope in as the pay flag, which
   * is the same defect `maySeePay` had a few lines up.
   *
   * No self case here, deliberately: the list shows no pay to a caller who is
   * not a compensation reader, including their own row. Opening your own record
   * goes through `getEmployee`, which does take the self case — and that is
   * what the three-role code did too, so nothing changes about what anybody
   * sees today.
   */
  return query(caller, `e.status <> 'exited' AND (${scope.sql})`, scope.params,
    maySeePay(caller));
}

/** Everyone still employed, within the caller's scope. */
export async function listActiveEmployees(caller: Caller): Promise<Employee[]> {
  return listVisibleEmployees(caller);
}

/** Leavers — the directory can switch to them. Admin only; nobody else needs it. */
export async function listExitedEmployees(caller: Caller): Promise<Employee[]> {
  if (!reaches(caller, 'employees', 'read', 'all')) return [];
  /* Pay was hardcoded `true` here, so reading the leaver list was enough to
     read what the leavers were paid. Same question as everywhere else. */
  return query(caller, `e.status = 'exited'`, [], maySeePay(caller));
}

export async function getEmployee(caller: Caller, id: string): Promise<Employee | null> {
  if (!hasScope(caller)) return null;
  const scope = scopeClause(scopeOf(caller, 'employees', 'read'), caller.employeeId);
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
  const scope = scopeClause(scopeOf(caller, 'employees', 'read'), caller.employeeId);
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
  const scope = scopeClause(scopeOf(caller, 'employees', 'read'), caller.employeeId);
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
    /* Compensation's question, not the directory's — see `maySeePay`. */
    maySeePay(caller),
  );
}

/*
 * The composite behind the profile drawer lives in `./profile.ts`.
 *
 * It answered three fields here for a while — employee, manager, reports —
 * against a contract asking for eighteen, which is why the frontend never
 * mapped the method. Moving it out is what let it import payroll, leave,
 * assets and the rest without this file, which they all sit beneath, having to
 * know about any of them.
 */
export type { EmployeeProfile } from './profile.ts';
export { buildEmployeeProfile as getEmployeeProfile } from './profile.ts';

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
  /*
   * `users` write, not `employees` read.
   *
   * Assigning a role is user administration, which the access table gives to
   * company_admin alone. Gated on who may *read* the directory, this let
   * hr_admin and finance_admin change anybody's role — including promoting
   * somebody to company_admin, and so promoting themselves by way of a second
   * account. A read gate on a privilege write is the worst version of the
   * module mix-up the sweep introduced.
   *
   * `mayAssignRole` is the finer-grained test — it refuses granting
   * company_admin to anyone who is not one — and is not called here yet
   * because `Employee['role']` still carries the old three values. That lands
   * with the API vocabulary change, where the 400 for an old value goes.
   */
  if (!reaches(caller, 'users', 'write', 'all')) {
    throw new EmployeeError('only an administrator may change roles', 'forbidden');
  }
  if (id === caller.employeeId) {
    throw new EmployeeError('you cannot change your own role', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const updated = await db.query('UPDATE employee SET app_role = $1 WHERE id = $2', [role, id]);
    if (updated.rowCount === 0) throw new EmployeeError('no such employee', 'not_found');

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
    if (!after) throw new EmployeeError('no such employee', 'not_found');
    return after;
  });
}
