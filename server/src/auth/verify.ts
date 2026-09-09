/**
 * Token verification against Supabase's JWKS.
 *
 * This project signs with ES256 and publishes the public key at
 * /auth/v1/.well-known/jwks.json. Asymmetric signing is the better model: this
 * server only ever holds a *public* key, so a leak of everything it knows does
 * not let an attacker mint a token.
 *
 * An earlier version of this file verified HS256 by hand. That is deleted
 * rather than extended — its own comment said not to extend it, and
 * hand-rolling asymmetric verification with key rotation is exactly the kind
 * of thing that looks fine until the day it does not. `jose` does this one job
 * and is maintained.
 */

import { createRemoteJWKSet, jwtVerify, errors } from 'jose';
import type { JWTPayload } from 'jose';
import { config } from '../config.ts';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Fetches and caches the signing keys, and refetches when an unknown key id
 * appears — which is what makes Supabase's key rotation a non-event rather
 * than an outage. Built once, at module load, so the cache is shared.
 */
const jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
});

export interface SupabaseClaims extends JWTPayload {
  sub: string;
  email?: string;
  /** Set by Supabase once the address is confirmed. Never trust the address without it. */
  user_metadata?: { email_verified?: boolean };
  app_metadata?: { tenant_id?: string; app_role?: string };
}

/**
 * Verify a Supabase access token.
 *
 * Issuer and audience are pinned, not merely read. A signature check alone
 * proves the token came from *a* Supabase project — pinning the issuer proves
 * it came from ours, which matters because anyone can create a project.
 */
export async function verifyAccessToken(token: string): Promise<SupabaseClaims> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${config.supabaseUrl}/auth/v1`,
      audience: 'authenticated',
      // Supabase signs ES256; naming it stops an attacker proposing something
      // weaker in the header.
      algorithms: ['ES256', 'RS256'],
      clockTolerance: 5,
    });

    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new AuthError('token has no subject');
    }
    return payload as SupabaseClaims;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (e instanceof errors.JWTExpired) throw new AuthError('token expired');
    if (e instanceof errors.JWTClaimValidationFailed) {
      throw new AuthError(`token rejected: ${e.claim} claim is wrong`);
    }
    if (e instanceof errors.JWSSignatureVerificationFailed) {
      throw new AuthError('bad token signature');
    }
    if (e instanceof errors.JWKSNoMatchingKey) {
      throw new AuthError('token signed with an unknown key');
    }
    // Anything else — a malformed token, a JWKS endpoint that is down — is not
    // detailed back to the caller.
    throw new AuthError('token could not be verified');
  }
}
