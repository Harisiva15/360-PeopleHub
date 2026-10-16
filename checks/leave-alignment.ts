/**
 * Approved leave shows as its own answer, beside expected and actual.
 *
 * Phase 2h-H gave the screens two channels and left an approved leave day reading
 * "Working / No attendance". This is the phase that adds the third, and the thing
 * worth ratcheting is that it stays a *third* — not a replacement for the
 * expectation, not a substitute for a record, and not a quiet route to `L`.
 *
 * What these assertions hold:
 *
 *   1. Only **approved** leave participates. Pending, rejected and cancelled are
 *      filtered in the model, not merely left out of the query — so a caller who
 *      forgets the status cannot leak a pending request onto a calendar.
 *   2. The schedule still decides the expectation. A Saturday or a holiday covered
 *      by leave keeps its own classification.
 *   3. A record still wins the actual channel, and a missing one still reads
 *      "No attendance" — never Absent, and never `L`.
 *   4. The three reads are range reads, and the day count a leave covers never
 *      includes days the schedule does not work.
 *
 * Behaviour is asserted against the model and the mock services wherever it can
 * be; the source reads are for absences, with comments stripped first.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mockServices as s } from '../src/services/mock';
import { ACTIVE } from '../src/data/employees';
import {
  actualLabel, awaitingRecord, composeDays, expectedLabel, leaveByEmployee,
  leaveLabel, leaveOn, NO_ATTENDANCE, recordedDuringLeave, type AttendanceDay,
} from '../src/modules/attendance/day';
import type { AttRecord, AttStatus, DayVerdict, LeaveRequest } from '../src/services';

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

const grid = code('src/modules/dashboard/shared.tsx');
const attUi = code('src/modules/attendance/index.tsx');
const rosterUi = code('src/modules/shifts/Roster.tsx');
const dayModel = code('src/modules/attendance/day.ts');

/* 2026-11-02 Monday, 2026-11-07 Saturday, 2026-11-08 Sunday. */
const MON = '2026-11-02';
const TUE = '2026-11-03';
const SAT = '2026-11-07';

const verdict = (date: string, reason: DayVerdict['reason'], over: Partial<DayVerdict> = {})
: DayVerdict => ({
  date, reason, workingDay: reason === 'WORKING', holiday: null,
  schedule: 'ZZMF', shift: 'IN', ...over,
});
const record = (date: string, status: AttStatus): AttRecord => ({
  id: `a-${date}`, empId: 'E1', date, status, inT: '09:02', outT: '18:04', mins: 480,
  site: 'CHN', lat: null, lng: null, dist: null, geoOk: null, src: 'web',
  late: false, reg: null, notes: '',
});
const req = (from: string, to: string, status: LeaveRequest['status'],
  over: Partial<LeaveRequest> = {}): LeaveRequest => ({
  id: `l-${from}-${status}`, empId: 'E1', type: 'CL', from, to, days: 1,
  half: null, reason: 'ZZ', status, approverId: null, appliedOn: from,
  actedOn: from, note: '', ...over,
});

const day = (v: DayVerdict | null, r: AttRecord | null, lv: LeaveRequest[] = [])
: AttendanceDay =>
  composeDays([v?.date ?? r?.date ?? MON], v ? [v] : [], r ? [r] : [], lv)[0]!;

/* ------------------------------------------------------------------ *
 * §23 21-22. Only approved participates
 * ------------------------------------------------------------------ */

console.log('\nonly approved leave is shown as leave\n');

const approved = day(verdict(MON, 'WORKING'), null, [req(MON, MON, 'Approved')]);
ok('1. approved leave appears as its own channel',
  approved.leave !== null && leaveLabel(approved) === 'Approved — CL',
  String(leaveLabel(approved)));
ok('    beside the expectation, which is unchanged',
  expectedLabel(approved) === 'Working');
ok('    and beside the actual, which is still nothing',
  actualLabel(approved) === NO_ATTENDANCE);
