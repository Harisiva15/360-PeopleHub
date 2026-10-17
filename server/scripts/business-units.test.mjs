/**
 * A business unit is created by an administrator, by nobody else, and only
 * inside its own tenant.
 *
 * `business_unit` is the first table of the Company Setup phase and nothing
 * references it yet, which makes this the moment to pin the rules down: once a
 * department carries a `business_unit_id`, a hole here becomes a hole in the org
 * chart.
 *
 * ## What is worth holding
 *
 * **Writes are an administrator's.** `/config` maps to the `settings` module,
 * which the policy ceiling already grants to an admin alone, so the service
 * check is a second lock rather than the only one. It is tested anyway, for both
 * other roles, on all three writes — a module gate that is later widened must not
 * silently widen this.
 *
 * **Reads are everybody's.** A screen showing which unit somebody belongs to has
 * to resolve the code to a name, so `listBusinessUnits` and `getBusinessUnit`
 * answer any role. That is a deliberate asymmetry and it is asserted, so nobody
 * "tightens" it later and breaks the directory.
 *
 * **A code is an identity.** It cannot be changed through the update path, and
 * asking is refused rather than ignored — a silently dropped rename leaves the
 * caller believing it happened.
 *
 * **Deactivation, not deletion.** A unit that stops trading stays on everything
 * recorded while it traded.
 *
 * **Tenant isolation.** The last section creates a unit in a second scratch
 * tenant and proves neither tenant can read, change or deactivate the other's,
 * through the service rather than by inspecting a WHERE clause.
 *
 * Everything runs inside scratch tenants, dropped in one statement each. The live
 * tenant is never addressed, and its row counts are compared before and after.
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
  console.log('\nSKIPPED: no database, and a business unit is a row in one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const config = await import('../src/modules/config/service.ts');
const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};
/** A refusal, not a crash: the service must say no in its own vocabulary. */
const refused = async (label, fn, expect) => {
  const e = await attempt(fn);
  ok(label, e !== null, 'the call succeeded — this is a hole, not a test failure');
  if (e) {
    ok('    refused in the service\'s own words',
      expect.test(e.message) || expect.test(e.code ?? ''), `${e.code ?? ''} ${e.message}`);
  }
};

const admin = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: sslConfig(),
});
await admin.connect();

const census = async () => (await admin.query(`
  SELECT (SELECT count(*)::int FROM business_unit) u,
         (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM audit_log) a`)).rows[0];
const before = await census();

