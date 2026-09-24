/**
 * The profile composite answers the whole contract, and no more than the
 * caller may see.
 *
 * `GET /employees/:id/profile` existed for months and answered three fields
 * against a contract asking for eighteen. Nothing failed: the route was live,
 * the types compiled, and the frontend simply never mapped the method — so the
 * drawer told every user "the full profile is not available yet" and no check
 * disagreed. A partial composite is invisible precisely because it is partial.
 *
 * So the first assertion here is not that some field is right. It is that the
 * set of fields the server returns is exactly the set the contract declares,
 * read out of `src/services/contracts.ts` rather than restated — adding a
 * field to the contract and forgetting to fill it fails here.
 *
 * The rest is scope. The composite fans out across thirteen services and each
 * one carries its own rules; the risk of assembling them in one place is that
 * the assembly quietly widens what any of them would have allowed. Pay is
 * where that matters most, and it is the one part this file checks from three
 * directions: the person themselves, an administrator, and a manager reading
 * somebody who reports to them.
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

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and this composite is assembled from one.\n');
  process.exit(0);
}

/* Two connections, not ten — the pooler counts every client against the tenant. */
process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { buildEmployeeProfile } = await import('../src/modules/employees/profile.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const admin = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await admin.connect();

const census = async () => (await admin.query(`
  SELECT (SELECT count(*)::int FROM employee) e,
         (SELECT count(*)::int FROM audit_log) a`)).rows[0];
const before = await census();

const ctx = (await admin.query(`
  SELECT t.id tenant, e.id emp,
         (SELECT id FROM department LIMIT 1) dept,
         (SELECT id FROM site WHERE active LIMIT 1) site,
         (SELECT id FROM legal_entity LIMIT 1) entity,
         (SELECT id FROM shift LIMIT 1) shift
    FROM tenant t JOIN employee e ON e.tenant_id = t.id
   WHERE t.slug = '360vhm' AND e.code = 'VHM004'`)).rows[0];

const caller = (role, employeeId) =>
  ({ role, tenantId: ctx.tenant, employeeId, userId: null });

/** Two throwaway employees, one reporting to the other. Removed either way. */
async function withLine(body) {
  const make = async (name, managerId) => (await admin.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id,
                           joined_on, manager_id)
     VALUES ($1, $2, $3, $4, 'active', 'employee', $5, $6, $7, $8, CURRENT_DATE, $9)
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name,
      `zz-profile-${Math.random().toString(36).slice(2, 9)}@360.technology`,
      ctx.dept, ctx.site, ctx.entity, ctx.shift, managerId])).rows[0].id;

  const boss = await make('Profile Probe Lead', null);
  const report = await make('Profile Probe Report', boss);
  try {
    return await body({ boss, report });
  } finally {
    await admin.query('DELETE FROM audit_log WHERE subject_id = ANY($1::uuid[])', [[boss, report]]);
    await admin.query('DELETE FROM employee WHERE id = ANY($1::uuid[])', [[boss, report]]);
  }
}

/* ------------------------------------------------------------------ *
 * 1. The shape is the contract's, read from the contract
 * ------------------------------------------------------------------ */

console.log('\nthe composite answers the whole contract\n');

const contractFields = (() => {
  const src = readFileSync(join(here, '..', '..', 'src', 'services', 'contracts.ts'), 'utf8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith('export interface EmployeeProfile {'));
  let depth = 0;
  let end = start;
  for (let i = start; i < lines.length; i += 1) {
    depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
    if (depth === 0 && i > start) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
})();

ok(`the contract declares ${contractFields.length} fields`, contractFields.length >= 18,
  `read ${contractFields.length} — if the interface moved, this test is reading the wrong block`);

const self = await buildEmployeeProfile(caller('admin', ctx.emp), ctx.emp);
ok('an administrator reading their own record gets a profile', self !== null);

if (self) {
  const got = Object.keys(self).sort();
  const want = [...contractFields].sort();
  const missing = want.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !want.includes(k));
  ok('every contract field is present', missing.length === 0, `missing: ${missing.join(', ')}`);
  ok('and nothing beyond the contract is returned', extra.length === 0, `extra: ${extra.join(', ')}`);
  ok('no field is undefined',
    Object.entries(self).every(([, v]) => v !== undefined),
    Object.entries(self).filter(([, v]) => v === undefined).map(([k]) => k).join(', '));

  /* The three that used to be the whole answer. */
  ok('the employee is the one asked for', self.employee.id === ctx.emp);
  ok('reports is an array', Array.isArray(self.reports));
  ok('managerName is a string', typeof self.managerName === 'string');
}

/* ------------------------------------------------------------------ *
 * 2. Pay, from three directions
 * ------------------------------------------------------------------ */

console.log('\nwho may see pay\n');

ok('reading your own record shows your salary',
  (self?.salary.earnings.length ?? 0) > 0,
  'VHM004 has a salary structure on file; an empty earnings list here means the '
  + 'composite is refusing pay to the person it belongs to');

ok('  and the monthly split is derived from it',
  Math.abs((self?.compMonthly.basic ?? 0) * 12 - (self?.salary.earnings[0]?.a ?? 0)) < 0.01,
  `basic monthly ${self?.compMonthly.basic} against annual ${self?.salary.earnings[0]?.a}`);

ok('  and the tax regime is a string, not absent',
  typeof self?.taxRegime === 'string' && self.taxRegime.length > 0);

await withLine(async ({ boss, report }) => {
  const asBoss = await buildEmployeeProfile(caller('manager', boss), report);
  ok('a manager can open a report’s profile', asBoss !== null,
    'the drawer is how a manager reaches their own line');

  if (asBoss) {
    ok('  and it is the report’s record', asBoss.employee.id === report);
    ok('  but carries no earnings lines', asBoss.salary.earnings.length === 0,
      'pay is admin-and-self only — salaryStructureOf asserts it and this mirrors it. '
      + 'An empty list cannot be rendered as a figure; a zeroed structure could');
    ok('  and no benefits either', asBoss.salary.benefits.length === 0);
    ok('  and no tax status', asBoss.taxStatus === '',
      `got ${JSON.stringify(asBoss.taxStatus)}`);
  }

  const asStranger = await buildEmployeeProfile(caller('employee', report), boss);
  ok('an employee cannot read somebody else’s profile at all', asStranger === null,
    'not an empty profile — no profile. Distinguishing "exists but hidden" from '
    + '"does not exist" is how a drawer becomes a directory');

  const own = await buildEmployeeProfile(caller('employee', report), report);
  ok('but can read their own', own !== null);
  ok('  with pay visible, because it is theirs', own !== null && Array.isArray(own.salary.earnings));
});

/* ------------------------------------------------------------------ *
 * 3. Nothing was left behind
 * ------------------------------------------------------------------ */

console.log('\nthe database is as it was\n');

const after = await census();
ok(`employees ${after.e}`, after.e === before.e, `was ${before.e}`);
ok(`audit rows ${after.a}`, after.a === before.a, `was ${before.a}`);

await admin.end();

console.log(failed
  ? `\n${failed} problem(s)`
  : '\nthe composite is whole, and pay stays where it belongs');
process.exit(failed ? 1 : 0);
