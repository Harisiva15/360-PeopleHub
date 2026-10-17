/**
 * The five manager gates, one check each: refused outside the team, allowed
 * for a direct report.
 *
 * ## What was wrong with all five
 *
 * Each was written `reaches(caller, <module>, 'read', 'all') || caller.hasReports`.
 * That grants **all-scope entry** to anybody with a single direct report, and
 * where the query behind the gate was unscoped the gate's breadth became the
 * query's breadth. It is how every joiner's offered salary became visible to
 * any manager in the company, and the same shape sat behind exits, hiring,
 * documents and the knowledge base.
 *
 * The table is the authority, and it does not say the same thing for all five:
 *
 *     onboarding  rule(NO,   ['team','team','none'], ...)   team
 *     exit        rule(SELF, ['team','none','none'], ...)   team read, NO write
 *     hiring      rule(NO,   ['team','team','team'], ...)   team
 *     documents   rule(SELF, SELF,                   ...)   own  — not team
 *     helpdesk    rule(SELF, LINE,                   ...)   write own — not the KB
 *
 * So three of the five confine a manager to their team, and two take the act
 * away from them: a document request is HR's, and a knowledge-base draft is
 * editorial state with no team to belong to. Both of those are asserted here as
 * refusals for a direct report too, because that is what the table says and the
 * surprising case is the one worth pinning down.
 *
 * ## The fixture
 *
 * A scratch tenant with three people: a manager, somebody who reports to them,
 * and an outsider who does not. Every check asks the same two questions — the
 * report is reachable, the outsider is not.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  console.log('\nSKIPPED: no database, and the manager gates need one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const onboarding = await import('../src/modules/onboarding/service.ts');
const exits = await import('../src/modules/exits/service.ts');
const hiring = await import('../src/modules/hiring/service.ts');
const documents = await import('../src/modules/documents/service.ts');
const helpdesk = await import('../src/modules/helpdesk/service.ts');
const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `${NL}        ${detail}`}`);
};
const attempt = async (fn) => {
  try { return { value: await fn(), error: null }; } catch (e) { return { value: null, error: e }; }
};

/** Allowed: it did not throw a refusal. */
const allowed = async (label, fn) => {
  const { error } = await attempt(fn);
  ok(label, error === null || error.code !== 'forbidden',
    `refused with: ${error?.message}`);
};
/** Refused: it threw, and said so in words rather than as a database error. */
const refused = async (label, fn, expect = /not on your|only|forbidden|own team/i) => {
  const { error } = await attempt(fn);
  ok(label, error !== null && error.code === 'forbidden',
    error ? `threw ${error.code}: ${error.message}` : 'the call succeeded');
  if (error?.code === 'forbidden') {
    ok('      in words a screen can show', expect.test(error.message), error.message);
  }
};

const db = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: sslConfig(),
});
await db.connect();

const census = async () => (await db.query(
  `SELECT (SELECT count(*)::int FROM tenant) t,
          (SELECT count(*)::int FROM employee) e`)).rows[0];
const before = await census();

