/**
 * Who may send an invitation, which memberships may receive one, and what is
 * recorded when the send fails.
 *
 * The provider is substituted through `setAuthAdmin`, so nothing here sends an
 * email. That is the only thing substituted: the authorisation, the membership
 * rules, the transaction and the audit write are the real ones, because those
 * are what this is testing. A test that mocked `mayAdminister` would prove
 * only that the mock works.
 *
 * The property worth stating plainly: **a refused send must not leave a record
 * saying one happened.** The previous implementation incremented the counter
 * and stamped the time without contacting anybody at all, so every account
 * looked invited and none had been. The provider is therefore called inside
 * the transaction, and a throw takes the counter with it.
 *
 * Fixtures are built and rolled back. Row counts are re-read afterwards on a
 * second connection to prove nothing survived.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { assertLocalDatabase } from './local-only.mjs';

/* This suite writes. It refuses anything but a local database. */
assertLocalDatabase();

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and these rules live in a transaction.\n');
  process.exit(0);
}

/*
 * A test process needs two connections, not ten. The pooler counts clients
 * across everything talking to it — a running dev server included — and the
 * refusal when it runs out arrives as a connection-time ENOIDENTIFIER rather
 * than anything that mentions capacity. Set before the pool module is loaded,
 * because it reads this once.
 */
process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';
/**
 * Which tenant and which administrator this suite reads.
 *
 * These were the literals '360vhm' and 'VHM004' — the live tenant's own slug and
 * its HR head's employee code — so the suite could only run against that one
 * database. A seeded database numbers its admin differently (`npm run seed`
 * makes VHM001), and the suite found no context row, dereferenced undefined and
 * died before its first assertion.
 *
 * Defaults unchanged, so running this against production behaves exactly as
 * before; CI points them at what it seeded.
 */
const TENANT_SLUG = process.env.TEST_TENANT_SLUG ?? '360vhm';
const ADMIN_CODE = process.env.TEST_ADMIN_CODE ?? 'VHM004';


const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const { inviteUser, resendInvitation, passwordChanged, createUser, nextEmployeeCode } = await import('../src/modules/users/service.ts');
const { withScratchTenant } = await import('./lib/scratch-tenant.mjs');
const { setAuthAdmin } = await import('../src/auth/adminApi.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

/*
 * TLS through the shared helper rather than a hard-coded `rejectUnauthorized`.
 *
 * Identical against Supabase, which needs TLS: with no PGSSLROOTCERT set it
 * still returns { rejectUnauthorized: false }. The difference is CI, where
 * PGSSLMODE=disable and the helper returns false — a stock postgres:17 service
 * container offers no TLS at all, so insisting on it fails to connect, and
 * these suites could not run there.
 */
const admin = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: sslConfig(),
});
await admin.connect();

const census = async () => (await admin.query(`
  SELECT (SELECT count(*)::int FROM employee) e,
         (SELECT count(*)::int FROM tenant_membership) m,
         (SELECT count(*)::int FROM audit_log) a`)).rows[0];
const before = await census();

const ctx = (await admin.query(`
  SELECT t.id tenant, e.id emp,
         (SELECT id FROM department LIMIT 1) dept,
         (SELECT id FROM site WHERE active LIMIT 1) site,
         (SELECT id FROM legal_entity LIMIT 1) entity,
         (SELECT id FROM shift LIMIT 1) shift
    FROM tenant t JOIN employee e ON e.tenant_id = t.id
   WHERE t.slug = $1 AND e.code = $2`, [TENANT_SLUG, ADMIN_CODE])).rows[0];

const ADMIN = { role: 'company_admin', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.emp, userId: null };
const MANAGER = { role: 'employee', hasReports: true, tenantId: ctx.tenant, employeeId: ctx.emp, userId: null };
const EMPLOYEE = { role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.emp, userId: null };

