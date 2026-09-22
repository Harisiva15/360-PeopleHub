/**
 * Signs a session out after a long enough gap, and says so first.
 *
 * The timing is in `idle.ts` and checked there. This is the part that needs a
 * browser: which events count as being present, and what the person sees
 * before they are signed out.
 *
 * **Not a Layer modal.** The layer stack holds one dialog at a time, so
 * opening this would close whatever the person had open — including a form
 * they were halfway through, which is precisely the work the warning exists to
 * let them save. It renders over the top instead, and leaves what is
 * underneath alone.
 *
 * **Nothing here is a security boundary.** A timeout in the browser ends a
 * session for the person sitting in front of it; it does not revoke a token
 * that has already been copied. What makes deactivation immediate is the
 * server reading `tenant_membership` on every request. This is the lock screen,
 * not the lock.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import {
  IDLE_KEY, IDLE_LIMIT_MS, IDLE_WARN_MS,
  formatCountdown, idleReading, readLastActivity, writeLastActivity,
} from './idle';
import type { IdlePhase } from './idle';

/**
 * What counts as somebody being there.
 *
 * `scroll` and `keydown` are the honest ones — reading a long page without
 * touching anything really is idle, and the warning is the answer to that, not
 * a reason to count mouse jitter. `visibilitychange` is here because coming
 * back to a tab is a deliberate act; `pointerdown` rather than `mousemove`
 * because a mouse nudged by a passing sleeve should not hold a session open
 * all afternoon.
 */
const ACTIVITY = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;

/** How often the timestamp is looked at. The timestamp is the truth. */
const TICK_MS = 5_000;

/**
 * At most one write a second.
 *
 * Every keystroke writing to localStorage is a synchronous write on the typing
 * path, and it fires a storage event in every other tab. A second's resolution
 * is far finer than a thirty-minute limit needs.
 */
const WRITE_EVERY_MS = 1_000;

export function IdleGuard() {
  const { session, signOut } = useAuth();
  const [phase, setPhase] = useState<IdlePhase>('active');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const lastWrite = useRef(0);
  // Guards the sign-out: expiry is noticed by a repeating tick, and without
  // this the second tick starts another one while the first is still going.
  const ending = useRef(false);

  const touch = useCallback(() => {
    const now = Date.now();
    if (now - lastWrite.current < WRITE_EVERY_MS) return;
    lastWrite.current = now;
    writeLastActivity(now);
  }, []);

  const stay = useCallback(() => {
    lastWrite.current = 0;
    touch();
    setPhase('active');
  }, [touch]);

  useEffect(() => {
    if (!session) return undefined;

    // A fresh session starts its clock now, not at whatever a previous one
    // left in storage — otherwise signing in after a long absence can land
    // straight in the warning.
    writeLastActivity();
    lastWrite.current = Date.now();
    ending.current = false;

    for (const name of ACTIVITY) {
      window.addEventListener(name, touch, { passive: true });
    }
    const onVisible = () => { if (!document.hidden) touch(); };
    document.addEventListener('visibilitychange', onVisible);

    /*
     * Another tab's activity. Read rather than trusted: the event says the key
     * changed, and readLastActivity applies the same validation to it that it
     * applies to everything else in storage.
     */
    const onStorage = (e: StorageEvent) => {
      if (e.key !== IDLE_KEY) return;
      const reading = idleReading(readLastActivity(), Date.now(), IDLE_LIMIT_MS, IDLE_WARN_MS);
      setPhase(reading.phase);
      setSecondsLeft(reading.secondsLeft);
    };
    window.addEventListener('storage', onStorage);

    const tick = window.setInterval(() => {
      const reading = idleReading(readLastActivity(), Date.now(), IDLE_LIMIT_MS, IDLE_WARN_MS);
      setPhase(reading.phase);
      setSecondsLeft(reading.secondsLeft);

      if (reading.phase === 'expired' && !ending.current) {
        ending.current = true;
        // signOut writes the history row itself, from the reason. Recording
        // one here as well is how this produced two rows for one event.
        void signOut('idle');
      }
    }, TICK_MS);

    return () => {
      for (const name of ACTIVITY) window.removeEventListener(name, touch);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
      window.clearInterval(tick);
    };
  }, [session, signOut, touch]);

  if (!session || phase !== 'warning') return null;

  return (
    <div className="idle-warn" role="alertdialog" aria-live="assertive"
      aria-labelledby="idle-warn-title">
      <div className="idle-warn-box">
        <h2 id="idle-warn-title">Still there?</h2>
        <p>
          You have not done anything for a while, so we will sign you out in
          {' '}<strong>{formatCountdown(secondsLeft)}</strong>.
        </p>
        {/*
          * Said plainly, because the thing people actually want to know when
          * this appears is whether the half-written form behind it survives.
          */}
        <p className="idle-warn-note">
          Anything you have typed and not saved will be lost.
        </p>
        <div className="idle-warn-actions">
          <button type="button" className="btn primary" onClick={stay}>
            Keep me signed in
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => { void signOut('manual'); }}
          >
            Sign out now
          </button>
        </div>
      </div>
    </div>
  );
}
