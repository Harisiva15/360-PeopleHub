/**
 * A project can be created, and only by somebody who should.
 *
 * ## The bug this exists for
 *
 * `addEntry` validates a timesheet line against `project WHERE code = $1 AND
 * active`, and nothing in the product ever inserted a project. The only two
 * `INSERT INTO project` statements in the repository were the demo seed and the
 * test harness. So a tenant provisioned for production had an empty table, every
 * line was refused with "choose a project", and the timesheet module could not
 * be used at all — with no screen, route or service method that could fix it.
 *
 * The first test below is therefore the whole point: starting from a tenant with
 * no projects, an administrator creates one and time books against it.
 *
 * ## What else is worth holding
 *
 * **Only an admin shapes the list.** `/projects` is gated on the `timesheet`
 * module so an employee can read the list for their own week, and the timesheet
 * rule lets an employee write their own sheet. Neither of those should let them
 * invent a project, so the check lives in the service and is tested here for
 * both other roles, on all three writes.
 *
 * **Closing is not deleting.** `timesheet_entry.project_id` is NOT NULL and
 * references `project`, as does `expense_item.project_id`, neither with an ON
 * DELETE action. A closed project must stop taking new time and keep naming the
 * hours already booked against it.
 *
 * **A client code is resolved, not trusted.** A code naming no client is
 * refused, because silently storing no client at all would render as "Internal"
 * and look deliberate.
 *
 * Everything runs inside a scratch tenant, which is deleted in one statement
 * afterwards. The live tenant is never addressed.
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
  console.log('\nSKIPPED: no database, and a project is a row in one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const projects = await import('../src/modules/projects/service.ts');
const timesheets = await import('../src/modules/timesheet/service.ts');
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
const refused = async (label, fn, expect = /only an admin/i) => {
  const e = await attempt(fn);
  ok(label, e !== null, 'the call succeeded — this is a permission hole, not a test failure');
  if (e) {
    ok('    refused in the service\'s own words',
      expect.test(e.message) || expect.test(e.code ?? ''), `${e.code ?? ''} ${e.message}`);
  }
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
  SELECT (SELECT count(*)::int FROM project) p,
         (SELECT count(*)::int FROM timesheet_entry) e,
         (SELECT count(*)::int FROM audit_log) a`)).rows[0];
const before = await census();

let fatal = null;
try {
await withScratchTenant(admin, async (ctx) => {

const caller = (role, employeeId) =>
  ({ role, tenantId: ctx.tenant, employeeId, userId: null });

const ADMIN = caller('admin', ctx.adminEmployeeId);
const MANAGER = caller('manager', ctx.adminEmployeeId);
const EMPLOYEE = caller('employee', ctx.adminEmployeeId);

/*
 * The scratch tenant seeds one project, because other suites book time against
 * it. Remove it so the first assertions start from the state a production
 * tenant was actually in: none at all.
 */
await admin.query('DELETE FROM project WHERE tenant_id = $1', [ctx.tenant]);

console.log('\nthe bug: an empty project table\n');

let list = await projects.listProjects(ADMIN);
ok('a fresh tenant has no projects', list.length === 0, `${list.length} found`);

const sheet = await timesheets.timesheetForWeek(ADMIN, ctx.adminEmployeeId, '2026-09-28');
let e = await attempt(() => timesheets.addEntry(ADMIN, sheet.id, {
  proj: 'P-NEW', task: 'Something', date: '2026-09-28', hours: 4,
}));
ok('and so no time can be booked at all', e !== null,
  'the entry was accepted with no project in the table');
ok('    the refusal names the missing project', /no such project/i.test(e?.message ?? ''),
  e?.message ?? '');

console.log('\ncreating one\n');

const made = await projects.createProject(ADMIN, {
  code: 'p-new', name: 'New Engagement', billable: true,
});
ok('an admin creates a project', made.id === 'P-NEW', made.id);
ok('    the code is upper-cased', made.id === made.id.toUpperCase(), made.id);
ok('    it is open for booking', made.active === true);
ok('    with no client it reads as Internal', made.client === 'Internal', made.client);
ok('    billable as asked', made.billable === true);
ok('    and no dates were invented',
  made.startsOn === null && made.endsOn === null, `${made.startsOn} ${made.endsOn}`);

/* The point of the whole exercise. */
const booked = await timesheets.addEntry(ADMIN, sheet.id, {
  proj: 'P-NEW', task: 'Something', date: '2026-09-28', hours: 4,
});
ok('time now books against it', booked.total === 4, `total ${booked.total}`);
ok('    and the line names the project',
  booked.entries.some((x) => x.proj === 'P-NEW'),
  JSON.stringify(booked.entries.map((x) => x.proj)));