/** A provider that records what it was asked and answers how it was told to. */
const spy = (behaviour) => {
  const calls = [];
  return {
    calls,
    inviteToSetPassword(email, redirectTo) {
      calls.push({ email, redirectTo });
      return behaviour(email, redirectTo);
    },
  };
};

/**
 * Build a membership in a transaction, run `body`, then roll back.
 *
 * The service opens its own transaction through withTenant, so the fixture is
 * committed on a separate connection and removed afterwards — a rollback here
 * would not be visible to it.
 */
async function withMembership(status, opts, body) {
  const email = `zz-invite-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@360.technology`;
  const emp = (await admin.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id, joined_on)
     VALUES ($1, $2, 'Invite Probe', $3, 'active', 'employee', $4, $5, $6, $7, CURRENT_DATE)
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      email, ctx.dept, ctx.site, ctx.entity, ctx.shift])).rows[0].id;

  const mem = (await admin.query(
    `INSERT INTO tenant_membership
       (tenant_id, user_id, role, employee_id, status, invited_at, invite_sent_at)
     VALUES ($1, NULL, $2, $3, 'invited', now(), $4)
     RETURNING id`,
    [ctx.tenant, opts.role ?? 'manager', emp, opts.sentAt ?? null])).rows[0].id;

  if (status !== 'invited') {
    await admin.query(
      `UPDATE tenant_membership SET status = $2,
              deleted_at = CASE WHEN $2 = 'deleted' THEN now() END,
              deleted_by = CASE WHEN $2 = 'deleted' THEN $3::uuid END
        WHERE id = $1`, [mem, status, ctx.emp]);
  }

  try {
    return await body({ mem, emp, email });
  } finally {
    await admin.query('DELETE FROM tenant_membership WHERE id = $1', [mem]);
    await admin.query('DELETE FROM audit_log WHERE subject_id = $1', [mem]);
    await admin.query('DELETE FROM employee WHERE id = $1', [emp]);
  }
}

const stateOf = async (mem) => (await admin.query(
  'SELECT status, invited_count, invite_sent_at FROM tenant_membership WHERE id = $1',
  [mem])).rows[0];

const auditFor = async (mem) => (await admin.query(
  `SELECT action, detail::text FROM audit_log
    WHERE subject_id = $1 AND action LIKE 'user.invit%' ORDER BY occurred_at`, [mem])).rows;

const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

/*
 * Supabase's pooler refuses a connection whose username carries no project
 * ref, and reports it as ENOIDENTIFIER — which surfaces here as a bare
 * connection failure with no hint about the cause. Left alone it is a stack
 * trace that sends people to look at the wrong thing, so it is named.
 */
const explain = (e) => {
  const text = String(e?.message ?? e);

  /*
   * The pooler stops accepting connections for a role after repeated failed
   * authentication, and stays shut for a few minutes. The usual cause is a
   * wrong username or password that has just been corrected — the breaker
   * does not know that and is still counting the old attempts.
   */
  if (/ECIRCUITBREAKER/.test(text)) {
    console.error([
      '',
      '  FAIL  the pooler is refusing new connections for this role',
      '',
      '        Supabase trips a circuit breaker after repeated authentication',
      '        failures and keeps it shut for a few minutes. If the credentials',
      '        were just corrected, they are probably right and this is the',
      '        breaker still counting the attempts that were wrong.',
      '',
      '        Wait a few minutes and run it again. Nothing needs changing.',
      '',
    ].join('\n'));
    return true;
  }

  if (!/ENOIDENTIFIER/.test(text)) return false;
  console.error([
    '',
    '  FAIL  the database refused the connection',
    '',
    "        Supabase's pooler needs the username to be <role>.<project-ref>.",
    '        DATABASE_URL in server/.env has no ref on its username, so every',
    '        runtime connection is refused. MIGRATE_DATABASE_URL does have one,',
    '        which is why migrations and the claim tests still work.',
    '',
    `        Append .${process.env.SUPABASE_REF ?? '<project-ref>'} to the role in that URL's`,
    '        username. Change nothing else — the password is not the problem.',
    '',
  ].join('\n'));
  return true;
};