let fatal = null;
try {
await withScratchTenant(admin, async (ctx) => {

const caller = (role) =>
  ({ role, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null });
const ADMIN = caller('admin');
const MANAGER = caller('manager');
const EMPLOYEE = caller('employee');

console.log('\na fresh tenant has none\n');

ok('no business unit to begin with',
  (await config.listBusinessUnits(ADMIN)).length === 0);

console.log('\ncreating one\n');

const made = await config.createBusinessUnit(ADMIN, {
  code: 'retail', name: 'Retail Banking', description: '  Branch and digital retail.  ',
});
ok('an admin creates a business unit', made.code === 'RETAIL', made.code);
ok('    the code is upper-cased', made.code === made.code.toUpperCase());
ok('    id is the code, as it is for sites and departments', made.id === made.code);
ok('    the name is kept', made.name === 'Retail Banking', made.name);
ok('    the description is trimmed',
  made.description === 'Branch and digital retail.', JSON.stringify(made.description));
ok('    it starts active', made.active === true);
ok('    created_at is set', typeof made.createdAt === 'string' && made.createdAt.length > 0);
ok('    updated_at is set', typeof made.updatedAt === 'string' && made.updatedAt.length > 0);

const row = (await admin.query(
  'SELECT code, name, description, active FROM business_unit WHERE tenant_id = $1',
  [ctx.tenant])).rows;
ok('and the row is in the database, not just the response',
  row.length === 1 && row[0].code === 'RETAIL', JSON.stringify(row));
ok('    stamped with this tenant',
  (await admin.query('SELECT count(*)::int n FROM business_unit WHERE tenant_id = $1',
    [ctx.tenant])).rows[0].n === 1);

console.log('\nwhat a business unit must have\n');

for (const [label, draft, expect] of [
  ['a code is required', { name: 'No code' }, /needs a code/i],
  ['a name is required', { code: 'BU-A' }, /needs a name/i],
  ['a blank name is not a name', { code: 'BU-A', name: '   ' }, /needs a name/i],
  ['a one-character code is refused', { code: 'B', name: 'n' }, /2-16 letters/i],
  ['a seventeen-character code is refused',
    { code: 'BU-ABCDEFGHIJKLMN', name: 'n' }, /2-16 letters/i],
  ['a code with a space is refused', { code: 'BU A', name: 'n' }, /2-16 letters/i],
  ['a code with a slash is refused', { code: 'BU/A', name: 'n' }, /2-16 letters/i],
  ['a code with an underscore is refused', { code: 'BU_A', name: 'n' }, /2-16 letters/i],
  ['an over-long name is refused', { code: 'BU-A', name: 'x'.repeat(121) }, /120 characters/i],
  ['an over-long description is refused',
    { code: 'BU-A', name: 'n', description: 'x'.repeat(501) }, /500 characters/i],
]) {
  await refused(label, () => config.createBusinessUnit(ADMIN, draft), expect);
}

ok('and none of those were written',
  (await config.listBusinessUnits(ADMIN)).length === 1);

console.log('\nduplicates\n');

await refused('the same code twice is refused',
  () => config.createBusinessUnit(ADMIN, { code: 'RETAIL', name: 'Something else' }),
  /already a business unit/i);
await refused('    case-insensitively, because the code is upper-cased first',
  () => config.createBusinessUnit(ADMIN, { code: 'retail', name: 'Something else' }),
  /already a business unit/i);
await refused('the same name under a different code is refused',
  () => config.createBusinessUnit(ADMIN, { code: 'BU-NEW', name: 'Retail Banking' }),
  /already called/i);
await refused('    and case does not get around it',
  () => config.createBusinessUnit(ADMIN, { code: 'BU-NEW', name: 'retail banking' }),
  /already called/i);

const dupErr = await attempt(() =>
  config.createBusinessUnit(ADMIN, { code: 'RETAIL', name: 'x' }));
ok('a duplicate is a conflict, not a bad request', dupErr?.code === 'conflict', dupErr?.code);

ok('still exactly one unit', (await config.listBusinessUnits(ADMIN)).length === 1);

/*
 * The database refuses it too, independently of the service. The service checks
 * so the caller gets a sentence rather than a constraint name; this proves the
 * constraint is really there, so a future code path that forgets to check cannot
 * create a second RETAIL.
 */
const rawDup = await attempt(() => admin.query(
  'INSERT INTO business_unit (tenant_id, code, name) VALUES ($1, $2, $3)',
  [ctx.tenant, 'RETAIL', 'Straight past the service']));
ok('and the unique constraint refuses it at the database',
  rawDup !== null && /unique|duplicate/i.test(rawDup.message), rawDup?.message);

console.log('\nreading\n');

const got = await config.getBusinessUnit(ADMIN, 'RETAIL');
ok('one unit reads back by code', got?.code === 'RETAIL');
ok('    and lower case finds it', (await config.getBusinessUnit(ADMIN, 'retail'))?.code === 'RETAIL');
ok('an unknown code is null, not a throw',
  (await config.getBusinessUnit(ADMIN, 'NOPE')) === null);

ok('a manager may read the list', (await config.listBusinessUnits(MANAGER)).length === 1,
  'a screen showing somebody\'s unit has to resolve the code to a name');
ok('an employee may read the list', (await config.listBusinessUnits(EMPLOYEE)).length === 1);
ok('a manager may read one', (await config.getBusinessUnit(MANAGER, 'RETAIL'))?.code === 'RETAIL');
ok('an employee may read one', (await config.getBusinessUnit(EMPLOYEE, 'RETAIL'))?.code === 'RETAIL');

console.log('\nonly an admin writes\n');

for (const [who, c] of [['a manager', MANAGER], ['an employee', EMPLOYEE]]) {
  await refused(`${who} cannot create one`,
    () => config.createBusinessUnit(c, { code: 'BU-X', name: 'Theirs' }), /only an admin/i);
  await refused(`${who} cannot change one`,
    () => config.updateBusinessUnit(c, 'RETAIL', { name: 'Renamed' }), /only an admin/i);
  await refused(`${who} cannot deactivate one`,
    () => config.setBusinessUnitActive(c, 'RETAIL', false), /only an admin/i);
}

const forb = await attempt(() =>
  config.createBusinessUnit(MANAGER, { code: 'BU-X', name: 'Theirs' }));
ok('a refusal is forbidden, which maps to 403', forb?.code === 'forbidden', forb?.code);

const after403 = await config.listBusinessUnits(ADMIN);
ok('and none of those attempts changed anything',
  after403.length === 1 && after403[0].name === 'Retail Banking');

console.log('\nchanging one\n');

const edited = await config.updateBusinessUnit(ADMIN, 'retail', {
  name: 'Retail & Digital', description: 'Branches, app and web.',
});
ok('the name changes', edited.name === 'Retail & Digital', edited.name);
ok('    matched case-insensitively', edited.code === 'RETAIL');
ok('    the description changes', edited.description === 'Branches, app and web.');
ok('    updated_at moves', edited.updatedAt >= made.updatedAt,
  `${made.updatedAt} -> ${edited.updatedAt}`);
ok('    created_at does not', edited.createdAt === made.createdAt,
  `${made.createdAt} -> ${edited.createdAt}`);

const cleared = await config.updateBusinessUnit(ADMIN, 'RETAIL', { name: 'Retail & Digital' });
ok('an omitted description clears it, rather than being kept',
  cleared.description === null, JSON.stringify(cleared.description));

await refused('an update still needs a name',
  () => config.updateBusinessUnit(ADMIN, 'RETAIL', { description: 'only this' }),
  /needs a name/i);
await refused('the code cannot be changed, and asking is refused not ignored',
  () => config.updateBusinessUnit(ADMIN, 'RETAIL', { code: 'MOVED', name: 'Retail & Digital' }),
  /code cannot be changed/i);
ok('    so the code is unchanged',
  (await config.getBusinessUnit(ADMIN, 'RETAIL'))?.code === 'RETAIL');

const ghost = await attempt(() => config.updateBusinessUnit(ADMIN, 'NOPE', { name: 'x' }));
ok('changing one that does not exist is a 404', ghost?.code === 'not_found', ghost?.code);

console.log('\ndeactivating, which is not deleting\n');

const second = await config.createBusinessUnit(ADMIN, { code: 'BU-CORP', name: 'Corporate' });
ok('a second unit is created', second.code === 'BU-CORP');

const off = await config.setBusinessUnitActive(ADMIN, 'BU-CORP', false);
ok('a unit can be deactivated', off.active === false);
ok('    updated_at moves', off.updatedAt >= second.updatedAt);
ok('it is still listed, so an older record still resolves',
  (await config.listBusinessUnits(ADMIN)).some((u) => u.code === 'BU-CORP' && !u.active));
ok('    and still readable by code',
  (await config.getBusinessUnit(ADMIN, 'BU-CORP'))?.active === false);
ok('    the row was not deleted',
  (await admin.query('SELECT count(*)::int n FROM business_unit WHERE tenant_id = $1',
    [ctx.tenant])).rows[0].n === 2);

const on = await config.setBusinessUnitActive(ADMIN, 'BU-CORP', true);
ok('and it can be reactivated', on.active === true);

const noGhost = await attempt(() => config.setBusinessUnitActive(ADMIN, 'NOPE', false));
ok('deactivating one that does not exist is a 404', noGhost?.code === 'not_found', noGhost?.code);

await refused('a non-boolean active flag is refused',
  () => config.setBusinessUnitActive(ADMIN, 'BU-CORP', 'yes'),
  /active or inactive/i);

console.log('\nordering\n');

await config.setBusinessUnitActive(ADMIN, 'BU-CORP', false);
const list = await config.listBusinessUnits(ADMIN);
ok('active units come first', list[0].active === true && list[list.length - 1].active === false,
  list.map((u) => `${u.code}:${u.active}`).join(' '));

console.log('\nevery write is audited\n');

const audit = (await admin.query(
  `SELECT action, detail FROM audit_log
    WHERE tenant_id = $1 AND subject_table = 'business_unit' ORDER BY id`,
  [ctx.tenant])).rows;
ok('a creation is recorded', audit.some((r) => r.action === 'business_unit_created'));
ok('an update is recorded', audit.some((r) => r.action === 'business_unit_updated'));
ok('a deactivation is recorded', audit.some((r) => r.action === 'business_unit_deactivated'));
ok('an activation is recorded', audit.some((r) => r.action === 'business_unit_activated'));
ok('    each names the unit it was about',
  audit.every((r) => typeof r.detail?.businessUnit === 'string'
    && r.detail.businessUnit.length > 0),
  JSON.stringify(audit.map((r) => r.detail?.businessUnit)));
ok('    and carries the actor',
  (await admin.query(
    `SELECT count(*)::int n FROM audit_log
      WHERE tenant_id = $1 AND subject_table = 'business_unit' AND actor_label <> ''`,
    [ctx.tenant])).rows[0].n === audit.length);
ok('a refused write left no audit row',
  !audit.some((r) => String(r.detail?.businessUnit ?? '').startsWith('BU-X')),
  'a manager\'s refused create must not be recorded as a create');

console.log('\ntenant isolation\n');

/*
 * A second scratch tenant, with a unit of its own under the *same* code. If
 * isolation held only by convention this is where it would show: both rows exist,
 * both are called RETAIL, and each tenant must see exactly one.
 */
await withScratchTenant(admin, async (other) => {
  const OTHER_ADMIN = {
    role: 'admin', tenantId: other.tenant, employeeId: other.adminEmployeeId, userId: null,
  };

  const theirs = await config.createBusinessUnit(OTHER_ADMIN, {
    code: 'RETAIL', name: 'Retail Banking', description: 'Theirs, not ours.',
  });
  ok('the same code is free in another tenant', theirs.code === 'RETAIL',
    'the unique is per tenant, not global');

  const mine = await config.listBusinessUnits(ADMIN);
  const others = await config.listBusinessUnits(OTHER_ADMIN);
  ok('each tenant sees only its own units',
    mine.length === 2 && others.length === 1,
    `ours ${mine.length}, theirs ${others.length}`);
  ok('    and ours is not theirs',
    mine.find((u) => u.code === 'RETAIL')?.description === null
    && others[0].description === 'Theirs, not ours.',
    `${JSON.stringify(mine.find((u) => u.code === 'RETAIL')?.description)} vs ${JSON.stringify(others[0].description)}`);

  ok('tenant A cannot read tenant B\'s unit by code',
    (await config.getBusinessUnit(OTHER_ADMIN, 'BU-CORP')) === null,
    'BU-CORP belongs to the first tenant only');

  /*
   * A cross-tenant write is refused as not-found rather than forbidden, and that
   * is the right answer: under row level security the row does not exist for
   * this caller, so saying "forbidden" would confirm that it exists somewhere.
   */
  const crossUpdate = await attempt(() =>
    config.updateBusinessUnit(OTHER_ADMIN, 'BU-CORP', { name: 'Hijacked' }));
  ok('tenant A cannot rename tenant B\'s unit', crossUpdate !== null);
  ok('    and is told it does not exist, not that it is forbidden',
    crossUpdate?.code === 'not_found', crossUpdate?.code);

  const crossActive = await attempt(() =>
    config.setBusinessUnitActive(OTHER_ADMIN, 'BU-CORP', true));
  ok('tenant A cannot reactivate tenant B\'s unit', crossActive?.code === 'not_found',
    crossActive?.code);

  ok('and tenant B\'s unit is untouched',
    (await config.getBusinessUnit(ADMIN, 'BU-CORP'))?.name === 'Corporate');

  const theirAudit = (await admin.query(
    `SELECT count(*)::int n FROM audit_log
      WHERE tenant_id = $1 AND subject_table = 'business_unit'`, [other.tenant])).rows[0].n;
  ok('the other tenant\'s audit trail holds only its own write', theirAudit === 1, `${theirAudit}`);
});

ok('after the second tenant is dropped, ours is intact',
  (await config.listBusinessUnits(ADMIN)).length === 2);

});
} catch (e) {
  fatal = e;
} finally {
  await sweepScratchTenants(admin);
}

console.log('\nthe live tenant was never written to\n');

const after = await census();
ok(`business units ${after.u}`, after.u === before.u, `was ${before.u}`);
ok(`tenants ${after.t}`, after.t === before.t, `was ${before.t}`);
ok(`audit rows ${after.a}`, after.a === before.a, `was ${before.a}`);
ok('no scratch tenant remains',
  (await admin.query("SELECT count(*)::int n FROM tenant WHERE slug LIKE 'zz-scratch-%'"))
    .rows[0].n === 0);

await admin.end();

if (fatal) {
  console.error(`\nthe run did not finish: ${fatal.message}`);
  console.error(fatal.stack);
  process.exit(1);
}

console.log();
if (failed) {
  console.error(`${failed} business unit checks failed`);
  process.exit(1);
}
console.log('a business unit is an admin\'s to shape, everybody\'s to read, and its tenant\'s alone');
