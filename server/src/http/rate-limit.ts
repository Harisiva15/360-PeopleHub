/**
 * Request rate limiting.
 *
 * Two buckets, because two different things are being protected.
 *
 * **Unauthenticated requests** are the ones worth being strict about: every
 * request without a usable token costs a JWKS verification, and a caller
 * guessing tokens is the shape of a brute-force attempt. These get a small
 * allowance.
 *
 * **Authenticated requests** are limited far more loosely. Somebody who has
 * signed in and is loading a busy screen can legitimately make a burst of
 * calls, and throttling them is a self-inflicted outage. The limit exists to
 * stop one session from monopolising the pool, not to police normal use.
 *
 * ## What this is not
 *
 * The counters live in this process's memory. Two instances behind a load
 * balancer each allow the full quota, so the effective limit is the limit
 * times the instance count. That is honest for a single-instance deployment
 * and needs Redis before it is more than one — writing it as though it were
 * distributed would be worse, because the number in the config would be a
 * number nobody could rely on.
 *
 * There is no cleanup timer. Buckets are pruned as they are read, so an idle
 * process holds nothing and a busy one holds one small object per active
 * caller.
 */

import { createHash } from 'node:crypto';

interface Bucket {
  count: number;
  /** When the window this bucket is counting started. */
  windowStart: number;
}

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** Anonymous callers: enough for a sign-in and a first page load, not a sweep. */
export const ANON: Limit = { max: 30, windowMs: 60_000 };

/** Signed-in callers: generous, because a dashboard fans out. */
export const AUTHED: Limit = { max: 600, windowMs: 60_000 };

const buckets = new Map<string, Bucket>();

/**
 * Cap on distinct keys held.
 *
 * Without it, a caller cycling source addresses would grow the map without
 * bound — the rate limiter becoming the denial of service it exists to
 * prevent. At the cap the oldest windows are dropped, which briefly forgives
 * whoever was quietest rather than whoever was loudest.
 */
const MAX_KEYS = 10_000;

function prune(now: number): void {
  if (buckets.size <= MAX_KEYS) return;
  const stale = [...buckets.entries()]
    .sort((a, b) => a[1].windowStart - b[1].windowStart)
    .slice(0, Math.floor(MAX_KEYS / 4));
  for (const [k] of stale) buckets.delete(k);
  void now;
}

export interface Verdict {
  allowed: boolean;
  /** Requests left in this window. */
  remaining: number;
  /** Seconds until the window resets — the Retry-After value. */
  resetSeconds: number;
}

/**
 * Count one request against `key` and say whether it may proceed.
 *
 * A fixed window rather than a sliding one: it can let through up to twice the
 * limit across a window boundary, which is a real weakness and an acceptable
 * one here. A sliding window needs per-request timestamps, and that is more
 * memory per caller than this is worth until there is evidence it matters.
 */
export function hit(key: string, limit: Limit, now = Date.now()): Verdict {
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= limit.windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    prune(now);
    return { allowed: true, remaining: limit.max - 1, resetSeconds: Math.ceil(limit.windowMs / 1000) };
  }

  bucket.count += 1;
  const resetSeconds = Math.max(1,
    Math.ceil((bucket.windowStart + limit.windowMs - now) / 1000));

  return {
    allowed: bucket.count <= limit.max,
    remaining: Math.max(0, limit.max - bucket.count),
    resetSeconds,
  };
}

/** Forget everything. For tests, so one does not leak into the next. */
export function reset(): void {
  buckets.clear();
}

/**
 * Who to count a request against.
 *
 * The token is preferred over the address: several people behind one office
 * NAT share an address, and limiting them as one caller would throttle a whole
 * floor because one person refreshed.
 *
 * The token is hashed, not truncated. Truncating it was the first attempt, and
 * a test caught that a token shorter than the slice survives whole — so the map
 * would hold real credentials for exactly the tokens least worth holding. A
 * hash tells sessions apart without ever storing one.
 *
 * `x-forwarded-for` is trusted only when TRUST_PROXY is set, because a header
 * the client controls is a header the client can rotate to reset its own
 * counter. Behind a load balancer it is the only real address available;
 * directly exposed, it is a bypass.
 */
export function keyFor(
  token: string | undefined,
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
  trustProxy = process.env.TRUST_PROXY === '1',
): string {
  if (token) {
    return `t:${createHash('sha256').update(token).digest('base64url').slice(0, 24)}`;
  }
  const forwarded = trustProxy && forwardedFor
    ? forwardedFor.split(',')[0]?.trim()
    : undefined;
  return `a:${forwarded || socketAddress || 'unknown'}`;
}