for (const signal of ['unhandledRejection', 'uncaughtException']) {
  process.on(signal, (e) => {
    if (!explain(e)) console.error(e);
    process.exit(1);
  });
}

console.log('\nwho may send an invitation\n');

{
  const api = spy(() => Promise.resolve({ kind: 'invited' }));
  const was = setAuthAdmin(api);
  try {
    await withMembership('invited', {}, async ({ mem }) => {
      const err = await attempt(() => inviteUser(ADMIN, mem));
      ok('1. an admin may invite', err === null, String(err?.message));
      ok('   and the provider was asked once', api.calls.length === 1);
      const st = await stateOf(mem);
      ok('   invite_sent_at is stamped', st.invite_sent_at !== null);
      /*
       * The column defaults to 1 — the row counts the invitation it was
       * created for — so one send makes it 2.
       */
      ok('   invited_count advanced by one', st.invited_count === 2, `got ${st.invited_count}`);
    });

    await withMembership('invited', {}, async ({ mem }) => {
      const err = await attempt(() => inviteUser(MANAGER, mem));
      ok('2. a manager may not invite', err !== null && /admin/i.test(err.message),
        String(err?.message));
      const st = await stateOf(mem);
      ok('   and nothing was recorded', st.invited_count === 1 && st.invite_sent_at === null);
    });

    await withMembership('invited', {}, async ({ mem }) => {
      const err = await attempt(() => inviteUser(EMPLOYEE, mem));
      ok('3. an employee may not invite', err !== null && /admin/i.test(err.message));
    });
  } finally { setAuthAdmin(was); }
}

console.log('\nwhich memberships may receive one\n');

/*
 * Only three statuses can exist without a user — pending_approval, invited and
 * deleted — because  says so. The other
 * four always carry one, so they cannot be built here without an auth user to
 * attach, and there is exactly one in this project. That is not a gap: the
 * invite path refuses everything that is not  with one condition, so
 * the two reachable cases exercise the whole rule.
 */
for (const [status, label] of [
  ['deleted', '4. a withdrawn invitation'],
  ['pending_approval', '5. one still awaiting approval'],
]) {
  const api = spy(() => Promise.resolve({ kind: 'invited' }));
  const was = setAuthAdmin(api);
  try {
    await withMembership(status, {}, async ({ mem }) => {
      const err = await attempt(() => inviteUser(ADMIN, mem));
      ok(`${label} is refused`, err !== null, 'it was accepted');
      ok('   the provider was never called', api.calls.length === 0,
        `called ${api.calls.length} times`);
      const st = await stateOf(mem);
      ok(`   and it stays ${status}`, st.status === status, `became ${st.status}`);
    });
  } finally { setAuthAdmin(was); }
}

console.log('\na refused send records nothing\n');

{
  const api = spy(() => Promise.reject(new Error('the mail provider said no')));
  const was = setAuthAdmin(api);
  try {
    await withMembership('invited', {}, async ({ mem }) => {
      const err = await attempt(() => inviteUser(ADMIN, mem));
      ok('7. the failure reaches the caller', err !== null);
      const st = await stateOf(mem);
      ok('   invite_sent_at is still null', st.invite_sent_at === null,
        'a refused send left a record saying one happened');
      ok('   invited_count did not move', st.invited_count === 1, `got ${st.invited_count}`);
      ok('   and no audit row was written', (await auditFor(mem)).length === 0);
    });
  } finally { setAuthAdmin(was); }
}

console.log('\nwhat is sent, and what is written down\n');

