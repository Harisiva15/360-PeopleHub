/**
 * Putting somebody on the hours they actually work.
 *
 * ## Why the account form needed a Shift field at all
 *
 * `createUser` derived the shift from the site's country — the profile whose
 * code matches `site.country`. That is right for everybody who works where
 * they sit and wrong for everybody who does not, and the people who do not are
 * exactly the ones whose attendance goes wrong quietly: somebody in Chennai on
 * US hours was measured against IST, so a 19:00 start read as nine and a half
 * hours late every single day and their punch out landed on the wrong calendar
 * day. The only way to say otherwise was the roster screen, which an
 * administrator setting up an account has no reason to open.
 *
 * ## One writer, two doors
 *
 * `assignShift` is the only thing that writes `employee.shift_id`. The roster
 * screen's `PUT /employees/:id/shift` and the Shift field on the account form
 * both go through it, so the gate, the own-line check, the active-only rule,
 * the self refusal and the audit entry are the same by either door. A second
 * copy inside `updateUser` would be a second answer waiting to drift.
 *
 * ## The three rules that are not obvious
 *
 *   **The gate asks about writing.** It asked `shifts read team` — a read
 *   scope standing in front of a write. For this module the two admit the same
 *   people, so it was latent rather than open, which is precisely how the same
 *   shape went unnoticed in `users`.
 *
 *   **Nobody moves their own shift.** Your hours decide the late threshold your
 *   own punches are judged by and the window they have to fall inside. There is
 *   no second pair of eyes on a self-move, because the audit entry names you as
 *   actor and subject both.
 *
 *   **An unchanged shift is not a change.** The drawer posts every field it
 *   holds. If `updateUser` passed that through, an administrator editing their
 *   own phone number would be refused with "you cannot change your own shift" —
 *   a guard firing on a field nobody touched.
 *
 * ## And closing a day is not the same question as opening one
 *
 * `punchOut` resolved the work date from the employee's *current* shift. Move
 * somebody mid-shift and their punch out is measured against hours they were
 * not working: at best it lands on a different work date and is refused with
 * "you have not checked in today", leaving the row open for ever. Assertions 14
 * to 17 move somebody between a day shift and a night shift while they are
 * clocked in and require the day to close against what it was opened on.
 */

import pg from 'pg';

import { loadEnv } from './env.mjs';

import { assertLocalDatabase } from './local-only.mjs';

/* This suite writes. It refuses anything but a local database. */
assertLocalDatabase();

loadEnv();

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and a shift assignment is a row in one.\n');
  process.exit(0);
}

const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');
const { createUser, updateUser, getUser } = await import('../src/modules/users/service.ts');
const { setEmployeeShift } = await import('../src/modules/shifts/service.ts');
const { punchIn, punchOut, attendanceForDay, unclosedDays } =
  await import('../src/modules/attendance/service.ts');
const { closePool } = await import('../src/db/pool.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};
const refused = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};
const refusedWith = async (label, fn, re) => {
  const e = await refused(fn);
  ok(label, Boolean(e) && re.test(e.message), e ? e.message : 'it was allowed');
};

const admin = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();
await sweepScratchTenants(admin);

/*
 * A day on the IST day shift, and the instants that open and close it.
 *
 * 2026-10-20 is a Tuesday. 04:30Z is 10:00 IST, inside the 09:30 start's
 * window; 13:00Z is 18:30 IST, the end of it. 510 minutes apart.
 */
const DAY = '2026-10-20';
const IN_AT = '2026-10-20T04:30:00.000Z';
const OUT_AT = '2026-10-20T13:00:00.000Z';
/* A week earlier, for the day nobody closed. */
const STALE = '2026-10-13';
const STALE_IN_AT = '2026-10-13T04:30:00.000Z';

