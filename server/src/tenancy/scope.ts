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
import type { Caller, TenantClient } from './context.ts';

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
 * May this caller act on this person, under this module and verb?
 *
 * The three scopes, answered properly:
 *
 *     all    anybody
 *     team   this caller's reporting line, to any depth — read from the tree
 *     own    themselves, and only if the module grants them `own`
 *
 * Asynchronous because the team case cannot be answered any other way:
 * whether somebody is on your line is a fact about `employee.manager_id`, not
 * something a scope comparison can decide. `reachesPerson` in `auth/can.ts`
 * returns false for that case deliberately and points here.
 *
 * This replaces a synchronous stub of the same intent that nothing called,
 * and which silently refused every team case — the shape of guard that let
 * four modules fall back on `|| caller.hasReports` instead.
 */
export async function personInScope(
  db: TenantClient,
  caller: Caller,
  employeeId: string,
  module: string,
  verb: Verb = 'read',
): Promise<boolean> {
  if (reaches(caller, module, verb, 'all')) return true;
  if (caller.employeeId !== null && caller.employeeId === employeeId) {
    return reaches(caller, module, verb, 'own');
  }
  /*
   * Somebody else. Only the team scope can reach them, and only if they are
   * actually on this caller's line — which is a question for the tree, not for
   * a scope comparison. `reachesPerson` in auth/can.ts returns false here on
   * purpose and says to come to the database; this is that.
   */
  if (!reaches(caller, module, verb, 'team')) return false;
  if (!caller.employeeId) return false;
  const r = await db.query(
    `WITH RECURSIVE t AS (
       SELECT id FROM employee WHERE manager_id = $1
       UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
     ) SELECT 1 FROM t WHERE id = $2`,
    [caller.employeeId, employeeId],
  );
  return (r.rowCount ?? 0) > 0;
}