{
  const api = spy(() => Promise.resolve({ kind: 'invited' }));
  const was = setAuthAdmin(api);
  try {
    /*
     * `role` here is a `tenant_membership` column value, not a Caller.
     *
     * `sweep-fixtures.mjs` rewrote it as though it were one — 'manager' became
     * `role: 'employee', hasReports: true` — which changed what the row holds
     * and broke the assertion below that the audit detail carries the role.
     * The sweep had no way to tell a database value from a caller fixture, and
     * this is the one place in these suites where that mattered.
     *
     * 'manager' is a legitimate membership value during expand: 0056 widened
     * the CHECK to accept both vocabularies. Step C tightens it to the new
     * names only, and this fixture has to change then.
     */
    await withMembership('invited', { role: 'manager' }, async ({ mem, email }) => {
      await inviteUser(ADMIN, mem);
      ok('8. the address invited is the employee\'s own', api.calls[0]?.email === email,
        `asked for ${api.calls[0]?.email}`);
      ok('   the redirect is APP_BASE_URL', api.calls[0]?.redirectTo === process.env.APP_BASE_URL.replace(/\/+$/, ''),
        `asked for ${api.calls[0]?.redirectTo}`);

      const rows = await auditFor(mem);
      ok('9. an audit row is written', rows.length === 1, `${rows.length} rows`);
      ok('   naming the first send', rows[0]?.action === 'user.invited', rows[0]?.action);
      ok('   carrying the role', /manager/.test(rows[0]?.detail ?? ''));

      const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
      const blob = JSON.stringify(rows);
      ok('10. and no secret, token or address',
        !blob.includes(secret) && !blob.includes(email) && !/token|password/i.test(blob));
    });
  } finally { setAuthAdmin(was); }
}

console.log('\nsending twice\n');

{
  const api = spy(() => Promise.resolve({ kind: 'recovered' }));
  const was = setAuthAdmin(api);
  try {
    await withMembership('invited', { sentAt: new Date().toISOString() }, async ({ mem, emp }) => {
      await resendInvitation(ADMIN, mem);
      const st = await stateOf(mem);
      ok('11. a resend goes through the same path', api.calls.length === 1);
      ok('    and counts as a resend', (await auditFor(mem))[0]?.action === 'user.invite_resent',
        (await auditFor(mem))[0]?.action);

      /* Two at once must not double anything. */
      const n0 = st.invited_count;
      await Promise.all([resendInvitation(ADMIN, mem), resendInvitation(ADMIN, mem)]);
      const st2 = await stateOf(mem);
      ok('12. two concurrent sends advance the count by exactly two',
        st2.invited_count === n0 + 2, `${n0} -> ${st2.invited_count}`);

      const mems = await admin.query(
        'SELECT count(*)::int n FROM tenant_membership WHERE employee_id = $1', [emp]);
      ok('    and create no second membership', mems.rows[0].n === 1, `${mems.rows[0].n} memberships`);
    });
  } finally { setAuthAdmin(was); }
}

console.log('\nan address that already has a sign-in\n');

{
  const api = spy(() => Promise.resolve({ kind: 'recovered' }));
  const was = setAuthAdmin(api);
  try {
    await withMembership('invited', {}, async ({ mem, emp }) => {
      await inviteUser(ADMIN, mem);
      const rows = await auditFor(mem);
      ok('13. a recovery is recorded as such', /existing sign-in/.test(rows[0]?.detail ?? ''),
        rows[0]?.detail);
      const mems = await admin.query(
        'SELECT count(*)::int n FROM tenant_membership WHERE employee_id = $1', [emp]);
      ok('    and still one membership', mems.rows[0].n === 1);
    });
  } finally { setAuthAdmin(was); }
}

/*
 * Creating an account with an invitation sends one, or records none.
 *
 * `createUser` stamped `invite_sent_at` and `invited_count = 1` whenever the
 * caller was an administrator, while never asking the provider for anything —
 * so every account made from the Users screen recorded an invitation nobody
 * sent, and the drawer displayed its date. The `sendInvitation` flag reached
 * only `must_change_password`, which is why ticking the box changed nothing an
 * email could come out of.
 *
 * A scratch tenant, because `createUser` needs reference data to look up by
 * code — a department, a site, a shift, a legal entity — and because deleting
 * the tenant at the end takes everything this block made with it, which is
 * what keeps the census below honest.
 */
