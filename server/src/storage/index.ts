/**
 * The one place this server puts bytes anywhere but Postgres.
 *
 * `document` has carried `storage_key`, `mime_type`, `size_bytes`, `checksum`
 * and `purged_at` since migration 0007, with a comment saying the bytes live in
 * object storage and the key is opaque to everything but a storage adapter.
 * This is that adapter; until now nothing in the codebase called Supabase
 * Storage at all.
 *
 * **Why REST rather than the SDK**, as in `auth/adminApi.ts`:
 * `@supabase/supabase-js` would be a new dependency and a client object with
 * far more reach than this needs — a whole database and auth API on the same
 * credential. Three `fetch` calls are the entire requirement.
 *
 * **The bucket is private.** Nothing is served from it directly. `signedUrl`
 * mints a short-lived URL for one object per request and stores none of them,
 * so a URL that leaks stops working on its own rather than being a standing
 * grant. Supabase's own `storage.objects` policies are a second layer under
 * this and are not a substitute for it: the service key bypasses them.
 *
 * **What a caller states and what this enforces.** Every `put` names its own
 * byte cap and its own list of accepted types, because the policies differ —
 * a company logo is not a payslip. This then enforces three things the caller
 * cannot be trusted to have checked:
 *
 *   the size, against that cap, measured from the bytes rather than a header;
 *   the declared type, against the bytes' own magic number, so a `.png` that
 *     is really something else is refused rather than stored and served back
 *     with a lying content type;
 *   the key, which is generated here and never taken from a caller.
 *
 * **Keys are `<prefix>/<tenant>/<uuid>`** and carry nothing about the person.
 * A key built from an employee id would let anybody holding one URL guess the
 * next, and `document.storage_key` is unique per tenant precisely so the key
 * can be treated as the identifier it is.
 */

import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.ts';

export class StorageError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

/** Where in the bucket something belongs. One per feature that stores bytes. */
export type StoragePrefix = 'branding' | 'photos' | 'documents';

export interface PutRequest {
  prefix: StoragePrefix;
  tenantId: string;
  bytes: Buffer;
  /** What the caller says it is. Verified against the bytes before storing. */
  mimeType: string;
  /** The largest this particular kind of upload may be. */
  maxBytes: number;
  /** The types this particular kind of upload may be. */
  allow: readonly string[];
}

export interface PutResult {
  /** Opaque. The only handle to the bytes, and what `document.storage_key` holds. */
  storageKey: string;
  /** sha256 of exactly the bytes stored, for `document.checksum`. */
  checksum: string;
  sizeBytes: number;
  mimeType: string;
}

export interface Storage {
  put(req: PutRequest): Promise<PutResult>;
  /** A URL that works for `expiresInSeconds` and then does not. */
  signedUrl(storageKey: string, expiresInSeconds: number): Promise<string>;
  remove(storageKey: string): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * What the bytes actually are
 * ------------------------------------------------------------------ */

/**
 * The magic numbers for the types this product stores.
 *
 * Checked because a declared content type is a claim by whoever is uploading.
 * Storing an executable under `image/png` and handing back a signed URL for it
 * is how a file store becomes a way to serve arbitrary content from a trusted
 * origin. The check is cheap and the cost of skipping it is not.
 */
const MAGIC: ReadonlyArray<{ mime: string; bytes: readonly number[] }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  /* JPEG's first three bytes are fixed; the fourth varies by segment marker. */
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

/** The type the bytes really are, or null if it is not one we store. */
export function sniff(bytes: Buffer): string | null {
  for (const { mime, bytes: sig } of MAGIC) {
    if (bytes.length < sig.length) continue;
    if (sig.every((b, i) => bytes[i] === b)) return mime;
  }
  return null;
}

/**
 * Check a request without storing anything.
 *
 * Separate from `put` so the rules can be asserted — and read — without a
 * bucket, a network or a credential. `put` calls it first and does nothing
 * else until it passes.
 */
export function validate(req: PutRequest): void {
  if (!req.bytes.length) {
    throw new StorageError('That file is empty', 'empty');
  }
  if (req.bytes.length > req.maxBytes) {
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
    throw new StorageError(
      `That file is ${mb(req.bytes.length)} and the limit is ${mb(req.maxBytes)}`,
      'too_large');
  }
  if (!req.allow.includes(req.mimeType)) {
    throw new StorageError(
      `${req.mimeType} is not accepted here — ${req.allow.join(' or ')}`,
      'wrong_type');
  }
  const actual = sniff(req.bytes);
  if (actual === null) {
    throw new StorageError(
      'That file is not an image or a PDF, whatever it is named', 'unrecognised');
  }
  if (actual !== req.mimeType) {
    /*
     * Names the mismatch but not the caller's claim as though it were true.
     * A file sent as PNG that is really a PDF is a mistake worth reporting
     * precisely; it is also the shape of a deliberate one.
     */
    throw new StorageError(
      `That file was sent as ${req.mimeType} but its contents are ${actual}`,
      'type_mismatch');
  }
}

/** `<prefix>/<tenant>/<uuid>` — opaque, and not derived from any person. */
export function keyFor(prefix: StoragePrefix, tenantId: string): string {
  return `${prefix}/${tenantId}/${randomUUID()}`;
}

/* ------------------------------------------------------------------ *
 * The real implementation
 * ------------------------------------------------------------------ */

const bucket = (): string => {
  if (!config.supabaseStorageBucket) {
    throw new StorageError(
      'this server is not configured for file storage '
      + '(SUPABASE_STORAGE_BUCKET is not set)',
      'not_configured');
  }
  if (!config.supabaseServiceKey) {
    throw new StorageError(
      'this server has no credential for file storage '
      + '(SUPABASE_SERVICE_ROLE_KEY is not set)',
      'not_configured');
  }
  return config.supabaseStorageBucket;
};

/** Keeps the key out of anything that gets logged or returned. See adminApi. */
const redactKey = (text: string): string => {
  const key = config.supabaseServiceKey;
  if (!key || !text) return text;
  return text.split(key).join('[redacted]');
};

const reasonFrom = async (res: Response): Promise<string> => {
  let detail = '';
  try {
    const text = await res.text();
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      detail = String(o.message ?? o.error ?? o.statusCode ?? '').trim();
    }
    if (!detail) detail = text.slice(0, 200);
  } catch { /* a body that is not JSON is not worth a second failure */ }
  return redactKey(detail) || `Supabase Storage returned ${res.status}`;
};