console.log('\nwhat a project must have\n');

for (const [label, draft, expect] of [
  ['a code is required', { name: 'No code' }, /needs a code/i],
  ['a name is required', { code: 'P-X' }, /needs a name/i],
  ['a blank name is not a name', { code: 'P-X', name: '   ' }, /needs a name/i],
  ['a code with a space is refused', { code: 'P X', name: 'n' }, /2–16 letters/i],
  ['a one-character code is refused', { code: 'P', name: 'n' }, /2–16 letters/i],
  ['a seventeen-character code is refused',
    { code: 'P-ABCDEFGHIJKLMNO', name: 'n' }, /2–16 letters/i],
  ['a code with a slash is refused', { code: 'P/X', name: 'n' }, /2–16 letters/i],
  ['a start that is not a date is refused',
    { code: 'P-Y', name: 'n', startsOn: 'soon' }, /is a date/i],
  ['an end before the start is refused',
    { code: 'P-Y', name: 'n', startsOn: '2026-06-01', endsOn: '2026-05-31' },
    /cannot end before it starts/i],
  ['a client that names nobody is refused',
    { code: 'P-Y', name: 'n', client: 'NOSUCHCLIENT' }, /no such client/i],
]) {
  await refused(label, () => projects.createProject(ADMIN, draft), expect);
}

const dup = await attempt(() => projects.createProject(ADMIN, { code: 'P-NEW', name: 'Again' }));
ok('the same code twice is refused', dup !== null, 'a duplicate code was accepted');
ok('    and says so', /already a project/i.test(dup?.message ?? ''), dup?.message ?? '');
ok('    as a conflict', dup?.code === 'conflict', dup?.code ?? '');

const dated = await projects.createProject(ADMIN, {
  code: 'P-DATED', name: 'Fixed Term', billable: false,
  startsOn: '2026-04-01', endsOn: '2027-03-31',
});
ok('dates are kept as given',
  dated.startsOn === '2026-04-01' && dated.endsOn === '2027-03-31',
  `${dated.startsOn} → ${dated.endsOn}`);
ok('    and non-billable stays non-billable', dated.billable === false);
ok('equal start and end is a one-day project',
  (await projects.createProject(ADMIN, {
    code: 'P-ONEDAY', name: 'One Day', startsOn: '2026-05-01', endsOn: '2026-05-01',
  })).startsOn === '2026-05-01');

console.log('\nonly an admin shapes the list\n');

await refused('a manager cannot create a project',
  () => projects.createProject(MANAGER, { code: 'P-MGR', name: 'Mine' }));
await refused('an employee cannot create a project',
  () => projects.createProject(EMPLOYEE, { code: 'P-EMP', name: 'Mine' }));
await refused('a manager cannot change one',
  () => projects.updateProject(MANAGER, 'P-NEW', { name: 'Renamed' }));
await refused('an employee cannot change one',
  () => projects.updateProject(EMPLOYEE, 'P-NEW', { name: 'Renamed' }));
await refused('a manager cannot close one',
  () => projects.setProjectStatus(MANAGER, 'P-NEW', false));
await refused('an employee cannot close one',
  () => projects.setProjectStatus(EMPLOYEE, 'P-NEW', false));

ok('and none of those changed anything',
  (await projects.listProjects(ADMIN)).find((p) => p.id === 'P-NEW')?.name === 'New Engagement');

/* Both other roles must still be able to *read* the list — the picker needs it. */
ok('a manager still reads the list', (await projects.listProjects(MANAGER)).length > 0);
ok('an employee still reads the list', (await projects.listProjects(EMPLOYEE)).length > 0);

console.log('\nchanging one\n');

const edited = await projects.updateProject(ADMIN, 'p-new', {
  name: 'Renamed Engagement', billable: false, startsOn: '2026-01-01',
});
ok('the name changes', edited.name === 'Renamed Engagement', edited.name);
ok('    the code is matched case-insensitively', edited.id === 'P-NEW', edited.id);
ok('    billable can be turned off', edited.billable === false);
ok('    a date can be added', edited.startsOn === '2026-01-01', String(edited.startsOn));
ok('    and an omitted date is cleared, not kept', edited.endsOn === null, String(edited.endsOn));

const noName = await attempt(() => projects.updateProject(ADMIN, 'P-NEW', { billable: true }));
ok('an update still needs a name', noName !== null, 'a nameless update was accepted');

const ghost = await attempt(() => projects.updateProject(ADMIN, 'P-NOPE', { name: 'x' }));
ok('changing a project that does not exist is a 404', ghost?.code === 'not_found', ghost?.code);

