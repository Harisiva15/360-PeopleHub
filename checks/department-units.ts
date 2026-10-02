/**
 * A department belongs to a business unit, and reports to a department.
 *
 * Two relationships, one screen, and in both cases the demo must agree with the server.
 *
 * `department.business_unit_id` arrived in `0052_department_business_unit.sql` as a
 * nullable column with a composite foreign key, so the database refuses three
 * things: a unit that does not exist, a unit in another tenant, and — by way of
 * `resolveBusinessUnit` in `server/src/modules/config/service.ts` — a unit that
 * has been deactivated. Only the first of those is a type error. The rest are
 * refusals that arrive at runtime, and the demo is where most people meet this
 * screen, so a demo that accepts what the server refuses teaches the wrong thing.
 *
 * Four assurances:
 *
 *   1. The demo seed is an arrangement the server would also allow. Every
 *      assigned department names a unit that exists and is active, and at least
 *      one department is left unassigned, because the column is nullable and a
 *      column that is never null in the demo hides half of its behaviour.
 *   2. The demo refuses what the server refuses, and accepts what it accepts —
 *      including the exception that matters: a department already naming a unit
 *      that has since been deactivated stays editable. Without that exception the
 *      form, which sends the whole record, could not save such a department at all.
 *   3. Absent, null and a code mean three different things. Absent leaves the
 *      assignment alone; null clears it; a code sets it. A patch that renames a
 *      department must not disturb which unit it reports into.
 *   4. The form offers units from the service rather than a constant, and the list
 *      prints the resolved name. The whole point of the join is that the screen
 *      shows a name rather than a uuid.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configService } from '../src/services/mock/config';
import { inTreeOrder, subtreeOf } from '../src/lib/orgtree';
import type { Department } from '../src/services';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/** Comments describe intent; they are not evidence of it. */
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const refused = async (f: () => Promise<unknown>): Promise<string | null> => {
  try { await f(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

const units = await configService.businessUnits();
const depts = await configService.departments();
const byCode = (ds: Department[], c: string) => ds.find((d) => d.code === c)!;

/* ------------------------------------------------------------------ *
 * 1. the seed is an arrangement the server would allow
 * ------------------------------------------------------------------ */

console.log('\nthe demo ships an arrangement the server would also accept\n');

const assigned = depts.filter((d) => d.businessUnitCode !== null);

ok('some departments report into a unit', assigned.length > 0,
  'every row would read Unassigned and the column would show nothing');
ok('and at least one does not', assigned.length < depts.length,
  'the column is nullable — the demo should show that state too');

for (const d of assigned) {
  const u = units.find((x) => x.code === d.businessUnitCode);
  ok(`${d.code} names ${d.businessUnitCode}, which exists`, u !== undefined,
    `${d.businessUnitCode} is not in the business unit list`);
  ok(`  and is active`, u?.active === true,
    'the server refuses an inactive unit, so the demo must not seed one');
  ok(`  and the name is resolved, not left blank`,
    d.businessUnitName === u?.name,
    `list shows ${JSON.stringify(d.businessUnitName)}, unit is ${JSON.stringify(u?.name)}`);
}

/* ------------------------------------------------------------------ *
 * 2. the demo refuses what the server refuses
 * ------------------------------------------------------------------ */

console.log('\nthe refusals match the ones resolveBusinessUnit raises\n');

const free = depts.find((d) => d.businessUnitCode === null)!;
const inactive = units.find((u) => !u.active);

ok('an unknown code is refused',
  (await refused(() => configService.updateDepartment(free.code, { businessUnitCode: 'NOSUCH' })))
    ?.includes('no such business unit') === true);

ok('an inactive unit cannot be newly assigned', inactive !== undefined
  && (await refused(() => configService
    .updateDepartment(free.code, { businessUnitCode: inactive.code })))
    ?.includes('inactive') === true,
  'the server says so, and a form that let it through would show a refusal it never explained');

ok('a code is matched case-insensitively, as the server upper-cases it',
  (await configService.updateDepartment(free.code, { businessUnitCode: units[0].code.toLowerCase() }))
    .businessUnitCode === units[0].code);

ok('and the name comes back with it',
  (await configService.departments()).find((d) => d.code === free.code)?.businessUnitName
    === units[0].name);

ok('null clears the assignment',
  (await configService.updateDepartment(free.code, { businessUnitCode: null }))
    .businessUnitCode === null);

/* The exception the form depends on: a unit deactivated after it was assigned. */
const victim = byCode(depts, assigned[0].code);
const heldUnit = victim.businessUnitCode!;
await configService.setBusinessUnitActive(heldUnit, false);

/* Refused rather than asserted on, so a regression reports a FAIL instead of crashing. */
const resaveFailure = await refused(() => configService.updateDepartment(
  victim.code, { name: victim.name, businessUnitCode: heldUnit }));
ok('a department naming a now-inactive unit can still be saved',
  resaveFailure === null
  && (await configService.departments()).find((d) => d.code === victim.code)
    ?.businessUnitCode === heldUnit,
  resaveFailure ?? 'the form sends the whole record, so refusing this makes it uneditable');

ok('but that unit still cannot be given to another department',
  (await refused(() => configService
    .updateDepartment(free.code, { businessUnitCode: heldUnit })))?.includes('inactive') === true);

await configService.setBusinessUnitActive(heldUnit, true);

/* ------------------------------------------------------------------ *
 * 3. absent, null and a code are three different instructions
 * ------------------------------------------------------------------ */

console.log('\nabsent leaves the assignment alone\n');

const renamed = await configService.updateDepartment(victim.code, { name: victim.name });
ok('a rename does not disturb the unit', renamed.businessUnitCode === heldUnit,
  `became ${renamed.businessUnitCode}`);

const recoloured = await configService.updateDepartment(victim.code, { colour: victim.colour });
ok('nor does a colour change', recoloured.businessUnitCode === heldUnit);

const made = await configService.createDepartment({
  code: 'ZZUNIT', name: 'Probe', colour: null, headId: null,
  businessUnitCode: units.find((u) => u.active)!.code,
});
ok('a new department may be created already assigned',
  made.businessUnitCode === units.find((u) => u.active)!.code);
ok('and one may be created unassigned',
  (await configService.createDepartment(
    { code: 'ZZFREE', name: 'Probe two', colour: null, headId: null })).businessUnitCode === null);
await configService.removeDepartment('ZZUNIT');
await configService.removeDepartment('ZZFREE');

/* ------------------------------------------------------------------ *
 * 4. the screen reads the service, and prints the name
 * ------------------------------------------------------------------ */

console.log('\nthe department screen offers units from the service\n');

const cfg = code('src/modules/settings/config.tsx');
const form = cfg.slice(cfg.indexOf('function DeptForm'), cfg.indexOf('export function OrgTab'));
const org = cfg.slice(cfg.indexOf('export function OrgTab'));

ok('OrgTab reads the units from the service', org.includes('useBusinessUnits()'),
  'a constant would offer units the server has never heard of');
ok('and hands them to the form', /<DeptForm[\s\S]*?units=\{units\}/.test(org));
ok('the form builds its options from that prop', /units\.filter\(/.test(form)
  && form.includes('.map((u)'),
  'the select must come from the list, not from a literal');
ok('an inactive unit is not offered unless it is already assigned',
  /u\.active \|\| u\.code === initial\.businessUnitCode/.test(form),
  'offering every unit would let the form propose what the server refuses');
ok('the empty option sends null rather than an empty string',
  /businessUnitCode: e\.target\.value \|\| null/.test(form),
  "'' is not a code, and the service reads null as clear-the-assignment");
ok('the draft carries the current assignment in', org.includes('existing?.businessUnitCode'),
  'opening the form on a department would otherwise clear its unit on save');

ok('the department list prints the resolved name', org.includes('d.businessUnitName'),
  'the join exists so a person reads a name instead of a uuid');
ok('and says so plainly when there is none', /Unassigned/.test(org));
ok('the list does not print the raw id', !/d\.businessUnitId/.test(org));


/* ------------------------------------------------------------------ *
 * 5. a department reports to a department
 * ------------------------------------------------------------------ */

console.log('\nthe tree functions hold their two properties\n');

interface Node { id: string; parentId: string | null; name: string }
const chain: Node[] = [
  { id: 'a', parentId: null, name: 'Alpha' },
  { id: 'b', parentId: 'a', name: 'Bravo' },
  { id: 'c', parentId: 'b', name: 'Charlie' },
  { id: 'z', parentId: null, name: 'Zulu' },
];

const sub = subtreeOf(chain, 'a');
ok('subtreeOf includes the root itself', sub.has('a'));
ok('  its child', sub.has('b'));
ok('  and its grandchild — the descendant the server refuses as a parent',
  sub.has('c'), [...sub].join(','));
ok('  and nothing else', !sub.has('z'), [...sub].join(','));
ok('a leaf has only itself', [...subtreeOf(chain, 'c')].join(',') === 'c');

/* The property that makes the selector correct: a current parent stays offerable. */
ok('a department\'s own parent is never excluded from its options',
  !subtreeOf(chain, 'c').has('b'),
  'reopening the form would otherwise blank the parent and clear it on save');

const order = inTreeOrder(chain).map((r) => `${r.node.id}:${r.depth}`).join(' ');
ok('inTreeOrder nests children under parents, each level by name',
  order === 'a:0 b:1 c:2 z:0', order);

/* A cycle must not hang or swallow rows. */
const looped: Node[] = [
  { id: 'p', parentId: 'q', name: 'Pp' },
  { id: 'q', parentId: 'p', name: 'Qq' },
  { id: 'r', parentId: null, name: 'Rr' },
];
const loopOrder = inTreeOrder(looped);
ok('a cycle does not hang the walk', loopOrder.length === 3, String(loopOrder.length));
ok('  and no row is dropped by it',
  loopOrder.map((r) => r.node.id).sort().join(',') === 'p,q,r',
  loopOrder.map((r) => r.node.id).join(','));
ok('a parent outside the list is treated as no parent',
  inTreeOrder([{ id: 'x', parentId: 'gone', name: 'Xx' }]).length === 1);
ok('subtreeOf terminates on a cycle', subtreeOf(looped, 'p').size === 2);

console.log('\nthe demo ships a hierarchy, so the column shows something\n');

const fresh = await configService.departments();
const nested = fresh.filter((d) => d.parentId !== null);
ok('some demo departments report to another', nested.length > 0,
  'every row would read Top level and the column would show nothing');
ok('and some are top-level', nested.length < fresh.length,
  'null is the ordinary state and the demo should show it');
for (const d of nested) {
  const parent = fresh.find((x) => x.id === d.parentId);
  ok(`${d.code} reports to ${parent?.code ?? '??'}, which exists`, parent !== undefined,
    `parentId ${d.parentId} matches no department`);
  ok('  and is not itself', parent?.id !== d.id);
}
ok('the demo hierarchy agrees with the demo business units',
  nested.every((d) => {
    const parent = fresh.find((x) => x.id === d.parentId);
    return parent === undefined || parent.businessUnitCode === d.businessUnitCode;
  }),
  'a child in a different division than its parent reads as two unrelated seeds');

console.log('\nthe demo refuses the cycles the server refuses\n');

/*
 * Everything below needs a nested department to push around. Reported and
 * skipped rather than crashed: a seed regression should read as one FAIL, not as
 * a stack trace that hides the rest of the file.
 */
const leaf = nested[0];
const parentOfLeaf = leaf ? fresh.find((d) => d.id === leaf.parentId) : undefined;
ok('the demo has a nested department to exercise',
  leaf !== undefined && parentOfLeaf !== undefined,
  'the refusals below cannot be checked without one');

if (leaf && parentOfLeaf) {

ok('a department cannot report to itself',
  (await refused(() => configService.updateDepartment(leaf.code, { parentId: leaf.id })))
    ?.includes('cannot report to itself') === true);

ok('a parent cannot be moved under its own child',
  (await refused(() => configService
    .updateDepartment(parentOfLeaf.code, { parentId: leaf.id })))
    ?.includes('report to itself') === true,
  'the server refuses this with a recursive walk');

ok('an unknown parent is refused',
  (await refused(() => configService.updateDepartment(leaf.code, { parentId: 'nope' })))
    ?.includes('no such department') === true);

ok('re-sending the parent it already has is accepted',
  (await configService.updateDepartment(leaf.code,
    { name: leaf.name, parentId: leaf.parentId })).parentId === leaf.parentId,
  'the form sends the whole record, so refusing this makes the department uneditable');

ok('a rename leaves the parent alone',
  (await configService.updateDepartment(leaf.code, { name: leaf.name })).parentId
    === leaf.parentId);

ok('null makes it top-level',
  (await configService.updateDepartment(leaf.code, { parentId: null })).parentId === null);
ok('  and the business unit survives that',
  (await configService.departments()).find((d) => d.code === leaf.code)?.businessUnitCode
    === leaf.businessUnitCode,
  'moving a department must not clear its division');
ok('and it can be put back',
  (await configService.updateDepartment(leaf.code, { parentId: parentOfLeaf.id })).parentId
    === parentOfLeaf.id);

const born = await configService.createDepartment(
  {
    code: 'ZZKID', name: 'Probe child', colour: null, headId: null,
    parentId: parentOfLeaf.id,
  });
ok('a department may be created under a parent', born.parentId === parentOfLeaf.id);
ok('and one may be created top-level',
  (await configService.createDepartment(
    { code: 'ZZTOP', name: 'Probe top', colour: null, headId: null })).parentId === null);
ok('a create with an unknown parent is refused',
  (await refused(() => configService.createDepartment(
    { code: 'ZZBAD', name: 'Probe bad', colour: null, headId: null, parentId: 'nope' })))
    ?.includes('no such department') === true);
await configService.removeDepartment('ZZKID');
await configService.removeDepartment('ZZTOP');
}

/* ------------------------------------------------------------------ *
 * 6. the screen offers the parent, and shows it
 * ------------------------------------------------------------------ */

console.log('\nthe department screen offers a parent and displays it\n');

ok('the form has a parent selector', /id="dept-parent"/.test(form),
  'the column has existed since 0002 and this is what exposes it');
ok('and it is labelled for a person, not for the column',
  /Reports to/.test(form), 'parent_id is not a label');
ok('the options leave out this department and its descendants',
  form.includes('subtreeOf(depts, selfId)') && /!excluded\.has\(d\.id\)/.test(form),
  'offering a descendant proposes the cycle the server refuses');
ok('  computed from the list rather than hard-coded', /depts\.filter\(/.test(form));
ok('the empty option sends null rather than an empty string',
  /parentId: e\.target\.value \|\| null/.test(form),
  "'' is not an id, and the service reads null as top-level");
ok('top level is offered as a real choice', /Top level/.test(form),
  'the column is nullable and most departments are top-level');
ok('an inactive department is still offered as a parent',
  /d\.active \? '' : ' \(inactive\)'/.test(form),
  'the server allows one, and hiding what the server allows is its own lie');
ok('the draft carries the current parent in', org.includes('existing?.parentId'),
  'opening the form on a nested department would otherwise clear its parent on save');
ok('the form is told which department it is editing',
  /selfId=\{existing\?\.id \?\? null\}/.test(org),
  'without it the form cannot exclude self');
ok('and is given the list to choose from', /depts=\{depts\}/.test(org));

ok('the list renders in tree order', org.includes('inTreeOrder(depts)'),
  'a flat alphabetical list hides the structure');
ok('  and indents by depth', /paddingLeft: 10 \+ depth \* 18/.test(org),
  'the indent is what makes the hierarchy readable');
ok('the list shows the parent by name', org.includes('nameOf(d.parentId)'),
  'a uuid is not a parent department');
ok('  and says Top level when there is none', /Top level/.test(org));
ok('the list shows the code', /<Badge>\{d\.code\}<\/Badge>/.test(org),
  'the code is what every other table joins on');
ok('the list does not print a raw parent id', !/\{d\.parentId\}/.test(org));

console.log();
if (failed) {
  console.error(`${failed} department/business-unit checks failed`);
  process.exit(1);
}
console.log('the demo offers the assignments and the parents the server accepts, and no others');