ok('2. and specifically not Absent',
  actualLabel(approved) !== 'Absent',
  'approved leave explains the gap; it does not become a verdict about them');

for (const bad of ['Pending', 'Rejected', 'Cancelled'] as LeaveRequest['status'][]) {
  const d = day(verdict(MON, 'WORKING'), null, [req(MON, MON, bad)]);
  ok(`3. ${bad.toLowerCase()} leave does not appear as leave`,
    d.leave === null && leaveLabel(d) === null, String(leaveLabel(d)));
}
ok('    filtered in the model, not only in the query',
  /r\.status === 'Approved'/.test(dayModel),
  'a caller who forgets the status filter still cannot leak a pending request');
ok('4. and a mixed list picks only the approved one',
  day(verdict(MON, 'WORKING'), null, [
    req(MON, MON, 'Pending'), req(MON, MON, 'Cancelled'), req(MON, MON, 'Approved'),
  ]).leave?.status === 'Approved');

/* ------------------------------------------------------------------ *
 * §23 23-26. The other two channels are untouched
 * ------------------------------------------------------------------ */

console.log('\nthe other two answers are not overwritten\n');

const withL = day(verdict(MON, 'WORKING'), record(MON, 'L'), [req(MON, MON, 'Approved')]);
ok('5. approved leave with an L record shows all three',
  expectedLabel(withL) === 'Working' && leaveLabel(withL) === 'Approved — CL'
  && actualLabel(withL) === 'Leave');
ok('    and that is not flagged as a conflict',
  recordedDuringLeave(withL) === false,
  'an L on a leave day is the two agreeing');

const withP = day(verdict(MON, 'WORKING'), record(MON, 'P'), [req(MON, MON, 'Approved')]);
ok('6. approved leave with a P record shows all three too',
  expectedLabel(withP) === 'Working' && leaveLabel(withP) === 'Approved — CL'
  && actualLabel(withP) === 'Present');
ok('    flagged neutrally, and not resolved',
  recordedDuringLeave(withP) === true,
  'which of the two is wrong is not a read\'s decision');
ok('    with the neutral wording the phase asked for',
  /attendance recorded during approved leave/.test(grid)
  && /Attendance recorded during approved leave/.test(attUi),
  'no "unauthorised", no "conflict", no verdict');

const offWithLeave = day(verdict(SAT, 'WEEKLY_OFF'), null, [req(MON, SAT, 'Approved')]);
ok('7. a week off inside a leave span is still a week off',
  expectedLabel(offWithLeave) === 'Week off' && offWithLeave.leave !== null,
  `${expectedLabel(offWithLeave)}`);
ok('    the expectation was not promoted to Working',
  offWithLeave.expected?.workingDay === false,
  'the schedule decides expected; a request does not rewrite it');

const holWithLeave = day(
  verdict(MON, 'HOLIDAY', { holiday: 'ZZ Diwali' }), null, [req(MON, MON, 'Approved')]);
ok('8. a holiday inside a leave span is still that holiday, named',
  expectedLabel(holWithLeave) === 'Holiday — ZZ Diwali' && holWithLeave.leave !== null);

/* ------------------------------------------------------------------ *
 * §23 24. Awaiting-a-record excludes leave
 * ------------------------------------------------------------------ */

console.log('\nleave explains a gap rather than becoming one\n');

ok('9. a working day with no record and no leave awaits a record',
  awaitingRecord(day(verdict(MON, 'WORKING'), null)) === true);
ok('10. the same day covered by approved leave does not',
  awaitingRecord(approved) === false,
  'counting leave days as awaiting is how that figure gets mistaken for absences');
ok('    and a pending request does not excuse it either',
  awaitingRecord(day(verdict(MON, 'WORKING'), null, [req(MON, MON, 'Pending')])) === true,
  'pending is not permission to be away');

/* ------------------------------------------------------------------ *
 * §23 27. Half day
 * ------------------------------------------------------------------ */

