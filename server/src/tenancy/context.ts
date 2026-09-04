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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Parameterised, so a tenant id can never be concatenated into SQL.
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', caller.tenantId]);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.actor_id', caller.employeeId ?? '',
    ]);

    const result = await fn(client);
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
