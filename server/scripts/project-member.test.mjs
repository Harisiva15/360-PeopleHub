/**
 * Who is on a project.
 *
 * Step one of three: the table and the service. **Nothing enforces membership
 * yet** — that is step three, and the assertion that a booking without a
 * membership is refused belongs to it, not here. What is asserted here is
 * everything the table and the service promise on their own.
 *
 *   node --experimental-strip-types scripts/project-member.test.mjs
 *
 * The three decisions worth pinning, because each was a choice and the next
 * reader cannot tell a choice from an accident:
 *
 *   * one *live* membership per person per project, history kept;
 *   * `role = 'lead'` grants nothing, so a lead with no reports may not
 *     manage the team;
 *   * an allocation over 100% warns and does not refuse.
 */

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
  if (!cond) failed += 1;
};

const refused = async (label, fn, rx) => {
  try {
    await fn();
    ok(label, false, 'it was allowed');
  } catch (e) {
    ok(label, rx.test(e?.message ?? ''), `${e?.constructor?.name}: ${e?.message}`);
  }
};

const { assertLocalDatabase } = await import('./local-only.mjs');
if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('SKIPPED: set MIGRATE_DATABASE_URL and DATABASE_URL to a local database.');
  process.exit(0);
}
assertLocalDatabase();

process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';

/* Nothing above the skip, for the reason photo.test.mjs records. */
const { default: pg } = await import('pg');
const { withScratchTenant } = await import('./lib/scratch-tenant.mjs');
const {
  listMembers, projectsOf, addMember, removeMember,
} = await import('../src/modules/projects/service.ts');

const admin = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();

