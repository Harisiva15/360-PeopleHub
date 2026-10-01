/**
 * No demo id can reach the real API.
 *
 * ## The bug
 *
 * `src/data/employees.ts` numbers its people `E001`…`E0NN`. The real database
 * keys employees by uuid, so one of those reaching the API is rejected by
 * Postgres while it parses the parameter:
 *
 *     22P02  invalid input syntax for type uuid: "E008"
 *     22P02  invalid input syntax for type uuid: "E001"
 *
 * Both lines appeared in the production logs on every single sign-in.
 *
 * `AppProvider` seeded `role` and `meId` from `ACCOUNTS()` — the demo dataset —
 * and replaced them only after `users.me()` came back. Screens query on mount,
 * so the render in between sent the demo HR head's id. `me` was `EMAP[meId]`,
 * whose `managerId` is `E001`, and `expenses/index.tsx` asked for both at once:
 *
 *     usePeople([app.meId, app.me.managerId])    // ['E008', 'E001']
 *
 * ## What this holds
 *
 * Three things, and the first is the one that matters.
 *
 * 1. **The seed.** In API mode nothing in `AppProvider` may come from
 *    `ACCOUNTS()`, `EMAP` or any other `src/data` export — not even for one
 *    render, because one render is all it took.
 *
 * 2. **The gate.** `AuthGate` must wait on `identityReady`, so no screen
 *    renders while the identity is still in flight. This is what makes the
 *    class of bug unreachable rather than fixed case by case: a new screen
 *    written the obvious way cannot reintroduce it.
 *
 * 3. **The guard.** `assertNoDemoIds` refuses an `E###` in a path, a query
 *    value or a body, in the one function every request passes through. The
 *    net, not the fix — but it is what turns "we found all the call sites" into
 *    something a build can check.
 *
 * Comments are stripped before every assertion. This file names the very
 * identifiers it forbids, and so does the code it reads; a check that matches
 * its own explanation of the fix is a check that passes for the wrong reason,
 * which this project has now done three times.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ApiError, assertNoDemoIds } from '../src/services/http/client';
import { ACCOUNTS } from '../src/state/rbac';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

/** Source with comments and string literals' innards left alone, comments gone. */
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/* The ids the demo dataset actually uses, so the test data is not invented. */
const DEMO = ACCOUNTS().map((a) => a.empId);

console.log('\nthe demo ids this guards against are real ones\n');

ok('the demo accounts are E###-shaped', DEMO.every((id) => /^E\d{3}$/.test(id)), DEMO.join(', '));
ok('  and E008 is among them, as the logs showed', DEMO.includes('E008'), DEMO.join(', '));

console.log('\nthe guard refuses them, wherever they sit\n');

const refuses = (label: string, run: () => void, expect: RegExp) => {
  let e: unknown = null;
  try { run(); } catch (err) { e = err; }
  ok(label, e !== null, 'the request was allowed through');
  if (e) {
    const m = e instanceof Error ? e.message : String(e);
    ok('    and names what it found', expect.test(m), m);
    ok('    as an ApiError, so a screen can show it', e instanceof ApiError);
  }
};

refuses('a demo id in a path segment',
  () => assertNoDemoIds('GET', '/employees/E008'), /path segment "E008"/);
refuses('  and deeper in the path',
  () => assertNoDemoIds('GET', '/employees/E008/team'), /path segment "E008"/);
refuses('a demo id in a query value',
  () => assertNoDemoIds('GET', '/employees/by-ids?ids=E001'), /query ids="E001"/);
refuses('  one among several, which is how byIds sends them',
  () => assertNoDemoIds('GET', '/employees/by-ids?ids=E008,E001'), /E008/);
refuses('  mixed with a real uuid',
  () => assertNoDemoIds(
    'GET', '/employees/by-ids?ids=3f1c9a62-1111-4222-8333-444455556666,E001'),
  /query ids="E001"/);
refuses('  url-encoded',
  () => assertNoDemoIds('GET', '/leave?empId=%45001'), /E001/);
refuses('a demo id in a body field',
  () => assertNoDemoIds('POST', '/leave', { empId: 'E043' }), /body\.empId="E043"/);
refuses('  inside an array',
  () => assertNoDemoIds('POST', '/x', { ids: ['ok', 'E001'] }), /body\.ids\[1\]="E001"/);
refuses('  nested in an object',
  () => assertNoDemoIds('POST', '/x', { a: { b: { c: 'E002' } } }), /body\.a\.b\.c="E002"/);

/*
 * The exact call the production logs recorded. `usePeople` sorts and joins the
 * ids it is given, so this is the request `expenses/index.tsx` produced.
 */
refuses('the call the logs actually showed',
  () => assertNoDemoIds('GET', `/employees/by-ids?ids=${['E008', 'E001'].sort().join(',')}`),
  /E001|E008/);

