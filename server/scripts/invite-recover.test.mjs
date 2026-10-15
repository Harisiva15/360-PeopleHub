/**
 * Setting a password for somebody who already has an auth user.
 *
 * `inviteToSetPassword` posts to `/auth/v1/invite`. Supabase refuses that with
 * 422 for an address it already knows — which is the ordinary case for a resend,
 * and for anybody who has ever signed in — so the module falls back to
 * `/auth/v1/recover`, the endpoint that lets an existing user set a new password.
 *
 * ## Why this suite exists
 *
 * The recover leg was returning 400 in production and nothing covered it.
 * `invite.test.mjs` substitutes the whole provider through `setAuthAdmin`, which
 * is right for testing who may send an invitation and what it does to a
 * membership — but it means the real two-call sequence, the one that actually
 * talks to GoTrue, had no test at all. This exercises `supabaseAuthAdmin` itself
 * with `fetch` stubbed, so the sequence and its failure modes are checked without
 * an email being sent or a key being used.
 *
 * ## What a 400 from recover actually means
 *
 * Not something this code can fix. GoTrue rejects a `redirect_to` that is not on
 * the project's allowlist, and it is the one input here that comes from outside:
 * `inviteRedirect()` returns `APP_BASE_URL` and deliberately nothing derived from
 * the request, because the API and the app are different hosts and an admin's
 * Origin is the wrong answer. So the assertions below pin two things — that the
 * fallback happens at all, and that when it is refused the refusal is reported
 * rather than swallowed, with the provider's own reason and without the key.
 *
 * Needs no database: every assertion is about the HTTP sequence.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

/*
 * A key and a base URL this suite controls, set before the module reads config.
 * Nothing here reaches a network: `fetch` is replaced below.
 */
const KEY = 'zz-not-a-real-service-role-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
process.env.SUPABASE_URL = 'https://zz-project.supabase.invalid';
process.env.APP_BASE_URL = 'https://360peoplehub.com';
/*
 * Inert, and required anyway.
 *
 * `adminApi.ts` imports `config.ts`, which has exactly two hard requirements
 * and throws on a missing DATABASE_URL before this file reaches its first
 * assertion. Nothing here opens a connection — every assertion is about an
 * HTTP sequence and `fetch` is replaced below — so the value only has to exist.
 * It is deliberately unroutable rather than plausible: if anything ever does
 * try to connect, it should fail loudly instead of reaching a real database.
 *
 * Set here rather than in CI's environment because this suite needs no
 * database and belongs in the job that has none. Without it the whole server
 * workflow failed on the static job, two commits after this file was written,
 * with the real cause four suites up the chain.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://zz:zz@127.0.0.1:1/zz-never-connected';

const { supabaseAuthAdmin, AdminApiError, inviteRedirect } =
  await import('../src/auth/adminApi.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { return { value: await fn(), error: null }; } catch (e) { return { value: null, error: e }; }
};

/** Every call made, so the sequence can be asserted rather than assumed. */
let calls = [];
const realFetch = globalThis.fetch;

/**
 * Answer each path with a canned status and body.
 *
 * A path with no entry is a failure of the test's own premise, not of the code,
 * so it throws loudly rather than returning something plausible.
 */
const stub = (routes) => {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({
      path,
      body: JSON.parse(init.body),
      headers: init.headers,
      method: init.method,
    });
    const r = routes[path];
    if (!r) throw new Error(`the stub was not told how to answer ${path}`);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };
};

const ALREADY = { status: 422, body: { msg: 'User already registered' } };
const EMAIL = 'zz.someone@360.technology';

