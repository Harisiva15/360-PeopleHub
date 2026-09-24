/**
 * Payroll refuses to guess what somebody is owed.
 *
 * `structureOf` answers in three legitimate ways, in order: the company's own
 * components against a stored structure, the derived rules against a stored
 * structure, or the derived rules against `employee.ctc`. A company that has
 * configured nothing still has to run payroll on the day it starts, so the
 * fallbacks are deliberate.
 *
 * The fourth case had no guard. An employee with neither a stored structure
 * nor a CTC fell through to `structureFor(0)`, where every percentage-based
 * component is zero and the flat medical insurance is not — so the balancing
 * line absorbs it:
 *
 *     special = 0 - 0 - 0 - 0 - 0 - 0 - 12000
 *
 * A payslip with a gross of **minus twelve thousand**, written, locked, and
 * put in a bank advice. Nothing refused it and nothing could have noticed: the
 * run reported its totals and completed.
 *
 * It reached nobody only by luck. The single employee on file had a CTC from
 * the seed script; every account created through User Management has neither
 * column set, because `createUser` does not ask for compensation. The first
 * real manager and employee would have been the first two negative payslips.
 *
 * So this file holds two things. That the arithmetic really does go negative —
 * transcribed from the rule, so the guard is not defending against an
 * imagined number — and that the run is refused before a single payslip row
 * is written.
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

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

/* ------------------------------------------------------------------ *
 * 1. The number the guard exists for, without a database
 * ------------------------------------------------------------------ */

const { structureFor } = await import('../src/modules/payroll/rules.ts');

console.log('\nwhat a zero CTC produces\n');

const zero = structureFor(0, 'IN');
ok('a zero CTC does not produce a zero payslip', zero.grossA !== 0,
  'if this ever becomes 0 the guard is defending against nothing — check the rule');
ok(`  it produces a negative gross (${zero.grossA})`, zero.grossA < 0,
  `gross was ${zero.grossA}`);
ok('  because the flat medical insurance has nothing to come out of',
  zero.grossA === -12000, `expected -12000, got ${zero.grossA}`);

const real = structureFor(1200000, 'IN');
ok('a real CTC is unaffected', real.grossA > 0 && real.ctc === 1200000,
  `gross ${real.grossA}`);

