/**
 * The idle timeout, at its boundaries.
 *
 * Everything that can go wrong here goes wrong at a moment: the millisecond
 * the warning should appear, the millisecond the session should end, and the
 * two cases where the clock itself is not to be trusted — a machine that slept
 * through the whole window, and a clock that went backwards. None of those are
 * reachable by using the application; all of them are one expression here.
 *
 * `idleReading` takes its limits as parameters for exactly this reason, so the
 * boundary can be named rather than waited for.
 */

import {
  IDLE_LIMIT_MS, IDLE_WARN_MS, formatCountdown, idleReading,
} from '../src/auth/idle';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const LIMIT = 30 * 60 * 1000;
const WARN = 2 * 60 * 1000;
const T0 = 1_700_000_000_000;

/** Reading at `msIdle` after the last activity. */
const at = (msIdle: number) => idleReading(T0, T0 + msIdle, LIMIT, WARN);

console.log('\nthe idle clock\n');

ok('fresh activity is active', at(0).phase === 'active', at(0).phase);
ok('a minute in is still active', at(60_000).phase === 'active', at(60_000).phase);

/*
 * The warning window is [limit - warn, limit). Both ends are named: one
 * millisecond either side has caught a `<` written as `<=` before.
 */
ok('the warning starts exactly at limit − warn',
  at(LIMIT - WARN).phase === 'warning',
  `got ${at(LIMIT - WARN).phase} at ${(LIMIT - WARN) / 1000}s`);
ok('one millisecond earlier is still active',
  at(LIMIT - WARN - 1).phase === 'active',
  `got ${at(LIMIT - WARN - 1).phase}`);
ok('one millisecond before the limit is still only a warning',
  at(LIMIT - 1).phase === 'warning',
  `got ${at(LIMIT - 1).phase}`);
ok('the limit itself expires',
  at(LIMIT).phase === 'expired',
  `got ${at(LIMIT).phase}`);

/*
 * The case a setTimeout gets wrong. A laptop closed for an hour must come back
 * expired, not with an hour-old timer about to fire — the session was
 * unattended for the whole hour, which is the thing being measured.
 */
ok('an hour asleep is expired, not pending',
  at(60 * 60 * 1000).phase === 'expired',
  'a machine that slept through the window must wake up signed out');

/*
 * And the case a naive subtraction gets wrong. If the clock moves backwards —
 * a manual change, an NTP correction — `now - last` is negative. Clamping to
 * zero keeps somebody signed in; not clamping would produce a huge idle and
 * sign them out mid-sentence for something that was not their doing.
 */
const backwards = idleReading(T0, T0 - 5 * 60 * 1000, LIMIT, WARN);
ok('a clock that went backwards reads as active',
  backwards.phase === 'active',
  `got ${backwards.phase} — a backwards clock must not end a session`);
ok('and reports the full window remaining',
  backwards.secondsLeft === LIMIT / 1000,
  `got ${backwards.secondsLeft}s, expected ${LIMIT / 1000}s`);

/* The countdown is what the person reads, so it never goes negative or past. */
ok('seconds left never exceeds the limit',
  at(0).secondsLeft <= LIMIT / 1000,
  `${at(0).secondsLeft}`);
ok('seconds left is zero once expired', at(LIMIT).secondsLeft === 0);
ok('seconds left counts down inside the warning',
  at(LIMIT - 90_000).secondsLeft === 90,
  `${at(LIMIT - 90_000).secondsLeft}`);

console.log('\nthe countdown as it reads\n');

ok('under a minute is seconds', formatCountdown(45) === '45s', formatCountdown(45));
ok('a minute is 1:00', formatCountdown(60) === '1:00', formatCountdown(60));
ok('ninety seconds is 1:30', formatCountdown(90) === '1:30', formatCountdown(90));
ok('two minutes is 2:00', formatCountdown(120) === '2:00', formatCountdown(120));
ok('single seconds are padded', formatCountdown(65) === '1:05', formatCountdown(65));

console.log('\nthe shipped values\n');

/*
 * The constants themselves, so a later edit that makes the warning longer than
 * the limit — which would mean the dialog appears the moment you sign in and
 * never goes away — fails here rather than in front of somebody.
 */
ok('the warning fits inside the limit', IDLE_WARN_MS < IDLE_LIMIT_MS,
  `warn ${IDLE_WARN_MS}ms, limit ${IDLE_LIMIT_MS}ms`);
ok('the limit is long enough to read a page',
  IDLE_LIMIT_MS >= 15 * 60 * 1000,
  `${IDLE_LIMIT_MS / 60000} minutes is short enough to interrupt ordinary work`);
ok('the limit is short enough to matter',
  IDLE_LIMIT_MS <= 8 * 60 * 60 * 1000,
  `${IDLE_LIMIT_MS / 60000} minutes is not a timeout`);
ok('the warning gives time to come back',
  IDLE_WARN_MS >= 30 * 1000,
  `${IDLE_WARN_MS / 1000}s is a jump scare, not a chance`);

console.log(`\n${failed ? `${failed} FAILED` : 'the idle clock holds'}\n`);
process.exit(failed ? 1 : 0);
