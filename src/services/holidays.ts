/**
 * The holiday calendar, as the server holds it.
 *
 * Alongside `./sites.ts` and `./departments.ts`, and for the same reason it
 * says: `src/data/org.ts` carries a `HOLIDAYS` table, and a screen that reads
 * it is describing a fiction rather than this tenant's year.
 *
 * ## What was wrong
 *
 * Two screens read that constant. The Attendance holiday panel listed it, and
 * Celebrations folded it into the month's occasions. Production holds **zero**
 * holidays, so both showed a full and plausible calendar — Pongal, Deepavali,
 * dates and all — for a tenant that has configured none. Looking configured
 * when nothing is configured is worse than looking empty: nobody goes to fix
 * what appears to be done.
 *
 * Settings → Holiday calendar was already live, which is how the two could
 * disagree: an administrator could add a holiday there and watch the
 * Attendance panel not change, because the panel was never reading the
 * database at all.
 *
 * ## What this does not change
 *
 * The *arithmetic* was never wrong. `attendance/data.ts` says it moved off the
 * compiled list on purpose, and the server resolves a person's holidays —
 * `site_id IS NULL OR site_id = their site`, the site row winning where both
 * exist — for both the attendance grid and leave day-counting. So this fixes
 * what two panels display, not what anything computes.
 *
 * ## Every site's, not one person's
 *
 * This returns the whole calendar, including rows belonging to locations the
 * reader does not work at, because its callers are administration screens that
 * list the company's year. A screen showing *this person's* holidays should
 * not filter this list itself — ask the server, which already knows which site
 * they are posted to.
 */

import { useQuery } from './react';
import type { Holiday } from '../types/org';

export function useHolidays(): {
  data: Holiday[];
  loading: boolean;
} {
  const { data = [], loading } = useQuery((s) => s.config.holidays(), []);
  return { data, loading };
}
