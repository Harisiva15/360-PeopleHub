/**
 * Authentication against Supabase Auth.
 *
 * Supabase issues the JWT; this module verifies it and turns it into a Caller.
 *
 * The important decision here: the token is trusted for *identity* and nothing
 * else. `sub` says which auth.users row is calling, and that is all we take
 * from it. The tenant and the role are read from tenant_membership on every
 * request, because a JWT is a cached copy of a decision and roles change — a
 * manager demoted an hour ago still holds a token that says "manager". Reading
 * the membership costs one indexed lookup inside a transaction we were opening
 * anyway, and it means revocation takes effect on the next request rather than
 * at token expiry.
 *
 * The `tenant_id` claim is used only to choose *which* membership when someone
 * belongs to several. It can never widen access beyond what the table says.
 */

import { verifyAccessToken, AuthError } from './verify.ts';
import type { SupabaseClaims } from './verify.ts';
import { withoutTenantForAuth } from '../tenancy/context.ts';
import type { Caller } from '../tenancy/context.ts';

export { AuthError };
export type { SupabaseClaims };

interface MembershipRow {
  tenant_id: string;
  role: Caller['role'];
  employee_id: string | null;
  membership_status: string;
  tenant_status: string;
}

/**
 * Resolve a bearer token to a caller.
 *
 * This is the only place a Caller is constructed. Nothing downstream may take
 * a tenant id, a role or an employee id from a request body or a header — that
 * is what turns a multi-tenant API into a shared database with extra steps.
 */
export async function callerFromToken(token: string | undefined): Promise<Caller> {
  if (!token) throw new AuthError('no bearer token');

  const claims = await verifyAccessToken(token);
  const preferredTenant = claims.app_metadata?.tenant_id ?? null;

  const row = await withoutTenantForAuth(async (db) => {
    // auth_membership is a SECURITY DEFINER function, and deliberately so:
    // this read happens before any tenant is established, which is exactly
    // what the row-level policy on tenant_membership denies. See migration
    // 0011 for why a narrow function beats a wider policy here.
    const result = await db.query<MembershipRow>(
      `SELECT tenant_id, role, employee_id, membership_status, tenant_status
         FROM auth_membership($1)
        WHERE ($2::uuid IS NULL OR tenant_id = $2::uuid)
        ORDER BY (tenant_id = $2::uuid) DESC
        LIMIT 1`,
      [claims.sub, preferredTenant],
    );
    return result.rows[0] ?? null;
  });

  /*
   * No membership yet. If their verified address matches exactly one unlinked
   * active employee, this is a first sign-in after HR added them — link it and
   * carry on. Anything ambiguous returns nothing and the error below stands.
   */
  if (!row && claims.email && claims.user_metadata?.email_verified) {
    const claimed = await withoutTenantForAuth(async (db) => {
      const r = await db.query<MembershipRow>(
        `SELECT tenant_id, role, employee_id, membership_status, tenant_status
           FROM auth_claim_membership($1, $2::citext)`,
        [claims.sub, claims.email],
      );
      return r.rows[0] ?? null;
    });
    if (claimed) {
      return {
        tenantId: claimed.tenant_id,
        userId: claims.sub,
        employeeId: claimed.employee_id,
        role: claimed.role,
      };
    }
  }

  if (!row) throw new AuthError('no active membership for this user');
  if (row.tenant_status === 'suspended' || row.tenant_status === 'closed') {
    throw new AuthError('tenant is not active');
  }

  return {
    tenantId: row.tenant_id,
    userId: claims.sub,
    employeeId: row.employee_id,
    role: row.role,
  };
}

/** Every tenant a user may enter, for a tenant picker. */
export async function membershipsFor(
  userId: string,
): Promise<{ tenantId: string; slug: string; name: string; role: string }[]> {
  return withoutTenantForAuth(async (db) => {
    const { rows } = await db.query(
      `SELECT tenant_id, tenant_slug, tenant_name, role
         FROM auth_membership($1)
        WHERE tenant_status IN ('trial', 'active')`,
      [userId],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      slug: r.tenant_slug,
      name: r.tenant_name,
      role: r.role,
    }));
  });
}
