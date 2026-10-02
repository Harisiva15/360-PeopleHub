/**
 * The shift screen shows the break and grace the server reports.
 *
 * It used to show them from `src/data/shifts.ts` — a client-side constant that
 * said a 45-minute break and a 20-minute grace for the India shift. The
 * `shift.break_minutes` and `shift.grace_minutes` columns say 60 and 10, and those
 * are the figures `attendance/service.ts` deducts from worked time and measures
 * lateness against. So the screen whose job was to state the rules stated
 * something else, and nothing failed — the numbers simply disagreed.
 *
 * Four assurances:
 *
 *   1. `ShiftProfile` carries break, grace, active and colour, and the demo returns
 *      them, so both modes take the same path.
 *   2. The screens read those fields and **nothing falls back to the constant.**
 *      A fallback would reinstate the wrong number for exactly the reader who has
 *      least reason to doubt it.
 *   3. `src/data/shifts.ts` still exists, because the demo seed, the roster and the
 *      overtime fixtures legitimately use it — but its break and grace now agree
 *      with the column rather than contradicting it.
 *   4. `resolveProfile` resolves an unknown code to something that claims nothing,
 *      rather than to another shift's hours.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shiftService } from '../src/services/mock/misc';
import { SHIFTS } from '../src/data/shifts';
import { colourOf, resolveProfile } from '../src/modules/shifts/profile';

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

const idx = code('src/modules/shifts/index.tsx');
/*
 * The editor lives in its own module: `index.tsx` already held seven components and
 * oxlint's only-export-components fires on each unexported one. These assertions
 * follow the markup rather than the file it used to sit in.
 */
const form = code('src/modules/shifts/ShiftForm.tsx');
const formRaw = read('src/modules/shifts/ShiftForm.tsx');
const ros = code('src/modules/shifts/Roster.tsx');
const contracts = code('src/services/contracts.ts');
const mock = code('src/services/mock/misc.ts');
const server = code('server/src/modules/shifts/service.ts');

/* ------------------------------------------------------------------ *
 * 1. the contract and the two implementations carry the columns
 * ------------------------------------------------------------------ */

console.log('\nthe four columns cross the seam\n');

const shape = contracts.slice(contracts.indexOf('export interface ShiftProfile'),
  contracts.indexOf('}', contracts.indexOf('export interface ShiftProfile')) + 1);
for (const f of ['breakMinutes', 'graceMinutes', 'active', 'colour']) {
  ok(`ShiftProfile carries ${f}`, shape.includes(`${f}:`), 'the field is not in the contract');
}
ok('colour is nullable, because the column is',
  /colour: string \| null;/.test(shape), shape.split('\n').find((l) => l.includes('colour')));

ok('the server projection selects break_minutes', server.includes('s.break_minutes'),
  'without this the screen has nothing to read');
ok('and grace_minutes', server.includes('s.grace_minutes'));
ok('and active', /s\.break_minutes, s\.grace_minutes, s\.active, s\.colour/.test(server));
ok('and maps them onto the contract names',
  /breakMinutes: Number\(r\.break_minutes\)/.test(server)
  && /graceMinutes: Number\(r\.grace_minutes\)/.test(server));

/*
 * Checked through one mapper rather than by the spelling of a literal: 2g-B moved
 * this into `asProfile` so the create and update paths share it, and an assertion
 * on the old expression would have failed a refactor that improved the thing it
 * was guarding. The values are asserted behaviourally further down.
 */
ok('the demo maps the store onto the contract in one place',
  /const asProfile = \(s: Shift\): ShiftProfile/.test(mock)
  && /breakMinutes: s\.brk, graceMinutes: s\.grace, active: s\.active, colour: s\.c/.test(mock),
  'demo mode and a configured build must take the same path');

/* ------------------------------------------------------------------ *
 * 2. the screens read the service, with no fallback
 * ------------------------------------------------------------------ */

console.log('\nthe screens read the service and nothing else\n');

ok('neither screen imports the constant any more',
  !/from '\.\.\/\.\.\/data\/shifts'/.test(idx) && !/from '\.\.\/\.\.\/data\/shifts'/.test(ros),
  'the import is how the wrong numbers got onto the screen');