console.log('');
let fatal = null;
try {
  await withScratchTenant(admin, async (ctx) => {
    const A = {
      role: 'company_admin', hasReports: false, tenantId: ctx.tenant,
      employeeId: ctx.adminEmployeeId, userId: null,
    };
    const HR = {
      role: 'hr_admin', hasReports: false, tenantId: ctx.tenant,
      employeeId: ctx.adminEmployeeId, userId: null,
    };

    const adminAccountId = (await admin.query(
      'SELECT id FROM tenant_membership WHERE tenant_id = $1 AND employee_id = $2',
      [ctx.tenant, ctx.adminEmployeeId])).rows[0].id;

    /*
     * Two more profiles beside the scratch tenant's own `IN` (09:30–18:30
     * Asia/Kolkata), which is the country default the site resolves to.
     *
     * `ZZSNIGHT` is the one that makes assertion 15 unambiguous: its window is
     * 21:00 IST to 11:00 the next morning, so the day shift's 18:30 punch out
     * falls *outside* it entirely. Measured against the employee's current
     * shift that punch has no day to belong to at all.
     *
     * The breaks differ on purpose — 60 on the day shift, 30 on the night one —
     * so assertion 17 can tell which shift's break was deducted. A wrong one
     * still produces a plausible-looking total, which is why it needs its own
     * assertion rather than being visible in the first.
     */
    const shiftOf = async (code, starts, ends, tz, breakMins, active = true) => (await admin.query(
      `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone, active,
                          grace_minutes, break_minutes, region)
       VALUES ($1, $2, $2, $3::time, $4::time, $5, $7, 10, $6, 'US') RETURNING id`,
      [ctx.tenant, code, starts, ends, tz, breakMins, active])).rows[0].id;

    await shiftOf('ZZSUS', '09:00', '18:00', 'America/New_York', 45);
    await shiftOf('ZZSNIGHT', '23:00', '07:00', 'Asia/Kolkata', 30);
    await shiftOf('ZZSOLD', '08:00', '17:00', 'Asia/Kolkata', 60, false);
    await admin.query(
      `UPDATE shift SET timezone = 'Asia/Kolkata', break_minutes = 60
        WHERE tenant_id = $1 AND code = 'IN'`, [ctx.tenant]);

    let n = 0;
    const draft = (extra = {}) => {
      n += 1;
      return {
        name: `ZZ Shifted ${n}`,
        email: `zz-shifted-${n}-${Date.now().toString(36)}@360.technology`,
        role: 'employee',
        dept: ctx.dept,
        site: ctx.site,
        designation: 'Tester',
        /* Never true. An invitation is an email to a real person. */
        sendInvitation: false,
        ...extra,
      };
    };

    const shiftCodeOf = async (empId) => (await admin.query(
      `SELECT sh.code FROM employee e JOIN shift sh ON sh.id = e.shift_id
        WHERE e.id = $1`, [empId])).rows[0]?.code ?? null;

    const moves = async (empId) => (await admin.query(
      `SELECT detail FROM audit_log
        WHERE tenant_id = $1 AND action = 'employee_shift_changed'
          AND detail ->> 'employeeId' = $2
        ORDER BY id DESC`, [ctx.tenant, empId])).rows.map((r) => r.detail);

    /* ---------------------------------------------------------------- *
     * Creating
     * ---------------------------------------------------------------- */

    console.log('\nthe country default, and saying otherwise\n');

    const byDefault = await createUser(A, draft());
    ok('1. with no shift named, the site\'s country still decides',
      byDefault.shift === 'IN', String(byDefault.shift));
    ok('    and the account reports which one it is',
      (await getUser(A, byDefault.id))?.shift === 'IN');

    const onUs = await createUser(A, draft({ shiftCode: 'ZZSUS' }));
    ok('2. a named shift overrides the default', onUs.shift === 'ZZSUS', String(onUs.shift));
    ok('    and it is the employee row that moved, not just the answer',
      (await shiftCodeOf(onUs.empId)) === 'ZZSUS');

    /*
     * Lower case, because a code is a code however it was typed. `shift.code`
     * is upper case by convention and the drawer sends whatever the select
     * holds; a case-sensitive lookup would refuse a correct choice.
     */
    const lower = await createUser(A, draft({ shiftCode: 'zzsus' }));
    ok('3. the code is matched without regard to case', lower.shift === 'ZZSUS',
      String(lower.shift));

    await refusedWith('4. a withdrawn profile cannot be assigned at creation',
      () => createUser(A, draft({ shiftCode: 'ZZSOLD' })),
      /not in use and cannot be assigned/);
    await refusedWith('5. nor one that does not exist',
      () => createUser(A, draft({ shiftCode: 'ZZNOPE' })), /no such shift/);

    /*
     * Creating leaves no `employee_shift_changed` entry. There is no previous
     * shift, so there is no move — nothing a from/to entry could describe. The
     * hire is the record.
     */
    ok('6. creating an account is not a move and logs none',
      (await moves(onUs.empId)).length === 0,
      JSON.stringify(await moves(onUs.empId)));

    /* ---------------------------------------------------------------- *
     * Changing
     * ---------------------------------------------------------------- */

    console.log('\nmoving somebody through the account form\n');

    const moved = await updateUser(A, byDefault.id, { shiftCode: 'ZZSUS' });
    ok('7. the account form moves somebody onto other hours',
      moved.shift === 'ZZSUS', String(moved.shift));
    ok('    and the employee row went with it',
      (await shiftCodeOf(byDefault.empId)) === 'ZZSUS');

    const entries = await moves(byDefault.empId);
    ok('8. one entry, through the same writer the roster screen uses',
      entries.length === 1, JSON.stringify(entries));
    ok('    naming where they came from', entries[0]?.from === 'IN', String(entries[0]?.from));
    ok('    and where they went', entries[0]?.to === 'ZZSUS', String(entries[0]?.to));

    const today = (await admin.query('SELECT current_date::text AS d')).rows[0].d;
    ok('9. and the day the move took effect',
      entries[0]?.effective === today, `${entries[0]?.effective} vs ${today}`);

    /*
     * Re-sending what is already there.
     *
     * The drawer posts every field it holds, so this is the ordinary case, not
     * an edge one: somebody corrects a phone number and the current shift rides
     * along. It must change nothing and log nothing.
     */
    const resent = await updateUser(A, byDefault.id, { phone: '+91 99999 00000', shiftCode: 'ZZSUS' });
    ok('10. re-sending the shift they are already on is not a move',
      resent.shift === 'ZZSUS' && resent.phone === '+91 99999 00000',
      `${resent.shift} / ${resent.phone}`);
    ok('    and logs no second entry',
      (await moves(byDefault.empId)).length === 1,
      JSON.stringify(await moves(byDefault.empId)));

    /*
     * The self refusal, and the reason it has to tolerate a resend.
     *
     * An administrator editing their own account is ordinary — a phone number,
     * a designation. The form sends their current shift with it. If that were
     * passed through, the edit would be refused with a message about a field
     * they never touched.
     */
    const ownShift = await shiftCodeOf(ctx.adminEmployeeId);
    const ownEdit = await refused(() => updateUser(A, adminAccountId, {
      phone: '+91 98765 43210', shiftCode: ownShift,
    }));
    ok('11. an administrator may edit their own account with their own shift on the form',
      ownEdit === null, `${ownEdit?.code}: ${ownEdit?.message}`);

    await refusedWith('12. but may not move themselves onto other hours',
      () => updateUser(A, adminAccountId, { shiftCode: 'ZZSUS' }),
      /cannot change your own shift/);
    ok('    and the refusal left their shift alone',
      (await shiftCodeOf(ctx.adminEmployeeId)) === ownShift);

    /*
     * Where an HR administrator actually does this — and it is not here.
     *
     * hr_admin holds `shifts write all`, so they may put anybody on any
     * profile. They hold `users read all` and *no* `users write`, so they may
     * not change an account at all: `scopeFor` gives them no row to load and
     * `updateUser` refuses before the shift is ever considered. The Shift field
     * on the account form is therefore company_admin's, and HR's door onto the
     * same writer is the Shifts & work schedules screen.
     *
     * Asserted as a pair, because the two halves read as a contradiction
     * otherwise and the next person to find one of them will want the other.
     * The refusal is about the account, not about the shift — the message is
     * the discriminator, and if a later change to the users policy opens
     * account editing to HR this assertion is where it will be noticed.
     */
    await refusedWith('13. an HR administrator cannot reach it through the account form',
      () => updateUser(HR, byDefault.id, { shiftCode: 'ZZSUS' }),
      /outside the people you can manage/);
    ok('    but moves the same person on the roster screen, through the same writer',
      (await setEmployeeShift(HR, byDefault.empId, 'IN')).shift === 'IN');
    ok('    which is the move that reached the employee row',
      (await shiftCodeOf(byDefault.empId)) === 'IN');

    await refusedWith('    and a withdrawn profile is refused on an edit too',
      () => updateUser(A, byDefault.id, { shiftCode: 'ZZSOLD' }),
      /not in use and cannot be assigned/);

    /* ---------------------------------------------------------------- *
     * Closing a day that was opened on another shift
     * ---------------------------------------------------------------- */

    console.log('\na day closes against the hours it was opened on\n');

    const worker = await createUser(A, draft({ shiftCode: 'IN' }));
    const me = {
      role: 'employee', hasReports: false, tenantId: ctx.tenant,
      employeeId: worker.empId, userId: null,
    };

    await punchIn(me, worker.empId, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: IN_AT,
    });
    ok('14. the day opens on the India shift', (await attendanceForDay(me, worker.empId, DAY))?.inT === '10:00',
      String((await attendanceForDay(me, worker.empId, DAY))?.inT));

    /* Moved while they are clocked in, which is the whole point. */
    await setEmployeeShift(A, worker.empId, 'ZZSNIGHT');
    ok('    and they are now on the night shift',
      (await shiftCodeOf(worker.empId)) === 'ZZSNIGHT');

    /*
     * 18:30 IST is outside the night shift's window entirely — it opens at
     * 21:00 — so resolving this punch against the employee's *current* shift
     * finds no day to attach it to and throws `outside_window`. Against the
     * row's own shift it is the end of the day they opened.
     */
    const closed = await refused(() => punchOut(me, worker.empId, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: OUT_AT,
    }));
    ok('15. the punch out still closes the day, not refused as outside a window',
      closed === null, `${closed?.code}: ${closed?.message}`);

    const day = await attendanceForDay(me, worker.empId, DAY);
    ok('16. it closed the day it was opened on',
      Boolean(day?.outT) && day?.missingPunchOut === false,
      `out=${day?.outT} missing=${day?.missingPunchOut}`);
    ok('    and the row still reads in the zone it was measured in',
      day?.inT === '10:00' && day?.outT === '18:30', `${day?.inT} → ${day?.outT}`);

    /*
     * 510 minutes between the punches, less the India shift's 60-minute break.
     * 480 would mean the night shift's 30 was deducted — the number the move
     * would have produced, and plausible enough to go unnoticed.
     */
    ok('17. and the break deducted was the day\'s own, not the new shift\'s',
      day?.mins === 450, `${day?.mins} — 480 would mean the night shift's 30`);

    /* ---------------------------------------------------------------- *
     * A stale open day does not swallow a later punch out
     * ---------------------------------------------------------------- */

    console.log('\nand a day nobody closed stays its own day\n');

    const forgetful = await createUser(A, draft({ shiftCode: 'IN' }));
    const them = {
      role: 'employee', hasReports: false, tenantId: ctx.tenant,
      employeeId: forgetful.empId, userId: null,
    };

    await punchIn(them, forgetful.empId, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: STALE_IN_AT,
    });
    await punchIn(them, forgetful.empId, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: IN_AT,
    });
    await punchOut(them, forgetful.empId, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: OUT_AT,
    });

    /*
     * The open-day lookup is bounded by the row's own window, which is why
     * this works: a week-old open row cannot contain today's instant. Without
     * that bound the punch out would have closed the 13th and recorded a
     * 190-hour shift — a number that would have reached payroll.
     */
    const closedDay = await attendanceForDay(them, forgetful.empId, DAY);
    ok('18. the later punch out closed the later day',
      Boolean(closedDay?.outT) && closedDay?.mins === 450,
      `out=${closedDay?.outT} mins=${closedDay?.mins}`);

    const staleDay = await attendanceForDay(them, forgetful.empId, STALE);
    ok('19. and the forgotten one is still open, not closed by it',
      Boolean(staleDay?.inT) && !staleDay?.outT && staleDay?.missingPunchOut === true,
      `in=${staleDay?.inT} out=${staleDay?.outT} missing=${staleDay?.missingPunchOut}`);
    ok('    and is still the only day reported unclosed',
      (await unclosedDays(them)).map((u) => u.date).join(',') === STALE,
      JSON.stringify((await unclosedDays(them)).map((u) => u.date)));
  });
} catch (e) {
  fatal = e;
  failed += 1;
  console.log(`\n  FAIL  the suite did not finish: ${e?.message ?? e}`);
  if (e?.stack) console.log(e.stack.split('\n').slice(1, 5).join('\n'));
} finally {
  await admin.end();
  await closePool();
}

console.log(`\n${failed
  ? `${failed} FAILED`
  : 'the hours somebody works are chosen once, by one writer, and a day closes on its own'}\n`);
process.exit(failed ? 1 : 0);
