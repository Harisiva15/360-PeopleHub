/**
 * Reading and writing one tenant's permission narrowing.
 *
 * **Only an administrator, and only downwards.** The write path clamps every
 * value to what `policy.ts` grants before it reaches the database, so a
 * crafted request cannot store a widening even though `effectiveRule` would
 * ignore one anyway. Two layers for the same rule, deliberately: the read-side
 * clamp is what makes the system safe, and this one keeps the table honest — a
 * row saying an employee may read payroll would be wrong in the database even
 * if nothing acted on it, and somebody would eventually read it and believe it.
 */

import { withTenant } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import { POLICY, ROLES, effectiveRule, narrower, ruleFor } from '../../auth/policy.ts';
import type { ModuleRule, Role, Scope } from '../../auth/policy.ts';
import { forgetOverrides, overridesFor } from '../../auth/overrides.ts';

export class PermissionError extends Error {
  constructor(message: string, readonly kind: 'forbidden' | 'invalid' = 'invalid') {
    super(message);
  }
}

const SCOPES: Scope[] = ['none', 'own', 'team', 'all'];
const isScope = (v: unknown): v is Scope =>
  typeof v === 'string' && (SCOPES as string[]).includes(v);

export interface ModuleGrid {
  module: string;
  /** What the code allows — the most this tenant could ever grant. */
  ceiling: Record<Role, ModuleRule>;
  /** What this tenant currently allows, after its own narrowing. */
  effective: Record<Role, ModuleRule>;
}

const byRole = (fn: (r: Role) => ModuleRule): Record<Role, ModuleRule> =>
  ({ employee: fn('employee'), manager: fn('manager'), admin: fn('admin') });

/**
 * The whole grid, ceiling and effective side by side.
 *
 * Both, because a screen showing only the effective values would offer choices
 * the code silently refuses — somebody sets an employee to 'all' on payroll,
 * the request succeeds, and nothing changes. The ceiling is what lets the
 * screen grey those out instead of accepting them and doing nothing.
 */
export async function permissionGrid(caller: Caller): Promise<ModuleGrid[]> {
  if (caller.role !== 'admin') {
    throw new PermissionError('Only an administrator can read this', 'forbidden');
  }
  const overrides = await overridesFor(caller);
  return Object.keys(POLICY).sort().map((module) => ({
    module,
    ceiling: byRole((r) => ruleFor(r, module)),
    effective: byRole((r) => effectiveRule(r, module, overrides)),
  }));
}

export interface GridPatch {
  module: string;
  role: Role;
  read?: Scope;
  write?: Scope;
  approve?: Scope;
}

/**
 * Narrow a cell, or restore it towards the ceiling.
 *
 * A value above the ceiling is clamped rather than refused. Refusing would be
 * defensible, but the screen's own controls cannot produce one, so a request
 * carrying it is either a stale client or somebody probing — and clamping
 * gives both the same harmless outcome the read path would.
 */
export async function setPermissions(
  caller: Caller,
  patches: GridPatch[],
): Promise<ModuleGrid[]> {
  if (caller.role !== 'admin') {
    throw new PermissionError('Only an administrator can change permissions', 'forbidden');
  }
  if (!Array.isArray(patches) || patches.length === 0) {
    throw new PermissionError('Nothing to change');
  }
  if (patches.length > 200) {
    throw new PermissionError('Too many changes in one request');
  }

  for (const p of patches) {
    if (!POLICY[p.module]) throw new PermissionError(`No such module: ${p.module}`);
    if (!ROLES.includes(p.role)) throw new PermissionError(`No such role: ${p.role}`);
    for (const f of ['read', 'write', 'approve'] as const) {
      if (p[f] !== undefined && !isScope(p[f])) {
        throw new PermissionError(`${f} must be one of ${SCOPES.join(', ')}`);
      }
    }
    /*
     * The one cell an administrator may not close: the door they are standing
     * in. A tenant that removes administrators from Settings has no way to
     * undo it from inside the application, and the fix becomes a database
     * session somebody has to be talked through on the phone.
     */
    if (p.module === 'settings' && p.role === 'admin' && p.read === 'none') {
      throw new PermissionError(
        'Administrators cannot be removed from Settings — there would be no way '
        + 'back from inside the application', 'forbidden');
    }
  }

  await withTenant(caller, async (db) => {
    for (const p of patches) {
      const base = ruleFor(p.role, p.module);
      /*
       * The row as it stands, so a patch naming only `read` leaves write and
       * approve where they were rather than resetting them to the ceiling.
       */
      const { rows } = await db.query<{
        read_scope: Scope; write_scope: Scope; approve_scope: Scope;
      }>(
        `SELECT read_scope, write_scope, approve_scope
           FROM role_permission WHERE role = $1 AND module = $2`,
        [p.role, p.module]);
      const now = rows[0]
        ? { read: rows[0].read_scope, write: rows[0].write_scope, approve: rows[0].approve_scope }
        : base;

      const next: ModuleRule = {
        read: narrower(base.read, p.read ?? now.read),
        write: narrower(base.write, p.write ?? now.write),
        approve: narrower(base.approve, p.approve ?? now.approve),
      };

      await db.query(
        `INSERT INTO role_permission
           (tenant_id, role, module, read_scope, write_scope, approve_scope)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, role, module)
         DO UPDATE SET read_scope = EXCLUDED.read_scope,
                       write_scope = EXCLUDED.write_scope,
                       approve_scope = EXCLUDED.approve_scope`,
        [p.role, p.module, next.read, next.write, next.approve]);
    }

    await auditPermissions(db, caller, 'permissions.changed',
      { changes: patches.length, patches });
  });

  // So the administrator sees their own change instead of the cached minute.
  forgetOverrides(caller.tenantId);
  return permissionGrid(caller);
}

/** Restore every cell for one module to what the code grants. */
export async function resetModule(caller: Caller, module: string): Promise<ModuleGrid[]> {
  if (caller.role !== 'admin') {
    throw new PermissionError('Only an administrator can change permissions', 'forbidden');
  }
  if (!POLICY[module]) throw new PermissionError(`No such module: ${module}`);

  await withTenant(caller, async (db) => {
    // Deleting rather than rewriting to the ceiling: an absent row already
    // means "no narrowing", and one representation of that beats two.
    await db.query('DELETE FROM role_permission WHERE module = $1', [module]);
    await auditPermissions(db, caller, 'permissions.reset', { module });
  });

  forgetOverrides(caller.tenantId);
  return permissionGrid(caller);
}

/**
 * One audit row, in the shape the rest of the codebase writes.
 *
 * `tenant_id` is omitted because apply_tenant_isolation (migration 0014) gives
 * every isolated table a default of current_tenant_id(), and `actor_label` is
 * resolved here rather than passed: it keeps the name as it was on the day, so
 * a later rename does not rewrite history.
 *
 * Severity is 'warning' rather than the 'notice' most access events use. A
 * change to who can see what is the row somebody looks for after an incident.
 */
async function auditPermissions(
  db: TenantClient,
  caller: Caller,
  action: string,
  detail: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                            subject_table, detail)
     SELECT 'security', $1, 'warning', $2,
            COALESCE((SELECT full_name FROM employee WHERE id = $2), 'system'),
            'role_permission', $3::jsonb`,
    [action, caller.employeeId, JSON.stringify(detail)]);
}
