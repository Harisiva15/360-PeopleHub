/**
 * Expected and actual are two answers, and the screens keep them apart.
 *
 * Phase 2h-H's whole subject is one sentence: **a scheduled working day with no
 * attendance row is not an absence.** `A` is a status something writes on purpose;
 * a missing row is missing information. Rendering them the same way is how a
 * payroll deduction eventually gets justified by a gap in the data.
 *
 * Before this phase the month grid collapsed both into one glyph — attendance
 * status if there was a row, otherwise `'O'` for a week off or `'H'` for a holiday
 * — so a day off was drawn exactly like an attendance record saying so, and a
 * working day with no record was drawn as nothing at all with no way to tell it
 * from a day nobody was expected in.
 *
 * What these assertions hold:
 *
 *   1. The two channels exist separately in the composite model and on screen.
 *   2. "No attendance" is a display state and never a status.
 *   3. Nothing in the display path writes, generates or infers an absence.
 *   4. Expected still comes from the resolver, never from a weekday test here.
 *
 * Behaviour is asserted against the model and the mock services wherever it can
 * be. The source reads are for absences — "this file never says Absent" — which no
 * behavioural test can state, and each strips comments first so prose about a rule
 * cannot satisfy an assertion about the rule.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mockServices as s } from '../src/services/mock';
import { ACTIVE } from '../src/data/employees';
import {
  ACTUAL_LABEL, actualLabel, awaitingRecord, composeDays, expectedLabel,
  NO_ATTENDANCE, recordsByEmployee, type AttendanceDay,
} from '../src/modules/attendance/day';
import { lookOfReason } from '../src/modules/shifts/expected';
import type { AttRecord, DayVerdict } from '../src/services';

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

/* 2026-10-05 Monday, 2026-10-10 Saturday, 2026-10-11 Sunday. */
const MON = '2026-10-05';
const SAT = '2026-10-10';

const verdict = (date: string, reason: DayVerdict['reason'], over: Partial<DayVerdict> = {})
: DayVerdict => ({
  date, reason, workingDay: reason === 'WORKING', holiday: null,
  schedule: 'ZZMF', shift: 'IN', ...over,
});
const record = (date: string, status: string, over: Partial<AttRecord> = {}): AttRecord => ({
  id: `a-${date}`, empId: 'E1', date, status, inT: '09:02', outT: '18:04', mins: 480,
  site: 'CHN', lat: null, lng: null, dist: null, geoOk: null, src: 'web',
  late: false, reg: null, notes: '', ...over,
});

/* ------------------------------------------------------------------ *
 * §24 1-6. The six combinations that matter
 * ------------------------------------------------------------------ */

console.log('\nthe two answers, composed without being merged\n');

const day = (v: DayVerdict | null, r: AttRecord | null): AttendanceDay =>
  composeDays([v?.date ?? r?.date ?? MON], v ? [v] : [], r ? [r] : [])[0]!;

const workingNoRecord = day(verdict(MON, 'WORKING'), null);
ok('1. working day, no record → Working / No attendance',
  expectedLabel(workingNoRecord) === 'Working'
  && actualLabel(workingNoRecord) === NO_ATTENDANCE,
  `${expectedLabel(workingNoRecord)} / ${actualLabel(workingNoRecord)}`);
ok('    and it is NOT called absent',
  actualLabel(workingNoRecord) !== 'Absent' && actualLabel(workingNoRecord) !== ACTUAL_LABEL.A,
  'the single most important assertion in this phase');
ok('    the expected side still names the schedule and the shift',
  workingNoRecord.expected?.schedule === 'ZZMF' && workingNoRecord.expected?.shift === 'IN');

const present = day(verdict(MON, 'WORKING'), record(MON, 'P'));
ok('2. working day, present → Working / Present',
  expectedLabel(present) === 'Working' && actualLabel(present) === 'Present');
ok('    and the expected side is not replaced by the actual one',
  present.expected !== null && present.actual !== null,
  'both channels survive the join');

const late = day(verdict(MON, 'WORKING'), record(MON, 'P', { late: true }));
ok('3. working day, late → Working / Present, flagged late',
  expectedLabel(late) === 'Working' && late.actual?.late === true,
  'late is a property of the record, not a seventh status');

const offNoRecord = day(verdict(SAT, 'WEEKLY_OFF'), null);
ok('4. weekly off, no record → Week off / No attendance',
  expectedLabel(offNoRecord) === 'Week off' && actualLabel(offNoRecord) === NO_ATTENDANCE);
ok('    and no attendance row is implied by the day being off',
  offNoRecord.actual === null,
  'the old grid drew this as status O, which read as a record saying so');

