/**
 * The lifecycle actions reach the server, and only the right people see them.
 *
 * Two server operations existed with routes, tests and no way to invoke them:
 * the drawer said "Probation review due" and offered nothing to press. This is
 * the wiring, and these are the claims worth holding about it.
 *
 * The first is that the buttons call the contract. A dialog that closed and
 * toasted would look identical to one that saved, which is the failure this
 * project has already found twenty-eight times — so the assertions are about
 * which service method the handler names, not about what the screen renders.
 *
 * The second is that visibility is *only* a convenience. Hiding a button is
 * not a permission, and the service refuses an employee and an out-of-scope
 * manager whatever the screen does. What is asserted here is that the screen
 * does not pretend otherwise: no local role check stands in for the server's,
 * and every refusal shown is the server's own message.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { mockServices } from '../src/services/mock';
import { createHttpServices } from '../src/services/http';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const index = read('src/modules/lifecycle/index.tsx');
const data = read('src/modules/lifecycle/data.ts');
const code = strip(index);

/* ------------------------------------------------------------------ *
 * 1. The contract is real, and both ends of it are mapped
 * ------------------------------------------------------------------ */

console.log('\nboth operations are backed by the API\n');

const merged = createHttpServices(mockServices) as unknown as Record<string, Record<string, unknown>>;
const mock = mockServices as unknown as Record<string, Record<string, unknown>>;

for (const m of ['confirmProbation', 'promote']) {
  ok(`lifecycle.${m} exists on the contract`, typeof mock.lifecycle![m] === 'function');
  ok(`  and goes to the server, not the mock`, merged.lifecycle![m] !== mock.lifecycle![m],
    'an unmapped method falls through to the in-memory implementation and the '
    + 'screen cannot tell the difference');
}
ok('config.grades exists', typeof mock.config!.grades === 'function');
ok('  and is mapped to the API', merged.config!.grades !== mock.config!.grades);

/* ------------------------------------------------------------------ *
 * 2. The hooks call those methods
 * ------------------------------------------------------------------ */

console.log('\nthe hooks name the contract methods\n');