/* The service key, never logged and never returned. */
const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
  apikey: config.supabaseServiceKey,
  authorization: `Bearer ${config.supabaseServiceKey}`,
  ...extra,
});

/** A network failure is not a 500 with no detail. See adminApi for the reasoning. */
const reach = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? cause.message : 'no further detail';
    throw new StorageError(
      `could not reach Supabase Storage (${redactKey(detail)})`, 'unreachable');
  }
};

export const supabaseStorage: Storage = {
  async put(req) {
    validate(req);
    const name = bucket();
    const storageKey = keyFor(req.prefix, req.tenantId);
    const checksum = createHash('sha256').update(req.bytes).digest('hex');

    const res = await reach(
      `${config.supabaseUrl}/storage/v1/object/${name}/${storageKey}`,
      {
        method: 'POST',
        headers: headers({
          'content-type': req.mimeType,
          /* Never overwrite: the key is fresh, so a collision is a bug worth
             hearing about rather than silently replacing somebody's file. */
          'x-upsert': 'false',
        }),
        body: new Uint8Array(req.bytes),
      });

    if (!res.ok) {
      throw new StorageError(
        `Supabase Storage refused the upload: ${await reasonFrom(res)}`, 'put_failed');
    }

    return {
      storageKey, checksum, sizeBytes: req.bytes.length, mimeType: req.mimeType,
    };
  },

  async signedUrl(storageKey, expiresInSeconds) {
    const name = bucket();
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new StorageError('a signed URL needs a positive lifetime', 'invalid');
    }
    const res = await reach(
      `${config.supabaseUrl}/storage/v1/object/sign/${name}/${storageKey}`,
      {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ expiresIn: Math.floor(expiresInSeconds) }),
      });

    if (!res.ok) {
      throw new StorageError(
        `Supabase Storage would not sign that: ${await reasonFrom(res)}`, 'sign_failed');
    }
    const body = await res.json() as { signedURL?: string; signedUrl?: string };
    const path = body.signedURL ?? body.signedUrl;
    if (!path) {
      throw new StorageError('Supabase Storage signed nothing', 'sign_failed');
    }
    /* The API answers with a path; the caller needs something openable. */
    return path.startsWith('http')
      ? path
      : `${config.supabaseUrl}/storage/v1${path.startsWith('/') ? '' : '/'}${path}`;
  },

  async remove(storageKey) {
    const name = bucket();
    const res = await reach(
      `${config.supabaseUrl}/storage/v1/object/${name}/${storageKey}`,
      { method: 'DELETE', headers: headers() });
    if (!res.ok) {
      throw new StorageError(
        `Supabase Storage would not delete that: ${await reasonFrom(res)}`, 'remove_failed');
    }
  },
};

/* ------------------------------------------------------------------ *
 * The seam
 * ------------------------------------------------------------------ */

let current: Storage = supabaseStorage;

/** The implementation in force. Production never changes this. */
export const storage = (): Storage => current;

/**
 * Substitute the store, for tests.
 *
 * Returns the previous one so a test can put it back. Nothing in the running
 * server calls this — callers ask `storage()` at the moment they need it
 * rather than capturing it, so a substitution takes effect.
 */
export function setStorage(next: Storage): Storage {
  const was = current;
  current = next;
  return was;
}
