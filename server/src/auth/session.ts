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
import { REFUSED, assertSecondFactorSatisfied as checkFactor } from './rules.ts';
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
  has_factor: boolean;
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
      // The factor flag rides along rather than costing a second round
      // trip: it is needed on every request, and a call this hot should
      // not become two.
      `SELECT tenant_id, role, employee_id, membership_status, tenant_status,
              auth_has_verified_factor($1) AS has_factor
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

  if (!row) throw new AuthError(await refusalReason(claims.sub));
  if (row.tenant_status === 'suspended' || row.tenant_status === 'closed') {
    throw new AuthError('tenant is not active');
  }
  // Rethrown as an AuthError so the HTTP layer maps it to 401 like every
  // other refusal here; the rule itself lives in rules.ts, testable without
  // a database.
  try {
    checkFactor(claims.aal, row.has_factor);
  } catch (e) {
    throw new AuthError(e instanceof Error ? e.message : 'second factor required');
  }

  return {
    tenantId: row.tenant_id,
    userId: claims.sub,
    employeeId: row.employee_id,
    role: row.role,
  };
}

/**
 * Why somebody with a valid token was refused.
 *
 * `auth_membership` filters to active memberships, so deactivating an account
 * takes effect on the very next request — the gate is the SQL, and it fails
 * closed whatever the application forgets. That is the right way round and it
 * is deliberately not moved up here.
 *
 * What it cost was the message. Every non-active status produced "no active
 * membership for this user", so somebody suspended, somebody awaiting approval
 * and somebody whose invitation had not been accepted all saw a sentence that
 * reads like a fault in the software. Each of those needs a different action
 * from the person reading it, and a vague refusal is paid for in support
 * tickets.
 *
 * So the reason is fetched only on the path where access has *already* been
 * refused. It cannot widen anything: by the time this runs the caller is
 * getting a 401 regardless, and the function it calls returns a status and
 * nothing else — no tenant, no role, no employee.
 */

async function refusalReason(userId: string): Promise<string> {
  try {
    const status = await withoutTenantForAuth(async (db) => {
      const { rows } = await db.query<{ status: string }>(
        'SELECT status FROM auth_membership_status($1) LIMIT 1', [userId]);
      return rows[0]?.status ?? null;
    });
    if (status && REFUSED[status]) return REFUSED[status];
  } catch {
    /* The lookup is for the wording only. If it fails, the refusal still stands. */
  }
  return 'no active membership for this user';
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

