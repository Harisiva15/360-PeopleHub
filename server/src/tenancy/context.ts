/**
 * Tenant context.
 *
 * Every query in this server runs inside `withTenant`. That is not a style
 * preference — it is the only place `app.tenant_id` is set, and without it the
 * row-level security policies raise rather than returning rows.
 *
 * The important detail is `set_config(..., is_local => true)`, which is SET
 * LOCAL: the setting lives for the transaction and is discarded on COMMIT or
 * ROLLBACK. A pooled connection therefore cannot carry one request's tenant
 * into the next request that borrows it, which is the classic way a
 * shared-pool multi-tenant service leaks.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.ts';

/** Who a request is acting as. Derived from the session, never from input. */
export interface Caller {
  tenantId: string;
  userId: string;
  /** The employee this login acts as. Null for an admin who is not on payroll. */
  employeeId: string | null;
  role: 'admin' | 'manager' | 'employee';
}

/** A database handle that is already inside a tenant-scoped transaction. */
export type TenantClient = PoolClient;

export class TenantContextError extends Error {}

/**
 * The transaction this request is already inside, if any.
 *
 * **Why this exists.** A service that inserts a row and then calls a `getX`
 * helper to return it was opening a *second* connection: withTenant took a
 * fresh one from the pool every time, so the helper ran outside the caller's
 * transaction and could not see the uncommitted row. It returned null, the
 * caller threw, and the throw rolled the insert back. Creating a user, a job
 * title, a saved report, a development plan, an event, a job order and a
 * software product all failed that way — every time, for everybody — while
 * typechecking cleanly, because both halves are correct on their own.
 *
 * The milder form is worse to find: after an UPDATE the row exists, so the
 * helper returned the values from *before* the change and nothing errored.
 * Eighteen call sites did that.
 *
 * **The tenant id is part of the key, and that is the whole safety argument.**
 * Reusing a connection means reusing its `app.tenant_id`, which is SET LOCAL
 * to the outer transaction. If a nested call belonged to a different tenant
 * and this reused the connection anyway, that call would silently read and
 * write the outer tenant's rows with row-level security none the wiser — it
 * would be doing exactly what the setting told it. So a mismatch opens a new
 * connection instead, which is correct and merely slower.
 */
const ambient = new AsyncLocalStorage<{ client: TenantClient; tenantId: string }>();

/** The open transaction for this tenant, or null if there is not one. */
const ambientFor = (tenantId: string): TenantClient | null => {
  const store = ambient.getStore();
  return store && store.tenantId === tenantId ? store.client : null;
};

/**
 * Run `fn` inside a transaction scoped to the caller's tenant.
 *
 * Everything the callback does is committed together or not at all, which is
 * what makes the multi-step guards honest: approving overtime credits comp off
 * in the same transaction, so a crash between them cannot leave one applied.
 */
export async function withTenant<T>(
  caller: Caller,
  fn: (db: TenantClient) => Promise<T>,
): Promise<T> {
  if (!caller.tenantId) throw new TenantContextError('no tenant on the caller');

  /*
   * Already inside a transaction for this same tenant: join it rather than
   * opening a second one. The callback sees its own uncommitted work, and the
   * whole request still commits or rolls back together — which is what the
   * outer caller already believed was happening.
   */
  const joined = ambientFor(caller.tenantId);
  if (joined) return fn(joined);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Parameterised, so a tenant id can never be concatenated into SQL.
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', caller.tenantId]);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.actor_id', caller.employeeId ?? '',
    ]);

    const result = await ambient.run({ client, tenantId: caller.tenantId }, () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it below is what matters.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Read-only variant. Marking the transaction READ ONLY means a handler that
 * was only supposed to look at something cannot quietly write.
 */
export async function withTenantReadOnly<T>(
  caller: Caller,
  fn: (db: TenantClient) => Promise<T>,
): Promise<T> {
  /*
   * Inside an existing transaction, join it and do *not* mark it read only.
   * SET TRANSACTION READ ONLY applies to the whole transaction, so setting it
   * here would demote the caller's write — and PostgreSQL refuses it outright
   * once a statement has run. A read nested in a write is a read either way.
   */
  const joined = ambientFor(caller.tenantId);
  if (joined) return fn(joined);

  return withTenant(caller, async (db) => {
    await db.query('SET TRANSACTION READ ONLY');
    return fn(db);
  });
}

/**
 * Escape hatch for the authentication module, which has to read
 * `tenant_membership` *before* it knows the tenant. Deliberately named to be
 * awkward and deliberately narrow: it runs without a tenant setting, so it
 * must only ever touch the platform tables that carry no policy.
 */
export async function withoutTenantForAuth<T>(
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* see above */
    }
    throw error;
  } finally {
    client.release();
  }
}