console.log('\nand lets real traffic through\n');

const allows = (label: string, run: () => void) => {
  let e: unknown = null;
  try { run(); } catch (err) { e = err; }
  ok(label, e === null, e instanceof Error ? e.message : String(e));
};

allows('a uuid path', () => assertNoDemoIds(
  'GET', '/employees/3f1c9a62-1111-4222-8333-444455556666'));
allows('a uuid list', () => assertNoDemoIds(
  'GET', '/employees/by-ids?ids=3f1c9a62-1111-4222-8333-444455556666'));
allows('an employee code, which is not an id', () => assertNoDemoIds(
  'GET', '/employees/by-ids?ids=VHM004'));
allows('a department code', () => assertNoDemoIds('PUT', '/config/departments/ENG', { name: 'x' }));
allows('a project code', () => assertNoDemoIds('PUT', '/projects/P-ATLAS', { name: 'x' }));
allows('a site code', () => assertNoDemoIds('GET', '/attendance?site=BLR'));
allows('a four-digit E, which is no demo id', () => assertNoDemoIds('GET', '/x/E0012'));
allows('a two-digit E, likewise', () => assertNoDemoIds('GET', '/x/E01'));
allows('a timesheet entry id', () => assertNoDemoIds('DELETE', '/timesheets/a/entries/TSE-9001'));
allows('an empty body', () => assertNoDemoIds('POST', '/x'));
allows('a month', () => assertNoDemoIds('GET', '/payroll/cycles?month=2026-09'));

console.log('\nthe identity in API mode comes only from the server\n');

{
  const ctx = read('src/state/AppContext.tsx');

  /*
   * The seed. `useState(apiMode ? … : start.…)` is the shape that matters: a
   * ternary on apiMode, with the demo value only in the demo branch.
   */
  const seedsRole = /useState<AppRole>\(\s*apiMode \?/.test(ctx);
  const seedsMeId = /useState<string>\(\s*apiMode \?/.test(ctx);
  ok('role is not seeded from the demo accounts in API mode', seedsRole,
    'AppProvider must not start from ACCOUNTS() when the API is configured');
  ok('meId is not either', seedsMeId,
    'one render with a demo meId is what sent E008 to Postgres');

  ok('  and the API-mode seeds carry no demo value',
    /apiMode \? 'employee' :/.test(ctx) && /apiMode \? '' :/.test(ctx),
    'the apiMode branch of each seed must be a literal, not an ACCOUNTS() lookup');

  ok('me is not read out of the demo map in API mode',
    /apiMode \? resolved\.me : EMAP\[meId\]/.test(ctx),
    'EMAP[meId] with a real uuid is undefined typed as Employee — '
    + 'that is where me.managerId threw, and where E001 came from');

  ok('the role switcher refuses to run in API mode',
    /if \(apiMode\) return;/.test(ctx),
    'signInAs picks a person out of src/data; it must be inert against a real tenant');

  ok('the resolver reads the employee row from the server',
    /employees\.byIds\(\[empId\]\)/.test(ctx),
    'app.me must be the server\'s row — the screens read managerId and ctc off it');

  ok('  and does not fall back to the demo row when it fails',
    !/catch[\s\S]{0,400}EMAP\[/.test(ctx),
    'falling back is the bug: it is what put a demo id on the wire');

  ok('an account with no employee record is reported, not guessed around',
    /not linked to an employee record/.test(ctx));
}

console.log('\nand no screen renders until it has\n');

{
  const app = read('src/App.tsx');
  ok('AuthGate waits on identityReady', /if \(!app\.identityReady\)/.test(app),
    'without this, screens mount and query while the identity is in flight');
  ok('  and offers a way out when it cannot be established',
    /identityError/.test(app) && /retryIdentity/.test(app),
    'a permanent spinner is worse than a message');

  /* The gate must sit before children render, not after. */
  const gateAt = app.indexOf('app.identityReady');
  const childrenAt = app.lastIndexOf('return <>{children}</>');
  ok('  before children are returned', gateAt > 0 && gateAt < childrenAt,
    `identityReady at ${gateAt}, children at ${childrenAt}`);
}

console.log('\nthe guard is wired into the one place every request passes\n');

{
  const client = read('src/services/http/client.ts');
  ok('request() calls the guard', /async function request[\s\S]{0,200}assertNoDemoIds\(/.test(client),
    'a guard that is not called is a comment');
  ok('  before the token is fetched, so it costs nothing to refuse',
    client.indexOf('assertNoDemoIds(method') < client.indexOf('await bearerToken()'));
  ok('  and before fetch',
    client.indexOf('assertNoDemoIds(method') < client.indexOf('await fetch('));
}

console.log(failed
  ? `\n${failed} failed\n`
  : '\nno demo id can reach the API, and none is held even briefly\n');
process.exit(failed ? 1 : 0);
