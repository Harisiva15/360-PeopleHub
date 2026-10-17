/**
 * Checking in and out, through the service, against a real database.
 *
 * ## Why this exists
 *
 * Nothing had ever called `punchIn`. Every suite that needed an attendance row
 * inserted one with SQL, and the only assertion about punching anywhere in the
 * repository was `typeof att.punchIn === 'function'`. So the one thing everybody
 * does every morning was the one path with no coverage at all.
 *
 * What that cost: migration 0004 closes `attendance.source` to
 * `('web','mobile','biometric','kiosk','import','system')`, the handler passed
 * `at.src` into it unchanged, and the web client sent `'Web'`. Postgres refused
 * every insert with 23514, the route answered 500, and `doPunch` had no catch so
 * the screen said nothing. Production reached fifty-five migrations with **zero
 * attendance rows ever written** — reported as "check-in records no time and no
 * location", which it did not, because there was no row to carry either.
 *
 * Both halves were invisible to everything that existed: the mock stores `src`
 * as a free string so the demo build was perfect, and no server suite executed
 * the statement that had the constraint on it.
 *
 * ## What is asserted
 *
 *   1. A punch writes a row, with the time, the site, the shift and the source.
 *   2. The source is stored as the schema's own vocabulary, whatever case the
 *      client used — and an unrecognised value does not refuse the punch.
 *   3. Coordinates are kept once the notice is acknowledged and withheld before,
 *      and the fence verdict is the server's, computed from the coordinates.
 *   4. Punching out closes the day and derives the minutes.
 *   5. The refusals are refusals: twice in, out before in, somebody else's day.
 */

import pg from 'pg';

import { loadEnv } from './env.mjs';

loadEnv();

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and a punch is a row in one.\n');
  process.exit(0);
}