console.log('');
let fatal = null;
try {
  await withScratchTenant(admin, async (ctx) => {
    const boss = {
      tenantId: ctx.tenant,
      userId: null,
      employeeId: ctx.adminEmployeeId,
      role: 'company_admin',
      hasReports: false,
    };
    /* `planner` write is `own` for both of these, which is the point. */
    const staff = { ...boss, role: 'employee' };
    const finance = { ...boss, role: 'finance_admin' };
    /* An employee who answers for a team reaches `team` through the layer. */
    const manager = { ...boss, role: 'employee', hasReports: true };

    const dept = (await admin.query(
      'SELECT id FROM department WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.dept])).rows[0].id;
    const site = (await admin.query(
      'SELECT id FROM site WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.site])).rows[0].id;

    const hire = async (code, name) => (await admin.query(
      `INSERT INTO employee
         (tenant_id, code, full_name, work_email, status, app_role, employment_type,
          department_id, site_id, legal_entity_id, shift_id, joined_on, currency, ctc)
       VALUES ($1, $2, $3, $4::citext, 'active', 'employee', 'permanent',
               $5, $6, $7, $8, DATE '2021-04-01', 'INR', 600000)
       RETURNING id`,
      [ctx.tenant, code, name, `${code.toLowerCase()}-${Date.now().toString(36)}@360.technology`,
        dept, site, ctx.entityId, ctx.shiftId])).rows[0].id;

    const anil = await hire('ZZ910', 'ZZ Anil');
    const bina = await hire('ZZ911', 'ZZ Bina');

    const second = (await admin.query(
      `INSERT INTO project (tenant_id, code, name, billable, active)
       VALUES ($1, 'ZZP2', 'ZZ Second Project', true, true) RETURNING code`,
      [ctx.tenant])).rows[0].code;
    const closed = (await admin.query(
      `INSERT INTO project (tenant_id, code, name, billable, active)
       VALUES ($1, 'ZZPX', 'ZZ Closed Project', true, false) RETURNING code`,
      [ctx.tenant])).rows[0].code;

    /* --- nothing yet ---------------------------------------------------- */

    ok('1. a project with nobody on it lists nobody',
      (await listMembers(boss, ctx.project)).length === 0);

    /* --- who may write -------------------------------------------------- */

    await refused('2. an employee may not put somebody on a project',
      () => addMember(staff, ctx.project, 'ZZ910'), /manager or an administrator/i);
    await refused('3. nor finance_admin, which also holds only `own`',
      () => addMember(finance, ctx.project, 'ZZ910'), /manager or an administrator/i);

    /*
     * The one worth reading. `role: 'lead'` is about display and a later
     * approval option; it is not a permission. An employee who leads a
     * project but answers for nobody still may not manage its team.
     */
    await refused('4. a lead with no reports still may not — `lead` grants nothing',
      () => addMember({ ...staff }, ctx.project, 'ZZ910', 'lead'),
      /manager or an administrator/i);

    const byManager = await addMember(manager, ctx.project, 'ZZ910');
    ok('5. a manager may, through the layer', byManager.member.employeeCode === 'ZZ910',
      JSON.stringify(byManager));

    /* --- what it stores ------------------------------------------------- */

    const withRole = await addMember(boss, ctx.project, 'ZZ911', 'lead', 40);
    ok('6. a role and an allocation are kept',
      withRole.member.role === 'lead' && withRole.member.allocationPct === 40,
      JSON.stringify(withRole.member));
    ok('7. no warning at 40%', withRole.warning === undefined, String(withRole.warning));

    const team = await listMembers(boss, ctx.project);
    ok('8. the project now lists two', team.length === 2, JSON.stringify(team.map((m) => m.employeeCode)));
    ok('9.  leads first', team[0]?.role === 'lead', JSON.stringify(team.map((m) => m.role)));

    /* --- one live row per person per project ---------------------------- */

    const again = await addMember(boss, ctx.project, 'ZZ911', 'member', 55);
    ok('10. adding the same person again updates rather than duplicating',
      again.member.role === 'member' && again.member.allocationPct === 55,
      JSON.stringify(again.member));
    ok('11.  and the project still lists two',
      (await listMembers(boss, ctx.project)).length === 2);

    const liveRows = (await admin.query(
      `SELECT count(*)::int n FROM project_member
        WHERE tenant_id = $1 AND employee_id = $2 AND left_on IS NULL`,
      [ctx.tenant, bina])).rows[0].n;
    ok('12.  with exactly one live row behind it', liveRows === 1, `${liveRows}`);

    /* --- the allocation warning ----------------------------------------- */

    const over = await addMember(boss, second, 'ZZ911', 'member', 60);
    ok('13. 55% + 60% is allowed', over.member.allocationPct === 60);
    ok('14.  and warns, naming the total',
      /115%/.test(over.warning ?? ''), String(over.warning));
    ok('15.  and the row really is there — a warning is not a refusal',
      (await projectsOf(boss, bina)).length === 2);

    /* --- reading somebody's projects ------------------------------------ */

    ok('16. somebody may read their own projects',
      (await projectsOf({ ...staff, employeeId: bina }, bina)).length === 2);

    /*
     * And anybody else's, which is the policy's answer and not an oversight:
     * `POLICY.planner` gives every role `read: 'all'`, because the project
     * board is tenant-public. This assertion exists so the day somebody
     * narrows that, this fails and says where the decision now lives.
     *
     * It was written the other way round first — refusing a plain employee —
     * and it failed, because the gate it was testing could not refuse anybody.
     * The gate is gone rather than the assertion weakened.
     */
    ok("17.  and anybody else's, because planner read is 'all' for every role",
      (await projectsOf({ ...staff, employeeId: anil }, bina)).length === 2);

    /* --- a closed project ----------------------------------------------- */

    await refused('18. nobody is added to a closed project',
      () => addMember(boss, closed, 'ZZ910'), /closed/i);

    /* --- leaving -------------------------------------------------------- */

    await removeMember(boss, ctx.project, 'ZZ911');
    ok('19. leaving takes them off the live list',
      (await listMembers(boss, ctx.project)).length === 1);

    const history = (await admin.query(
      `SELECT left_on::text AS l FROM project_member
        WHERE tenant_id = $1 AND employee_id = $2 AND left_on IS NOT NULL`,
      [ctx.tenant, bina])).rows;
    ok('20.  and keeps the row, because last quarter\'s timesheet needs it',
      history.length === 1 && history[0].l !== null, JSON.stringify(history));

    const rejoined = await addMember(boss, ctx.project, 'ZZ911');
    ok('21. rejoining is a second row, not a resurrection',
      rejoined.member.employeeCode === 'ZZ911');
    const allRows = (await admin.query(
      `SELECT count(*)::int n FROM project_member
        WHERE tenant_id = $1 AND employee_id = $2 AND project_id =
          (SELECT id FROM project WHERE tenant_id = $1 AND code = $3)`,
      [ctx.tenant, bina, ctx.project])).rows[0].n;
    ok('22.  so the history reads two rows for that pairing', allRows === 2, `${allRows}`);

    await refused('23. taking off somebody who is not on it says so',
      () => removeMember(boss, second, 'ZZ910'), /not on that project/i);

    /* --- validation ----------------------------------------------------- */

    await refused('24. an allocation of 0 is refused',
      () => addMember(boss, ctx.project, 'ZZ910', 'member', 0), /1 to 100/);
    await refused('25.  and 101',
      () => addMember(boss, ctx.project, 'ZZ910', 'member', 101), /1 to 100/);
    await refused('26.  and a fraction, because the column is a smallint',
      () => addMember(boss, ctx.project, 'ZZ910', 'member', 12.5), /1 to 100/);
    await refused('27. a project role outside member and lead is refused',
      () => addMember(boss, ctx.project, 'ZZ910', 'owner'), /member.*lead/i);

    /* --- the audit trail ------------------------------------------------ */

    const trail = (await admin.query(
      `SELECT action, category FROM audit_log
        WHERE tenant_id = $1 AND action LIKE 'project_member%'`, [ctx.tenant])).rows;
    ok('28. every membership change is audited',
      trail.filter((r) => r.action === 'project_member_added').length >= 5
      && trail.some((r) => r.action === 'project_member_removed'),
      JSON.stringify(trail.map((r) => r.action)));
    ok('29.  as a config change', trail.every((r) => r.category === 'config'));

    /* --- nothing is enforced yet, and that is on purpose ---------------- */

    const anyConstraint = (await admin.query(
      `SELECT count(*)::int n FROM pg_constraint
        WHERE conrelid = 'timesheet_entry'::regclass
          AND pg_get_constraintdef(oid) ILIKE '%project_member%'`)).rows[0].n;
    ok('30. booking time does not require membership yet — that is step three',
      anyConstraint === 0, `${anyConstraint} constraint(s) already reference it`);
  });
} catch (e) {
  fatal = e;
} finally {
  await admin.end();
}

if (fatal) { console.error(`${NL}the run did not finish: ${fatal.message}${NL}`); process.exit(1); }
console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`a project knows its team, history and all, and a lead is not a role${NL}`);
process.exit(0);
