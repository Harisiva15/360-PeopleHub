/**
 * Resolving a shift code to the profile the server returned.
 *
 * Both shift screens used `shiftOf` from `src/data/shifts.ts` for this — a
 * per-code map of hours, timezone, colour, break and grace held on the client.
 * Two of those values were wrong: the constant said a 45-minute break and a
 * 20-minute grace for the India shift, while `shift.break_minutes` and
 * `shift.grace_minutes` say 60 and 10, and the columns are what
 * `attendance/service.ts` deducts from worked time and measures lateness against.
 * So a screen whose whole job was to state the rules stated something else.
 *
 * This lives in its own module because both screens need it and `index.tsx`
 * already imports `Roster.tsx` — putting it in either would make a cycle.
 */

import type { ShiftProfile } from '../../services';

/**
 * The profile for a code, or a placeholder that claims nothing.
 *
 * **Nothing here falls back to the old constant.** An unknown code resolves to a
 * profile carrying only what is actually known — the code itself — rather than to
 * another shift's hours. Showing the wrong shift's numbers is the defect this
 * replaced, and a fallback would reintroduce it for exactly the case where the
 * reader has least reason to doubt what they are shown.
 */
export function resolveProfile(profiles: ShiftProfile[], code: string): ShiftProfile {
  const found = profiles.find((p) => p.code === code);
  if (found) return found;
  return {
    id: code, code, name: code, start: '—', end: '—', timezone: '—', region: '',
    night: false, flexible: false, breakMinutes: 0, graceMinutes: 0,
    active: false, colour: null, nightAllowance: null, headcount: 0,
  };
}

/**
 * A chart colour for a profile, from the tenant's own choice where it made one.
 *
 * `shift.colour` is nullable and every seeded row leaves it null, so a palette
 * slot stands in. Keyed by position rather than by code: a per-code map is what
 * drifted in the first place, and a neutral slot says nothing untrue about a
 * shift it has never heard of.
 */
const PALETTE = ['var(--s1)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s7)', 'var(--s2)'];

export const colourOf = (p: ShiftProfile, i: number): string =>
  p.colour ?? PALETTE[i % PALETTE.length]!;
