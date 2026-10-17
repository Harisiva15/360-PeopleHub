/**
 * Which of *this tenant's* people a caller may see.
 *
 * RLS keeps other tenants out and says nothing about this one: every row a
 * manager must not see belongs to their own tenant and passes the policy
 * cleanly. So role scope is a predicate in the query, and this is the
 * predicate.
 *
 * It was written out separately in `employees`, `assets` and `leave` before
 * this file existed — three copies of a recursive CTE that decides who can see
 * whose salary. Three copies of a boundary is two too many: the day somebody
 * fixes a bug in one of them is the day the other two become the hole. Those
 * three are left alone for now because changing working authorisation code is
 * not a thing to do in passing, but new modules use this.
 *
 * The recursion is deliberate. A manager sees their whole sub-tree, not just
 * their direct reports — a skip-level report is still in their line, and a
 * one-level query would quietly hide half a department from the person
 * accountable for it.
 */

import { reaches, scopeOf } from '../auth/can.ts';
import type { Verb } from '../auth/policy.ts';
import type { Caller } from './context.ts';

export interface Scope {
  /** A SQL boolean expression. `TRUE` for an administrator. */
  sql: string;
  /** Appended to the caller's parameter list; `sql` refers to them by position. */
  params: unknown[];
}

/**
 * Build the predicate for a column holding an employee id.
 *
 * `params` is the query's running parameter list and is appended to in place,
 * so this composes with other conditions rather than owning the whole WHERE.
 *
 *     const params: unknown[] = [somethingElse];
 *     const s = employeeScope(caller, 'p.employee_id', params);
 *     db.query(`... WHERE x = $1 AND (${s})`, params);
 */
/*
 * The three branches below were admin, employee and manager. They are the
 * three scopes: 'all' is every row, 'own' is the caller's, 'team' is their
 * line. The module decides which one applies, so the module is what this
 * now takes - and a module nobody has classified answers none, which is
 * FALSE here rather than TRUE.
 */
export function employeeScope(
  caller: Caller,
  column: string,
  params: unknown[],
  module: string,
  verb: Verb = 'read',
): string {
  const scope = scopeOf(caller, module, verb);
  if (scope === 'none') return 'FALSE';
  if (scope === 'all') return 'TRUE';

  /*
   * A non-admin with no employee record has no line and no self, so they see
   * nothing. Returning TRUE here — or an unparameterised comparison against
   * null — would turn a misconfigured account into an administrator.
   */
  if (!caller.employeeId) return 'FALSE';

  params.push(caller.employeeId);
  const p = `$${params.length}`;

  if (scope === 'own') return `${column} = ${p}`;

  return `(${column} = ${p} OR ${column} IN (
    WITH RECURSIVE line AS (
      SELECT id FROM employee WHERE manager_id = ${p}
      UNION ALL
      SELECT c.id FROM employee c JOIN line ON c.manager_id = line.id
    )
    SELECT id FROM line
  ))`;
}

/**
 * True where this caller could see that person at all.
 *
 * Nothing calls it. Left in place with the module it needs, rather than
  * deleted in the middle of a sweep, so whoever next reaches for it gets the
  * version that asks the policy.
 */
export function withinScope(
  caller: Caller,
  employeeId: string,
  module: string,
  verb: Verb = 'read',
): boolean {
  if (reaches(caller, module, verb, 'all')) return true;
  return caller.employeeId === employeeId;
}