let fatal = null;
try {

await withScratchTenant(db, async (ctx) => {
  const deptId = (await db.query(
    'SELECT id FROM department WHERE tenant_id = $1 AND code = $2',
    [ctx.tenant, ctx.dept])).rows[0].id;
  const siteId = (await db.query(
    'SELECT id FROM site WHERE tenant_id = $1 AND code = $2',
    [ctx.tenant, ctx.site])).rows[0].id;

  const employee = async (name, managerId = null) => (await db.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id,
                           joined_on, manager_id)
     VALUES ($1, $2, $3, $4, 'active', 'employee', $5, $6, $7, $8, CURRENT_DATE, $9)
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name,
      `zz-gates-${Math.random().toString(36).slice(2, 9)}@360.technology`,
      deptId, siteId, ctx.entityId, ctx.shiftId, managerId])).rows[0].id;

  const BOSS_ID = await employee('ZZ Gate Manager');
  const REPORT_ID = await employee('ZZ Gate Report', BOSS_ID);
  const OUTSIDER_ID = await employee('ZZ Gate Outsider');

  const caller = (role, employeeId, hasReports = false) =>
    ({ role, hasReports, tenantId: ctx.tenant, employeeId, userId: null });

  /* The manager: an employee with a report, which is the whole model. */
  const BOSS = caller('employee', BOSS_ID, true);
  const HR = caller('hr_admin', ctx.adminEmployeeId);

  ok('the fixture has a manager with exactly one report',
    (await db.query('SELECT count(*)::int n FROM employee WHERE manager_id = $1',
      [BOSS_ID])).rows[0].n === 1);
  ok('  and an outsider who reports to nobody',
    (await db.query('SELECT manager_id FROM employee WHERE id = $1',
      [OUTSIDER_ID])).rows[0].manager_id === null);

  /* ================================================================== */
  console.log(`${NL}1. mayOnboard — onboarding, manager: team${NL}`);

  const journeyFor = async (managerId) => (await db.query(
    `INSERT INTO onboarding_journey
       (tenant_id, full_name, joining_on, manager_id, annual_ctc, currency, status)
     VALUES ($1, 'ZZ Joiner', CURRENT_DATE + 7, $2, 900000, 'INR', 'pre_boarding')
     RETURNING id`, [ctx.tenant, managerId])).rows[0].id;

  const ownJourney = await journeyFor(REPORT_ID);
  const foreignJourney = await journeyFor(OUTSIDER_ID);

  await allowed('a manager may update a checklist on their own line',
    () => onboarding.setTask(BOSS, ownJourney, 'buddy', true));
  await refused('and is refused on somebody else\'s joiner',
    () => onboarding.setTask(BOSS, foreignJourney, 'buddy', true));

  const listed = await onboarding.listOnboarding(BOSS);
  ok('  the listing shows their line only',
    listed.some((j) => j.id === ownJourney) && !listed.some((j) => j.id === foreignJourney),
    `${listed.length} journeys came back`);
  ok('  and carries no salary, compensation being a separate grant',
    (listed.find((j) => j.id === ownJourney)?.ctc ?? -1) === 0);

  /* ================================================================== */
  console.log(`${NL}2. mayHandle — exit, manager: team read, no write${NL}`);

  const exitFor = async (empId) => (await db.query(
    `INSERT INTO exit_record
       (tenant_id, employee_id, resigned_on, last_working_day, reason)
     VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE + 30, 'ZZ probe')
     RETURNING id`, [ctx.tenant, empId])).rows[0].id;

  const ownExit = await exitFor(REPORT_ID);
  const foreignExit = await exitFor(OUTSIDER_ID);

  ok('a manager reads their report\'s exit',
    (await exits.exitDetail(BOSS, ownExit)) !== null);
  ok('  and not an outsider\'s', (await exits.exitDetail(BOSS, foreignExit)) === null,
    'exitDetail returns null rather than throwing, as it did before');

  const exitList = await exits.listExits(BOSS);
  ok('  the listing shows their line only',
    exitList.some((x) => x.id === ownExit) && !exitList.some((x) => x.id === foreignExit),
    `${exitList.length} exits came back`);

  await refused('and a manager writes no exit, even for their own report',
    () => exits.recordExitInterview(BOSS, ownExit, { rating: 4 }),
    /only HR/i);
  await allowed('  which HR does', () => exits.recordExitInterview(HR, ownExit, { rating: 4 }));

  /* ================================================================== */
  console.log(`${NL}3. mayRecruit — hiring, manager: team${NL}`);

  const reqFor = async (managerId) => (await db.query(
    `INSERT INTO requisition
       (tenant_id, code, title, department_id, site_id, hiring_manager_id)
     VALUES ($1, $2, 'ZZ Role', $3, $4, $5)
     RETURNING id`,
    [ctx.tenant, `ZZR${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      deptId, siteId, managerId])).rows[0].id;

  const ownReq = await reqFor(BOSS_ID);
  const foreignReq = await reqFor(OUTSIDER_ID);

  await allowed('a manager submits a candidate to their own requisition',
    () => hiring.submitCandidate(BOSS, {
      reqId: ownReq, name: 'ZZ Candidate A', email: `zz-cand-a-${Date.now()}@360.technology`,
    }));
  await refused('and is refused on somebody else\'s requisition',
    () => hiring.submitCandidate(BOSS, {
      reqId: foreignReq, name: 'ZZ Candidate B', email: `zz-cand-b-${Date.now()}@360.technology`,
    }));

  const reqs = await hiring.listRequisitions(BOSS);
  ok('  the listing shows their own requisitions only',
    reqs.some((r) => r.id === ownReq) && !reqs.some((r) => r.id === foreignReq),
    `${reqs.length} requisitions came back`);

  await refused('  and a requisition cannot be opened for another manager',
    () => hiring.openRequisition(BOSS, {
      title: 'ZZ Elsewhere', dept: ctx.dept, site: ctx.site, openings: 1,
      hiringManagerId: OUTSIDER_ID,
    }),
    /your own team/i);

  /* ================================================================== */
  console.log(`${NL}4. mayChase — documents, manager: own (not team)${NL}`);

  await refused('a manager may not chase documents, even from their own report',
    () => documents.requestDocument(BOSS, {
      empId: REPORT_ID, kind: 'pan', label: 'ZZ PAN card',
    }),
    /only HR/i);
  await allowed('  which HR does', () => documents.requestDocument(HR, {
    empId: REPORT_ID, kind: 'pan', label: 'ZZ PAN card',
  }));

  const mineOnly = await documents.listRequests(BOSS, {});
  ok('  and a manager\'s request list is their own, not their team\'s',
    !mineOnly.some((r) => r.empId === REPORT_ID),
    `${mineOnly.length} requests came back; documents read is own for the layer`);

  /* ================================================================== */
  console.log(`${NL}5. the helpdesk gate — knowledge base, editors only${NL}`);

  const draft = (await db.query(
    `INSERT INTO kb_article (tenant_id, question, answer, published)
     VALUES ($1, 'ZZ draft question', 'ZZ draft answer', false) RETURNING id`,
    [ctx.tenant])).rows[0].id;

  const bossSees = await helpdesk.knowledgeBase(BOSS);
  ok('a manager does not see an unpublished draft',
    !bossSees.some((a) => a.id === draft),
    'a draft is editorial state; the layer\'s helpdesk write is own');
  const hrSees = await helpdesk.knowledgeBase(HR);
  ok('  and an editor does', hrSees.some((a) => a.id === draft));
});

} catch (e) {
  fatal = e;
}

console.log(`${NL}the database is as it was${NL}`);
const after = await census();
ok('tenants', after.t === before.t, `${before.t} -> ${after.t}`);
ok('employees', after.e === before.e, `${before.e} -> ${after.e}`);
const swept = await sweepScratchTenants(db);
ok('no scratch tenant remains', swept.length === 0, `${swept.join(', ')} left`);

await db.end();

if (fatal) {
  console.error(`${NL}the run did not finish: ${fatal.message}`);
  console.error(fatal.stack);
  process.exit(1);
}
console.log('');
if (failed) { console.error(`${failed} problem(s)${NL}`); process.exit(1); }
console.log(`each gate reaches the caller's own team, and no further${NL}`);
