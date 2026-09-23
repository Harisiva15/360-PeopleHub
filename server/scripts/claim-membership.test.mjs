/**
 * What a first sign-in may and may not claim.
 *
 * `auth_claim_membership` decides whether an authenticated person becomes a
 * member of the tenant. It used to guard that with a denylist — refusing an
 * expired invitation and one awaiting approval — and let everything else
 * through. `tenant_membership_user_once_usable` permits three statuses to have
 * no user, and only two were named, so a **withdrawn invitation was revived by
 * the person signing in**, with the role the administrator had chosen before
 * withdrawing it.
 *
 * This is SQL, so it is tested as SQL. Transcribing the logic into JavaScript
 * would prove that the transcription is right and say nothing about the
 * function the database actually runs — which is the only thing that decides
 * who gets in.
 *
 * Every case builds its fixture inside a transaction and rolls it back, and the
 * row counts are re-read afterwards on a second connection to prove it. No
 * employee, membership or auth user survives this file.
 *
 * Skips cleanly where there is no database, so a checkout without credentials
 * still runs the rest of the suite.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) {
  console.log('\nSKIPPED: no MIGRATE_DATABASE_URL, so the live function cannot be asked.');
  console.log('This file tests deployed SQL; there is nothing to test without it.\n');
  process.exit(0);
}

const { default: pg } = await import('pg');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const connect = async () => {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
};

/* Counts read from outside every transaction, to prove nothing leaked. */
const outside = await connect();
const census = async () => (await outside.query(`
  SELECT (SELECT count(*)::int FROM employee) e,
         (SELECT count(*)::int FROM tenant_membership) m,
         (SELECT count(*)::int FROM audit_log) a,
         (SELECT count(*)::int FROM auth.users) u`)).rows[0];
const before = await census();

/**
 * Run one case against a throwaway employee, then roll everything back.
 *
 * `setup` receives the ids it needs and returns the membership id to watch, or
 * null when the case is "there is no membership". `FAKE_USER` is never a real
 * auth user, so a successful claim fails on the foreign key — which is itself
 * the signal that the guards let it through. Cases that must be refused never
 * reach that statement, so they complete cleanly.
 */
const FAKE_USER = '11111111-2222-3333-4444-555555555555';

