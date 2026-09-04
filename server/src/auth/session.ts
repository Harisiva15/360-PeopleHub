/**
 * Sessions.
 *
 * Tokens here are opaque random strings, not JWTs. The trade is deliberate: a
 * JWT saves a database read per request, but this product needs revocation to
 * be immediate — an admin who is dismissed must lose access now, not in
 * fifteen minutes — and every request already opens a transaction. So the
 * lookup is nearly free, and "log everyone out" is one UPDATE.
 *
 * The token is stored hashed. A leaked database backup then does not hand the
 * attacker live sessions.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withoutTenantForAuth } from '../tenancy/context.ts';
import type { Caller } from '../tenancy/context.ts';
import { config } from '../config.ts';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Opaque 256-bit token, URL-safe. */
export const mintToken = (): string => randomBytes(32).toString('base64url');

/**
 * Hash for storage. Peppered with a server-side secret so the hashes are
 * useless without it, and SHA-256 rather than a slow KDF because the input is
 * already 256 bits of entropy — there is nothing to brute-force.
 */
const hashToken = (token: string): string =>
  createHash('sha256').update(`${config.tokenPepper}:${token}`).digest('hex');

const sameHash = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
};

interface SessionRow {
  user_id: string;
  tenant_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  role: Caller['role'];
  employee_id: string | null;
  membership_status: string;
  tenant_status: string;
}

/**
 * Resolve a bearer token to a caller.
 *
 * This is the only place a Caller is constructed. Nothing downstream may take
 * a tenant id, a role or an employee id from the request body or a header —
 * that is what turns a multi-tenant API into a single shared database with
 * extra steps.
 */
export async function callerFromToken(token: string | undefined): Promise<Caller> {
  if (!token) throw new AuthError('no bearer token');

  const candidateHash = hashToken(token);

  const row = await withoutTenantForAuth(async (db) => {
    const result = await db.query<SessionRow>(
      `SELECT s.user_id,
              s.tenant_id,
              s.refresh_token_hash,
              s.expires_at,
              s.revoked_at,
              m.role,
              m.employee_id,
              m.status AS membership_status,
              t.status AS tenant_status
         FROM user_session s
         JOIN tenant_membership m
           ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
         JOIN tenant t ON t.id = s.tenant_id
        WHERE s.refresh_token_hash = $1
        LIMIT 1`,
      [candidateHash],
    );
    return result.rows[0] ?? null;
  });

  // Compare again in constant time. The lookup above is an index probe on the
  // hash, so this adds nothing on the happy path and removes a timing signal.
  if (!row || !sameHash(row.refresh_token_hash, candidateHash)) {
    throw new AuthError('unknown session');
  }
  if (row.revoked_at) throw new AuthError('session revoked');
  if (row.expires_at.getTime() <= Date.now()) throw new AuthError('session expired');
  if (row.membership_status !== 'active') throw new AuthError('membership is not active');
  if (row.tenant_status === 'suspended' || row.tenant_status === 'closed') {
    throw new AuthError('tenant is not active');
  }

  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    employeeId: row.employee_id,
    role: row.role,
  };
}

/** Issue a session for a user against one of their tenants. */
export async function createSession(
  userId: string,
  tenantId: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = mintToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86_400_000);

  await withoutTenantForAuth(async (db) => {
    const membership = await db.query(
      `SELECT 1 FROM tenant_membership
        WHERE user_id = $1 AND tenant_id = $2 AND status = 'active'`,
      [userId, tenantId],
    );
    if (membership.rowCount === 0) throw new AuthError('no active membership for that tenant');

    await db.query(
      `INSERT INTO user_session (user_id, tenant_id, refresh_token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, tenantId, hashToken(token), expiresAt, meta.ip ?? null, meta.userAgent ?? null],
    );
  });

  return { token, expiresAt };
}

/** Revoke one session, or every session a user holds. */
export async function revokeSessions(userId: string, token?: string): Promise<number> {
  return withoutTenantForAuth(async (db) => {
    const result = token
      ? await db.query(
          `UPDATE user_session SET revoked_at = now()
            WHERE user_id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL`,
          [userId, hashToken(token)],
        )
      : await db.query(
          `UPDATE user_session SET revoked_at = now()
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        );
    return result.rowCount ?? 0;
  });
}
