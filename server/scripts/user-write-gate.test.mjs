/**
 * Changing an account is a write, and only the write scope opens it.
 *
 * ## What was wrong
 *
 * `createUser`, `updateUser`, `setUserStatus` and `bulkUpdateUsers` all gated
 * on `mayAdminister`, which asks for `users read ≥ team`. The declared policy
 *
 *     users: rule(NO, ['team','none','none'], ALL_R, NO, ALL_RWA)
 *
 * gives write to the company administrator and to nobody else — but hr_admin
 * holds `users read all` and any manager with reports holds `users read team`,
 * so both satisfied a read gate standing in front of a write.
 *
 * `inviteUser` already knew. It asks `users write all` itself, with a comment
 * saying `mayAdminister` "admits a manager" and that an invitation is not a
 * manager's to send. That was a workaround at one call site; `mayWrite` is the
 * same rule everywhere it belongs.
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
 * manager reading their own line is the policy — and assertions 9 and 10
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

    console.log('\ncreating an account\n');

    const byHr = await refused(() => createUser(hrAdmin, draft('hr')));
    ok('1. an HR administrator cannot create an account',
      forbidden(byHr), `${byHr?.code}: ${byHr?.message}`);

    const byMgr = await refused(() => createUser(manager, draft('mgr')));
    ok('2. nor can a manager with reports',
      forbidden(byMgr), `${byMgr?.code}: ${byMgr?.message}`);

    let made = null;
    const byAdmin = await refused(async () => { made = await createUser(companyAdmin, draft('adm')); });
    ok('3. the company administrator can, which is what the policy says',
      byAdmin === null && Boolean(made?.id), `${byAdmin?.code}: ${byAdmin?.message}`);

    /* ---------------------------------------------------------------- *
     * Changing
     * ---------------------------------------------------------------- */

    console.log('\nchanging one\n');

    const upHr = await refused(() => updateUser(hrAdmin, made.id, { name: 'ZZ Renamed' }));
    ok('4. an HR administrator cannot change an account',
      forbidden(upHr), `${upHr?.code}: ${upHr?.message}`);

    const upMgr = await refused(() => updateUser(manager, made.id, { name: 'ZZ Renamed' }));
    ok('5. nor can a manager', forbidden(upMgr), `${upMgr?.code}: ${upMgr?.message}`);

    const statusHr = await refused(() => setUserStatus(hrAdmin, made.id, 'suspended'));
    ok('6. nor suspend one', forbidden(statusHr), `${statusHr?.code}: ${statusHr?.message}`);

    const bulkHr = await refused(() => bulkUpdateUsers(hrAdmin, [made.id], { role: 'employee' }));
    ok('7. nor change a batch of them', forbidden(bulkHr), `${bulkHr?.code}: ${bulkHr?.message}`);

    const codeHr = await refused(() => nextEmployeeCode(hrAdmin));
    ok('8. nor read the next free employee code',
      forbidden(codeHr), `${codeHr?.code}: ${codeHr?.message}`);

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
    ok('9. an HR administrator reads every account, not an empty list',
      hrRows.length > 0 && hrRows.some((u) => u.id === made.id),
      `${hrRows.length} rows`);

    const hrOne = await getUser(hrAdmin, made.id);
    ok('    and opens one', Boolean(hrOne?.id), JSON.stringify(hrOne?.id ?? null));

    const mgrList = await refused(() => listUsers(manager));
    ok('10. and a manager still reads their line',
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
    ok('11. the change is recorded on its own',
      changed.length === 1, JSON.stringify(changed));
    ok('    carrying the address it was',
      (changed[0]?.summary ?? '').includes(before), String(changed[0]?.summary));
    ok('    and the one it became',
      (changed[0]?.summary ?? '').includes(after), String(changed[0]?.summary));

    await updateUser(companyAdmin, made.id, { name: 'ZZ Gate Renamed' });
    ok('12. an edit that leaves the email alone records nothing',
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
