/**
 * The work schedule screens, the employee assignment, and the rota that reads them.
 *
 * Phase 2h-F is the phase where the schedule tables got a user. Three things are
 * worth a ratchet, and the rest of this file is in service of them:
 *
 *   1. **The rota no longer decides which days are worked.** It called Saturday
 *      and Sunday off for everybody, in the server from a weekday test and in the
 *      demo from `isWeekend`. Both are gone, and the assertions below fail if
 *      either comes back.
 *   2. **"Not assigned" stays visible.** Phase 2h-E deliberately does not default
 *      an unassigned employee onto `DEFAULT_MF`; it answers from a constant rule
 *      and reports `schedule: null`. A screen that printed DEFAULT_MF there would
 *      hide the one distinction that phase was careful to keep, so the assignment
 *      card is checked for the words rather than the behaviour.
 *   3. **The rota shows what is expected and writes nothing.** No attendance row,
 *      no invented absence. A working day with no attendance is a working day with
 *      no attendance.
 *
 * Behaviour is asserted against the mock services wherever it can be, because
 * calling them is evidence and reading source is not. The source reads that remain
 * are for absences — "this file does not compute a weekend" — which is the one
 * claim no behavioural test can make, and each strips comments first so the prose
 * above a rule cannot satisfy an assertion about the rule.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ACTIVE } from '../src/data/employees';
import { mockServices as s } from '../src/services/mock';
import { classifyDemoDays } from '../src/services/mock/calendar';
import { WEEKDAYS, draftOf, monToFriDraft } from '../src/modules/shifts/weekdays';
import { EXPECTED_LEGEND, lookOf, scheduleOver, standingShift } from '../src/modules/shifts/expected';

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

const schedUi = code('src/modules/shifts/Schedules.tsx');
const formUi = code('src/modules/shifts/ScheduleForm.tsx');
const empUi = code('src/modules/lifecycle/Schedule.tsx');
const rosterUi = code('src/modules/shifts/Roster.tsx');
const shiftsUi = code('src/modules/shifts/index.tsx');
const mockRoster = code('src/services/mock/misc.ts');
const serverRoster = code('server/src/modules/shifts/service.ts');

/* 2026-10-05 is a Monday, 2026-10-10 a Saturday, 2026-10-11 a Sunday. */
const MON = '2026-10-05';
const SAT = '2026-10-10';
const SUN = '2026-10-11';
const NEXT_SUN = '2026-10-11';

const EMP = ACTIVE()[0]!.id;
const OTHER = ACTIVE()[1]!.id;

/* ------------------------------------------------------------------ *
 * Work schedule screen — §26 1-9
 * ------------------------------------------------------------------ */

console.log('\nthe patterns screen lists what the service returns\n');

const patterns = await s.schedules.workSchedules();
ok('1. the list renders from the service', patterns.length > 0, String(patterns.length));
ok('    with a code, a name and a state on every row',
  patterns.every((p) => p.code && p.name && typeof p.active === 'boolean'));
ok('2. and the weekday pattern comes with the list',
  patterns.every((p) => p.days.length === 7),
  'a list that returned no days would need one request per row to show the pattern');