ok('useConfirmProbation calls lifecycle.confirmProbation',
  /useConfirmProbation[\s\S]*?s\.lifecycle\.confirmProbation\(/.test(data));
ok('usePromote calls lifecycle.promote',
  /usePromote[\s\S]*?s\.lifecycle\.promote\(/.test(data));
ok('useGrades calls config.grades',
  /useGrades[\s\S]*?s\.config\.grades\(/.test(data));

ok('every hook passes the caller',
  /confirmProbation\(c,/.test(data) && /promote\(c,/.test(data),
  'the service scopes by caller; a hook that dropped it would be asking as nobody');

/* ------------------------------------------------------------------ *
 * 3. The handlers await, and only then report success
 * ------------------------------------------------------------------ */

console.log('\nsuccess is reported after the mutation, never before\n');

for (const [form, hook, verb] of [
  ['ConfirmProbationForm', 'confirm', 'confirmed'],
  ['PromoteForm', 'promote', 'promoted'],
] as const) {
  const start = code.indexOf(`function ${form}`);
  const end = code.indexOf('\n}', code.indexOf('return (', start));
  const body = code.slice(start, end);

  ok(`${form} awaits the mutation`, /await\s+\w+\.mutate\(/.test(body));
  ok(`  and toasts only after it`,
    body.indexOf('await') < body.indexOf('app.toast'),
    'a toast before the await reports a result nobody has yet');
  ok(`  shows the server's own message on failure`,
    /catch \(e\)[\s\S]*?setErr\(msg\(e,/.test(body),
    'not a message of its own — the service says why it refused');
  ok(`  refreshes afterwards`, /done\(\)/.test(body),
    'the drawer must re-read, or it shows the state from before the change');
  ok(`  disables the button while in flight`,
    new RegExp(`${hook}\\.pending`).test(body));
  ok(`  and says ${verb} rather than something vaguer`,
    body.includes(verb), verb);
}

ok('neither form fakes a result',
  !/setTimeout/.test(code) && !/Promise\.resolve\(\s*true\s*\)/.test(code),
  'no timer stands in for a round trip');

/* ------------------------------------------------------------------ *
 * 4. Visibility, and what it is not
 * ------------------------------------------------------------------ */

console.log('\nvisibility is a convenience, not the rule\n');

ok('an employee is not offered either action',
  /app\.role !== 'employee'/.test(code),
  'the service refuses them too — this only avoids offering what will be refused');
ok('neither action is offered for an alumnus',
  /d\.standing\.stage !== 'Alumni'/.test(code));
ok('probation confirmation appears only while there is one to confirm',
  /d\.standing\.stage === 'Joined'/.test(code),
  'the derivation keeps somebody in Joined until a probation_confirmed record '
  + 'exists, so that stage is the condition');

/*
 * The scope question. A manager sees the drawer only for people the *service*
 * returned, because `useLifecycleRow` is the service call — so there is no
 * client-side scope test to get wrong, and none should appear.
 */
ok('no client-side team check stands in for the server scope',
  !/isMyReport|visibleIds|managerId === /.test(code),
  'scope belongs to the service; a second copy here would drift from it');

ok('the drawer reads the row from the service',
  /useLifecycleRow\(id\)/.test(code));

/* ------------------------------------------------------------------ *
 * 5. Dates are bounded where they are typed
 * ------------------------------------------------------------------ */

console.log('\nthe date inputs match the rules the service enforces\n');

const probation = code.slice(code.indexOf('function ConfirmProbationForm'),
  code.indexOf('function PromoteForm'));

ok('confirmation cannot be dated in the future', /max=\{today\}/.test(probation),
  'the service refuses it; the input should not offer it');
ok('nor before the joining date', /min=\{d\.subject\.startOn\}/.test(probation));
ok('and it defaults to today', /useState\(today\)/.test(probation));
ok('a promotion cannot be dated before the joining date',
  /min=\{d\.subject\.startOn\}/.test(code.slice(code.indexOf('function PromoteForm'))));

/* ------------------------------------------------------------------ *
 * 6. The promotion form uses the real ladder
 * ------------------------------------------------------------------ */

console.log('\nthe grade ladder comes from the database\n');

ok('the form reads grades from the service', /useGrades\(\)/.test(code));
/*
 * Against the stripped source. The comment above the form explains *why* it
 * does not read GRADES, and a check that matched its own explanation would
 * fail for saying the right thing — which this project has now done three
 * times.
 */
ok('  not from the GRADES constant',
  !/\bGRADES\b/.test(code),
  'src/data/org.ts has drifted from grade_band — L4 is 3,400,000 there and '
  + '3,500,000 in the database');

/* The JSX wraps its prose across lines, so match it flattened. */
const flat = index.replace(/\s+/g, ' ');
ok('a lower band is offered disabled rather than hidden',
  /disabled=\{currentRank !== null && b\.rank < currentRank\}/.test(code),
  'hiding it leaves somebody hunting for the demotion that is deliberately absent');
/* Wrapped prose: the words are split across lines in the JSX. */
ok('and the form says where to record a move down instead',
  /change of role/i.test(flat));
ok('an employee with no grade is not shown as holding one',
  /None recorded/.test(flat),
  'the employee mapper coalesces a missing grade to L1; this reads the '
  + 'lifecycle subject, which keeps it null');

/* ------------------------------------------------------------------ *
 * 7. Nothing else grew a promotion button
 * ------------------------------------------------------------------ */

console.log('\npromotion is recorded in one place\n');

const screens = execSync('git ls-files src/modules', { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => /\.tsx$/.test(f));
const promoters = screens.filter((f) =>
  f !== 'src/modules/lifecycle/index.tsx' && /\.promote\(/.test(read(f)));
ok('only the lifecycle drawer records a promotion', promoters.length === 0,
  `${promoters.join(', ')} — an ordinary edit form labelled "promotion" is exactly `
  + 'what the server refuses to infer');

console.log(failed
  ? `\n${failed} problem(s)`
  : '\nthe lifecycle actions call the server, and hide nothing the server allows');
process.exit(failed ? 1 : 0);
