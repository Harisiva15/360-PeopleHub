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

import { createHmac, timingSafeEqual } from 'node:crypto';
import { withoutTenantForAuth } from '../tenancy/context.ts';
import type { Caller } from '../tenancy/context.ts';
import { config } from '../config.ts';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

interface SupabaseClaims {
  sub: string;
  exp: number;
  /** Set with the service role only; a user cannot edit their own. */
  app_metadata?: { tenant_id?: string; app_role?: string };
}

const b64urlToBuffer = (input: string): Buffer =>
  Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Verify a Supabase HS256 JWT.
 *
 * Hand-rolled deliberately narrowly: the algorithm is pinned to HS256 and
 * anything else is rejected outright, which closes the two classic holes —
 * `alg: none`, and an RS256 token replayed as HS256 with the public key as the
 * HMAC secret.
 *
 * Projects using Supabase's newer asymmetric signing keys (ES256/RS256 with a
 * JWKS endpoint) cannot use this path. Verify against the JWKS with a
 * maintained library instead; do not extend this function to cover it.
 */
function verifyJwt(token: string): SupabaseClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');

  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(b64urlToBuffer(headerPart).toString('utf8'));
  } catch {
    throw new AuthError('malformed token header');
  }
  if (header.alg !== 'HS256') throw new AuthError(`unsupported token algorithm ${header.alg}`);

  const expected = createHmac('sha256', config.supabaseJwtSecret)
    .update(`${headerPart}.${payloadPart}`)
    .digest();
  const provided = b64urlToBuffer(signaturePart);

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new AuthError('bad token signature');
  }

  let claims: SupabaseClaims;
  try {
    claims = JSON.parse(b64urlToBuffer(payloadPart).toString('utf8'));
  } catch {
    throw new AuthError('malformed token payload');
  }

  if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('token has no subject');
  if (typeof claims.exp !== 'number') throw new AuthError('token has no expiry');
  // Seconds, per the JWT spec. A small skew allowance would go here if clocks
  // between Supabase and this server ever proved to be a problem.
  if (claims.exp * 1000 <= Date.now()) throw new AuthError('token expired');

  return claims;
}

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

  const claims = verifyJwt(token);
  const preferredTenant = claims.app_metadata?.tenant_id ?? null;

  const row = await withoutTenantForAuth(async (db) => {
    const result = await db.query<MembershipRow>(
      `SELECT m.tenant_id,
              m.role,
              m.employee_id,
              m.status AS membership_status,
              t.status AS tenant_status
         FROM tenant_membership m
         JOIN tenant t ON t.id = m.tenant_id
        WHERE m.user_id = $1
          AND m.status = 'active'
          AND ($2::uuid IS NULL OR m.tenant_id = $2::uuid)
        ORDER BY (m.tenant_id = $2::uuid) DESC
        LIMIT 1`,
      [claims.sub, preferredTenant],
    );
    return result.rows[0] ?? null;
  });

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
      `SELECT m.tenant_id, t.slug, t.display_name, m.role
         FROM tenant_membership m
         JOIN tenant t ON t.id = m.tenant_id
        WHERE m.user_id = $1 AND m.status = 'active' AND t.status IN ('trial', 'active')
        ORDER BY t.display_name`,
      [userId],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      slug: r.slug,
      name: r.display_name,
      role: r.role,
    }));
  });
}
