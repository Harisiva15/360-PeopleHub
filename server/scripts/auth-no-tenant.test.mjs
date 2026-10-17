/**
 * Everything the auth path reads before a tenant exists goes through a
 * SECURITY DEFINER function — and those functions really are callable that way.
 *
 * ## The outage this exists because of
 *
 * The four-role model derives the manager layer from the reporting tree, so
 * `callerFromToken` has to ask "does anybody report to this person" while it is
 * still building the caller — before any tenant context exists, because
 * establishing one is what it is in the middle of doing.
 *
 * It asked by querying `employee` directly. The row-level policy on that table
 * calls `current_tenant_id()`, which **raises** when nothing is set rather than
 * returning null:
 *
 *     42501  no tenant in this session: set app.tenant_id, or sign in with a
 *            tenant claim
 *
 * So `callerFromToken` threw on every authenticated request. The frontend's
 * password gate fails closed, so what anybody actually saw was "Set a new
 * password" on a loop, and resetting the password did not help because the call
 * that clears the flag was failing too.
 *
 * ## Why 203 files of green checks missed a total auth outage
 *
 * Every database-backed suite builds `Caller` objects by hand. Not one of them
 * has ever called `callerFromToken`, so the function that broke was never
 * executed. And a behavioural test is awkward to add — `callerFromToken` takes
 * a signed JWT and verifies it against Supabase's JWKS, which these suites
 * deliberately never contact.
 *
 * So this checks the *rule* instead of one path through it, which also covers
 * whoever adds the sixth no-tenant query:
 *
 *   1. statically — every query inside a `withoutTenantForAuth` block reads an
 *      `auth_*` function and never a table directly;
 *   2. at runtime — each of those functions is callable as `app_rw` with no
 *      tenant set, which is the condition that broke;
 *   3. and a floor — a direct table read in the same condition still raises.
 *      If that ever stops raising, the premise of (1) has changed and this
 *      check has gone blind rather than the code having got safer.
 *
 * Migration 0011 wrote this lesson down first: "A test that runs as a more
 * privileged role than production does is a test that proves the wrong thing."
 * Point (2) runs as `app_rw` for exactly that reason — the suites' own admin
 * connection is the owner, and the owner bypasses row-level security.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertLocalDatabase } from './local-only.mjs';

/* This suite reads only, but it connects — and the guard is cheap. */
assertLocalDatabase();

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `${NL}        ${detail}`}`);
};

/* ===========================================================================
 * 1. Statically: no table is read without a tenant
 * ======================================================================== */

const SRC = join(here, '..', 'src', 'auth', 'session.ts');
const src = readFileSync(SRC, 'utf8');
const lines = src.split(NL);

/** The body of each `withoutTenantForAuth(...)` block, by brace depth. */
const blocks = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!/withoutTenantForAuth\(/.test(lines[i])) continue;
  if (/^import /.test(lines[i])) continue;
  let depth = 0;
  let started = false;
  const body = [];
  for (let j = i; j < lines.length; j += 1) {
    for (const ch of lines[j]) {
      if (ch === '{') { depth += 1; started = true; }
      else if (ch === '}') depth -= 1;
    }
    body.push(lines[j]);
    if (started && depth <= 0) break;
  }
  blocks.push({ line: i + 1, text: body.join(NL) });
}

console.log(`${NL}the auth path reads nothing without a tenant but an auth_* function${NL}`);

ok(`found the no-tenant blocks in session.ts (${blocks.length})`, blocks.length >= 4,
  'if this drops, the scan has stopped finding them rather than the code having changed');

const TABLES = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?!auth_)([a-z_]{3,})\b/g;
/* Reading a CTE this query defined itself is not reading a table. */
const ctes = (text) => new Set(
  [...text.matchAll(/\b([a-z_]+)\s+AS\s*\(/gi)].map((m) => m[1].toLowerCase()),
);

for (const b of blocks) {
  const own = ctes(b.text);
  const direct = [];
  for (const m of b.text.matchAll(TABLES)) {
    const name = m[1].toLowerCase();
    if (own.has(name)) continue;
    if (/^(stdin|select|only)$/.test(name)) continue;
    direct.push(name);
  }
  const fns = [...new Set([...b.text.matchAll(/\b(auth_[a-z_]+)\s*\(/g)].map((m) => m[1]))];
  ok(`session.ts:${String(b.line).padEnd(4)} reads ${fns.length ? fns.join(', ') : '(nothing)'}`,
    direct.length === 0,
    `reads these directly, which RLS will refuse without a tenant: ${direct.join(', ')}`);
}

/* ===========================================================================
 * 2 & 3. At runtime, as app_rw, with no tenant
 * ======================================================================== */

if (!process.env.DATABASE_URL || !process.env.MIGRATE_DATABASE_URL) {
  console.log(`${NL}SKIPPED the runtime half: no database.${NL}`);
  if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
  process.exit(0);
}

const { default: pg } = await import('pg');

/* The owner, only to find a real user id to ask about. */
const owner = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await owner.connect();
const known = (await owner.query(
  'SELECT user_id FROM tenant_membership WHERE user_id IS NOT NULL LIMIT 1')).rows[0]?.user_id
  ?? '00000000-0000-0000-0000-000000000001';
await owner.end();

/*
 * app_rw, not the owner. The owner bypasses row-level security, so a check that
 * used the suites' admin connection would pass with the bug still present —
 * which is precisely how this shipped.
 */
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const role = (await db.query('SELECT current_user')).rows[0].current_user;
console.log(`${NL}...and those functions work as ${role}, with no tenant set${NL}`);
ok(`connected as app_rw, not the owner (${role})`, role === 'app_rw',
  'the owner bypasses RLS, so this check would prove nothing');

/** Each probe in its own transaction, so one failure cannot cascade. */
const attempt = async (sql, params) => {
  await db.query('BEGIN');
  try {
    const r = await db.query(sql, params);
    return { ok: true, row: r.rows[0] };
  } catch (e) {
    return { ok: false, code: e.code, message: e.message.split(':')[0] };
  } finally {
    await db.query('ROLLBACK').catch(() => {});
  }
};

const CALLS = [
  ['auth_has_reports', 'SELECT auth_has_reports($1) AS v', [known]],
  ['auth_membership', 'SELECT count(*)::int AS v FROM auth_membership($1)', [known]],
  ['auth_membership_status', 'SELECT count(*)::int AS v FROM auth_membership_status($1)', [known]],
  ['auth_has_verified_factor', 'SELECT auth_has_verified_factor($1) AS v', [known]],
];

for (const [name, sql, params] of CALLS) {
  const r = await attempt(sql, params);
  ok(`${name.padEnd(26)} answers`, r.ok,
    `${r.code} ${r.message} — this is the shape of the outage`);
}

/* An unknown user is a false, not an error: a stranger's token must not 500. */
const stranger = await attempt('SELECT auth_has_reports($1) AS v',
  ['00000000-0000-0000-0000-000000000009']);
ok('auth_has_reports for an unknown user is false, not an error',
  stranger.ok && stranger.row.v === false,
  stranger.ok ? `returned ${JSON.stringify(stranger.row)}` : `${stranger.code} ${stranger.message}`);

/* The floor. If this stops raising, the rule above is no longer load-bearing. */
const direct = await attempt(
  'SELECT EXISTS (SELECT 1 FROM employee WHERE manager_id = $1) AS v', [known]);
ok('a direct employee read still raises 42501 without a tenant',
  !direct.ok && direct.code === '42501',
  direct.ok
    ? 'it succeeded — RLS is no longer refusing, so this suite has gone blind'
    : `raised ${direct.code}, expected 42501`);

await db.end();

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`nothing reads a table before its tenant exists${NL}`);