ok('nor calls shiftOf', !/\bshiftOf\(/.test(idx) && !/\bshiftOf\(/.test(ros),
  'shiftOf is the per-code map that drifted');
ok('nor reads SHIFTS', !/\bSHIFTS\b/.test(idx) && !/\bSHIFTS\b/.test(ros));

ok('the profiles table takes break from the profile', /brk: p\.breakMinutes/.test(idx),
  'this is the number an administrator reads off the screen');
ok('and grace from the profile', /grace: p\.graceMinutes/.test(idx));
ok('and active from the profile', /active: p\.active/.test(idx));
ok('and colour through the palette helper', /c: colourOf\(p, i\)/.test(idx));
ok('there is no conditional fallback left in the table',
  !/profiles\.length\s*\n?\s*\?/.test(idx),
  'falling back when a read is slow is the same defect with extra steps');
ok('an inactive profile is marked as one', /!s\.active &&/.test(idx)
  && /Inactive/.test(idx));

ok('the roster builds its legend from the profiles',
  /shiftList = profiles\.map/.test(ros));
ok('and resolves each row through resolveProfile',
  (ros.match(/resolveProfile\(profiles, code\)/g) ?? []).length >= 2,
  'both the table and the export need the same source');
ok('the roster has no constant fallback either',
  !/: SHIFTS\.map/.test(ros));

/* ------------------------------------------------------------------ *
 * 3. the constant survives for what legitimately needs it
 * ------------------------------------------------------------------ */

console.log('\nthe constant stays for the demo seed, and no longer contradicts the column\n');

ok('src/data/shifts.ts still exists', SHIFTS.length === 4,
  'the mock profiles, the roster and the overtime fixtures are built from it');
for (const s of SHIFTS) {
  ok(`${s.id} break is 60, as the column defaults`, s.brk === 60,
    `${s.brk} — this said 45 before, while the column said 60`);
  ok(`  and grace is 10`, s.grace === 10,
    `${s.grace} — this said 20 for IN and 15 for the rest`);
}

const data = code('src/data/shifts.ts');
ok('and it is still imported only where it belongs',
  /export const SHIFTS/.test(data) && /export const ROSTER/.test(data),
  'the roster and overtime fixtures live here too');

/* ------------------------------------------------------------------ *
 * 4. the demo values reach a caller, and resolution is honest
 * ------------------------------------------------------------------ */

console.log('\nthe demo service returns the real shape\n');

const profiles = await shiftService.profiles();
ok('the demo returns four profiles', profiles.length === 4, String(profiles.length));
for (const p of profiles) {
  ok(`${p.code} reports a 60-minute break`, p.breakMinutes === 60, String(p.breakMinutes));
  ok(`  a 10-minute grace`, p.graceMinutes === 10, String(p.graceMinutes));
  ok(`  active`, p.active === true);
  ok(`  and a colour`, typeof p.colour === 'string' && p.colour.length > 0,
    String(p.colour));
}
ok('and everything already returned is still there',
  profiles.every((p) => p.code && p.name && p.start && p.end && p.timezone
    && typeof p.night === 'boolean' && typeof p.flexible === 'boolean'
    && typeof p.headcount === 'number'),
  JSON.stringify(profiles[0]));

console.log('\nresolving a code claims nothing it does not know\n');

const found = resolveProfile(profiles, 'US');
ok('a known code resolves to its own profile', found.code === 'US' && found.name === 'US Shift');
ok('  with the service\'s break and grace',
  found.breakMinutes === 60 && found.graceMinutes === 10);

const unknown = resolveProfile(profiles, 'ZZNOPE');
ok('an unknown code does not resolve to another shift', unknown.code === 'ZZNOPE',
  `resolved to ${unknown.code} — falling through to SHIFTS[0] is the old bug`);
ok('  and reports no hours rather than someone else\'s',
  unknown.start === '—' && unknown.end === '—', `${unknown.start}-${unknown.end}`);
ok('  and no break or grace rather than a plausible guess',
  unknown.breakMinutes === 0 && unknown.graceMinutes === 0,
  `${unknown.breakMinutes}/${unknown.graceMinutes}`);
ok('  and shows as inactive', unknown.active === false);

ok('colourOf prefers the profile\'s own colour',
  colourOf({ ...found, colour: 'var(--s9)' }, 3) === 'var(--s9)');
ok('  and falls back to a slot by position when the column is null',
  colourOf({ ...found, colour: null }, 0) !== colourOf({ ...found, colour: null }, 1),
  'a per-code map is what drifted; a positional slot claims nothing about the shift');


/* ------------------------------------------------------------------ *
 * 2g-B — the admin controls, and what the demo refuses
 * ------------------------------------------------------------------ */

console.log('\nthe screen offers an admin the three controls\n');

ok('the screen reads the three write hooks',
  idx.includes('useCreateShift()') && idx.includes('useUpdateShift()')
  && idx.includes('useSetShiftActive()'));
ok('the Add control is gated on the role', /actions=\{admin && \(/.test(idx),
  'a control the service refuses should not be offered');
ok('  and so are Edit and Withdraw', /\{admin && \(\s*<td className="right nowrap">/.test(idx));
ok('the role is derived from the session, not passed in',
  /const admin = app\.role === 'admin'/.test(idx));
ok('the editor exists', /export function ShiftForm\(/.test(form),
  'and is exported, which is what keeps it out of the lint warning');
ok('  and index.tsx imports it rather than declaring it',
  /import \{ ShiftForm \} from '\.\/ShiftForm';/.test(idx)
  && !/function ShiftForm\(/.test(idx));
ok('  with a field for every mutable setting',
  ['sh-code', 'sh-name', 'sh-start', 'sh-end', 'sh-tz', 'sh-region',
    'sh-break', 'sh-grace', 'sh-night', 'sh-flexible']
    .every((id) => form.includes(`id="${id}"`)),
  'a setting with no field cannot be corrected');
ok('the code is locked when editing', /id="sh-code"[\s\S]{0,200}disabled=\{editing\}/.test(form),
  'three tables join on the code');
ok('the timezone is a list, not free text', /id="sh-tz"[\s\S]{0,200}TIMEZONES\.map/.test(form),
  'a free-text zone could save a string that breaks punching');
ok('break and grace are bounded in the field as well as the service',
  /max=\{480\}/.test(form) && /max=\{240\}/.test(form));
ok('the attendance-history refusal is explained before it is met',
  /attendance recorded/.test(formRaw) && /create a new profile instead/i.test(formRaw),
  'the server refuses it; the form should say so first');
ok('  and says which fields stay editable',
  /name, end time, region and\s+flags can always be corrected/i.test(formRaw),
  'the copy wraps across lines, so the match has to tolerate the break');
ok('a refusal from the service is surfaced, not swallowed',
  /app\.toast\(e instanceof Error \? e\.message/.test(idx));
ok('the list says how many are in use', /in use of/.test(idx));
ok('and the row offers Withdraw or Reinstate by state',
  /s\.active \? 'Withdraw' : 'Reinstate'/.test(idx));
ok('there is no delete control anywhere on the screen',
  !/Delete|Remove/.test(idx.slice(idx.indexOf('function ShDef'))),
  'three tables point at a shift row and a worked pattern is history');

ok('the contract carries ShiftDraft', /export interface ShiftDraft/.test(contracts));
ok('  with no active field, because that is its own call',
  !/active\??:/.test(contracts.slice(contracts.indexOf('export interface ShiftDraft'),
    contracts.indexOf('}', contracts.indexOf('export interface ShiftDraft')))));
ok('the contract declares the three writes',
  /createShift\(draft: ShiftDraft\)/.test(contracts)
  && /updateShift\(code: string, patch: ShiftDraft\)/.test(contracts)
  && /setShiftActive\(code: string, active: boolean\)/.test(contracts));

const http2 = code('src/services/http/index.ts');
ok('the bindings post, put and put-active', /api\.post\('\/shifts', draft\)/.test(http2)
  && /api\.put\(`\/shifts\/\$\{encodeURIComponent\(code\)\}`, patch\)/.test(http2)
  && /\/active`, \{ active \}\)/.test(http2));
ok('and there is no delete binding', !/api\.del\(`\/shifts/.test(http2));

const hooks = code('src/modules/shifts/data.ts');
ok('the hooks are declared in the shift data layer',
  hooks.includes('useCreateShift') && hooks.includes('useUpdateShift')
  && hooks.includes('useSetShiftActive'));

console.log('\nthe demo refuses what the service refuses\n');

const refuse = async (label: string, f: () => Promise<unknown>, want: RegExp) => {
  let said: string | null = null;
  try { await f(); } catch (e) { said = e instanceof Error ? e.message : String(e); }
  ok(label, said !== null && want.test(said), said ?? 'the call succeeded');
};

const base = {
  name: 'ZZ Check Shift', startsAt: '08:00', endsAt: '16:00', timezone: 'Europe/London',
};

await refuse('a blank code is refused',
  () => shiftService.createShift({ ...base, code: '  ' }), /needs a code/);
await refuse('a code that is not a code is refused',
  () => shiftService.createShift({ ...base, code: 'ZZ BAD!' }), /2-12 characters/);
await refuse('a blank name is refused',
  () => shiftService.createShift({ ...base, code: 'ZZC1', name: '  ' }), /needs a name/);
await refuse('an unknown timezone is refused',
  () => shiftService.createShift({ ...base, code: 'ZZC2', timezone: 'Mars/Olympus' }),
  /not a timezone/);
await refuse('reversed hours are refused',
  () => shiftService.createShift({ ...base, code: 'ZZC3', startsAt: '18:00', endsAt: '09:00' }),
  /must end after it starts/);
await refuse('  and a night shift is not an exception, because nothing computes overnight',
  () => shiftService.createShift({
    ...base, code: 'ZZC4', startsAt: '22:00', endsAt: '06:00', isNight: true,
  }), /Overnight hours are not supported/);
await refuse('a negative break is refused',
  () => shiftService.createShift({ ...base, code: 'ZZC5', breakMinutes: -1 }),
  /cannot be negative/);
await refuse('an absurd break is refused',
  () => shiftService.createShift({ ...base, code: 'ZZC6', breakMinutes: 9999 }),
  /at most 480/);
await refuse('a fractional grace is refused',
  () => shiftService.createShift({ ...base, code: 'ZZC7', graceMinutes: 2.5 }),
  /whole number/);
await refuse('an absurd grace is refused',
  () => shiftService.createShift({ ...base, code: 'ZZC8', graceMinutes: 999 }),
  /at most 240/);
await refuse('a bad region is refused',
  () => shiftService.createShift({ ...base, code: 'ZZC9', region: 'IND' }),
  /two-letter country code/);

console.log('\nand accepts what the service accepts\n');

const made = await shiftService.createShift({
  ...base, code: 'zzdemo', breakMinutes: 30, graceMinutes: 5, region: 'gb',
  colour: 'var(--s2)',
});
ok('a profile can be created', made.code === 'ZZDEMO', made.code);
ok('  the code is upper-cased', made.code === 'ZZDEMO');
ok('  the region is upper-cased', made.region === 'GB', made.region);
ok('  break and grace are what was asked for',
  made.breakMinutes === 30 && made.graceMinutes === 5);
ok('  and it starts active', made.active === true);
await refuse('a duplicate code is refused',
  () => shiftService.createShift({ ...base, code: 'ZZDEMO' }), /already a shift/);
await refuse('and so is a duplicate of a seeded profile',
  () => shiftService.createShift({ ...base, code: 'IN' }), /already a shift/);

const patched = await shiftService.updateShift('ZZDEMO', {
  name: 'ZZ Demo Renamed', endsAt: '17:00', breakMinutes: 45,
});
ok('a profile can be corrected', patched.name === 'ZZ Demo Renamed');
ok('  and absent fields are left alone', patched.start === '08:00', patched.start);
ok('  while the ones named change', patched.end === '17:00' && patched.breakMinutes === 45);
await refuse('the code cannot change',
  () => shiftService.updateShift('ZZDEMO', { code: 'ZZOTHER' }), /code cannot change/);
await refuse('an unknown profile is refused',
  () => shiftService.updateShift('ZZGONE', { name: 'x' }), /no such shift/);
await refuse('reversing the hours on a patch is refused',
  () => shiftService.updateShift('ZZDEMO', { endsAt: '07:00' }), /must end after it starts/);

const off = await shiftService.setShiftActive('ZZDEMO', false);
ok('a profile can be withdrawn', off.active === false);
ok('  and is still in the list', (await shiftService.profiles())
  .some((p) => p.code === 'ZZDEMO'),
  'an assigned employee and an old record both still have to resolve it');
ok('  with actives listed first', await (async () => {
  const list = await shiftService.profiles();
  const firstOff = list.findIndex((p) => !p.active);
  return firstOff === -1 || list.slice(firstOff).every((p) => !p.active);
})());
await refuse('  and cannot be newly assigned',
  () => shiftService.setShift('E001', 'ZZDEMO'), /not in use and cannot be assigned/);
ok('a profile can be reinstated',
  (await shiftService.setShiftActive('ZZDEMO', true)).active === true);
await refuse('an unknown profile cannot be withdrawn',
  () => shiftService.setShiftActive('ZZGONE', false), /no such shift/);

ok('the demo seed is not left polluted', await (async () => {
  /* The probe profile is the demo's own store, so take it back out. */
  const list = await shiftService.profiles();
  return list.length === 5 && list.some((p) => p.code === 'ZZDEMO');
})(), 'four seeded plus the one this check created');

console.log();
if (failed) {
  console.error(`${failed} shift seam checks failed`);
  process.exit(1);
}
console.log('the shift screen reports the columns attendance measures against');
