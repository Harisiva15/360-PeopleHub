/**
 * The one module that reads the service-role key.
 *
 * That key is the single credential this server holds which Supabase treats as
 * itself: it bypasses every row-level security policy in the schema. Everything
 * else the server knows is either public (the project URL, the JWKS endpoint)
 * or constrained by RLS (`app_rw`).
 *
 * `checks/auth-gate.tsx` asserts that only this file and `config.ts` name it,
 * which is why the file exists at all. It used to assert `adminApi.ts` instead,
 * and that held for as long as sending invitations was the only thing needing
 * the credential. Phase 0's storage adapter is a second consumer — Supabase
 * Storage authenticates with the same key — and the choice was between two
 * modules each reading it or one module handing out a header. One reader is
 * the property worth keeping, so this is it.
 *
 * Consumers get a header and a redactor. Neither returns the key, and nothing
 * here logs it.
 */

import { config } from '../config.ts';

/**
 * Whether this deployment can act as Supabase at all.
 *
 * Checked by callers before they try, so each can refuse in its own words —
 * "cannot send invitations" and "has no credential for file storage" are
 * different sentences for the same absence, and the person reading the error
 * is trying to fix one feature rather than audit the configuration.
 */
export const hasServiceKey = (): boolean => Boolean(config.supabaseServiceKey);

/**
 * The headers that authenticate a request as the project.
 *
 * Both are required: Supabase's gateway reads `apikey`, and the services behind
 * it read `authorization`. Returned fresh each call rather than built once at
 * module load, so nothing holds a copy.
 */
export const serviceHeaders = (
  extra: Record<string, string> = {},
): Record<string, string> => ({
  apikey: config.supabaseServiceKey,
  authorization: `Bearer ${config.supabaseServiceKey}`,
  ...extra,
});

/**
 * Remove the key from anything on its way into a message or a log line.
 *
 * A provider's error body is passed through verbatim by the callers of this
 * module, and the request that produced it carried the key. A provider that
 * echoed it back — in a validation message, a proxy error, a misconfigured
 * gateway — would otherwise write it into whatever logged the failure.
 *
 * Not a likely response, and the cost of being wrong is the one credential
 * that bypasses RLS. The key is never compared against anything, only removed,
 * so this says nothing about it either.
 */
export const redactServiceKey = (text: string): string => {
  const key = config.supabaseServiceKey;
  if (!key || !text) return text;
  return text.split(key).join('[redacted]');
};
