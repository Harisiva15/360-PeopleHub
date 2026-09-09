/**
 * The rate limiter, as pure logic.
 *
 * `hit()` takes `now` so a window can be crossed without waiting a minute for
 * it. A limiter tested by sleeping is a limiter that is tested once and then
 * skipped.
 *
 *   node scripts/rate-limit.test.mjs
 */

import { ANON, AUTHED, hit, keyFor, reset } from '../src/http/rate-limit.ts';

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed += 1;
    console.error(`  FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  } else {
    console.log(`  ok    ${label}`);
  }
};

console.log('\nrate limiter\n');

/* ---- the allowance is spent, then refused ---- */
reset();
const t0 = 1_000_000;
let last;
for (let i = 0; i < ANON.max; i += 1) last = hit('a:1.2.3.4', ANON, t0);
check(`the first ${ANON.max} anonymous requests are allowed`, last.allowed, true);
check('and the allowance is exhausted', last.remaining, 0);

const over = hit('a:1.2.3.4', ANON, t0);
check('the next one is refused', over.allowed, false);
check('with a retry-after inside the window', over.resetSeconds <= 60 && over.resetSeconds >= 1, true);

/* ---- one caller's limit is not another's ---- */
check('a different address is unaffected', hit('a:5.6.7.8', ANON, t0).allowed, true);

/* ---- the window rolls ---- */
check('and the window reopens once it passes',
  hit('a:1.2.3.4', ANON, t0 + ANON.windowMs).allowed, true);

/* ---- signed-in callers get much more room ---- */
reset();
let authed;
for (let i = 0; i < ANON.max + 1; i += 1) authed = hit('t:abc', AUTHED, t0);
check('a signed-in caller is not stopped at the anonymous limit', authed.allowed, true);
check('their allowance is the larger one', AUTHED.max > ANON.max, true);

/* ---- the key ---- */
check('a token identifies the caller, not their address',
  keyFor('header.payload.signature-tail-value-here', '10.0.0.1', undefined).startsWith('t:'), true);
check('and only its tail is kept, so the map holds no credential',
  keyFor('secret-token-value', '10.0.0.1', undefined).includes('secret-token-value'), false);
check('without a token, the socket address is used',
  keyFor(undefined, '10.0.0.1', undefined), 'a:10.0.0.1');

/*
 * The forwarded header is the interesting one: trusting it unconditionally
 * lets a caller reset their own counter by changing a header they control.
 */
check('x-forwarded-for is ignored by default',
  keyFor(undefined, '10.0.0.1', '9.9.9.9', false), 'a:10.0.0.1');
check('and honoured only when the proxy is trusted',
  keyFor(undefined, '10.0.0.1', '9.9.9.9', true), 'a:9.9.9.9');
check('taking the first hop of a chain',
  keyFor(undefined, '10.0.0.1', '9.9.9.9, 10.0.0.5', true), 'a:9.9.9.9');

/* ---- two people behind one office NAT are not one caller ---- */
reset();
for (let i = 0; i < ANON.max; i += 1) hit(keyFor('token-one', '203.0.113.7', undefined), AUTHED, t0);
check('one signed-in colleague does not exhaust another on the same address',
  hit(keyFor('token-two', '203.0.113.7', undefined), AUTHED, t0).allowed, true);

console.log(failed
  ? `\n${failed} rate limiter check(s) FAILED`
  : '\nrate limiter behaves');
process.exit(failed ? 1 : 0);
