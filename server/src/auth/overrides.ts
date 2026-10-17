/**
 * Reading one tenant's permission narrowing out of `role_permission`.
 *
 * **Cached, because this is on every request that asks.** Permissions change
 * when an administrator changes them, which is rarely; re-reading forty-five
 * rows on every call to price that in would be paying a lot for nothing. The
 * entry is dropped after a minute and whenever this process writes one, so the
 * worst staleness a person sees is a minute of the access they had before —
 * and the direction matters: a *narrowing* that takes a minute to apply is a
 * minute of the access the code already grants, not a minute of something new.
 *
 * **The cache is per process.** Two API instances can disagree for that
 * minute. Stated rather than solved: solving it means a shared cache or a
 * notification channel, and neither is worth it for a value that only ever
 * restricts and that the code's ceiling already bounds.
 */

import { withTenantReadOnly } from '../tenancy/context.ts';
import type { Caller } from '../tenancy/context.ts';
import type { Overrides, Role, Scope } from './policy.ts';

const TTL_MS = 60_000;

interface Entry { at: number; value: Overrides }
const cache = new Map<string, Entry>();

const SCOPES: Scope[] = ['none', 'own', 'team', 'all'];
const ROLE_NAMES: Role[] = ['employee', 'manager', 'admin'];

/** A value from the database is only a scope if it is one. */
const asScope = (v: unknown): Scope | undefined =>
  (typeof v === 'string' && (SCOPES as string[]).includes(v) ? v as Scope : undefined);

/**
 * This tenant's overrides, or an empty set.
 *
 * **Every failure produces `{}`, which means "no narrowing".** That looks like
 * failing open and is not: `{}` returns exactly what `policy.ts` grants, which
 * is the same answer the product gave before this table was read at all. The
 * alternative — treating an unreadable table as "deny everything" — would turn
 * a transient database error into every employee being locked out of every
 * screen, which is a far worse failure and a self-inflicted one.
 *
 * A row can only ever tighten the code's grant (see `effectiveRule`), so
 * losing rows cannot grant anything either.
 */
export async function overridesFor(caller: Caller): Promise<Overrides> {
  const hit = cache.get(caller.tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value: Overrides = {};
  try {
    value = await withTenantReadOnly(caller, async (db) => {
      const { rows } = await db.query<{
        role: string; module: string;
        read_scope: string; write_scope: string; approve_scope: string;
      }>('SELECT role, module, read_scope, write_scope, approve_scope FROM role_permission');

      const out: Overrides = {};
      for (const r of rows) {
        if (!(ROLE_NAMES as string[]).includes(r.role)) continue;
        const read = asScope(r.read_scope);
        const write = asScope(r.write_scope);
        const approve = asScope(r.approve_scope);
        // A row with nothing recognisable in it says nothing, rather than
        // saying "none" — an unparseable value must not silently revoke.
        if (!read && !write && !approve) continue;
        const byRole = out[r.module] ?? (out[r.module] = {});
        byRole[r.role as Role] = {
          ...(read ? { read } : {}),
          ...(write ? { write } : {}),
          ...(approve ? { approve } : {}),
        };
      }
      return out;
    });
  } catch {
    /* See above: no narrowing, which is the pre-existing behaviour. */
    value = {};
  }

  cache.set(caller.tenantId, { at: Date.now(), value });
  return value;
}

/** Called after a write, so an administrator sees their own change at once. */
export const forgetOverrides = (tenantId: string): void => { cache.delete(tenantId); };

/** For the checks, and for a test that wants a cold read. */
export const clearOverrideCache = (): void => { cache.clear(); };