console.log('\nan account created with an invitation actually sends one\n');

await withScratchTenant(admin, async (sctx) => {
  const A = {
    role: 'company_admin', hasReports: false,
    tenantId: sctx.tenant, employeeId: sctx.adminEmployeeId, userId: null,
  };

  let seq = 0;
  const draft = (over = {}) => {
    seq += 1;
    return {
      name: `ZZ Invitee ${seq}`,
      email: `zz-invitee-${seq}-${Math.random().toString(36).slice(2, 8)}@360.technology`,
      dept: sctx.dept,
      site: sctx.site,
      designation: 'Engineer',
      role: 'employee',
      joinedOn: '2026-09-01',
      ...over,
    };
  };

  const memFor = async (email) => (await admin.query(
    `SELECT m.invite_sent_at, m.invited_count, m.must_change_password
       FROM tenant_membership m JOIN employee e ON e.id = m.employee_id
      WHERE lower(e.work_email) = lower($1)`, [email])).rows[0];

  const actionsFor = async (email) => (await admin.query(
    `SELECT a.action FROM audit_log a
       JOIN tenant_membership m ON m.id = a.subject_id
       JOIN employee e ON e.id = m.employee_id
      WHERE lower(e.work_email) = lower($1)
      ORDER BY a.occurred_at`, [email])).rows.map((r) => r.action);

  /* --- the box is ticked: something must actually go out --- */
  {
    const api = spy(() => Promise.resolve({ kind: 'invited' }));
    const was = setAuthAdmin(api);
    try {
      const d = draft({ sendInvitation: true });
      await createUser(A, d);
      ok('14. the provider was actually asked', api.calls.length === 1,
        `${api.calls.length} call(s) — this is the regression`);
      ok('    with the address of the new hire',
        api.calls[0]?.email === d.email.trim(), api.calls[0]?.email);
      const m = await memFor(d.email);
      ok('    invite_sent_at is stamped', Boolean(m?.invite_sent_at));
      ok('    invited_count is 1', m?.invited_count === 1, String(m?.invited_count));
      ok('    and a user.invited row was written',
        (await actionsFor(d.email)).includes('user.invited'),
        (await actionsFor(d.email)).join(', '));
    } finally { setAuthAdmin(was); }
  }

  /* --- the box is unticked: nothing sent, and nothing claimed --- */
  {
    const api = spy(() => Promise.resolve({ kind: 'invited' }));
    const was = setAuthAdmin(api);
    try {
      const d = draft({ sendInvitation: false });
      await createUser(A, d);
      ok('15. "I will tell them myself" sends nothing', api.calls.length === 0,
        `${api.calls.length} call(s)`);
      const m = await memFor(d.email);
      ok('    invite_sent_at stays null', m?.invite_sent_at === null,
        'an unsent invitation must not be recorded as sent');
      ok('    invited_count stays 0', m?.invited_count === 0, String(m?.invited_count));
      ok('    and they must set a password at first sign-in',
        m?.must_change_password === true);
      ok('    no user.invited row', !(await actionsFor(d.email)).includes('user.invited'));
    } finally { setAuthAdmin(was); }
  }

  /* --- the provider refuses: the whole account goes with it --- */
  {
    const api = spy(() => Promise.reject(new Error('the mail provider said no')));
    const was = setAuthAdmin(api);
    try {
      const d = draft({ sendInvitation: true });
      const err = await attempt(() => createUser(A, d));
      ok('16. a refused send fails the creation', err !== null,
        'the account was created although the invitation was refused');
      const emp = await admin.query(
        'SELECT 1 FROM employee WHERE lower(work_email) = lower($1)', [d.email]);
      ok('    and leaves no employee row', emp.rowCount === 0,
        `${emp.rowCount} row(s) survived the rollback`);
      ok('    nor a membership', (await memFor(d.email)) === undefined);
      ok('    nor an audit trail', (await actionsFor(d.email)).length === 0);
    } finally { setAuthAdmin(was); }
  }

  /*
   * The suggested employee ID follows this tenant's own format.
   *
   * It used to be `E${n}` with the letter hard-coded and the number padded to
   * three. That was wrong twice: it ignored the tenant's format — production
   * uses VHM004, so it proposed E007 — and `/^E\d{3}$/` is exactly the shape
   * the browser's demo-id guard refuses, so every suggestion was rejected by
   * the client before it could be sent. "Suggest" could not produce a usable
   * value for any tenant with fewer than a thousand people.
   *
   * The scratch tenant's only employee is ZZ001, so the successor is ZZ002:
   * same prefix, same width.
   */
  {
    /*
     * Derived, not hard-coded. The cases above created people in this same
     * scratch tenant and each one consumed a code, so a literal expectation
     * here would encode the order of the whole block — and would have to be
     * edited every time a case is added above, which is how an expectation
     * stops meaning anything.
     */
    const mine = (await admin.query(
      `SELECT code FROM employee WHERE tenant_id = $1 AND code ~ '^ZZ[0-9]+$'
        ORDER BY code`, [sctx.tenant])).rows.map((r) => r.code);
    const highest = Math.max(...mine.map((c) => Number(c.slice(2))));
    const expected = `ZZ${String(highest + 1).padStart(3, '0')}`;

    const first = await nextEmployeeCode(A);
    ok('18. the suggestion keeps the tenant prefix and width',
      first === expected,
      `got ${first}, expected ${expected} after ${mine.join(', ')}`);
    ok('    and is not the shape the client guard refuses',
      !/^E\d{3}$/.test(first),
      'every suggestion used to match it, so Suggest could never be saved');
    ok('    and is not already taken', !mine.includes(first), first);

    /* A gap, to prove the width is taken from the codes and not assumed. */
    const api = spy(() => Promise.resolve({ kind: 'invited' }));
    const was = setAuthAdmin(api);
    try {
      await createUser(A, draft({ sendInvitation: false, code: 'ZZ009' }));
      const after = await nextEmployeeCode(A);
      ok('    it follows the highest code, not the row count', after === 'ZZ010', after);
    } finally { setAuthAdmin(was); }
  }
});

