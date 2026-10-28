/**
 * Which day a punch lands on, through `punchIn` and `punchOut`, against a real
 * database.
 *
 * ## The bug
 *
 * Both handlers took the work date as an argument and the client sent the
 * browser's calendar day. For somebody in Chennai working the New Jersey
 * shift that is the wrong day twice a day:
 *
 *   * punch in 18:30 IST → the browser says the 20th, and so does New York;
 *   * punch out 03:30 IST → the browser says the **21st**, New York still says
 *     the 20th. `punchOut` ran `WHERE work_date = '2026-10-21'`, found no
 *     `punch_in`, and refused with "you have not checked in today". The shift
 *     could not be closed at all, and the 20th stayed open for payroll to read
 *     as an absence.
 *
 * `server/scripts/shift-instance.test.mjs` already proves the derivation in
 * isolation. This proves the handlers use it: the row it writes, the row it
 * closes, and that it is one row rather than two.
 *
 * ## Why two dates, and why these two
 *
 * 20 October 2026 is EDT (UTC−4); 10 November 2026 is EST (UTC−5). The same
 * wall-clock shift is a different instant in each, so a test on one date alone
 * would pass just as well against a hard-coded offset. Running both is what
 * distinguishes "asks Postgres for the zone" from "subtracts four hours", and
 * the handover this was built for is 1 November.
 *
 * Fixed dates, not `today`: a suite whose correctness depends on when it runs
 * is a suite that fails in November for reasons nobody can reproduce in
 * October.
 */

import pg from 'pg';

import { loadEnv } from './env.mjs';

import { assertLocalDatabase } from './local-only.mjs';

/* This suite writes. It refuses anything but a local database. */
assertLocalDatabase();

loadEnv();

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and a punch is a row in one.\n');
  process.exit(0);
}

