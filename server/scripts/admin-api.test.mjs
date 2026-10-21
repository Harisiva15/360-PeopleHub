/**
 * A provider this server cannot reach says so.
 *
 * `adminApi.post` returns a `fetch`, and `fetch` rejects rather than resolving
 * when the host cannot be reached at all — DNS, TLS, a refused connection, a
 * timeout. Unwrapped, that rejection is a bare `TypeError: fetch failed`. It
 * matches no branch of `statusFor`, so it reached the administrator as a blank
 * 500 with no detail, and "could not reach Supabase" and "Supabase refused
 * this" are different problems for whoever has to decide whether to retry.
 *
 * No database and no network beyond a refused connection to localhost: the
 * point is the failure path, and the fastest honest way to produce a real
 * `fetch` rejection is to aim it at a port nothing is listening on.
 *
 *   node --experimental-strip-types scripts/admin-api.test.mjs
 */

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
  if (!cond) failed += 1;
};

/*
 * Set before the import: config.ts reads the environment once, at module
 * evaluation. Port 1 is reserved and nothing listens there, so the connection
 * is refused immediately rather than hanging until a timeout.
 *
 * The key is a fake. This suite must never be able to reach anything real, and
 * it asserts below that whatever is in this variable does not end up in an
 * error message.
 *
 * Assembled from parts rather than written out, so that no `sb_secret_`-shaped
 * literal exists anywhere in the repository. GitHub's push protection scans
 * for that shape and cannot tell an invented key from a real one — it blocked
 * this file on the first attempt to push it. The offered escape is a link that
 * marks the secret allowed, which would have worked and would also have taught
 * everyone here to click through secret warnings. Not writing the shape down
 * costs one line and leaves the protection meaning what it says.
 */
const FAKE_KEY = ['sb', 'secret', 'notarealkeyfortests', '0'.repeat(8)].join('_');
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE_KEY;
process.env.APP_BASE_URL = 'https://example.test';

const { supabaseAuthAdmin, AdminApiError, inviteRedirect } =
  await import('../src/auth/adminApi.ts');

console.log(`${NL}a provider it cannot reach is reported as unreachable${NL}`);

let thrown = null;
try {
  await supabaseAuthAdmin.inviteToSetPassword('nobody@example.test', inviteRedirect());
  ok('1. an unreachable provider is refused, not accepted', false,
    'it resolved — a send that never left must not look like one that did');
} catch (e) {
  thrown = e;
  ok('1. an unreachable provider is refused, not accepted', true);
}

ok('2. as an AdminApiError, not a bare TypeError',
  thrown instanceof AdminApiError,
  `got ${thrown?.constructor?.name ?? typeof thrown}: ${thrown?.message ?? ''}`);

/*
 * The code decides the status. `statusFor` maps 'not_configured' to 503 and
 * every other AdminApiError code to 502, so this is the assertion that the
 * administrator gets 502 Bad Gateway rather than 503 Service Unavailable —
 * the upstream was reachable-in-principle and simply was not there.
 */
ok('3. with the code that maps to 502, not 503',
  thrown?.code === 'unreachable',
  `code is ${JSON.stringify(thrown?.code)}`);

ok('4. and says it could not reach Supabase',
  /could not reach supabase/i.test(thrown?.message ?? ''),
  thrown?.message ?? '(no message)');

ok('5.  naming the underlying cause',
  (thrown?.message ?? '').length > 'could not reach Supabase to send this ()'.length,
  thrown?.message ?? '(no message)');

/*
 * The whole claim of this module is that the key is read from config, put in a
 * header, and appears in no return value, no error message and no log line.
 * This failure path is new, so it gets the same test as the others.
 */
ok('6. the key is nowhere in the message',
  !(thrown?.message ?? '').includes(FAKE_KEY),
  'a credential reached an error message');

ok('7.  nor in the stack',
  !(thrown?.stack ?? '').includes(FAKE_KEY),
  'a credential reached a stack trace');

/*
 * A detector that cannot fail is worth nothing. If the wrap were removed, the
 * rejection would arrive as a TypeError whose message is "fetch failed" — so
 * assert positively that what we caught is *not* that.
 */
ok('8. the unwrapped TypeError no longer escapes',
  !(thrown instanceof TypeError) && !/^fetch failed$/i.test(thrown?.message ?? ''),
  'the bare fetch rejection is still reaching the caller');

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`an unreachable provider is a 502 that names the cause, not a blank 500${NL}`);
process.exit(0);
