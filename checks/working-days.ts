/**
 * The browser no longer decides how many days of leave a request is.
 *
 * `src/modules/leave/index.tsx` counted them — `if (isWeekend(d) ||
 * HOLIDAY_MAP[ymd(d)]) excluded++` — and sent the number, which `applyForLeave`
 * stored after checking only that it was positive. Two dates and a tampered body
 * could claim a hundred days, and approval would debit a hundred from the balance.
 *
 * `HOLIDAY_MAP` was a 2026 Tamil Nadu calendar compiled into the bundle, while the
 * `holiday` table — the only thing a tenant can actually edit — took no part in it.
 * The same pair also filled the attendance calendar's empty days, so a configured
 * build showed week-offs and holidays no server data supported.
 *
 * Four assurances:
 *
 *   1. The leave form does not compute the count, does not send one, and the
 *      contract has nowhere to put one.
 *   2. Neither the leave screen nor the dashboard calendar reads `isWeekend` or
 *      `HOLIDAY_MAP` any more. The shared date helpers survive for presentation,
 *      because other features legitimately use them.
 *   3. The demo derives the count the same way the server does, so demo mode cannot
 *      store a figure production would refuse.
 *   4. Nothing materialises an attendance row. A day with no record reads as no
 *      record rather than as a fabricated week off.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { leaveService } from '../src/services/mock/leave';
import { calendarService, classifyDemoDays, demoWorkingDays } from '../src/services/mock/calendar';
import { scheduleService } from '../src/services/mock/schedules';
import { ACTIVE } from '../src/data/employees';
import { HOLIDAY_MAP } from '../src/data/org';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/** Comments describe intent; they are not evidence of it. */
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const refused = async (f: () => Promise<unknown>): Promise<string | null> => {
  try { await f(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

const leaveUi = code('src/modules/leave/index.tsx');
const dash = code('src/modules/dashboard/shared.tsx');
const contracts = code('src/services/contracts.ts');
const http = code('src/services/http/index.ts');
const server = code('server/src/modules/leave/service.ts');
const resolver = code('server/src/modules/calendar/service.ts');

/*
 * A real demo employee. The calendar is per person now — migration 0054 puts
 * everybody on DEFAULT_MF and the demo mirrors that — so a count needs somebody
 * to count for.
 */
const EMP = ACTIVE()[0]!.id;

/* Fixed dates: 2026-10-05 is a Monday, 2026-10-11 a Sunday. */
const MON = '2026-10-05';
const FRI = '2026-10-09';
const SAT = '2026-10-10';
const SUN = '2026-10-11';
const NEXT_MON = '2026-10-12';

/* ------------------------------------------------------------------ *
 * 1. the client no longer counts, and cannot send a count
 * ------------------------------------------------------------------ */

console.log('\nthe browser does not decide the day count\n');

ok('the leave form does not compute days from a weekend rule',
  !/isWeekend/.test(leaveUi), 'this is how the wrong number got stored');
ok('nor from a holiday list in the bundle', !/HOLIDAY_MAP/.test(leaveUi));
ok('it reads the count from the service instead', /useWorkingDays\(/.test(leaveUi));
ok('  and derives the shown figure from those verdicts',
  /span\.filter\(\(d: DayVerdict\) => d\.workingDay\)\.length/.test(leaveUi));
ok('the submit body carries no days field',
  !/applyLeave\.mutate\(\{[\s\S]{0,160}days[,:]/.test(leaveUi),
  'the server derives it; sending one would imply otherwise');
ok('ApplyLeave has no days field at all',
  !/days/.test(contracts.slice(contracts.indexOf('export interface ApplyLeave'),
    contracts.indexOf('}', contracts.indexOf('export interface ApplyLeave')))),
  'the contract is where a client would look for permission to send one');
ok('and the http binding does not send one',
  !/endsOn: req\.to, days:/.test(http), http.split('\n').find((l) => l.includes('endsOn: req.to')));

ok('the server ignores a days field if an older client sends one',
  /days\?: number;/.test(server) && !/input\.days/.test(server),
  'kept in the shape so an old body still parses, never read');
ok('and derives the count from the resolver in its own transaction',
  /classifyRange\(db, input\.employeeId, input\.startsOn, input\.endsOn\)/.test(server));
ok('  storing that figure, not the caller\'s',
  /const days = half !== null \? 0\.5 : working\.length;/.test(server));

/* ------------------------------------------------------------------ *
 * 2. the resolver decides the weekday in SQL, not in JavaScript
 * ------------------------------------------------------------------ */

console.log('\nthe weekday is decided as a calendar date\n');

ok('the resolver uses ISODOW over generate_series',
  /EXTRACT\(ISODOW FROM/.test(resolver) && /generate_series/.test(resolver),
  'new Date(ymd).getDay() reports the weekday in whatever zone the runtime is in');
ok('it never calls getDay or getUTCDay',
  !/getDay\(\)/.test(resolver) && !/getUTCDay\(\)/.test(resolver));
ok('it reads only non-optional holidays',
  /h\.optional = false/.test(resolver),
  'an optional holiday is a day an employee may take, not one the office closes');
ok('and site-specific ones only for that site',
  /h\.site_id IS NULL OR h\.site_id = who\.site_id/.test(resolver),
  '0002: null means the whole tenant, otherwise location-specific');
ok('the demo mirrors it without a Date-based weekday',
  !/getDay\(\)/.test(code('src/services/mock/calendar.ts')));

/* ------------------------------------------------------------------ *
 * 3. the dashboard calendar stops inventing days
 * ------------------------------------------------------------------ */

console.log('\nthe attendance calendar shows what the server says, or nothing\n');

ok('MonthCalendar does not read the bundled holiday list',
  !/HOLIDAY_MAP/.test(dash));
ok('nor a hard-coded weekend', !/isWeekend/.test(dash));
ok('it takes the server verdicts as a prop', /calendar\?: DayVerdict\[\]/.test(dash));
ok('an attendance row still wins over the calendar',
  /const st = r \? r\.status/.test(dash),
  'what happened beats what was expected');
ok('and with no verdict the cell says nothing',
  /: v && !v\.workingDay \? 'O' : '';/.test(dash),
  'a blank day reads as no record, not as a fabricated week off');
ok('both callers pass the verdicts',
  /calendar=\{monthCal\}/.test(code('src/modules/attendance/index.tsx'))
  && /calendar=\{monthCal\}/.test(code('src/modules/dashboard/index.tsx')));

ok('nothing writes an attendance status anywhere in this change',
  !/status: 'O'/.test(dash) && !/status: 'H'/.test(dash) && !/status: 'A'/.test(dash),
  'materialising expected days belongs to a later phase');

/* ------------------------------------------------------------------ *
 * 4. the demo agrees with the server
 * ------------------------------------------------------------------ */

console.log('\nthe demo counts the same days\n');

const verdicts = await calendarService.workingDays('any', MON, SUN);
ok('a week comes back day by day', verdicts.length === 7, String(verdicts.length));
ok('Monday is working', verdicts[0]!.workingDay === true && verdicts[0]!.reason === 'WORKING');
ok('Saturday is not', verdicts[5]!.workingDay === false
  && verdicts[5]!.reason === 'WEEKLY_OFF');
ok('Sunday is not', verdicts[6]!.workingDay === false);

ok('Monday to Friday is five', demoWorkingDays(EMP, MON, FRI) === 5,
  String(demoWorkingDays(EMP, MON, FRI)));
ok('Saturday to Sunday is none', demoWorkingDays(EMP, SAT, SUN) === 0);
ok('Friday to Monday is two', demoWorkingDays(EMP, FRI, NEXT_MON) === 2);
ok('Monday to the next Monday is six', demoWorkingDays(EMP, MON, NEXT_MON) === 6);
ok('a reversed range is empty', classifyDemoDays(EMP, FRI, MON).length === 0);

/* A mandatory holiday from the demo's own list drops out; an optional one does not. */
const fixed = Object.keys(HOLIDAY_MAP)[0]!;
ok('a mandatory demo holiday is non-working',
  classifyDemoDays(EMP, fixed, fixed)[0]!.workingDay === false
  || classifyDemoDays(EMP, fixed, fixed)[0]!.reason === 'WEEKLY_OFF',
  `${fixed} → ${JSON.stringify(classifyDemoDays(EMP, fixed, fixed)[0])}`);
ok('  and HOLIDAY_MAP still holds only the mandatory ones',
  !Object.keys(HOLIDAY_MAP).includes('2026-01-15'),
  'Thiruvalluvar Day is optional, so it is a working day');

console.log('\nthe demo stores the count it derives\n');

const demoReq = await leaveService.apply({
  empId: 'E001', type: 'CL', from: MON, to: FRI, reason: 'ZZ check', half: null,
});
ok('a Monday-to-Friday request stores five', demoReq.days === 5, String(demoReq.days));
ok('a half day stores 0.5', (await leaveService.apply({
  empId: 'E001', type: 'CL', from: MON, to: MON, reason: 'ZZ half', half: 'First Half',
})).days === 0.5);
ok('half of a range is refused',
  (await refused(() => leaveService.apply({
    empId: 'E001', type: 'CL', from: MON, to: FRI, reason: 'ZZ bad', half: 'First Half',
  })))?.includes('a half day is a single day') === true);
ok('a weekend-only request is refused',
  (await refused(() => leaveService.apply({
    empId: 'E001', type: 'CL', from: SAT, to: SUN, reason: 'ZZ weekend', half: null,
  })))?.includes('no leave to take') === true);

/* ------------------------------------------------------------------ *
 * 5. the demo reads schedules, as production now does
 * ------------------------------------------------------------------ */

console.log('\nthe demo answers from the pattern, not a hard-coded week\n');

const mockCal = code('src/services/mock/calendar.ts');
ok('the demo calendar reads the demo assignments',
  /ASSIGNMENTS/.test(mockCal) && /SCHEDULES/.test(mockCal),
  'production resolves a schedule; a hard-coded week here would disagree with it');
ok('  resolving the one covering each date',
  /a\.validFrom <= date && \(a\.validTo === null \|\| date <= a\.validTo\)/.test(mockCal),
  'inclusive valid_to, and per date rather than the current assignment');
ok('  and reporting which schedule decided it',
  /schedule: null/.test(mockCal) && /schedule,/.test(mockCal));

const before = demoWorkingDays(EMP, MON, SUN);
ok('on the default pattern the week holds five working days', before === 5, String(before));

await scheduleService.createWorkSchedule({
  code: 'ZZCHK', name: 'ZZ Check Six Day',
  days: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, working: dayOfWeek <= 6 })),
});
await scheduleService.assignEmployeeSchedule(EMP, {
  scheduleCode: 'ZZCHK', validFrom: NEXT_MON,
});

ok('assigning a six-day pattern from the next Monday changes that week',
  demoWorkingDays(EMP, NEXT_MON, '2026-10-18') === 6,
  String(demoWorkingDays(EMP, NEXT_MON, '2026-10-18')));
ok('  and leaves the earlier week alone',
  demoWorkingDays(EMP, MON, SUN) === before,
  'the assignment is effective-dated, so history does not move');
ok('  with each week naming its own schedule',
  classifyDemoDays(EMP, MON, MON)[0]!.schedule === 'DEFAULT_MF'
  && classifyDemoDays(EMP, NEXT_MON, NEXT_MON)[0]!.schedule === 'ZZCHK',
  `${classifyDemoDays(EMP, MON, MON)[0]!.schedule} / ${classifyDemoDays(EMP, NEXT_MON, NEXT_MON)[0]!.schedule}`);
ok('a leave request now counts the Saturday it did not before',
  (await leaveService.apply({
    empId: EMP, type: 'CL', from: NEXT_MON, to: '2026-10-17', reason: 'ZZ six', half: null,
  })).days === 6,
  'the count follows the schedule, which is the whole point of the phase');

ok('an employee nobody assigned falls back, and says so',
  classifyDemoDays('nobody-at-all', MON, SUN).filter((d) => d.workingDay).length === 5
  && classifyDemoDays('nobody-at-all', MON, MON)[0]!.schedule === null,
  'the fallback is the Monday-to-Friday rule, reported as schedule: null');

console.log();
if (failed) {
  console.error(`${failed} working-day checks failed`);
  process.exit(1);
}
console.log('the server decides how many days a leave request is, and the screens read it');