const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');
const {
  punchIn, punchOut, attendanceForDay, AttendanceError,
} = await import('../src/modules/attendance/service.ts');
const { closePool } = await import('../src/db/pool.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};
const refused = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

const admin = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();
await sweepScratchTenants(admin);

/*
 * The two handovers, as instants. Each pair is 09:00 and 18:00 in New York on
 * the given day; the IST column is what the browser would have sent.
 *
 *   EDT  09:00 → 13:00Z (18:30 IST, 20th)    18:00 → 22:00Z (03:30 IST, 21st)
 *   EST  09:00 → 14:00Z (19:30 IST, 10th)    18:00 → 23:00Z (04:30 IST, 11th)
 */
const EDT = { date: '2026-10-20', next: '2026-10-21', in: '2026-10-20T13:00:00.000Z', out: '2026-10-20T22:00:00.000Z' };
const EST = { date: '2026-11-10', next: '2026-11-11', in: '2026-11-10T14:00:00.000Z', out: '2026-11-10T23:00:00.000Z' };

console.log('');
let fatal = null;
try {
  await withScratchTenant(admin, async (ctx) => {
    const dept = (await admin.query(
      'SELECT id FROM department WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.dept])).rows[0].id;
    const site = (await admin.query(
      'SELECT id FROM site WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.site])).rows[0].id;
    const entity = (await admin.query(
      'SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1', [ctx.tenant])).rows[0].id;

    /* 09:00–18:00 New York, with an hour's break: a nine-hour day that pays
       eight. Nothing here stores an offset — the zone is a name. */
    const usShift = (await admin.query(
      `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone, active,
                          grace_minutes, break_minutes)
       VALUES ($1, 'ZZUS', 'ZZ US Day', '09:00'::time, '18:00'::time,
               'America/New_York', true, 10, 60) RETURNING id`,
      [ctx.tenant])).rows[0].id;

    let n = 0;
    const hire = async () => {
      n += 1;
      const code = `ZZW${n}`;
      return (await admin.query(
        `INSERT INTO employee
           (tenant_id, code, full_name, work_email, status, app_role, employment_type,
            department_id, site_id, legal_entity_id, shift_id, joined_on, currency, ctc)
         VALUES ($1, $2, $2, $3::citext, 'active', 'employee', 'permanent',
                 $4, $5, $6, $7, DATE '2021-04-01', 'USD', 90000)
         RETURNING id`,
        [ctx.tenant, code, `${code.toLowerCase()}-${Date.now().toString(36)}@360.technology`,
          dept, site, entity, usShift])).rows[0].id;
    };

    const callerFor = (employeeId) => ({
      role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId, userId: null,
    });

    const rowsFor = async (employeeId) => (await admin.query(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS work_date, punch_in, punch_out,
              worked_minutes
         FROM attendance WHERE tenant_id = $1 AND employee_id = $2
        ORDER BY work_date`, [ctx.tenant, employeeId])).rows;

    /* ---------------------------------------------------------------- *
     * A full shift, worked from India, on each side of the DST change
     * ---------------------------------------------------------------- */

    for (const [label, T] of [['EDT (20 Oct)', EDT], ['EST (10 Nov)', EST]]) {
      console.log(`\na whole shift closes, ${label}\n`);

      const emp = await hire();
      const me = callerFor(emp);

      const inRec = await punchIn(me, emp, {
        site: ctx.site, lat: null, lng: null, src: 'web', at: T.in,
      });
      ok(`1. punching in files the day under New York's date, ${label}`,
        inRec.date === T.date, `${inRec.date}, wanted ${T.date}`);

      /*
       * The assertion the bug was about. The instant below is the next day in
       * IST and in the browser that sent it; it is the same day in the shift's
       * own zone, so it must close the row that is already open.
       */
      const outRec = await punchOut(me, emp, {
        site: ctx.site, lat: null, lng: null, src: 'web', at: T.out,
      });
      ok(`2. punching out after midnight IST closes it, ${label}`,
        Boolean(outRec.outT), `outT=${outRec.outT}`);
      ok(`    and under the same date, not the browser's next day`,
        outRec.date === T.date, `${outRec.date}, wanted ${T.date}`);

      const rows = await rowsFor(emp);
      ok('3. it is one row, not an open one and a stray one',
        rows.length === 1, JSON.stringify(rows.map((r) => r.work_date)));
      ok(`    carrying both punches on ${T.date}`,
        rows[0]?.work_date === T.date && rows[0]?.punch_in && rows[0]?.punch_out,
        JSON.stringify(rows[0]));
      ok('4. nine hours less the hour of break',
        rows[0]?.worked_minutes === 480, String(rows[0]?.worked_minutes));

      /* And nothing was written under the day the browser would have named. */
      const stray = await attendanceForDay(me, emp, T.next);
      ok(`5. nothing on ${T.next}, which is what the browser would have sent`,
        stray === null, JSON.stringify(stray));
    }

    /* ---------------------------------------------------------------- *
     * The other wrong answer: the server's own UTC day
     * ---------------------------------------------------------------- *
     *
     * Everything above is about the browser's day, and it rules out a server
     * that believes the client. It does *not* rule out a server that reaches
     * for `new Date().toISOString().slice(0, 10)` instead — because 18:00 in
     * New York is 22:00Z, still the same calendar day in UTC, so the naive
     * answer and the right one coincide.
     *
     * This closes that: 21:00 EDT on the 20th is 01:00Z on the **21st**, and
     * inside the window, which closes four hours after 18:00. A UTC-day
     * server files it under the 21st and cannot close the 20th.
     *
     * Verified by patching `workDateFor` to each wrong answer in turn and
     * watching this suite fail — the first draft asserted all of the above
     * and passed against the UTC-day version, which is to say it was not
     * testing what its own names claimed.
     */
    console.log('\nnor the server\'s own UTC day\n');
    {
      const emp = await hire();
      const me = callerFor(emp);
      await punchIn(me, emp, {
        site: ctx.site, lat: null, lng: null, src: 'web', at: EDT.in,
      });
      const late = await punchOut(me, emp, {
        site: ctx.site, lat: null, lng: null, src: 'web', at: '2026-10-21T01:00:00.000Z',
      });
      ok('6. a punch out at 21:00 New York closes the 20th, though UTC says the 21st',
        late.date === '2026-10-20' && Boolean(late.outT),
        `${late.date}, outT=${late.outT}`);

      const rows = await rowsFor(emp);
      ok('    as one row, on the 20th', rows.length === 1 && rows[0]?.work_date === '2026-10-20',
        JSON.stringify(rows.map((r) => r.work_date)));
      ok('    twelve hours less the hour of break',
        rows[0]?.worked_minutes === 660, String(rows[0]?.worked_minutes));
    }

    /*
     * The offsets differ, which is the point of running both dates: 13:00Z is
     * 09:00 in New York in October and 08:00 in November. If the derivation
     * subtracted a fixed four hours, one of the two shifts above would have
     * been filed an hour off its start — and `is_late` is measured from that
     * start, so it would have been wrong about lateness too.
     */
    console.log('\nthe zone is a name, not an offset\n');
    {
      const offsets = (await admin.query(
        `SELECT to_char(($1::timestamptz) AT TIME ZONE 'America/New_York', 'HH24:MI') AS oct,
                to_char(($2::timestamptz) AT TIME ZONE 'America/New_York', 'HH24:MI') AS nov`,
        [EDT.in, '2026-11-10T13:00:00.000Z'])).rows[0];
      ok('7. 13:00Z is 09:00 in New York in October', offsets.oct === '09:00', offsets.oct);
      ok('    and 08:00 in November', offsets.nov === '08:00', offsets.nov);
    }

    /* ---------------------------------------------------------------- *
     * A punch in whose IST day is already tomorrow
     * ---------------------------------------------------------------- */

    console.log('\na punch in late in the New York evening\n');
    {
      const emp = await hire();
      const me = callerFor(emp);
      /* 21:00 EDT on the 20th — inside the window, which closes four hours
         after 18:00 — and 06:30 IST on the 21st. */
      const rec = await punchIn(me, emp, {
        site: ctx.site, lat: null, lng: null, src: 'web', at: '2026-10-21T01:00:00.000Z',
      });
      ok('8. filed under the 20th, though IST had reached the 21st',
        rec.date === '2026-10-20', rec.date);
    }

    /* ---------------------------------------------------------------- *
     * Outside every window
     * ---------------------------------------------------------------- */

    console.log('\nand a punch nowhere near a shift\n');
    {
      const emp = await hire();
      const me = callerFor(emp);
      /* 04:00 EDT: the window opens two hours before 09:00. */
      const err = await refused(() => punchIn(me, emp, {
        site: ctx.site, lat: null, lng: null, src: 'web', at: '2026-10-20T08:00:00.000Z',
      }));
      ok('9. is refused, rather than filed under a day it does not belong to',
        err instanceof AttendanceError && err.code === 'outside_window',
        `${err?.code}: ${err?.message}`);
      ok('    and is told what to do instead',
        /attendance correction/i.test(err?.message ?? ''), String(err?.message));
      ok('    for the day the shift\'s own zone was on, not the browser\'s',
        /2026-10-20/.test(err?.message ?? ''), String(err?.message));

      const rows = await rowsFor(emp);
      ok('10. and wrote nothing at all', rows.length === 0, JSON.stringify(rows));
    }
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

console.log(`\n${failed ? `${failed} FAILED` : 'all good'}\n`);
process.exit(failed ? 1 : 0);
