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

/**
 * A failure here resolves to `null` and warns. It does not announce.
 *
 * `useQuery` announces every rejection, because nearly every call site
 * discards `error` and without it a failure is indistinguishable from an empty
 * result. That is the right default and the wrong one for this hook, for two
 * reasons.
 *
 * The first is what it costs. `TopBar` asks for the signed-in person's photo
 * on every page, so one failing read is not one toast — it is a toast for
 * every user on every page load. A photo is decoration with `Avatar`'s
 * initials behind it, so the screen is already correct without it; the toast
 * is the only damage.
 *
 * The second is that the failure is routine rather than exceptional. Render
 * and Pages deploy independently from one push, so a new frontend talks to the
 * old server for a minute or two and the route 404s; the same is true for any
 * window where the column this reads is not yet migrated. Both are transient,
 * self-healing, and nothing a person can act on.
 *
 * So it is swallowed here rather than by widening `useQuery`: a read whose
 * failure a user could act on — a payslip, a leave balance, a document — must
 * keep announcing itself.
 */
export function usePhotoUrl(empId: string | null | undefined): {
  data: string | null | undefined;
  loading: boolean;
} {
  const id = empId ?? '';
  const { data, loading } = useQuery(
    (s) => (id
      ? s.employees.photoUrl(id).catch((e: unknown) => {
        /* Warn, not error: this is expected during a deploy and is not a fault. */
        console.warn('photo unavailable, showing initials:',
          e instanceof Error ? e.message : String(e));
        return null;
      })
      : Promise.resolve(null)),
    [id],
  );
  return { data, loading };
}