/* ------------------------------------------------------------------ *
 * 2. The guard itself, against a database
 * ------------------------------------------------------------------ */

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED the live half: no database.\n');
  process.exit(failed ? 1 : 0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { setAuthAdmin } = await import('../src/auth/adminApi.ts');
const users = await import('../src/modules/users/service.ts');
const payroll = await import('../src/modules/payroll/service.ts');
const comp = await import('../src/modules/payroll/compensation.ts');
const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');

setAuthAdmin({ inviteToSetPassword: () => Promise.resolve({ kind: 'invited' }) });

const db = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await db.connect();

const liveBefore = (await db.query(`
  SELECT (SELECT count(*)::int FROM pay_run) runs,
         (SELECT count(*)::int FROM payslip) slips,
         (SELECT count(*)::int FROM tenant) tenants`)).rows[0];

await sweepScratchTenants(db);

let fatal = null;
try {
await withScratchTenant(db, async (ctx) => {
  const ADMIN = { role: 'admin', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };
  const mk = '2026-09';

  const make = async (name) => {
    const acct = await users.createUser(ADMIN, {
      name, email: `zz-prereq-${Math.random().toString(36).slice(2, 9)}@360.technology`,
      dept: ctx.dept, site: ctx.site, designation: 'ZZ Engineer', role: 'employee',
    });
    return (await db.query(
      'SELECT employee_id FROM tenant_membership WHERE id = $1', [acct.id])).rows[0].employee_id;
  };

  /* A cycle to process. The scratch tenant has none. */
  await db.query(
    `INSERT INTO pay_run (tenant_id, legal_entity_id, period_month, status, locked)
     VALUES ($1, $2, $3::date, 'draft', false)`,
    [ctx.tenant, ctx.entityId, `${mk}-01`]);

  console.log('\nan employee created through User Management\n');

  const bare = await make('ZZ Prereq Probe');
  const row = (await db.query('SELECT ctc FROM employee WHERE id = $1', [bare])).rows[0];
  ok('has no CTC', row.ctc === null, `ctc = ${row.ctc}`);
  ok('  and no stored salary structure',
    (await db.query('SELECT count(*)::int n FROM salary_structure WHERE employee_id = $1',
      [bare])).rows[0].n === 0);

  const derived = await payroll.salaryStructureOf(ADMIN, bare);
  ok('  so the structure payroll would use is the negative one',
    derived.grossA === -12000, `gross ${derived.grossA}`);

  console.log('\nthe run is refused, and nothing is written\n');

  const err = await attempt(() => payroll.processRun(ADMIN, mk));
  ok('processing is refused', err !== null,
    'without this the run writes a payslip with a negative gross, locks, and '
    + 'produces a bank advice');
  ok('  naming the person', /ZZ Prereq Probe/.test(err?.message ?? ''), err?.message);
  ok('  naming their employee code', /ZZ\d|E0\d|\(ZZ/.test(err?.message ?? ''), err?.message);
  ok('  and saying what to do about it', /Compensation/.test(err?.message ?? ''), err?.message);
  ok('  with a code that maps to 409, not 400 or 403',
    !['forbidden', 'not_found', 'invalid'].includes(err?.code ?? ''),
    `code was ${err?.code}`);

  /*
   * Scoped to this tenant. `db` is the migration role, which bypasses RLS, so
   * an unscoped count here sees the live tenant's September payslip too — the
   * first version of this assertion failed for exactly that reason.
   */
  const slips = (await db.query(
    'SELECT count(*)::int n FROM payslip WHERE tenant_id = $1', [ctx.tenant])).rows[0].n;
  ok('no payslip was written', slips === 0, `${slips} found`);
  const state = (await db.query(
    'SELECT status, locked FROM pay_run WHERE tenant_id = $1', [ctx.tenant])).rows[0];
  ok('  and the cycle is still an unlocked draft',
    state.status === 'draft' && state.locked === false, JSON.stringify(state));

  console.log('\nand once the compensation is recorded\n');

  await comp.setSalaryStructure(ADMIN, bare, {
    ctc: 900000, validFrom: `${mk}-01`, reason: 'ZZ probe',
  });
  const now = await payroll.salaryStructureOf(ADMIN, bare);
  ok('the structure is the real one', now.ctc === 900000 && now.grossA > 0,
    `ctc ${now.ctc} gross ${now.grossA}`);

  const done = await payroll.processRun(ADMIN, mk);
  ok('the run goes through', done !== null);
  const after = (await db.query(
    'SELECT count(*)::int n FROM payslip WHERE tenant_id = $1', [ctx.tenant])).rows[0].n;
  ok(`  and writes ${after} payslip(s)`, after >= 1);
  const gross = (await db.query(
    'SELECT gross FROM payslip WHERE employee_id = $1', [bare])).rows[0];
  ok('  with a positive gross', Number(gross.gross) > 0, `gross ${gross?.gross}`);

  console.log('\nwho may process at all\n');

  const asManager = await attempt(() => payroll.processRun(
    { role: 'manager', tenantId: ctx.tenant, employeeId: bare, userId: null }, mk));
  ok('a manager cannot process payroll', asManager !== null);
  ok('  refused as forbidden', asManager?.code === 'forbidden', asManager?.code);
  const asEmployee = await attempt(() => payroll.processRun(
    { role: 'employee', tenantId: ctx.tenant, employeeId: bare, userId: null }, mk));
  ok('an employee cannot process payroll', asEmployee !== null);
  ok('  refused as forbidden', asEmployee?.code === 'forbidden', asEmployee?.code);

  console.log('\ninvalid input\n');

  ok('a month with no cycle is a not-found',
    (await attempt(() => payroll.processRun(ADMIN, '2030-01')))?.code === 'not_found');
  const nonsense = await attempt(() => payroll.processRun(ADMIN, 'not-a-month'));
  ok('a malformed month is refused rather than throwing a database error',
    nonsense !== null && !/syntax|invalid input syntax/i.test(nonsense.message),
    nonsense?.message);
});
} catch (e) {
  fatal = e;
  failed += 1;
  console.log(`\n  FAIL  the run stopped: ${e.message}`);
}

console.log('\nthe live tenant was never written to\n');

const liveAfter = (await db.query(`
  SELECT (SELECT count(*)::int FROM pay_run) runs,
         (SELECT count(*)::int FROM payslip) slips,
         (SELECT count(*)::int FROM tenant) tenants`)).rows[0];
ok(`pay runs ${liveAfter.runs}`, liveAfter.runs === liveBefore.runs, `was ${liveBefore.runs}`);
ok(`payslips ${liveAfter.slips}`, liveAfter.slips === liveBefore.slips, `was ${liveBefore.slips}`);
ok(`tenants ${liveAfter.tenants}`, liveAfter.tenants === liveBefore.tenants,
  `was ${liveBefore.tenants}`);

const paid = (await db.query('SELECT status, locked FROM pay_run')).rows[0];
ok('September is still paid and locked',
  paid?.status === 'paid' && paid.locked === true, JSON.stringify(paid));

await db.end();

if (fatal) console.log(`\nstopped early; its tenant was dropped regardless:\n  ${fatal.stack}`);

console.log(failed
  ? `\n${failed} problem(s)`
  : '\npayroll refuses to guess, and says whose compensation is missing');
process.exit(failed ? 1 : 0);