async function withCase(email, setup) {
  const c = await connect();
  try {
    await c.query('BEGIN');
    const one = async (sql, p = []) => (await c.query(sql, p)).rows[0];

    const tenant = (await one("SELECT id FROM tenant WHERE slug = '360vhm'")).id;
    const dept = (await one('SELECT id FROM department LIMIT 1')).id;
    const site = (await one("SELECT id FROM site WHERE active LIMIT 1")).id;
    const entity = (await one('SELECT id FROM legal_entity LIMIT 1')).id;
    const shift = (await one('SELECT id FROM shift LIMIT 1')).id;
    const admin = (await one("SELECT id FROM employee WHERE code = 'VHM004'")).id;

    const emp = (await one(
      `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                             department_id, site_id, legal_entity_id, shift_id, joined_on)
       VALUES ($1, 'ZZCLAIM', 'Claim Probe', $2, 'active', 'employee', $3, $4, $5, $6, CURRENT_DATE)
       RETURNING id`, [tenant, email, dept, site, entity, shift])).id;

    const memId = await setup({ c, one, tenant, emp, admin });

    const statusBefore = memId
      ? (await one('SELECT status FROM tenant_membership WHERE id = $1', [memId])).status
      : null;

    let claimed = null;
    let threw = null;
    try {
      await c.query('SAVEPOINT s');
      const r = await c.query(
        'SELECT * FROM auth_claim_membership($1, $2::citext)', [FAKE_USER, email]);
      claimed = r.rows.length;
    } catch (e) {
      threw = e.constraint ?? e.code;
      await c.query('ROLLBACK TO SAVEPOINT s');
    }

    const statusAfter = memId
      ? (await one('SELECT status FROM tenant_membership WHERE id = $1', [memId])).status
      : null;

    return { claimed, threw, statusBefore, statusAfter };
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

/** A membership the administrator created and left open. */
const invited = (age = '0 days') => async ({ c, one, tenant, emp }) => (await one(
  `INSERT INTO tenant_membership
     (tenant_id, user_id, role, employee_id, status, invited_at, invite_sent_at)
   VALUES ($1, NULL, 'manager', $2, 'invited', now(), now() - $3::interval)
   RETURNING id`, [tenant, emp, age])).id;

console.log('\nwhat a first sign-in may claim\n');

/* ---- CASE 1: a valid invitation ---- */
{
  const r = await withCase('zz-case1@360.technology', invited());
  /*
   * The claim reaching the FK on user_id is the proof it was allowed: nothing
   * else in the function writes that column, and a refusal returns before it.
   */
  const allowed = r.threw === 'tenant_membership_user_id_fkey' || r.claimed > 0;
  ok('1. an open invitation is claimed', allowed,
    `returned ${r.claimed}, threw ${r.threw}, status ${r.statusBefore} -> ${r.statusAfter}`);
}

/* ---- CASE 2: withdrawn ---- */
{
  const r = await withCase('zz-case2@360.technology', async (ctx) => {
    const id = await invited()(ctx);
    await ctx.c.query(
      `UPDATE tenant_membership SET status='deleted', deleted_at=now(), deleted_by=$2
        WHERE id=$1`, [id, ctx.admin]);
    return id;
  });
  ok('2. a withdrawn invitation is refused', r.claimed === 0 && r.threw === null,
    `returned ${r.claimed}, threw ${r.threw} — this is the bug 0049 fixes`);
  ok('   and it stays withdrawn', r.statusAfter === 'deleted',
    `status went ${r.statusBefore} -> ${r.statusAfter}`);
}

/* ---- CASE 3: expired ---- */
{
  const r = await withCase('zz-case3@360.technology', invited('20 days'));
  ok('3. an expired invitation is refused', r.claimed === 0 && r.threw === null,
    `returned ${r.claimed}, threw ${r.threw}`);
  ok('   and it does not become active', r.statusAfter === 'invited',
    `status went ${r.statusBefore} -> ${r.statusAfter}`);
}

/* ---- CASE 4: no membership at all ---- */
{
  const r = await withCase('zz-case4@360.technology', async () => null);
  ok('4. an employee with no membership is refused', r.claimed === 0 && r.threw === null,
    `returned ${r.claimed}, threw ${r.threw} — signing in must not enrol anybody`);
}

/* ---- CASE 5: the address does not match ---- */
{
  const c = await connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(
      'SELECT * FROM auth_claim_membership($1, $2::citext)',
      [FAKE_USER, 'nobody-here@example.invalid']);
    ok('5. an address matching no employee is refused', r.rows.length === 0,
      `returned ${r.rows.length} rows`);
    const made = await c.query(
      "SELECT count(*)::int n FROM tenant_membership WHERE user_id = $1", [FAKE_USER]);
    ok('   and no membership is created for it', made.rows[0].n === 0);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

/* ---- CASE 6: the administrator, already active ---- */
{
  const c = await connect();
  try {
    const admin = (await c.query(`
      SELECT m.user_id, m.role, m.status FROM tenant_membership m
        JOIN employee e ON e.id = m.employee_id WHERE e.code = 'VHM004'`)).rows[0];
    ok('6. the existing administrator is active with a user',
      admin.status === 'active' && admin.user_id !== null && admin.role === 'admin',
      `status=${admin.status} role=${admin.role}`);

    /* auth_membership is what a returning session uses; the claim is not
       called for somebody who already has one. */
    const live = await c.query('SELECT * FROM auth_membership($1)', [admin.user_id]);
    ok('   and auth_membership still resolves them', live.rows.length === 1,
      `returned ${live.rows.length} rows`);
    ok('   with the admin role', live.rows[0]?.role === 'admin');
  } finally {
    await c.end();
  }
}

/* ---- nothing survived ---- */
const after = await census();
console.log('\nthe database is as it was\n');
ok(`employees ${before.e}`, before.e === after.e, `now ${after.e}`);
ok(`memberships ${before.m}`, before.m === after.m, `now ${after.m}`);
ok(`audit rows ${before.a}`, before.a === after.a, `now ${after.a}`);
ok(`auth users ${before.u}`, before.u === after.u, `now ${after.u}`);
await outside.end();

console.log(failed
  ? `\n${failed} failed\n`
  : '\nonly an open invitation is claimable, and nothing else was touched\n');
process.exit(failed ? 1 : 0);