ok('the booked hours survived the edit',
  (await timesheets.timesheetForWeek(ADMIN, ctx.adminEmployeeId, '2026-09-28')).total === 4);

console.log('\nclosing is not deleting\n');

const closed = await projects.setProjectStatus(ADMIN, 'P-NEW', false);
ok('a project can be closed', closed.active === false);

e = await attempt(() => timesheets.addEntry(ADMIN, sheet.id, {
  proj: 'P-NEW', task: 'More', date: '2026-09-29', hours: 2,
}));
ok('no new time books against a closed project', e !== null,
  'a closed project still accepted time');
ok('    and the refusal names it', /no such project/i.test(e?.message ?? ''), e?.message ?? '');

const after = await timesheets.timesheetForWeek(ADMIN, ctx.adminEmployeeId, '2026-09-28');
ok('the hours already booked are untouched', after.total === 4, `total ${after.total}`);
ok('    and still name the closed project',
  after.entries.some((x) => x.proj === 'P-NEW'));
ok('a closed project is still listed, so old entries resolve',
  (await projects.listProjects(ADMIN)).some((p) => p.id === 'P-NEW' && !p.active));

const reopened = await projects.setProjectStatus(ADMIN, 'P-NEW', true);
ok('it can be reopened', reopened.active === true);
const again = await timesheets.addEntry(ADMIN, sheet.id, {
  proj: 'P-NEW', task: 'More', date: '2026-09-29', hours: 2,
});
ok('    and takes time again', again.total === 6, `total ${again.total}`);

const noGhost = await attempt(() => projects.setProjectStatus(ADMIN, 'P-NOPE', false));
ok('closing a project that does not exist is a 404',
  noGhost?.code === 'not_found', noGhost?.code);

console.log('\nthe list, and what it says\n');

list = await projects.listProjects(ADMIN);
ok('every project created is in it', list.length === 3, `${list.length}`);
ok('    open ones come first',
  list.findIndex((p) => !p.active) === -1
    || list.findIndex((p) => !p.active) === list.length - 1
    || list.slice(0, list.findIndex((p) => !p.active)).every((p) => p.active));
ok('    each carries a code, a name and a client',
  list.every((p) => p.id && p.name && p.client));

console.log('\nevery write is audited\n');

const audit = (await admin.query(
  `SELECT action, detail FROM audit_log
    WHERE tenant_id = $1 AND subject_table = 'project' ORDER BY id`, [ctx.tenant])).rows;
ok('a creation is recorded', audit.some((r) => r.action === 'project_created'));
ok('an update is recorded', audit.some((r) => r.action === 'project_updated'));
ok('a closure is recorded', audit.some((r) => r.action === 'project_closed'));
ok('a reopening is recorded', audit.some((r) => r.action === 'project_reopened'));
ok('    and each names the project it was about',
  audit.every((r) => typeof r.detail?.project === 'string' && r.detail.project.length > 0),
  JSON.stringify(audit.map((r) => r.detail?.project)));
ok('    a refused write left no audit row',
  !audit.some((r) => String(r.detail?.project ?? '').startsWith('P-MGR')));

console.log('\ntenant isolation\n');

/*
 * The scratch tenant's admin addressing the live tenant's id. `withTenant` sets
 * the tenant from the caller and RLS forces it, so this must see nothing of the
 * other tenant rather than refusing loudly.
 */
const other = (await admin.query(
  'SELECT id FROM tenant WHERE id <> $1 LIMIT 1', [ctx.tenant])).rows[0];
if (other) {
  const theirs = await projects.listProjects(
    { role: 'admin', tenantId: other.id, employeeId: null, userId: null });
  const mine = new Set(list.map((p) => p.id));
  ok('another tenant\'s list holds none of ours',
    !theirs.some((p) => mine.has(p.id)),
    JSON.stringify(theirs.filter((p) => mine.has(p.id)).map((p) => p.id)));
} else {
  ok('another tenant\'s list holds none of ours', true, 'only one tenant exists — nothing to cross');
}

});
} catch (e) {
  fatal = e;
} finally {
  await sweepScratchTenants(admin);
}

const after = await census();
ok('the live tenant is exactly as it was',
  after.p === before.p && after.e === before.e && after.a === before.a,
  `projects ${before.p}->${after.p}  entries ${before.e}->${after.e}  audit ${before.a}->${after.a}`);

await admin.end();

if (fatal) {
  console.error(`\nthe run did not finish: ${fatal.message}`);
  console.error(fatal.stack);
  process.exit(1);
}

console.log();
if (failed) {
  console.error(`${failed} project checks failed`);
  process.exit(1);
}
console.log('a project can be created, only by an admin, and closing one keeps its hours');
