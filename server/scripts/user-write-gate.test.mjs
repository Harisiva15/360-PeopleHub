/**
 * Changing an account is a write, and only the write scope opens it.
 *
 * ## What was wrong
 *
 * Not the gate. `updateUser` asks `mayAdminister` — `users read ≥ team` — and
 * that is the model: the gate says whether you manage accounts at all, and the
 * row predicate says whose. The fault was in the predicate. `scopeFor` called
 * `employeeScope` without a verb, which defaults to `read`, so the *write*
 * predicate was built out of the *read* scope. Against
 *
 *     users: rule(NO, ['team','none','none'], ALL_R, NO, ALL_RWA)
 *
 * that read as: a manager writes their line, because `users read` is `team`
 * there; and anybody holding `users read all` *and* reports gets `TRUE`, full
 * write reach over every account in the tenant. hr_admin holds `users read
 * all`, so an HR administrator who managed one person administered everything.
 *
 * `inviteUser` already knew the gate alone was not enough — it asks `users
 * write all` itself, with a comment saying `mayAdminister` "admits a manager"
 * and that an invitation is not a manager's to send. That was a workaround at
 * one call site. Passing the verb is the rule in the one place that decides.
 *
 * **Why not `mayWrite` on the gate.** That was tried and reverted twice. It
 * refuses `createUser` for a manager and an HR administrator, which deletes
 * the raise-a-joiner workflow `provisioning.test.mjs` asserts — there, the
 * write scope is meant to decide what the create *means* (`pending_approval`
 * against a live account), not whether it happens. Assertions 1 to 3 are that
 * distinction, and they are why the fix belongs in the predicate.
 *
 * ## What it took away
 *
 * One assertion, in `employment.test.mjs`: a manager changing their own
 * report's designation. It was never reachable — `ACTION_GATE` puts
 * `user.edit` behind `users write` and `ACTION_SCOPE` gives the manager layer
 * `none`, so no screen has ever rendered Edit for a manager, and the drawer is
 * the only path to `updateUser`. And because the row is the unit — there is no
 * per-field gate inside `updateUser` — "a manager may fix a designation" was
 * in fact "a manager may change their report's name and work email too".
 *
 * ## Why the email change is audited by itself
 *
 * `user.updated` records which field *names* changed, which is enough to go
 * and look — except for this one. `inviteUser` reads `work_email` inside its
 * own transaction and posts it to Supabase's invite endpoint, so changing the
 * address and then resending an invitation sends a set-password link to the
 * new one. The question afterwards is "from what, to what, by whom", and only
 * a dedicated entry can answer it.
 *
 * ## What this does not assert
 *
 * The reads. `listUsers` and `getUser` keep `mayAdminister` on purpose — a
 * manager reading their own line is the policy — and assertions 32 and 33
 * require that the tightening did not take that away.
 */

import pg from 'pg';

import { loadEnv } from './env.mjs';

import { assertLocalDatabase } from './local-only.mjs';

/* This suite writes. It refuses anything but a local database. */
assertLocalDatabase();

loadEnv();

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and an account is a row in one.\n');
  process.exit(0);
}

const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');
const {
  createUser, updateUser, setUserStatus, bulkUpdateUsers, nextEmployeeCode,
  listUsers, getUser, UserError,
} = await import('../src/modules/users/service.ts');
const { closePool } = await import('../src/db/pool.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};
const refused = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};
const forbidden = (e) => e instanceof UserError && e.code === 'forbidden';

const admin = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();
await sweepScratchTenants(admin);