console.log('\nhalf days keep the representation the schema has\n');

const half = day(verdict(MON, 'WORKING'), record(MON, 'P'),
  [req(MON, MON, 'Approved', { half: 'First Half', days: 0.5 })]);
ok('11. a half day names which half',
  leaveLabel(half) === 'Approved — CL — First Half', String(leaveLabel(half)));
ok('    taken from the stored value, not computed as a fraction here',
  /day\.leave\.half/.test(dayModel) && !/0\.5/.test(dayModel),
  'the days figure carries the fraction and is the leave service\'s to derive');
ok('12. and the whole day is not reclassified as Leave',
  actualLabel(half) === 'Present' && expectedLabel(half) === 'Working',
  'a half day worked is half worked — the record says what it says');

/* ------------------------------------------------------------------ *
 * Multi-day, resolved date by date
 * ------------------------------------------------------------------ */

const spanDays = composeDays(
  [MON, TUE, SAT],
  [verdict(MON, 'WORKING'), verdict(TUE, 'WORKING'), verdict(SAT, 'WEEKLY_OFF')],
  [],
  [req(MON, SAT, 'Approved')]);
ok('13. one multi-day request covers each date it spans',
  spanDays.every((d) => d.leave !== null));
ok('    while each date keeps its own expectation',
  spanDays.map((d) => d.expected!.reason).join(',') === 'WORKING,WORKING,WEEKLY_OFF');
ok('14. and bounds are inclusive at both ends',
  leaveOn([req(MON, SAT, 'Approved')], MON) !== null
  && leaveOn([req(MON, SAT, 'Approved')], SAT) !== null
  && leaveOn([req(TUE, SAT, 'Approved')], MON) === null);

/* ------------------------------------------------------------------ *
 * §23 30. The screens explain the three channels
 * ------------------------------------------------------------------ */

console.log('\nthe screens name all three, in words\n');

ok('15. the month grid composes with leave',
  /composeDays\(dates, calendar, records, leave\)/.test(grid));
ok('    and names it in the tooltip',
  /Leave: \$\{onLeave\}/.test(grid), 'alongside Expected: and Actual:');
ok('16. the grid marks a leave day without relying on the mark alone',
  /day-lv/.test(grid) && /Leave: /.test(grid),
  'a corner dot plus the word in the label');
ok('    with its own stylesheet rule',
  /\.cal \.day \.day-lv/.test(read('src/styles/global.css')));
ok('17. and a legend entry explaining it',
  /Approved leave/.test(grid) && /corner mark/.test(grid));

