/**
 * When a session has been left alone too long.
 *
 * **Timestamps, not timers.** The obvious build is `setTimeout(signOut, 30 min)`
 * and it is wrong on a laptop: close the lid, open it an hour later, and the
 * timer fires late or not at all while the session sat unattended the whole
 * time. So the *fact* is a timestamp of the last interaction, and the interval
 * is only how often somebody looks at it. Waking from sleep is then the normal
 * case rather than a gap in the logic.
 *
 * **Activity is shared across tabs.** Two tabs each with their own idle clock
 * means the one you are not looking at signs you out of the one you are. The
 * timestamp is written to localStorage and read back, so any tab's activity
 * keeps every tab alive — and only genuine inactivity everywhere ends it.
 *
 * The logic is kept here, as functions over numbers, so it can be checked
 * without a browser, a clock or a React tree.
 */

/**
 * Half an hour, with a warning two minutes out.
 *
 * Long enough that reading a long page is not an interruption — scrolling
 * counts as activity, but reading without moving does not — and short enough
 * that an unlocked laptop in a meeting room is not an open session all
 * afternoon. Two minutes is enough to notice a dialog and come back to the
 * keyboard; a ten-second warning is a jump scare, not a chance.
 */
export const IDLE_LIMIT_MS = 30 * 60 * 1000;
export const IDLE_WARN_MS = 2 * 60 * 1000;

/** Shared across tabs of the same origin. */
export const IDLE_KEY = 'ph.lastActivity';

export type IdlePhase = 'active' | 'warning' | 'expired';

export interface IdleReading {
  phase: IdlePhase;
  /** Whole seconds until sign-out. Zero once expired; never negative. */
  secondsLeft: number;
}

/**
 * Where a session stands, given when it was last touched.
 *
 * `limit` and `warn` are parameters rather than constants read from module
 * scope so the boundaries can be checked at the exact millisecond they turn
 * over, which is the only place an off-by-one in this lives.
 */
export function idleReading(
  lastActivity: number,
  now: number,
  limit: number = IDLE_LIMIT_MS,
  warn: number = IDLE_WARN_MS,
): IdleReading {
  // A clock that went backwards — a manual change, an NTP correction — would
  // otherwise read as a very long idle and sign somebody out mid-sentence.
  // Treating the future as "just now" fails towards keeping them signed in,
  // which is the right way for a convenience feature to fail.
  const idleFor = Math.max(0, now - lastActivity);
  if (idleFor >= limit) return { phase: 'expired', secondsLeft: 0 };

  const msLeft = limit - idleFor;
  const secondsLeft = Math.ceil(msLeft / 1000);
  return { phase: msLeft <= warn ? 'warning' : 'active', secondsLeft };
}

/**
 * The most recent activity this browser knows about, across every tab.
 *
 * Storage can throw — a private window, a blocked origin — and can hold
 * something that is not a number if anything else ever wrote to the key. Both
 * fall back to "now": an idle timeout that cannot read its own clock must not
 * sign people out, because the failure has nothing to do with whether they are
 * there.
 */
export function readLastActivity(now: number = Date.now()): number {
  try {
    const raw = window.localStorage.getItem(IDLE_KEY);
    if (!raw) return now;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : now;
  } catch {
    return now;
  }
}

export function writeLastActivity(at: number = Date.now()): void {
  try {
    window.localStorage.setItem(IDLE_KEY, String(at));
  } catch {
    /* See above: unreadable storage must not end anybody's session. */
  }
}

/** Cleared on sign-out so the next session starts its own clock. */
export function clearLastActivity(): void {
  try {
    window.localStorage.removeItem(IDLE_KEY);
  } catch {
    /* Nothing to do, and nothing that should be reported to the person. */
  }
}

/** "1:30", "45s" — a countdown somebody can read at a glance. */
export function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