console.log('');
let fatal = null;
try {
  await withScratchTenant(admin, async (ctx) => {
    const caller = (role, hasReports) => ({
      role, hasReports, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
    });

    /* The three the policy distinguishes. The manager is an employee whose
       reach comes entirely from the manager layer, which is the case that
       made a read gate look like enough. */
    const companyAdmin = caller('company_admin', false);
    const hrAdmin = caller('hr_admin', false);
    const manager = caller('employee', true);

    const draft = (code) => ({
      name: `ZZ Gate ${code}`,
      email: `zz-gate-${code}-${Date.now().toString(36)}@360.technology`,
      role: 'employee',
      dept: ctx.dept,
      site: ctx.site,
      designation: 'Tester',
    });

    /* ---------------------------------------------------------------- *
     * Creating
     * ---------------------------------------------------------------- */

    /*
     * Creating is a read gate, and the write scope decides what the create
     * *means*: `createUser` sets `status` to `pending_approval` for anybody
     * without `users write all`. A manager raising a joiner makes a request;
     * an administrator makes an account.
     *
     * The first version of this suite asserted that an HR administrator and a
     * manager were refused outright, which is what the code did after I put
     * `mayWrite` here — and it deleted a workflow `provisioning.test.mjs`
     * asserts on. The boundary is the status, not the refusal.
     */
    console.log('\ncreating an account\n');

    const hrMade = await createUser(hrAdmin, draft('hr'));
    ok('1. an HR administrator raises a request, not a live account',
      hrMade.status === 'Pending Approval', String(hrMade.status));

    const mgrMade = await createUser(manager,
      { ...draft('mgr'), managerId: ctx.adminEmployeeId });
    ok('2. so does a manager raising a joiner on their own line',
      mgrMade.status === 'Pending Approval', String(mgrMade.status));

    let made = null;
    const byAdmin = await refused(async () => { made = await createUser(companyAdmin, draft('adm')); });
    ok('3. and the company administrator creates the account itself',
      byAdmin === null && made?.status !== 'Pending Approval',
      `${byAdmin?.code ?? ''} ${made?.status ?? byAdmin?.message}`);

    /* ---------------------------------------------------------------- *
     * Who may change whose name, work email and role
     * ---------------------------------------------------------------- *
     *
     * The whole table, asserted rather than described, because the answer used
     * to depend on a scope the question was not about.
     *
     *                      own account   own report   anybody else
     *   employee               no            —             no
     *   manager                no            no            no
     *   hr_admin               no            —             no
     *   finance_admin          no            —             no
     *   company_admin         yes*          yes           yes
     *
     *   * subject to the two role guards: an administrator cannot remove their
     *     own administrator role, and the last administrator cannot be demoted
     *     by anybody. Both are asserted in `last-admin.test.mjs`.
     *
     * So: only company_admin, for anybody in the tenant. The row is the unit,
     * not the field — there is no per-field gate inside `updateUser`, which is
     * why "a manager may fix their report's designation" was in fact "a manager
     * may change their report's name and work email", and why the work email
     * matters most: `inviteUser` reads it inside its own transaction and posts
     * it to Supabase, so whoever can change the address can redirect a
     * set-password link.
     *
     * The manager row is the one worth reading twice. The refusal is not
     * because the line is empty — `boss` really does manage `report`, and the
     * recursive scope really does find them — it is because `users write` is
     * `none` for the manager layer and the predicate now asks about writing.
     */

    console.log('\nwho may change whose name, email and role\n');

    const bossAcct = await createUser(companyAdmin, draft('boss'));
    const reportAcct = await createUser(companyAdmin,
      { ...draft('rep'), managerId: bossAcct.empId });
    const boss = {
      role: 'employee', hasReports: true, tenantId: ctx.tenant,
      employeeId: bossAcct.empId, userId: null,
    };
    const plain = {
      role: 'employee', hasReports: false, tenantId: ctx.tenant,
      employeeId: reportAcct.empId, userId: null,
    };
    const finance = {
      role: 'finance_admin', hasReports: false, tenantId: ctx.tenant,
      employeeId: ctx.adminEmployeeId, userId: null,
    };

    /* The line really exists, so the refusals below are about the verb. */
    const lineExists = (await admin.query(
      'SELECT manager_id FROM employee WHERE id = $1', [reportAcct.empId]))
      .rows[0]?.manager_id === bossAcct.empId;
    ok('4. the manager really does manage the report', lineExists,
      'otherwise the refusals below would prove nothing about the verb');

    const FIELDS = [
      ['their name', { name: 'ZZ Renamed By Test' }],
      ['their work email', { email: `zz-redirect-${Date.now().toString(36)}@360.technology` }],
      ['their role', { role: 'hr_admin' }],
    ];

    const ROWS = [
      ['an employee', plain, [['their own account', reportAcct], ['somebody else', bossAcct]]],
      ['a manager', boss, [
        ['their own account', bossAcct],
        ['their own report', reportAcct],
        ['somebody else', made],
      ]],
      ['an HR administrator', hrAdmin, [['any account', reportAcct]]],
      ['a finance administrator', finance, [['any account', reportAcct]]],
    ];

    let row = 4;
    for (const [who, caller_, subjects] of ROWS) {
      for (const [whose, subject] of subjects) {
        for (const [what, patch] of FIELDS) {
          row += 1;
          const e = await refused(() => updateUser(caller_, subject.id, patch));
          ok(`${row}. ${who} cannot change ${what} on ${whose}`,
            forbidden(e), e ? `${e.code}: ${e.message}` : 'it was allowed');
        }
      }
    }

    /* And the one role that can, on somebody who is not itself. */
    const admName = await updateUser(companyAdmin, reportAcct.id, { name: 'ZZ Renamed By Admin' });
    ok(`${row + 1}. the company administrator changes a name`,
      admName.name === 'ZZ Renamed By Admin', admName.name);
    const admRole = await updateUser(companyAdmin, reportAcct.id, { role: 'hr_admin' });
    ok('    and a role', admRole.role === 'hr_admin', String(admRole.role));
    const admEmail = `zz-admin-set-${Date.now().toString(36)}@360.technology`;
    const admMail = await updateUser(companyAdmin, reportAcct.id, { email: admEmail });
    ok('    and a work email', admMail.email === admEmail, admMail.email);

    /* ---------------------------------------------------------------- *
     * Changing
     * ---------------------------------------------------------------- */

    console.log('\nand the rest of the account surface goes the same way\n');

    /*
     * `scopeFor` passes the verb through, so `users write` — company_admin's
     * alone by the declared policy — is what these ask. An HR administrator
     * reaches none of them whether or not they manage somebody, which is the
     * half the old read-derived predicate got wrong: hr_admin plus one report
     * came out as `TRUE`, write reach over every account in the tenant.
     */
    const upHr = await refused(() => updateUser(hrAdmin, made.id, { name: 'ZZ Renamed' }));
    ok('27. an HR administrator cannot change an account',
      forbidden(upHr), `${upHr?.code}: ${upHr?.message}`);

    const upMgr = await refused(() => updateUser(manager, made.id, { name: 'ZZ Renamed' }));
    ok('28. nor a manager, for anybody at all',
      forbidden(upMgr), `${upMgr?.code}: ${upMgr?.message}`);

    /* The display form, which is what the API takes — `'suspended'` is the
       database's spelling and is rejected as invalid before the scope is ever
       consulted, so asserting on it proved nothing about permissions. */
    const statusHr = await refused(() => setUserStatus(hrAdmin, made.id, 'Suspended'));
    ok('29. nor suspend one', forbidden(statusHr), `${statusHr?.code}: ${statusHr?.message}`);

    const bulkHr = await refused(() => bulkUpdateUsers(hrAdmin, [made.id], { role: 'employee' }));
    ok('30. nor change a batch of them', forbidden(bulkHr), `${bulkHr?.code}: ${bulkHr?.message}`);

    /* And the next free code stays open, because the form that raises a
       joiner needs it and raising one is allowed. */
    const codeHr = await refused(() => nextEmployeeCode(hrAdmin));
    ok('31. while the next free employee code stays readable',
      codeHr === null, `${codeHr?.code}: ${codeHr?.message}`);

    /* ---------------------------------------------------------------- *
     * And the reads are untouched
     * ---------------------------------------------------------------- */

    console.log('\nwhile reading is exactly as it was\n');

    /*
     * Asserted on the *contents*, not on "it did not throw".
     *
     * `scopeFor` asked the write scope for visibility too, so an HR
     * administrator's `listUsers` returned an empty array — no error, no
     * refusal, simply nothing — and `getUser` refused an account they are
     * entitled to read. The first draft of this suite only checked that
     * neither call threw, and an empty list passes that.
     */
    const hrRows = await listUsers(hrAdmin);
    ok('32. an HR administrator reads every account, not an empty list',
      hrRows.length > 0 && hrRows.some((u) => u.id === made.id),
      `${hrRows.length} rows`);

    const hrOne = await getUser(hrAdmin, made.id);
    ok('    and opens one', Boolean(hrOne?.id), JSON.stringify(hrOne?.id ?? null));

    const mgrList = await refused(() => listUsers(manager));
    ok('33. and a manager still reads their line',
      mgrList === null, `${mgrList?.code}: ${mgrList?.message}`);

    /* ---------------------------------------------------------------- *
     * The email-change entry
     * ---------------------------------------------------------------- */

    console.log('\nand a changed work email says so by itself\n');

    const entries = async (action) => (await admin.query(
      `SELECT detail->>'summary' AS summary
         FROM audit_log
        WHERE tenant_id = $1 AND subject_id = $2 AND action = $3
        ORDER BY id DESC`, [ctx.tenant, made.id, action])).rows;

    const before = made.email;
    const after = `zz-gate-moved-${Date.now().toString(36)}@360.technology`;
    await updateUser(companyAdmin, made.id, { email: after });

    const changed = await entries('user.email_changed');
    ok('34. the change is recorded on its own',
      changed.length === 1, JSON.stringify(changed));
    ok('    carrying the address it was',
      (changed[0]?.summary ?? '').includes(before), String(changed[0]?.summary));
    ok('    and the one it became',
      (changed[0]?.summary ?? '').includes(after), String(changed[0]?.summary));

    await updateUser(companyAdmin, made.id, { name: 'ZZ Gate Renamed' });
    ok('35. an edit that leaves the email alone records nothing',
      (await entries('user.email_changed')).length === 1,
      JSON.stringify(await entries('user.email_changed')));

    /* Re-sending the same address is not a change either — a form that posts
       every field would otherwise log one on every save. */
    await updateUser(companyAdmin, made.id, { email: after.toUpperCase() });
    ok('    nor does resubmitting the same address in another case',
      (await entries('user.email_changed')).length === 1,
      JSON.stringify(await entries('user.email_changed')));
  });
} catch (e) {
  fatal = e;
  failed += 1;
  console.log(`\n  FAIL  the suite threw: ${e?.message ?? e}`);
  if (e?.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
} finally {
  await admin.end();
  await closePool();
}

console.log(`\n${failed ? `${failed} FAILED` : 'only the write scope changes an account, and a changed email says so'}\n`);
process.exit(failed ? 1 : 0);