ok('18. the rota reads leave in one range call',
  /useApprovedLeave\(/.test(rosterUi) && /leaveByEmployee\(/.test(rosterUi),
  'not one per person, and not one per cell');
ok('19. its cells name leave beside the expectation',
  /rost-lv/.test(rosterUi) && /Leave: Approved/.test(rosterUi));
ok('20. and the CSV uses the field names the phase asked for',
  /leave status/.test(rosterUi) && /leave type/.test(rosterUi),
  'clear rather than ambiguous');
ok('21. the rota still never labels a missing record absent',
  !/'Absent'/.test(rosterUi) && !/Absent/.test(rosterUi.replace(/ACTUAL_LABEL/g, '')));

ok('22. the employee view shows their own three answers',
  /useApprovedLeave\(\[me\.id\]/.test(attUi) && /leaveLabel\(todayDay\)/.test(attUi));
ok('    and counts leave days off the expected channel',
  /d\.expected\?\.reason === 'WORKING'/.test(attUi),
  'so a weekend inside a leave span is not counted as a leave day');

/* ------------------------------------------------------------------ *
 * §23 28-29. Scope, and nothing written
 * ------------------------------------------------------------------ */

console.log('\nvisibility and writes are unchanged\n');

ok('23. the employee view asks only for their own leave',
  /useApprovedLeave\(\[me\.id\]/.test(attUi) && !/useApprovedLeave\(ids/.test(attUi),
  'the rota is where a team read belongs, and it is scoped by the service');
ok('24. the rota asks for the ids it was already allowed to show',
  /useApprovedLeave\(ids,/.test(rosterUi),
  'the same id set the roster and attendance reads use');
ok('25. no display path writes leave',
  !/\.leave\.(apply|approve|reject|cancel)\(/.test(grid + rosterUi)
  && !/\.leave\.(approve|reject|cancel)\(/.test(attUi),
  'reading three answers mutates none of them');
ok('26. nor attendance',
  !/punchIn|punchOut|raiseRegularisation/.test(grid + rosterUi));
ok('27. and the model persists nothing',
  !/INSERT|UPDATE|DELETE/i.test(dayModel));

const emp = ACTIVE()[0]!.id;
const beforeLeave = (await s.leave.list({})).length;
const beforeAtt = (await s.attendance.list({})).length;
await s.leave.list({ empIds: [emp], from: MON, to: SAT, status: 'Approved' });
await s.calendar.workingDays(emp, MON, SAT);
await s.attendance.list({ empIds: [emp], from: MON, to: SAT });
ok('28. three reads create no leave request',
  (await s.leave.list({})).length === beforeLeave,
  `${beforeLeave} → ${(await s.leave.list({})).length}`);
ok('29. and no attendance row',
  (await s.attendance.list({})).length === beforeAtt);

/* ------------------------------------------------------------------ *
 * The demo honours the range and the status
 * ------------------------------------------------------------------ */

console.log('\nthe demo filters as the service does\n');

const all = await s.leave.list({ empIds: [emp] });
const windowed = await s.leave.list({ empIds: [emp], from: '2026-11-01', to: '2026-11-30' });
ok('30. a span narrows the demo result',
  windowed.length <= all.length
  && windowed.every((r) => r.to >= '2026-11-01' && r.from <= '2026-11-30'),
  `${all.length} → ${windowed.length}`);
ok('31. matched on overlap, not containment',
  /l\.to >= q\.from/.test(code('src/services/mock/leave.ts'))
  && /l\.from <= q\.to/.test(code('src/services/mock/leave.ts')),
  'a leave that began before the window must still appear in it');
ok('32. and an approved-only request returns only approved',
  (await s.leave.list({ status: 'Approved' })).every((r) => r.status === 'Approved'));
ok('33. the demo has approved leave to show',
  (await s.leave.list({ status: 'Approved' })).length > 0,
  'otherwise none of the above proves anything about the demo');

const grouped = leaveByEmployee(await s.leave.list({ status: 'Approved' }));
ok('34. leave groups by employee from one read',
  [...grouped.values()].every((list) => list.length > 0)
  && [...grouped.entries()].every(([id, list]) => list.every((r) => r.empId === id)));

/* ------------------------------------------------------------------ *
 * The dashboard caller, which Phase 2h-I left passing no leave
 * ------------------------------------------------------------------ */

console.log('\nthe dashboard month calendar gets the leave channel too\n');

const dashUi = code('src/modules/dashboard/index.tsx');

ok('35. the dashboard reads approved leave for the month',
  /useApprovedLeave\(\[me\.id\], mk \+ '-01', mk \+ '-31'\)/.test(dashUi),
  'the shared component had the channel; this caller passed nothing into it');
ok('36. and passes it to the shared calendar',
  /leave=\{monthLeave\}/.test(dashUi),
  'which is the whole of the fix');
ok('37. for their own id only',
  /useApprovedLeave\(\[me\.id\]/.test(dashUi) && !/useApprovedLeave\(ids/.test(dashUi),
  'a personal dashboard reads one person; the rota is where a team read belongs');
ok('38. over the month the rest of the calendar already uses',
  /useMonthCalendar\(me\.id, mk\)/.test(dashUi) && /mk \+ '-01', mk \+ '-31'/.test(dashUi),
  'the same span as the attendance and verdict reads beside it');

/*
 * One hook, not four. The status filter is the thing that must not drift between
 * callers: a copy that forgot `status: 'Approved'` would show pending requests as
 * leave somebody is entitled to take.
 */
const sharedHook = code('src/services/leave.ts');
ok('39. the hook lives in one shared module',
  /export const useApprovedLeave/.test(sharedHook)
  && /status: 'Approved'/.test(sharedHook));
ok('40. and every module re-exports it rather than redeclaring it',
  (['attendance', 'shifts', 'dashboard'] as const).every((m) =>
    /export \{ useApprovedLeave \} from '\.\.\/\.\.\/services\/leave'/
      .test(code(`src/modules/${m}/data.ts`))),
  (['attendance', 'shifts', 'dashboard'] as const)
    .filter((m) => !/export \{ useApprovedLeave \}/.test(code(`src/modules/${m}/data.ts`)))
    .join(',') || 'all three re-export');
ok('    so the status filter exists in exactly one place',
  (['attendance', 'shifts', 'dashboard'] as const).every((m) =>
    !/status: 'Approved'/.test(code(`src/modules/${m}/data.ts`))),
  'a fourth copy is a fourth chance to forget it');
ok('41. it reads through the existing contract, not a new endpoint',
  /s\.leave\.list\(/.test(sharedHook)
  && /from, to, status: 'Approved'/.test(sharedHook),
  'the listLeave range 2h-I added, reused');

/*
 * The behaviour the dashboard now shows, exercised through the same model the
 * component uses. Pending, rejected and cancelled are already covered above for
 * the attendance view; these repeat them against a dashboard-shaped month so the
 * fix cannot be green for the wrong reason.
 */
const monthDates = ['2026-11-02', '2026-11-03', '2026-11-07'];
const monthVerdicts = [
  verdict('2026-11-02', 'WORKING'), verdict('2026-11-03', 'WORKING'),
  verdict('2026-11-07', 'WEEKLY_OFF'),
];
const dashDays = (status: LeaveRequest['status']) =>
  composeDays(monthDates, monthVerdicts, [], [req('2026-11-02', '2026-11-03', status)]);

ok('42. approved leave appears on the dashboard month',
  dashDays('Approved').filter((d) => d.leave !== null).length === 2,
  String(dashDays('Approved').filter((d) => d.leave !== null).length));
for (const bad of ['Pending', 'Rejected', 'Cancelled'] as LeaveRequest['status'][]) {
  ok(`43. ${bad.toLowerCase()} leave does not`,
    dashDays(bad).every((d) => d.leave === null));
}
ok('44. and the week off in that month keeps its own expectation',
  dashDays('Approved')[2]!.expected!.reason === 'WEEKLY_OFF');
ok('45. while nothing on the dashboard path writes',
  !/\.leave\.(apply|approve|reject|cancel)\(/.test(dashUi)
  && !/punchIn|punchOut/.test(dashUi),
  'a dashboard is a read');

const dashBeforeLeave = (await s.leave.list({})).length;
const dashBeforeAtt = (await s.attendance.list({})).length;
const dashBeforeBal = JSON.stringify(await s.leave.balances(emp));
await s.leave.list({ empIds: [emp], from: '2026-11-01', to: '2026-11-30', status: 'Approved' });
ok('46. the dashboard-shaped read creates no leave request',
  (await s.leave.list({})).length === dashBeforeLeave);
ok('47. no attendance row',
  (await s.attendance.list({})).length === dashBeforeAtt);
ok('48. and leaves the balance untouched',
  JSON.stringify(await s.leave.balances(emp)) === dashBeforeBal,
  'reading leave does not consume it');

console.log();
if (failed) {
  console.error(`${failed} leave alignment check(s) failed`);
  process.exit(1);
}
console.log('expected, approved leave and what was recorded are three answers on screen');