/*
 * A membership with no employee record is told so, not told "fine".
 *
 * `passwordChanged` used to `return { ok: true }` for a caller with no
 * employeeId. That is the worst answer available: the flag stays set, the
 * browser is told the change was recorded, and the next sign-in asks again —
 * permanently, with no failure recorded anywhere. The client suite cannot
 * catch a regression here because it fakes the server, so the guard is
 * asserted against the real function.
 *
 * It throws before opening a transaction, so no fixture is needed.
 */
console.log('\na password change it cannot record is not reported as recorded\n');
{
  const orphan = { role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: null, userId: null };
  let threw = null;
  try {
    const answer = await passwordChanged(orphan);
    ok('17. no employeeId is refused, not accepted', false,
      `returned ${JSON.stringify(answer)} instead of throwing — this is the regression`);
  } catch (e) {
    threw = e;
    ok('17. no employeeId is refused, not accepted', true);
  }
  ok('    and the message names the cause',
    /not linked to an employee record/i.test(threw?.message ?? ''),
    threw?.message ?? '(no message)');
  ok('    and says the password itself was saved',
    /password was saved/i.test(threw?.message ?? ''),
    'the person must know not to re-type it');
  ok('    and tells them who can fix it',
    /administrator/i.test(threw?.message ?? ''),
    threw?.message ?? '(no message)');
}

console.log('\nnothing survived\n');
const after = await census();
ok(`employees ${before.e}`, before.e === after.e, `now ${after.e}`);
ok(`memberships ${before.m}`, before.m === after.m, `now ${after.m}`);
ok(`audit rows ${before.a}`, before.a === after.a, `now ${after.a}`);
await admin.end();

console.log(failed ? `\n${failed} failed\n` : '\nonly an open invitation is sent, and only a real send is recorded\n');
process.exit(failed ? 1 : 0);