const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');
const {
  punchIn, punchOut, acknowledgeLocationNotice, attendanceForDay, AttendanceError,
} = await import('../src/modules/attendance/service.ts');
const { closePool } = await import('../src/db/pool.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const refused = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

const db = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await db.connect();
await sweepScratchTenants(db);

const today = new Date().toISOString().slice(0, 10);
/* An instant inside the working day, so lateness is a property of the shift
 * rather than of whenever this suite happens to run. */
const at8 = `${today}T02:30:00.000Z`;   /* 08:00 Asia/Kolkata */
const at18 = `${today}T12:30:00.000Z`;  /* 18:00 Asia/Kolkata */

const row = async (tenant) => (await db.query(
  `SELECT status, punch_in, punch_out, worked_minutes, late, source,
          latitude, longitude, distance_m, geo_ok,
          site_id IS NOT NULL AS has_site, shift_id IS NOT NULL AS has_shift
     FROM attendance WHERE tenant_id = $1`, [tenant])).rows;

try {

/* ------------------------------------------------------------------ *
 * A punch becomes a row
 * ------------------------------------------------------------------ */

console.log('\nchecking in writes a row that carries the time\n');

await withScratchTenant(db, async (ctx) => {
  const me = {
    role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  await acknowledgeLocationNotice(me);

  const r = await punchIn(me, ctx.adminEmployeeId, today, {
    site: ctx.site, lat: null, lng: null, src: 'web', at: at8,
  });

  ok('1. punchIn returns a record', Boolean(r), JSON.stringify(r));
  ok('    with the punch-in time set', Boolean(r.inT), String(r.inT));
  ok('    and no punch-out yet', !r.outT, String(r.outT));
  ok('    status P for an office punch', r.status === 'P', r.status);

  const [stored] = await row(ctx.tenant);
  ok('2. the row exists in attendance', Boolean(stored),
    'this is the assertion whose absence let every live punch fail silently');
  ok('    punch_in is a timestamp, not null', stored?.punch_in instanceof Date,
    String(stored?.punch_in));
  ok('    the site is recorded', stored?.has_site === true);
  ok('    the shift is recorded', stored?.has_shift === true,
    'worked minutes are derived against it later');
  ok('3. source is the schema vocabulary', stored?.source === 'web', String(stored?.source));
});

/* ------------------------------------------------------------------ *
 * The constraint this suite was written for
 * ------------------------------------------------------------------ */

console.log('\nthe source column is a closed set, and the client\'s case is not its problem\n');

for (const [sent, want] of [
  ['Web', 'web'],
  ['WEB', 'web'],
  ['Mobile', 'mobile'],
  ['biometric', 'biometric'],
  ['  Kiosk  ', 'kiosk'],
  ['carrier-pigeon', 'web'],
  ['', 'web'],
  [undefined, 'web'],
]) {
  await withScratchTenant(db, async (ctx) => {
    const me = {
      role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
    };
    const err = await refused(() => punchIn(me, ctx.adminEmployeeId, today, {
      site: ctx.site, lat: null, lng: null, src: sent, at: at8,
    }));
    const [stored] = await row(ctx.tenant);
    ok(`4. src ${JSON.stringify(sent)} is accepted and stored as ${want}`,
      err === null && stored?.source === want,
      err ? `${err.code ?? ''} ${err.message}` : `stored ${stored?.source}`);
  });
}

/* ------------------------------------------------------------------ *
 * Where they were
 * ------------------------------------------------------------------ */

console.log('\nthe position is kept once they have been told, and not before\n');

await withScratchTenant(db, async (ctx) => {
  const me = {
    role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  /* Deliberately no acknowledgement. */
  await punchIn(me, ctx.adminEmployeeId, today, {
    site: ctx.site, lat: 12.9911, lng: 80.2503, src: 'web', at: at8,
  });
  const [stored] = await row(ctx.tenant);
  ok('5. without the notice, coordinates are discarded',
    stored.latitude === null && stored.longitude === null,
    `${stored.latitude} ${stored.longitude}`);
  ok('    and the punch still counts', stored.punch_in instanceof Date,
    'refusing it would be a payroll fault dressed as a privacy control');
});

await withScratchTenant(db, async (ctx) => {
  const me = {
    role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  await acknowledgeLocationNotice(me);
  /* A fence this scratch site actually has, and a point inside it. */
  await db.query(
    `UPDATE site SET latitude = 12.9911, longitude = 80.2503, fence_radius_m = 250
      WHERE tenant_id = $1 AND code = $2`, [ctx.tenant, ctx.site]);

  const inside = await punchIn(me, ctx.adminEmployeeId, today, {
    site: ctx.site, lat: 12.9912, lng: 80.2504, src: 'web', at: at8,
  });
  const [stored] = await row(ctx.tenant);
  ok('6. with the notice, the coordinates are kept',
    stored.latitude !== null && stored.longitude !== null,
    `${stored.latitude} ${stored.longitude}`);
  ok('    the distance is computed by the server',
    stored.distance_m !== null && Number(stored.distance_m) < 100,
    String(stored.distance_m));
  ok('    and the fence verdict is true inside it',
    stored.geo_ok === true && inside.geoOk === true, String(stored.geo_ok));
});

await withScratchTenant(db, async (ctx) => {
  const me = {
    role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  await acknowledgeLocationNotice(me);
  await db.query(
    `UPDATE site SET latitude = 12.9911, longitude = 80.2503, fence_radius_m = 250
      WHERE tenant_id = $1 AND code = $2`, [ctx.tenant, ctx.site]);
  /* Roughly 5 km away. */
  await punchIn(me, ctx.adminEmployeeId, today, {
    site: ctx.site, lat: 13.0400, lng: 80.2503, src: 'web', at: at8,
  });
  const [stored] = await row(ctx.tenant);
  ok('7. outside the fence is recorded as outside, not refused',
    stored.geo_ok === false && Number(stored.distance_m) > 1000,
    `${stored.geo_ok} at ${stored.distance_m} m`);
  ok('    and the day is still present', stored.status === 'P', stored.status);
});

/* ------------------------------------------------------------------ *
 * Out, and the minutes
 * ------------------------------------------------------------------ */

console.log('\nchecking out closes the day\n');

await withScratchTenant(db, async (ctx) => {
  const me = {
    role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  await punchIn(me, ctx.adminEmployeeId, today, {
    site: ctx.site, lat: null, lng: null, src: 'web', at: at8,
  });
  const out = await punchOut(me, ctx.adminEmployeeId, today, {
    site: ctx.site, lat: null, lng: null, src: 'web', at: at18,
  });
  ok('8. punchOut sets the time', Boolean(out.outT), String(out.outT));
  const [stored] = await row(ctx.tenant);
  ok('    and the row carries both punches',
    stored.punch_in instanceof Date && stored.punch_out instanceof Date);
  ok('9. worked minutes are derived, with the break taken off',
    stored.worked_minutes === 600 - 60,
    `${stored.worked_minutes} — ten hours less a sixty-minute break`);
  const day = await attendanceForDay(me, ctx.adminEmployeeId, today);
  ok('10. and the day reads back through the API shape',
    day?.inT && day?.outT && day.mins === 540,
    JSON.stringify(day));
});

/* ------------------------------------------------------------------ *
 * The refusals
 * ------------------------------------------------------------------ */

console.log('\nand what it refuses\n');

await withScratchTenant(db, async (ctx) => {
  const me = {
    role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  await punchIn(me, ctx.adminEmployeeId, today, {
    site: ctx.site, lat: null, lng: null, src: 'web', at: at8,
  });
  const twice = await refused(() => punchIn(me, ctx.adminEmployeeId, today, {
    site: ctx.site, lat: null, lng: null, src: 'web', at: at18,
  }));
  ok('11. punching in twice is refused', twice instanceof AttendanceError
    && twice.code === 'already_in', `${twice?.code}: ${twice?.message}`);
  ok('    in the service\'s own words, not a database error',
    /already checked in/.test(twice?.message ?? ''), String(twice?.message));
});

await withScratchTenant(db, async (ctx) => {
  const me = {
    role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const early = await refused(() => punchOut(me, ctx.adminEmployeeId, today, {
    site: ctx.site, lat: null, lng: null, src: 'web', at: at18,
  }));
  ok('12. punching out without punching in is refused',
    early instanceof AttendanceError && early.code === 'no_punch_in',
    `${early?.code}: ${early?.message}`);

  const bad = await refused(() => punchIn(me, ctx.adminEmployeeId, today, {
    site: ctx.site, lat: null, lng: null, src: 'web', at: '09:30',
  }));
  ok('13. a wall-clock time is refused as invalid, not as a 500',
    bad instanceof AttendanceError && bad.code === 'invalid',
    `${bad?.code}: ${bad?.message}`);
  ok('    naming what it wanted', /ISO-8601/.test(bad?.message ?? ''), String(bad?.message));
});

await withScratchTenant(db, async (ctx) => {
  /* A second employee, and somebody who is not an admin trying to punch them in. */
  const other = (await db.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id, joined_on)
     SELECT $1, 'ZZOTH', 'ZZ Other', $2, 'active', 'employee',
            (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM site WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM shift WHERE tenant_id = $1 LIMIT 1), '2020-01-01'
     RETURNING id`,
    [ctx.tenant, `zz-other-${Math.random().toString(36).slice(2, 9)}@360.technology`]
  )).rows[0].id;

  const employee = {
    role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const notMine = await refused(() => punchIn(employee, other, today, {
    site: ctx.site, lat: null, lng: null, src: 'web', at: at8,
  }));
  ok('14. an employee cannot punch somebody else in',
    notMine instanceof AttendanceError && notMine.code === 'forbidden',
    `${notMine?.code}: ${notMine?.message}`);

  const admin = {
    role: 'company_admin', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const byAdmin = await refused(() => punchIn(admin, other, today, {
    site: ctx.site, lat: null, lng: null, src: 'web', at: at8,
  }));
  ok('    while an admin can, which is what the exception is for',
    byAdmin === null, `${byAdmin?.code}: ${byAdmin?.message}`);
});

console.log('\nnothing was left behind\n');
ok('no scratch tenant remains',
  (await db.query("SELECT count(*)::int n FROM tenant WHERE slug LIKE 'zz-scratch-%'"))
    .rows[0].n === 0);

} finally {
  await sweepScratchTenants(db);
  await db.end();
  await closePool();
}

console.log();
if (failed) {
  console.error(`${failed} punch checks failed`);
  process.exit(1);
}
console.log('a punch records the time, the place and how it was made, and says so when it cannot');
