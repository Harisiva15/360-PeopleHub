/**
 * How an expected day is presented, decided once.
 *
 * The rota and the personal four-week calendar both render the same four
 * expectations, and both used to decide for themselves what "off" looked like —
 * from a hard-coded weekend at that. This module holds the presentation and
 * nothing else: the *expectation* arrives already decided by the server's
 * calendar resolver, and there is deliberately no function here that computes one.
 *
 * **Every colour is repeated by a word.** A rota read by somebody colour-blind, or
 * printed in grey, still has to say which days are worked — so `short` is in the
 * cell regardless of the tint, and `label` is in its tooltip.
 */

import type { DayReason, RosterDay } from '../../services';

/** The presentation of one expected state. */
export interface ExpectedLook {
  /** What goes in the cell. Short, because a rota cell is about 26px wide. */
  short: string;
  /** The full wording, for a tooltip, a legend or a CSV. */
  label: string;
  /** A background tint, or null to leave the cell on the shift's own colour. */
  tint: string | null;
  /** Whether this day counts as one somebody is expected to work. */
  working: boolean;
}

/**
 * The four states the resolver can return.
 *
 * `NOT_EMPLOYED` is kept visually distinct from `WEEKLY_OFF` on purpose. Both are
 * non-working, but "they had not joined yet" and "that is their week off" are
 * different facts, and a rota that drew them the same way would invite somebody to
 * ask why a new joiner has a six-day weekend.
 */
const LOOK: Record<DayReason, ExpectedLook> = {
  WORKING: { short: '', label: 'Working', tint: null, working: true },
  WEEKLY_OFF: { short: 'Off', label: 'Week off', tint: 'var(--surface-3)', working: false },
  HOLIDAY: { short: 'Hol', label: 'Holiday', tint: 'var(--surface-2)', working: false },
  NOT_EMPLOYED: { short: '—', label: 'Not employed', tint: 'transparent', working: false },
};

/**
 * The look for a cell the server answered, or for one it did not.
 *
 * A missing cell is not guessed at. The server returns a verdict for every date it
 * was asked about and omits people the caller may not see, so `undefined` here
 * means "no answer for this person and date" — rendered blank, which reads as no
 * answer rather than as a fabricated day off. That is the same rule the attendance
 * calendar follows for a day with no record.
 */
export function lookOf(cell: RosterDay | undefined): ExpectedLook | null {
  if (!cell) return null;
  return LOOK[cell.expected] ?? null;
}

/** The legend, in the order the states are worth explaining. */
export const EXPECTED_LEGEND: { reason: DayReason; look: ExpectedLook }[] =
  (['WEEKLY_OFF', 'HOLIDAY', 'NOT_EMPLOYED'] as DayReason[])
    .map((reason) => ({ reason, look: LOOK[reason]! }));

/**
 * The shift somebody is expected on across a span — their standing profile.
 *
 * Read off the first day they are expected to work, because that is the only day
 * that carries one: a week off names no shift, and neither does a date outside
 * their employment. Null when the span holds no working day at all, which is a
 * real answer for somebody on leave-length absence or not yet joined.
 */
export function standingShift(
  week: Record<string, RosterDay> | undefined,
  dates: string[],
): string | null {
  if (!week) return null;
  for (const d of dates) {
    const cell = week[d];
    if (cell && cell.expected === 'WORKING' && cell.shift) return cell.shift;
  }
  /*
   * Nobody expected in on any of these dates. A holiday still names the shift it
   * displaced, so that is the next best evidence of what they normally work.
   */
  for (const d of dates) {
    const cell = week[d];
    if (cell && cell.shift) return cell.shift;
  }
  return null;
}

/**
 * The work schedule somebody is on across a span, or null.
 *
 * Null means **no assignment covered these dates** and the server answered from
 * its Monday-to-Friday fallback. A screen must say "Not assigned" for that rather
 * than naming `DEFAULT_MF`: Phase 2h-E deliberately does not default unassigned
 * people onto the tenant's editable default, and presenting them as if it had
 * would hide the one distinction that phase was careful to keep.
 */
export function scheduleOver(
  week: Record<string, RosterDay> | undefined,
  dates: string[],
): string | null {
  if (!week) return null;
  for (const d of dates) {
    const code = week[d]?.schedule;
    if (code) return code;
  }
  return null;
}