const holNoRecord = day(verdict(MON, 'HOLIDAY', { holiday: 'ZZ Diwali' }), null);
ok('5. holiday, no record → Holiday (named) / No attendance',
  expectedLabel(holNoRecord) === 'Holiday — ZZ Diwali'
  && actualLabel(holNoRecord) === NO_ATTENDANCE,
  `${expectedLabel(holNoRecord)} / ${actualLabel(holNoRecord)}`);

const notEmp = day(verdict(MON, 'NOT_EMPLOYED', { schedule: null, shift: null }), null);
ok('6. not employed, no record → Not employed / No attendance',
  expectedLabel(notEmp) === 'Not employed' && actualLabel(notEmp) === NO_ATTENDANCE);
ok('    and that is not an absence either', actualLabel(notEmp) !== 'Absent');

const leaveDay = day(verdict(MON, 'WORKING'), record(MON, 'L'));
ok('7. working day with a leave record → Working / Leave',
  expectedLabel(leaveDay) === 'Working' && actualLabel(leaveDay) === 'Leave',
  'read from the status attendance already holds; leave is not duplicated here');

ok('8. a date the server answered neither way is still listed',
  composeDays([MON], [], []).length === 1
  && composeDays([MON], [], [])[0]!.expected === null
  && composeDays([MON], [], [])[0]!.actual === null,
  'a calendar that drops a day is worse than one admitting it knows nothing');

/* ------------------------------------------------------------------ *
 * The status vocabulary is not extended
 * ------------------------------------------------------------------ */

console.log('\nno status was invented\n');

ok('9. the actual labels are exactly migration 0004\'s six',
  Object.keys(ACTUAL_LABEL).sort().join('') === 'AHLOPW',
  Object.keys(ACTUAL_LABEL).sort().join(''));
ok('10. "No attendance" is not among them',
  !Object.values(ACTUAL_LABEL).includes(NO_ATTENDANCE),
  'it is what the map cannot answer, not an entry in it');
ok('11. and none of the invented statuses appear anywhere',
  !/NO_SHOW|POTENTIAL_ABSENCE|MISSING_ATTENDANCE|EXPECTED_STATUS/.test(dayModel + grid + attUi),
  'the §32 list, which this phase was told not to create');

ok('12. awaitingRecord asks a different question from "was absent"',
  awaitingRecord(workingNoRecord) === true && awaitingRecord(offNoRecord) === false
  && awaitingRecord(present) === false && awaitingRecord(notEmp) === false,
  'worth a human looking at — which is not the same as a verdict about them');

/* ------------------------------------------------------------------ *
 * The month grid shows both
 * ------------------------------------------------------------------ */

console.log('\nthe month grid draws expected and actual in separate channels\n');