ok('    so the screen never reads a pattern one at a time',
  !/\.schedules\.workSchedule\(/.test(schedUi),
  'that is the N+1 the list was widened to avoid');
ok('3. the screen reads the list, the shifts and nothing else for its rows',
  /useWorkSchedules\(\)/.test(schedUi) && /useShiftProfiles\(\)/.test(schedUi));

ok('4. seven weekdays are defined Monday first',
  WEEKDAYS.length === 7 && WEEKDAYS[0]!.dow === 1 && WEEKDAYS[0]!.name === 'Monday'
  && WEEKDAYS[6]!.dow === 7 && WEEKDAYS[6]!.name === 'Sunday',
  WEEKDAYS.map((w) => w.name).join(','));
ok('    and the form renders a row per weekday, keyed by it',
  /WEEKDAYS\.map\(/.test(formUi) && /key=\{w\.dow\}/.test(formUi),
  'the row is the weekday, so a duplicate weekday cannot be produced');
ok('5. a default draft is Monday to Friday, all seven rows present',
  monToFriDraft().length === 7
  && monToFriDraft().filter((d) => d.working).map((d) => d.dayOfWeek).join(',') === '1,2,3,4,5',
  JSON.stringify(monToFriDraft().map((d) => [d.dayOfWeek, d.working])));

ok('6. working/off is a labelled control per day',
  /aria-label=\{`Is \$\{w\.name\} worked\?`\}/.test(formUi));
ok('    and the shift selector is labelled per day',
  /aria-label=\{`Shift on \$\{w\.name\}`\}/.test(formUi));
ok('7. the shift selector is disabled on a day nobody works',
  /disabled=\{!row\.working\}/.test(formUi),
  'a day off carries no shift — the schema refuses one');
ok('    and turning a day off clears its shift',
  /shiftCode: working \? row\.shiftCode : null/.test(formUi),
  'so the refusal is unreachable rather than merely reported');
ok('8. only shifts the service would accept are offered',
  /profiles\.filter\(\(p\) => p\.active \|\| named\.has\(p\.code\)\)/.test(formUi),
  'active ones, plus an inactive one this pattern already names');
ok('    and the shift list comes from the existing shift service',
  /useShiftProfiles/.test(schedUi) && !/SHIFTS/.test(schedUi),
  'no second shift-definition UI');

console.log('\nand the writes go to the service, which decides\n');

ok('9. create, update, weekday and active all call their own method',
  /\.schedules\.createWorkSchedule\(/.test(code('src/modules/shifts/data.ts'))
  && /\.schedules\.updateWorkSchedule\(/.test(code('src/modules/shifts/data.ts'))
  && /\.schedules\.setWorkScheduleDay\(/.test(code('src/modules/shifts/data.ts'))
  && /\.schedules\.setWorkScheduleActive\(/.test(code('src/modules/shifts/data.ts')));
ok('    the screen calls create for a new pattern',
  /create\.mutate\(\{/.test(schedUi));
ok('    update for the details, and setDay per changed weekday',
  /update\.mutate\(existing\.code/.test(schedUi) && /setDay\.mutate\(existing\.code, d\)/.test(schedUi),
  'the service refuses days sent to update, so they go one at a time');
ok('    only the weekdays that actually changed',
  /if \(was\.working === d\.working &&/.test(schedUi),
  'an unchanged pattern costs one request, not eight');
ok('    and setActive for withdraw/reinstate',
  /setActive\.mutate\(s\.code, !s\.active\)/.test(schedUi));
ok('    with the service\'s own words on failure',
  (schedUi.match(/e instanceof Error \? e\.message/g) ?? []).length >= 2,
  'no raw database text, and no invented wording either');

const dup = await refused(() => s.schedules.createWorkSchedule({
  code: patterns[0]!.code, name: 'ZZ clash',
}));
ok('    a duplicate code is refused, in words a screen can show',
  dup !== null && /already a work schedule/.test(dup), String(dup));
ok('    and nothing in the message is a database error code',
  dup !== null && !/^23[0-9P]/.test(dup), String(dup));

console.log('\nwithdrawing preserves everything\n');

const withdrawn = await s.schedules.setWorkScheduleActive(patterns[0]!.code, false);
ok('10. a withdrawn pattern keeps its days', withdrawn.days.length === 7);
ok('    and is still listed',
  (await s.schedules.workSchedules()).some((p) => p.code === withdrawn.code));
ok('    shown as withdrawn rather than hidden',
  /Withdrawn<\/Badge>/.test(schedUi) && /showWithdrawn/.test(schedUi));
ok('    with no delete offered, because the service has none',
  !/deleteWorkSchedule/.test(schedUi) && !/>Delete</.test(schedUi)
  && !('deleteWorkSchedule' in s.schedules),
  'an assignment may still name it and history has to resolve');
await s.schedules.setWorkScheduleActive(patterns[0]!.code, true);

ok('    status is not communicated by colour alone',
  /In use<\/Badge>/.test(schedUi),
  'the badge carries the word, as the roster cells carry theirs');

/* ------------------------------------------------------------------ *
 * Employee schedule — §26 10-16
 * ------------------------------------------------------------------ */

console.log('\none person\'s pattern, and its history\n');

ok('11. the card reads the assignments through the service',
  /useEmployeeSchedules\(empId\)/.test(empUi)
  && /\.schedules\.employeeSchedules\(/.test(code('src/modules/lifecycle/data.ts')));
ok('    and shows the period applying today',
  /function currentOf/.test(empUi) && /r\.validFrom <= today/.test(empUi));
ok('12. history renders every period, ended ones included',
  /rows\.map\(\(r\) =>/.test(empUi) && /Ended<\/Badge>/.test(empUi));
ok('    marking which one applies today',
  /Applies today<\/Badge>/.test(empUi));

const history = await s.schedules.employeeSchedules(EMP);
ok('13. the service returns a history to render', history.length > 0, String(history.length));
ok('    each row naming its pattern and dates',
  history.every((r) => r.scheduleCode && r.validFrom));

console.log('\n"not assigned" is a real state, and says so\n');

ok('14. the card says Not assigned when nothing covers today',
  /Not assigned<\/span>/.test(empUi) || /Not assigned/.test(empUi));
ok('    and never substitutes DEFAULT_MF for it',
  !/DEFAULT_MF/.test(empUi),
  'Phase 2h-E does not default unassigned people; printing it here would hide that');
ok('    explaining the fallback instead',
  /falls back to Monday/.test(empUi),
  'an assumption, named as one');
ok('15. the roster helper returns null rather than a pattern name',
  scheduleOver({}, [MON]) === null && scheduleOver(undefined, [MON]) === null);
ok('    and the roster prints Not assigned for that',
  /Not assigned<\/span>/.test(rosterUi));

const unassigned = classifyDemoDays('nobody-at-all', MON, SUN);
ok('    which is what the service reports for somebody unassigned',
  unassigned.every((d) => d.schedule === null)
  && unassigned.filter((d) => d.workingDay).length === 5,
  'five working days from the constant rule, and no pattern claimed');

console.log('\neffective dating, stated inclusively\n');

ok('16. the assignment form sends the dates the service expects',
  /scheduleCode: code, validFrom: from, validTo: to \|\| null/.test(empUi));
ok('17. effective-to is described as inclusive, in words',
  /Inclusive/.test(empUi) && /applies <b>on<\/b> this date/.test(empUi),
  'an off-by-one in a reader\'s head costs as much as one in the code');
ok('    and the history column is headed Through, not Until',
  /<th>Through<\/th>/.test(empUi));
ok('    the ending dialog says it too',
  /still applies on this date/.test(empUi));

ok('18. the form blocks the one overlap it can see',
  /from < open\.validFrom/.test(empUi),
  'a start before the open period began');
ok('    and leaves the rest to the service',
  /e instanceof Error \? e\.message : 'Could not assign the pattern'/.test(empUi));

ok('20. the UI does not reimplement the same-day amend',
  !/amend/i.test(empUi),
  'the service amends the open period; the screen renders what came back');

console.log('\nan employee may read their pattern and not set it\n');

ok('21. the assign control is withheld from an employee',
  /app\.role === 'admin' \|\| app\.role === 'manager'/.test(empUi));
ok('    and from anybody looking at their own record',
  /mayAssign && !own/.test(empUi),
  'a manager does not assign their own pattern either');
ok('    with the reason shown rather than the control silently missing',
  /your own record/.test(empUi));
ok('22. the employee\'s own view is read-only and has no mutation',
  !/assignEmployeeSchedule/.test(shiftsUi) && !/setWorkSchedule/.test(shiftsUi),
  'the shifts module shows a pattern; it never sets one');
ok('    while still naming the pattern they are on',
  /My working pattern/.test(shiftsUi) && /scheduleOver/.test(shiftsUi));
ok('    and saying Not assigned where there is none',
  /sched \?\? 'Not assigned'/.test(shiftsUi));

/* ------------------------------------------------------------------ *
 * Roster — §26 17-25
 * ------------------------------------------------------------------ */

console.log('\nthe rota reads the authoritative verdicts\n');

const rota = await s.shifts.roster([EMP, OTHER], MON, 7);
ok('23. one call returns every person and every date',
  Object.keys(rota).length === 2
  && Object.keys(rota[EMP]!).length === 7,
  JSON.stringify(Object.keys(rota).map((k) => Object.keys(rota[k]!).length)));
ok('    each cell carrying an expectation, not a bare code',
  Object.values(rota[EMP]!).every((c) => typeof c === 'object' && 'expected' in c));

const week = rota[EMP]!;
ok('24. a five-day pattern works Monday and rests Saturday',
  week[MON]!.expected === 'WORKING' && week[SAT]!.expected === 'WEEKLY_OFF',
  `${week[MON]!.expected} / ${week[SAT]!.expected}`);
ok('    and Sunday', week[SUN]!.expected === 'WEEKLY_OFF');
ok('    decided by an assigned pattern, not by the fallback',
  week[MON]!.schedule === 'DEFAULT_MF', String(week[MON]!.schedule),
);

/* A six-day pattern, assigned through the service the screen uses. */
await s.schedules.createWorkSchedule({
  code: 'ZZUI6', name: 'ZZ UI Six Day',
  days: WEEKDAYS.map((w) => ({ dayOfWeek: w.dow, working: w.dow <= 6, shiftCode: null })),
});
await s.schedules.assignEmployeeSchedule(EMP, { scheduleCode: 'ZZUI6', validFrom: MON });
const six = (await s.shifts.roster([EMP], MON, 7))[EMP]!;
ok('25. a Monday-to-Saturday pattern shows Saturday as working',
  six[SAT]!.expected === 'WORKING', six[SAT]!.expected);
ok('    while Sunday stays off', six[SUN]!.expected === 'WEEKLY_OFF');
ok('    and the cell names the pattern that decided it',
  six[SAT]!.schedule === 'ZZUI6', String(six[SAT]!.schedule));
ok('    which is the thing the hard-coded weekend could never say',
  week[SAT]!.expected === 'WEEKLY_OFF' && six[SAT]!.expected === 'WORKING',
  'one date, two patterns, two answers');

/* And a Gulf week, to prove the weekend is not merely widened. */
await s.schedules.createWorkSchedule({
  code: 'ZZUIGULF', name: 'ZZ UI Sunday to Thursday',
  days: WEEKDAYS.map((w) => ({
    dayOfWeek: w.dow, working: w.dow <= 4 || w.dow === 7, shiftCode: null,
  })),
});
await s.schedules.assignEmployeeSchedule(OTHER, { scheduleCode: 'ZZUIGULF', validFrom: MON });
const gulf = (await s.shifts.roster([OTHER], MON, 7))[OTHER]!;
ok('26. a Sunday-to-Thursday pattern shows Sunday as working',
  gulf[NEXT_SUN]!.expected === 'WORKING', gulf[NEXT_SUN]!.expected);
ok('    and Friday and Saturday as off',
  gulf['2026-10-09']!.expected === 'WEEKLY_OFF' && gulf[SAT]!.expected === 'WEEKLY_OFF');

console.log('\nholidays and week offs follow the verdict, not the cell\n');

const holidayDate = Object.keys(
  (await import('../src/data/org')).HOLIDAY_MAP)[0]!;
const holWeek = classifyDemoDays(EMP, holidayDate, holidayDate);
ok('27. a holiday verdict is HOLIDAY or the week off it landed on',
  ['HOLIDAY', 'WEEKLY_OFF'].includes(holWeek[0]!.reason), holWeek[0]!.reason);
ok('    and the rota presents whichever the server said',
  /lookOf\(cell\)/.test(rosterUi) && !/HOLIDAY_MAP/.test(rosterUi),
  'the cell renders the verdict; it does not look a holiday up');
ok('28. every expected state has a word as well as a tint',
  EXPECTED_LEGEND.every((x) => x.look.label.length > 2),
  EXPECTED_LEGEND.map((x) => x.look.label).join(','));
ok('    including not-employed, kept distinct from a week off',
  lookOf({ expected: 'NOT_EMPLOYED', shift: null, schedule: null, holiday: null })!.label
    === 'Not employed'
  && lookOf({ expected: 'WEEKLY_OFF', shift: null, schedule: null, holiday: null })!.label
    === 'Week off');
ok('29. a cell the server did not answer is not guessed at',
  lookOf(undefined) === null && /if \(!look\)/.test(rosterUi),
  'blank reads as no answer; an invented day off is what somebody plans around');

console.log('\nno local weekend calculation is left in the rota\n');

ok('30. the roster screen computes no weekend',
  !/isWeekend/.test(rosterUi) && !/getUTCDay/.test(rosterUi)
  && !/HOLIDAY_MAP/.test(rosterUi),
  'it reads verdicts; the only Date use left is formatting a column header');
ok('    nor does the personal four-week view',
  !/isWeekend/.test(shiftsUi) && !/getUTCDay/.test(shiftsUi)
  && !/HOLIDAY_MAP/.test(shiftsUi));
ok('31. the demo roster reads the demo calendar instead of a weekend test',
  /classifyDemoDays/.test(mockRoster) && !/isWeekend/.test(mockRoster),
  'the same function the demo calendar and demo leave count use');
ok('32. and the server roster reads the authoritative resolver',
  /classifyMany/.test(serverRoster) && !/getUTCDay/.test(serverRoster),
  'one statement for the whole team, and one answer in the product');
ok('    with no weekday arithmetic of its own',
  !/dow === 0 \|\| dow === 6/.test(serverRoster));

console.log('\nthe rota is expected, never actual, and writes nothing\n');

ok('33. no cell is labelled absent',
  !/'A'/.test(rosterUi) && !/Absent/.test(rosterUi),
  'a working day with no attendance row is not an absence');
ok('    and the roster writes no attendance status',
  !/status: 'O'/.test(rosterUi) && !/status: 'H'/.test(rosterUi)
  && !/status: 'A'/.test(rosterUi));
ok('34. the rota calls no attendance method at all',
  !/\.attendance\./.test(rosterUi) && !/\.attendance\./.test(schedUi)
  && !/\.attendance\./.test(empUi),
  'attendance integration is a later phase');
ok('    and the server roster writes nothing',
  !/INSERT INTO attendance/.test(serverRoster) && !/UPDATE attendance/.test(serverRoster));
ok('35. where attendance and expectation meet, attendance still wins',
  /const st = r \? r\.status/.test(code('src/modules/dashboard/shared.tsx')),
  'the month calendar prefers the record over the verdict, unchanged by this phase');
ok('    and the dashboard still consumes the authoritative verdicts',
  /calendar\?: DayVerdict\[\]/.test(code('src/modules/dashboard/shared.tsx')),
  'Phase 2h-E architecture kept, not replaced');

/* ------------------------------------------------------------------ *
 * Demo parity and navigation — §26 26-28, §21
 * ------------------------------------------------------------------ */

console.log('\nthe demo behaves as production does\n');

ok('36. assigning a pattern in the demo changes the counted days',
  six[SAT]!.expected === 'WORKING' && week[SAT]!.expected === 'WEEKLY_OFF',
  'the same assignment the screen makes, through the same service');
ok('37. and changes the demo leave count with it', await (async () => {
  const r = await s.leave.apply({
    empId: EMP, type: 'CL', from: '2026-10-09', to: '2026-10-12',
    reason: 'ZZ ui check', half: null,
  });
  /* Fri, Sat, Mon on a six-day pattern — Sunday is the only day off. */
  return r.days === 3;
})(), 'a five-day employee would take two');
ok('38. the demo history carries the period that was just assigned',
  (await s.schedules.employeeSchedules(EMP)).some((r) => r.scheduleCode === 'ZZUI6'));
ok('39. a demo pattern can be withdrawn and stays listed',
  (await s.schedules.setWorkScheduleActive('ZZUI6', false)).active === false
  && (await s.schedules.workSchedules()).some((p) => p.code === 'ZZUI6'));
ok('40. and a withdrawn pattern is refused for a new assignment', await (async () => {
  const e = await refused(() => s.schedules.assignEmployeeSchedule(OTHER, {
    scheduleCode: 'ZZUI6', validFrom: '2027-01-04',
  }));
  return e !== null && /not in use/.test(e);
})());

console.log('\nthe navigation gained nothing\n');

const nav = code('src/nav.ts');
ok('41. the existing Shifts & work schedules item is unchanged',
  /Shifts & work schedules/.test(nav));
ok('    and no second schedule nav item was added',
  (nav.match(/work schedule/gi) ?? []).length === 1,
  (nav.match(/work schedule/gi) ?? []).join(' | '));
ok('42. the patterns screen is a tab in the module that item already opens',
  /\{ v: 'sched', label: 'Working patterns' \}/.test(shiftsUi)
  && /active === 'sched' && <SchedulesView \/>/.test(shiftsUi));
ok('43. and the employee assignment is a tab in the existing lifecycle drawer',
  /v: 'schedule' as const, label: 'Working pattern'/.test(code('src/modules/lifecycle/index.tsx'))
  && /<EmployeeScheduleCard empId=\{id\} \/>/.test(code('src/modules/lifecycle/index.tsx')),
  'no separate employee-management architecture');

ok('44. every role can read the patterns, as the service allows',
  /app\.role === 'employee'[\s\S]{0,400}'Working patterns'/.test(shiftsUi),
  'which days a company works is not privileged');
ok('45. while the write controls are an admin\'s',
  /const admin = app\.role === 'admin'/.test(schedUi)
  && /admin && \(/.test(schedUi));

ok('46. a draft round-trips an existing pattern without losing a weekday',
  draftOf(patterns[0]!).days.length === 7
  && draftOf(patterns[0]!).days.map((d) => d.dayOfWeek).join(',') === '1,2,3,4,5,6,7');

/*
 * The overlap refusal, asserted last so nothing above it is read through a
 * mutated demo. By now EMP has a settled DEFAULT_MF period and an open ZZUI6 one,
 * so a start date inside the settled one is the case the service refuses outright.
 */
const settled = (await s.schedules.employeeSchedules(EMP))
  .find((r) => r.validTo !== null);
ok('48. a period that has already ended is there to clash with',
  settled !== undefined, 'the six-day assignment above should have closed one');
const overlap = await refused(() => s.schedules.assignEmployeeSchedule(EMP, {
  scheduleCode: patterns[0]!.code, validFrom: settled!.validFrom,
  validTo: settled!.validTo!,
}));
ok('    and starting inside it is refused in words a screen can show',
  overlap !== null && overlap.length > 10 && !/^23[0-9P]/.test(overlap), String(overlap));
ok('    naming what went wrong rather than a constraint',
  overlap !== null && /(already ended|covering that period|not rewritten)/.test(overlap),
  String(overlap));

ok('47. the standing shift is read off a working day, not guessed',
  standingShift(week, Object.keys(week)) !== null
  && standingShift({}, [MON]) === null);

console.log();
if (failed) {
  console.error(`${failed} schedule UI check(s) failed`);
  process.exit(1);
}
console.log('the schedule has screens, and the rota reads the server rather than the calendar');
