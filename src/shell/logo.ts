/**
 * The tenant's own logo for the shell, or null.
 *
 * ## Why this is not `useLogoUrl` from the settings module
 *
 * That hook takes an entity code, because the Company Profile screen is about
 * a named entity. The shell has no entity in hand and wants one answer: the
 * default entity's mark, which is what `is_default` exists to decide and what
 * `logoUrl(caller, null)` returns when no code is given.
 *
 * Importing the settings module's data layer into the shell would also pull a
 * screen's worth of queries into every page.
 *
 * ## Null is the ordinary case
 *
 * Most tenants upload nothing, and the built-in mark is the right answer for
 * them — so this resolves to null rather than erroring, and the caller falls
 * back. A failure to read resolves to null as well: a logo that cannot be
 * fetched must not take the navigation down with it, which is the same
 * reasoning `usePhotoUrl` records for initials.
 */

import { useQuery } from '../services/react';

/** A short-lived signed URL for the default entity's logo, or null. */
export function useTenantLogo(): string | null {
  const { data } = useQuery(
    (s) => s.config.tenantLogoUrl().catch(() => null),
    [],
  );
  return data ?? null;
}