ok('13. the grid composes through the shared model',
  /composeDays\(/.test(grid),
  'rather than its own join, which is where the collapse lived');
/*
 * Written against the shape of the bug rather than the old variable name. A first
 * version matched `v.reason === 'HOLIDAY' ? 'H'` exactly, so re-collapsing the
 * channels under any other identifier slipped past it — which a red-before-green
 * run showed when the reintroduced bug used `day.expected` instead of `v`.
 */
ok('14. it no longer substitutes an attendance status for an expected state',
  !/=== 'HOLIDAY'\s*\?\s*'H'/.test(grid) && !/workingDay\s*\?\s*'O'/.test(grid)
  && !/:\s*'O'\s*:/.test(grid),
  'a week off drawn as status O reads as a record saying so');
ok('15. the expected side comes from the shared look-up',
  /lookOfReason\(/.test(grid),
  'one table of labels, so a week off is drawn the same way as on the rota');
ok('16. the actual side is labelled from the status map',
  /actualLabel\(/.test(grid));
/*
 * Framed against the tooltip rather than the source text. A first version looked
 * for the words "No attendance" in the grid — but the grid calls `actualLabel`,
 * which is the right thing to do, so the assertion was testing the wrong artefact.
 */
ok('17. and the tooltip names both channels, expected first',
  /Expected: /.test(grid) && /Actual: /.test(grid),
  'one merged sentence is how a gap comes to be read as a result');
/*
 * A first version forbade the word "Absent" anywhere in the grid. It belongs
 * there — Absent is a recorded status and the Recorded legend should name it.
 * What must not exist is a path that reaches it without a record.
 */
ok('18. Absent appears only as a recorded-legend entry',
  (grid.match(/Absent/g) ?? []).length === 1 && /\{ k: 'Absent'/.test(grid),
  (grid.match(/.{0,24}Absent.{0,16}/g) ?? []).join(' | '));
ok('    and no code path reaches it without a record',
  !/\?\s*'A'/.test(grid) && !/\|\|\s*'Absent'/.test(grid),
  'the only Absent on screen is the label of a persisted A');
ok('19. nor computes a weekend or a holiday of its own',
  !/isWeekend/.test(grid) && !/HOLIDAY_MAP/.test(grid),
  'the resolver is the authority — Phase 2h-B onwards');
/*
 * A first version counted `getDay()` calls and expected one. There are two, and
 * both are display — the dashboard greeting and the grid's leading offset.
 * Counting was the wrong instrument for "no weekday decides an expectation";
 * what actually holds that is the namespacing below, plus assertions 14 and 15.
 */
ok('    and the expected class is namespaced away from the statuses',
  /EXPECTED_CLASS\[day\.expected!\.reason\]/.test(grid)
  && /WEEKLY_OFF: 'exp-weekly_off'/.test(grid),
  'exp-weekly_off is not O — the two cannot collide in CSS either');
ok('    so a week off no longer borrows the status palette',
  /\.cal \.day\.exp-weekly_off/.test(read('src/styles/global.css')),
  'it has its own class with its own rule');

/* ------------------------------------------------------------------ *
 * The rota shows both
 * ------------------------------------------------------------------ */

console.log('\nand so does the rota\n');

ok('20. the rota reads attendance in one range call',
  /useAttendance\(/.test(rosterUi) && /recordsByEmployee\(/.test(rosterUi),
  'not one request per person, and not one per cell');
ok('21. it keeps the expected channel it had in 2h-F',
  /lookOf\(/.test(rosterUi) && /scheduleOver\(/.test(rosterUi));
ok('22. and never labels a missing record as absent',
  !/'Absent'/.test(rosterUi) && !/>A</.test(rosterUi));
ok('23. nor writes attendance',
  !/punchIn|punchOut|raiseRegularisation|actOnRegularisation/.test(rosterUi),
  'the rota is a read');

/* ------------------------------------------------------------------ *
 * §25. Nothing in the display path writes
 * ------------------------------------------------------------------ */

console.log('\nreading changes nothing\n');

const emp = ACTIVE()[0]!.id;
const beforeAll = (await s.attendance.list({})).length;
await s.attendance.list({ empIds: [emp], from: MON, to: SAT });
await s.calendar.workingDays(emp, MON, SAT);
await s.shifts.roster([emp], MON, 7);
const afterAll = (await s.attendance.list({})).length;
ok('24. listing attendance creates no record', afterAll === beforeAll,
  `${beforeAll} → ${afterAll}`);
ok('25. reading the calendar creates none either', afterAll === beforeAll);
ok('26. and reading the rota creates none', afterAll === beforeAll);

const span = await s.calendar.workingDays(emp, MON, SAT);
const mine = await s.attendance.list({ empIds: [emp], from: MON, to: SAT });
const composed = composeDays(span.map((v) => v.date), span, mine);
ok('27. composing the two creates nothing',
  (await s.attendance.list({})).length === beforeAll);
ok('28. and produces a day for every date in the span',
  composed.length === span.length, `${composed.length} vs ${span.length}`);
ok('29. with no day claiming an absence the data does not hold',
  composed.every((d) => d.actual === null || d.actual.status !== 'A'
    || mine.some((r) => r.date === d.date && r.status === 'A')),
  'every Absent shown traces to a persisted A');

/* ------------------------------------------------------------------ *
 * Grouping, for the team view
 * ------------------------------------------------------------------ */

const two = ACTIVE().slice(0, 2).map((e) => e.id);
const team = await s.attendance.list({ empIds: two, from: '2026-09-01', to: '2026-10-31' });
const grouped = recordsByEmployee(team);
ok('30. attendance groups by employee from one read',
  [...grouped.keys()].every((k) => two.includes(k)),
  [...grouped.keys()].join(','));
ok('31. and every record lands under its own date',
  [...grouped.entries()].every(([, byDate]) =>
    [...byDate.entries()].every(([d, r]) => r.date === d)));

/* ------------------------------------------------------------------ *
 * Expected presentation is shared, not duplicated
 * ------------------------------------------------------------------ */

console.log('\none table of labels for the expected side\n');

ok('32. the four expected states each have a word',
  (['WORKING', 'WEEKLY_OFF', 'HOLIDAY', 'NOT_EMPLOYED'] as const)
    .every((r) => (lookOfReason(r)?.label.length ?? 0) > 2),
  (['WORKING', 'WEEKLY_OFF', 'HOLIDAY', 'NOT_EMPLOYED'] as const)
    .map((r) => lookOfReason(r)?.label).join(','));
ok('33. and an unanswered reason has no look',
  lookOfReason(undefined) === null);
ok('34. not employed stays distinct from a week off',
  lookOfReason('NOT_EMPLOYED')!.label !== lookOfReason('WEEKLY_OFF')!.label);

ok('35. the model is a display shape, not a persisted one',
  !/INSERT|UPDATE|DELETE/i.test(dayModel),
  'there is no expected_status column and this phase added none');

console.log();
if (failed) {
  console.error(`${failed} expected-vs-actual check(s) failed`);
  process.exit(1);
}
console.log('expected and actual are shown as two answers, and a missing record stays missing');
