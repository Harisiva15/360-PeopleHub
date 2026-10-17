/**
 * A new account can be put on a working pattern, and "Not assigned" survives.
 *
 * Phase 2h-G connected employee creation to the schedule architecture. Two things
 * are worth a ratchet:
 *
 *   1. **One selector, in one place.** The choice is offered where the joining
 *      date is, because the assignment starts on it — and nowhere else, so there
 *      is no second editor quietly rewriting somebody's current period instead of
 *      opening a new one.
 *   2. **Choosing nothing is still a choice.** The option says "Not assigned", the
 *      field explains what that means, and the demo records no assignment for it.
 *      Collapsing it into DEFAULT_MF is the one thing this phase was told not to
 *      do, and assertions 9-13 hold that it did not.
 *
 * Behaviour is asserted against the mock services where it can be. The source
 * reads are for absences — "there is no second selector", "the edit form does not
 * offer one" — which no behavioural test can state, and each strips comments first
 * so prose about a rule cannot satisfy an assertion about the rule.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mockServices as s } from '../src/services/mock';
import { ASSIGNMENTS } from '../src/services/mock/schedules';
import { ACTIVE } from '../src/data/employees';

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

const form = code('src/modules/users/Drawers.tsx');
const contracts = code('src/services/contracts.ts');
const mockUsers = code('src/services/mock/users.ts');
const provision = code('server/src/modules/people/provision.ts');
const usersSvc = code('server/src/modules/users/service.ts');
const schedSvc = code('server/src/modules/schedules/service.ts');

const ADMIN = { role: 'admin' as const, meId: ACTIVE()[0]!.id };

/* ------------------------------------------------------------------ *
 * The contract, and the one canonical field
 * ------------------------------------------------------------------ */

console.log('\none field, named the way the rest of the schedule surface is\n');

ok('1. the creation contract carries workScheduleCode',
  /workScheduleCode\?: string \| null;/.test(contracts));
