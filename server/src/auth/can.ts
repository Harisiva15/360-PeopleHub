/**
 * What a caller reaches, asked synchronously.
 *
 * ## Why this exists
 *
 * Before the cutover, 192 sites across 47 services asked `caller.role ===
 * 'admin'`. That question cannot be renamed into the four-role model: 'admin'
 * became `company_admin`, and rewriting it that way would have handed
 * `hr_admin` and `finance_admin` nothing on the modules the access table gives
 * them outright. It has to become a question about a module and a verb.
 *
 * So each of those sites now says what it actually means:
 *
 *     if (!reaches(caller, 'payroll', 'read', 'all')) throw forbidden
 *
 * ## Why it does not consult the tenant's narrowing
 *
 * `role_permission` can narrow what a role reaches, and this deliberately does
 * not read it. The narrowing is applied once per request in the HTTP layer,
 * which refuses the whole module before any handler runs — see the module gate
 * in http/app.ts, whose comment sets out the division: the boundary answers
 * "may this role open this module at all", and the service answers whether a
 * particular act inside it is allowed.
 *
 * Reading the override table here would mean an await at every one of those
 * 192 sites, for an answer the request has already been refused on. It would
 * also be the wrong shape: a tenant switching a module off is a preference
 * about the whole module, not a per-act rule.
 *
 * That division is why this can be synchronous, and being synchronous is why
 * the sweep is a rewrite of conditions rather than of every function signature.
 */

import { covers as coversScope, effectiveFor } from './policy.ts';
import type { Scope, Verb } from './policy.ts';
import type { Caller } from '../tenancy/context.ts';

/**
 * How far this caller reaches for one verb in one module.
 *
 * The union of their role and, where they have reports, the manager layer —
 * `max(employee, hasReports ? manager : none, role)`. An unknown module answers
 * `none`, so a module nobody has classified is not readable by accident.
 */
export const scopeOf = (
  caller: Caller,
  module: string,
  verb: Verb,
): Scope => effectiveFor(caller.role, caller.hasReports, module)[verb];

/**
 * Does this caller reach at least `needed` on this module and verb?
 *
 * The question nearly every guard wants. `needed` is usually `'all'` for a
 * whole-company surface and `'own'` for somebody's own record; `'team'` is the
 * reporting line, which is what makes a manager's reach expressible at all.
 */
export const reaches = (
  caller: Caller,
  module: string,
  verb: Verb,
  needed: Scope,
): boolean => coversScope(scopeOf(caller, module, verb), needed);

/**
 * Whether this caller may act on `empId` under this module and verb.
 *
 * The shape `assertOwnOrAdmin` had, generalised. Three outcomes rather than
 * two, because the middle one is the whole point of the model:
 *
 *   all    anybody's record
 *   team   handled by the caller — this cannot answer it without the tree, so
 *          it returns false and the caller narrows its own query instead
 *   own    their own record and nobody else's
 *
 * A guard that wants the team case asks `reaches(c, m, v, 'team')` and then
 * scopes its SQL, which is the only honest way round: whether somebody is on
 * your line is a question for the database, not for a scope comparison.
 */
export const reachesPerson = (
  caller: Caller,
  module: string,
  verb: Verb,
  empId: string,
): boolean => {
  if (reaches(caller, module, verb, 'all')) return true;
  return caller.employeeId !== null && caller.employeeId === empId
    && reaches(caller, module, verb, 'own');
};