try {

/* ------------------------------------------------------------------ *
 * The happy path: a brand-new address
 * ------------------------------------------------------------------ */

console.log('\na new address is invited, and nothing else is called\n');

stub({ '/auth/v1/invite': { status: 200, body: { id: 'u1' } } });
{
  const { value, error } = await attempt(
    () => supabaseAuthAdmin.inviteToSetPassword(EMAIL, inviteRedirect()));
  ok('1. a 200 from invite reports an invitation', error === null && value?.kind === 'invited',
    `${error?.message ?? JSON.stringify(value)}`);
  ok('2. exactly one call was made', calls.length === 1, JSON.stringify(calls.map((c) => c.path)));
  ok('    to the invite endpoint', calls[0]?.path === '/auth/v1/invite', calls[0]?.path);
  ok('3. carrying the address and the redirect',
    calls[0]?.body.email === EMAIL
    && calls[0]?.body.redirect_to === 'https://360peoplehub.com',
    JSON.stringify(calls[0]?.body));
  ok('4. and recover was not called',
    !calls.some((c) => c.path === '/auth/v1/recover'),
    'an address Supabase accepted does not need a password reset');
}

/* ------------------------------------------------------------------ *
 * The fallback, which is the whole point
 * ------------------------------------------------------------------ */

console.log('\nan address Supabase already knows falls back to recover\n');

stub({
  '/auth/v1/invite': ALREADY,
  '/auth/v1/recover': { status: 200, body: {} },
});
{
  const { value, error } = await attempt(
    () => supabaseAuthAdmin.inviteToSetPassword(EMAIL, inviteRedirect()));
  ok('5. a 422 "already registered" ends in a recovery, not a failure',
    error === null && value?.kind === 'recovered',
    `${error?.message ?? JSON.stringify(value)}`);
  ok('6. two calls, invite then recover',
    calls.map((c) => c.path).join(' → ') === '/auth/v1/invite → /auth/v1/recover',
    calls.map((c) => c.path).join(' → '));
  ok('7. recover carries the same address',
    calls[1]?.body.email === EMAIL, JSON.stringify(calls[1]?.body));
  ok('8. and the same redirect — the one GoTrue must have allowlisted',
    calls[1]?.body.redirect_to === 'https://360peoplehub.com',
    `${calls[1]?.body.redirect_to} — a redirect_to off the allowlist is what 400s`);
}

/* ------------------------------------------------------------------ *
 * The production symptom: recover itself refuses
 * ------------------------------------------------------------------ */

console.log('\nand when recover is refused, the refusal is reported\n');

stub({
  '/auth/v1/invite': ALREADY,
  '/auth/v1/recover': {
    status: 400,
    body: { msg: 'Redirect URL not allowed', error_code: 'validation_failed' },
  },
});
{
  const { value, error } = await attempt(
    () => supabaseAuthAdmin.inviteToSetPassword(EMAIL, inviteRedirect()));
  ok('9. a 400 from recover throws rather than reporting success',
    value === null && error instanceof AdminApiError,
    `${error?.name}: ${error?.message}`);
  ok('10. coded as a send failure', error?.code === 'send_failed', String(error?.code));
  ok('11. saying the account already exists and the reset was refused',
    /already has an account/.test(error?.message ?? '')
    && /refused/.test(error?.message ?? ''),
    String(error?.message));
  ok('12. and carrying Supabase\'s own reason, so the cause is diagnosable',
    /Redirect URL not allowed/.test(error?.message ?? ''),
    'without this, a 400 reads as "something went wrong" and nobody finds the allowlist');
  ok('13. the recover call was still attempted',
    calls.some((c) => c.path === '/auth/v1/recover'));
}

/* ------------------------------------------------------------------ *
 * The other refusals, which must not be mistaken for the above
 * ------------------------------------------------------------------ */

console.log('\nother refusals are kept distinct\n');

stub({ '/auth/v1/invite': { status: 422, body: { msg: 'Password is too short' } } });
{
  const { error } = await attempt(
    () => supabaseAuthAdmin.inviteToSetPassword(EMAIL, inviteRedirect()));
  ok('14. a 422 that is not "already registered" does not fall back',
    !calls.some((c) => c.path === '/auth/v1/recover'),
    'recovering an address Supabase does not have would send nobody anything');
  ok('    and surfaces the provider\'s reason',
    /Password is too short/.test(error?.message ?? ''), String(error?.message));
}

for (const status of [401, 403]) {
  stub({ '/auth/v1/invite': { status, body: { msg: 'invalid api key' } } });
  const { error } = await attempt(
    () => supabaseAuthAdmin.inviteToSetPassword(EMAIL, inviteRedirect()));
  ok(`15. a ${status} is a credentials problem, not a send problem`,
    error?.code === 'not_authorised', String(error?.code));
  ok('    worded without naming which credential',
    /rejected this server's credentials/.test(error?.message ?? '')
    && !/apikey|authorization|service.role/i.test(error?.message ?? ''),
    String(error?.message));
  ok('    and no fallback was attempted',
    !calls.some((c) => c.path === '/auth/v1/recover'));
}

stub({ '/auth/v1/invite': { status: 500, body: { msg: 'internal' } } });
{
  const { error } = await attempt(
    () => supabaseAuthAdmin.inviteToSetPassword(EMAIL, inviteRedirect()));
  ok('16. a 500 is a send failure', error?.code === 'send_failed', String(error?.code));
}

/* ------------------------------------------------------------------ *
 * The key, which must not appear anywhere a human can read
 * ------------------------------------------------------------------ */

console.log('\nthe service-role key stays in the header\n');

stub({
  '/auth/v1/invite': ALREADY,
  '/auth/v1/recover': { status: 400, body: { msg: `rejected: ${KEY}` } },
});
{
  const { error } = await attempt(
    () => supabaseAuthAdmin.inviteToSetPassword(EMAIL, inviteRedirect()));
  ok('17. it is sent as both headers GoTrue requires',
    calls[0]?.headers.apikey === KEY
    && calls[0]?.headers.authorization === `Bearer ${KEY}`,
    JSON.stringify(Object.keys(calls[0]?.headers ?? {})));
  /*
   * The one case worth pinning: the provider echoed the key back in its own
   * error body. Reporting that message verbatim would write the key into a log
   * or a screen, which is the failure this assertion exists to catch.
   */
  ok('18. a provider message echoing the key does not reach the error',
    !(error?.message ?? '').includes(KEY),
    'Supabase echoed the key back and it was passed through verbatim');
}

/* ------------------------------------------------------------------ *
 * The redirect, the one input that comes from outside
 * ------------------------------------------------------------------ */

console.log('\nthe redirect comes from configuration, not from the caller\n');

ok('19. inviteRedirect returns APP_BASE_URL',
  inviteRedirect() === 'https://360peoplehub.com', inviteRedirect());

const src = readFileSync(join(here, '..', 'src', 'auth', 'adminApi.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
ok('20. and nothing in this module derives it from a request',
  !/req\.|headers\.origin|Origin|referer/i.test(src),
  'the admin\'s Origin is the wrong host in production');
ok('21. a missing APP_BASE_URL is refused rather than guessed', await (async () => {
  const { config } = await import('../src/config.ts');
  const saved = config.appBaseUrl;
  config.appBaseUrl = '';
  const { error } = await attempt(async () => inviteRedirect());
  config.appBaseUrl = saved;
  return error?.code === 'not_configured' && /nowhere to send/.test(error.message);
})());

/* ------------------------------------------------------------------ *
 * Nothing was sent
 * ------------------------------------------------------------------ */

ok('22. no request left this process',
  globalThis.fetch !== realFetch,
  'fetch is stubbed throughout; a real call would mean a real email');

} finally {
  globalThis.fetch = realFetch;
}

console.log();
if (failed) {
  console.error(`${failed} invite/recover checks failed`);
  process.exit(1);
}
console.log('an address Supabase already knows gets a recovery, and a refusal says why');
