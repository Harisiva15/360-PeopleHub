/**
 * Somebody's profile photo, as a URL a browser can open.
 *
 * Alongside `./sites.ts` and `./departments.ts`, and for the same reason: a
 * screen should ask the server rather than derive this itself.
 *
 * ## One person at a time, deliberately
 *
 * The URL is signed and lives five minutes, so it cannot be cached across a
 * session or embedded in a list payload — each one is minted per request. That
 * makes this the wrong hook for a directory of two hundred people: it would be
 * two hundred requests, and no amount of care at the call site changes that.
 *
 * So it is for the places that render **one** known person: the top bar, an
 * account screen, a profile header. Showing photos in a list needs a bulk
 * endpoint that signs many keys in one call, which does not exist yet — see
 * the phase 4 note in docs/roadmap.md.
 *
 * An empty id resolves to null rather than asking, because "who am I" is
 * sometimes not answered yet on first render and a request for nobody's photo
 * is a 404 in the network log for no reason.
 */

import { useQuery } from './react';

export function usePhotoUrl(empId: string | null | undefined): {
  data: string | null | undefined;
  loading: boolean;
} {
  const id = empId ?? '';
  const { data, loading } = useQuery(
    (s) => (id ? s.employees.photoUrl(id) : Promise.resolve(null)),
    [id],
  );
  return { data, loading };
}
