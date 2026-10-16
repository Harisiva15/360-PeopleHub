/**
 * What this caller may reach, resolved once per request.
 *
 * ## Why this exists
 *
 * 406 places compared `caller.role` to a string literal. Every one of them was
 * really asking one of two questions — *how far does my reach extend in this
 * module* or *may I perform this act* — and answering it by naming a role. That
 * worked while there were three roles in a straight line. It cannot survive
 * four roles where two are incomparable: `caller.role !== 'admin'` silently
 * means "and also not hr_admin and not finance_admin", which is the opposite of
 * what an administrative role is for.
 *
 * So the comparison goes away and the question is asked directly. `scope()`
 * answers the first, `mayAct()` the second, and `checks/role-gates.ts` fails the
 * build if a raw comparison reappears outside the policy.
 *
 * ## Resolved once, then synchronous
 *
 * Per-tenant narrowing lives in `role_permission` and reaching it is a database
 * read. Making `scope()` async would have put an `await` in front of 400 call
 * sites and inside SQL-building helpers that are not async at all — so the
 * caller's whole effective rule set is computed when the caller is built and
 * carried on it. The overrides read is already cached per process, so this
 * costs one map build per request over 46 modules.
 *
 * ## Fail closed
 *
 * An unknown module returns `none` for all three verbs. A typo in a module key
 * must deny, not default to something permissive: the alternative is a gate
 * that opens because somebody misspelled the thing it was guarding.
 */

import {
  POLICY, covers as coversScope, effectiveActionScope, effectiveRuleFor,
} from './policy.ts';
import type { ModuleRule, Overrides, Role, Scope, UserAction } from './policy.ts';

export type Verb = 'read' | 'write' | 'approve';

/** Nothing, for an unknown module. */
const DENY: ModuleRule = { read: 'none', write: 'none', approve: 'none' };

export interface Access {
  readonly role: Role;
  /** Whether anybody reports to this person, at any depth. */
  readonly hasReports: boolean;
  /** This caller's rule in one module. `none` throughout for an unknown one. */
  rule(module: string): ModuleRule;
  /** How far this caller reaches for one verb in one module. */
  scope(module: string, verb: Verb): Scope;
  /** Whether this caller's reach is at least `needed`. */
  covers(module: string, verb: Verb, needed: Scope): boolean;
  /** Whether this caller may perform an administrative act at all. */
  mayAct(action: UserAction): boolean;
  /** How far this caller reaches performing an administrative act. */
  actScope(action: UserAction): Scope;
}

/**
 * Build the snapshot.
 *
 * `overrides` is this tenant's narrowing, already read. Passing `{}` is the
 * no-narrowing case and is what every path that cannot reach the table uses —
 * see `overrides.ts` for why that is the safe direction rather than the lax one.
 */
export function buildAccess(
  role: Role,
  hasReports: boolean,
  overrides: Overrides,
): Access {
  /*
   * Precomputed, because a request asks about the same module repeatedly — a
   * list endpoint asks for read, then builds a SQL scope from the same answer,
   * then checks write on each row it is about to touch.
   */
  const rules = new Map<string, ModuleRule>();
  for (const module of Object.keys(POLICY)) {
    rules.set(module, effectiveRuleFor(role, hasReports, module, overrides));
  }

  const rule = (module: string): ModuleRule => rules.get(module) ?? DENY;

  return {
    role,
    hasReports,
    rule,
    scope: (module, verb) => rule(module)[verb],
    covers: (module, verb, needed) => coversScope(rule(module)[verb], needed),
    mayAct: (action) => effectiveActionScope(role, hasReports, action) !== 'none',
    actScope: (action) => effectiveActionScope(role, hasReports, action),
  };
}

/**
 * The denying snapshot, for a caller with no usable membership.
 *
 * Used where a `Caller` has to exist before anything is known about it. It
 * grants nothing, which is the only safe value for a half-built caller.
 */
export const NO_ACCESS: Access = {
  role: 'employee',
  hasReports: false,
  rule: () => DENY,
  scope: () => 'none',
  covers: () => false,
  mayAct: () => false,
  actScope: () => 'none',
};