ok('    on UserDraft, where the creation flow reads it',
  /export interface UserDraft \{[\s\S]{0,1400}?workScheduleCode\?: string \| null;/.test(contracts));
ok('2. and no competing field was introduced',
  !/\bscheduleId\?:/.test(contracts) && !/\bemployeeScheduleId\?:/.test(contracts)
  && !/\bpatternId\?:/.test(contracts) && !/\bworkScheduleId\?:/.test(contracts),
  'the schedule surface identifies a pattern by code everywhere else');
ok('3. the field is a code, matching assignEmployeeSchedule\'s own draft',
  /scheduleCode: string;/.test(contracts),
  'a uuid here would be the only place a client names a schedule by id');

/* ------------------------------------------------------------------ *
 * The form
 * ------------------------------------------------------------------ */

console.log('\nthe choice is offered once, beside the date it starts from\n');

ok('4. the creation form offers a work schedule',
  /id="user-sched"/.test(form) && /Work schedule<\/label>/.test(form));
ok('5. only when creating, never when editing',
  /\{!existing && \([\s\S]{0,400}id="user-sched"/.test(form),
  'changing a pattern is effective-dated and belongs on the employee\'s own record');
ok('6. there is exactly one selector in the whole form',
  (form.match(/id="user-sched"/g) ?? []).length === 1,
  String((form.match(/id="user-sched"/g) ?? []).length));
ok('7. offering only patterns the server would accept',
  /\.filter\(\(w\) => w\.active\)/.test(form),
  'an inactive one is refused by the service, so offering it offers a failure');
ok('8. and it reads them from the schedule service',
  /useWorkSchedules\(\)/.test(form)
  && /\.schedules\.workSchedules\(\)/.test(code('src/modules/users/data.ts')));

console.log('\nand "not assigned" is spelled out\n');

ok('9. the empty option says Not assigned',
  /<option value="">Not assigned<\/option>/.test(form));
ok('10. with an explanation of what that means',
  /falls back to Monday/.test(form) && /Not assigned/.test(form),
  'an assumption named as one, not a gap');
ok('11. the form never names DEFAULT_MF',
  !/DEFAULT_MF/.test(form),
  'this product has no default schedule concept to name');
ok('12. a chosen pattern says which date it applies from',
  /Applies from \{fmtD\(joinedOn\)\}/.test(form),
  'the joining date, which is what the server dates the assignment from');
ok('13. an empty choice is sent as null, not as a guess',
  /workScheduleCode: workScheduleCode \|\| null/.test(form));
ok('14. and a tenant with no pattern yet gets an empty state, not a fabricated one',
  /No working pattern has been set up yet/.test(form));

/* ------------------------------------------------------------------ *
 * The server, read for the properties no mock can show
 * ------------------------------------------------------------------ */

console.log('\nthe server decides, inside the creating transaction\n');

ok('15. provisioning assigns through the schedule service',
  /assignInitialSchedule\(db, caller, id, \{/.test(provision),
  'not a direct insert — the rules live in one place');
/*
 * Scoped to the assignment call. A first version tested the whole file for
 * `CURRENT_DATE` and failed on `openLeaveBalances`, which legitimately uses it to
 * work out the leave year — a reminder that "this file never mentions X" is
 * usually the wrong shape for an assertion about one statement in it.
 */
const assignBlock = provision.slice(provision.lastIndexOf('assignInitialSchedule('), provision.lastIndexOf('assignInitialSchedule(') + 220);
ok('16. dated from the joining date, never from now',
  /validFrom: spec\.joinedOn/.test(assignBlock)
  && !/CURRENT_DATE/.test(assignBlock) && !/ymd\(/.test(assignBlock),
  assignBlock.slice(0, 200));
ok('17. and only when a pattern was actually named',
  /typeof spec\.workScheduleCode === 'string' && spec\.workScheduleCode\.trim\(\)/.test(provision),
  'blank means unassigned, which is what the selector sends for Not assigned');
ok('18. provision.ts substitutes no default of its own',
  !/DEFAULT_MF/.test(provision),
  'there is nothing authoritative to substitute');

ok('19. User Management assigns the same way',
  /assignInitialSchedule\(db, caller, emp\[0\]!\.id, \{/.test(usersSvc));
ok('    reading the joining date off the row it just wrote',
  /joined_on::text AS on FROM employee WHERE id = \$1/.test(usersSvc),
  'so the assignment and the employee cannot disagree about when they started');

ok('20. the shared assignment core has one copy of the rules',
  /async function writeAssignment\(/.test(schedSvc)
  && (schedSvc.match(/writeAssignment\(db, caller, employeeId, draft\)/g) ?? []).length === 2,
  'assignEmployeeSchedule and assignInitialSchedule both go through it');
ok('21. and the provisioning entry point is not routed',
  !/assignInitialSchedule/.test(code('server/src/http/app.ts')),
  'it skips the line check, so it must be reachable only from a creation path');

/* ------------------------------------------------------------------ *
 * The demo
 * ------------------------------------------------------------------ */

console.log('\nthe demo refuses what the server refuses\n');

const base = {
  name: 'ZZ Provision Check',
  email: `zz-prov-${Math.random().toString(36).slice(2, 9)}@360.technology`,
  dept: 'ENG', designation: 'Engineer', site: 'CHN',
  role: 'employee' as const, joinedOn: '2026-09-01', sendInvitation: false,
};

ok('22. an unknown pattern is refused, in the server\'s words',
  (await refused(() => s.users.create(ADMIN, { ...base, workScheduleCode: 'ZZNOPE' })))
    ?.includes('no such work schedule') === true);

const patterns = await s.schedules.workSchedules();
const live = patterns.find((p) => p.active)!;
await s.schedules.setWorkScheduleActive(live.code, false);
ok('23. a withdrawn pattern is refused, in the server\'s words',
  (await refused(() => s.users.create(ADMIN, {
    ...base, email: `zz-p2-${Math.random().toString(36).slice(2, 9)}@360.technology`,
    workScheduleCode: live.code,
  })))?.includes('not in use and cannot be assigned') === true);
await s.schedules.setWorkScheduleActive(live.code, true);

ok('24. and neither refusal created an account',
  !(await s.users.list(ADMIN, { q: 'ZZ Provision Check' })).length);

console.log('\nand records what it can represent\n');

const linked = ACTIVE()[2]!.id;
const beforeCount = ASSIGNMENTS.filter((a) => a.employeeId === linked).length;
await s.users.create(ADMIN, {
  ...base, email: `zz-p3-${Math.random().toString(36).slice(2, 9)}@360.technology`,
  empId: linked, joinedOn: '2026-09-01', workScheduleCode: live.code,
});
const added = ASSIGNMENTS.filter((a) => a.employeeId === linked);
ok('25. an account linked to a person records the assignment',
  added.length === beforeCount + 1, `${beforeCount} → ${added.length}`);
ok('26. from the joining date on the draft',
  added.some((a) => a.validFrom === '2026-09-01' && a.scheduleCode === live.code),
  JSON.stringify(added.map((a) => [a.scheduleCode, a.validFrom])));
ok('27. open-ended', added.some((a) => a.validTo === null));

const unlinked = ACTIVE()[3]!.id;
const beforeNone = ASSIGNMENTS.filter((a) => a.employeeId === unlinked).length;
await s.users.create(ADMIN, {
  ...base, email: `zz-p4-${Math.random().toString(36).slice(2, 9)}@360.technology`,
  empId: unlinked,
});
ok('28. choosing none records nothing',
  ASSIGNMENTS.filter((a) => a.employeeId === unlinked).length === beforeNone,
  'the unassigned state the resolver and the screens both rely on');
ok('29. and a blank code is treated as none, not as an error',
  (await refused(() => s.users.create(ADMIN, {
    ...base, email: `zz-p5-${Math.random().toString(36).slice(2, 9)}@360.technology`,
    workScheduleCode: '   ',
  }))) === null,
  'a selector set to "Not assigned" sends an empty value');
ok('30. the demo substitutes no default either',
  !/DEFAULT_MF/.test(mockUsers));

console.log();
if (failed) {
  console.error(`${failed} provisioning check(s) failed`);
  process.exit(1);
}
console.log('a new account can start on a chosen pattern, and choosing none still means none');
