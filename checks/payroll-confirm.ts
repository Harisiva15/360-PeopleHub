/**
 * Processing payroll cannot be one click again.
 *
 * A real September 2026 cycle was processed from the runs screen during
 * development, on live data, by a single click on a button that sat where
 * "Register" and "Payslips" sit. Processing locks the cycle, freezes payslips
 * and generates a bank advice; nothing about the click said so.
 *
 * The fix is a confirmation that names the month and the head count, behind an
 * explicit acknowledgement. This checks the fix is still there, because the
 * way it would come back is somebody wiring a new Process button straight to
 * the mutation — which is what the old one did and which looks perfectly
 * reasonable in a diff.
 *
 * What this cannot check is the server, which is where the actual protection
 * lives: `server/scripts/payroll-run.test.mjs` covers the states that refuse.
 * A confirmation the client can skip protects nobody; this one exists so the
 * click is deliberate, not so the rule is enforced.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * 1. Nothing processes payroll without going through the dialog
 * ------------------------------------------------------------------ */

console.log('\nprocessing payroll goes through a confirmation\n');

const files = execSync('git ls-files src', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.tsx?$/.test(f));

/*
 * `processRun.mutate(...)` inside an onClick is the shape that caused this.
 * Calling it from the confirmation's onConfirm is the whole point, so the
 * dialog's own caller is identified by name rather than by pattern.
 */
const THROUGH_THE_DIALOG = 'src/modules/payroll/index.tsx';
const direct: string[] = [];

for (const rel of files) {
  const src = read(rel);
  for (const m of src.matchAll(/onClick=\{[^}]*?processRun\.mutate/gs)) {
    direct.push(`${rel}: ${m[0].slice(0, 60).replace(/\s+/g, ' ')}`);
  }
}
ok('no onClick calls processRun.mutate directly', direct.length === 0,
  `${direct.join('\n        ')}\n        `
  + 'Processing locks the cycle and generates a bank advice. It goes through '
  + 'ProcessConfirmation, whose onConfirm calls the mutation.');

{
  const src = read(THROUGH_THE_DIALOG);
  ok('the runs screen renders ProcessConfirmation', src.includes('<ProcessConfirmation'),
    'the confirmation is not mounted anywhere — the dialog exists and nothing opens it');
  ok('and the mutation is called from its onConfirm',
    /onConfirm=\{async \(\) => \{\s*await processRun\.mutate/.test(src),
    'the dialog is shown but does not actually process, or processes elsewhere');
}

/* ------------------------------------------------------------------ *
 * 2. The dialog says what is about to happen
 * ------------------------------------------------------------------ */

console.log('\nthe dialog names what is being agreed to\n');

/*
 * Comments stripped first. This file's own docstring quotes the phrase the
 * last assertion forbids — explaining why the dialog does not say "are you
 * sure" would otherwise fail the check for saying it.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const dialog = stripComments(read('src/modules/payroll/ProcessConfirm.tsx'));

ok('it names the payroll period', /Payroll period/.test(dialog)
  && /monthLabelLong\(run\.mk\)/.test(dialog),
  'somebody who clicked the wrong row has to be able to see the wrong month here');
ok('it shows the employee count', /Employees/.test(dialog) && /run\.count/.test(dialog));
ok('it shows the estimated gross', /gross payroll/i.test(dialog) && /run\.gross/.test(dialog));
ok('it shows the estimated net', /net payroll/i.test(dialog) && /run\.net/.test(dialog));
ok('it says payslips will be generated', /Payslips/.test(dialog));
ok('it says a bank batch will be generated', /Bank batch/i.test(dialog));
ok('it says the run will be locked', /lock/i.test(dialog));

ok('it is not a generic "are you sure"', !/are you sure/i.test(dialog),
  'a generic prompt teaches people to dismiss prompts');

/* ------------------------------------------------------------------ *
 * 3. The acknowledgement is required, and double submit is guarded
 * ------------------------------------------------------------------ */

console.log('\nthe acknowledgement and the double-submit guard\n');

ok('there is a checkbox to acknowledge', /type="checkbox"/.test(dialog));
ok('the confirm button is disabled until it is checked',
  /disabled=\{!understood \|\| busy\}/.test(dialog),
  'the button must require both the acknowledgement and a settled request');
ok('the acknowledgement names locking and the bank advice',
  /I understand that processing this payroll will lock/.test(dialog));

ok('a second submit is refused in the handler, not only by the disabled button',
  /if \(busy\) return;/.test(dialog),
  'a disabled button is a picture of the state, not the state itself — a double '
  + 'click or a keyboard repeat can land before the re-render');
ok('the button reports that it is working', /Processing…/.test(dialog));

/* ------------------------------------------------------------------ *
 * 4. A locked cycle offers no way to process it
 * ------------------------------------------------------------------ */

console.log('\na locked cycle is shown as locked\n');

{
  const src = read(THROUGH_THE_DIALOG);
  ok('the banner shows Locked instead of the button when locked',
    /CUR_RUN\.locked \|\| CUR_RUN\.status === 'Paid'/.test(src),
    'a locked cycle must not offer a button the server will refuse');
  ok('the runs table marks locked rows', /r\.locked && \(/.test(src),
    'locked is a separate fact from the status — the schema permits a locked '
    + 'run that is not paid, and a status column alone would not say so');
  ok('the per-row Process button is hidden once locked',
    /!r\.locked && r\.status !== 'Paid'/.test(src));
}

/* ------------------------------------------------------------------ *
 * 5. A manager's payroll is their own and nothing else
 * ------------------------------------------------------------------ */

console.log('\na manager reaches only their own pay\n');

{
  const payroll = read('src/modules/payroll/index.tsx');
  const nav = read('src/nav.ts');

  /*
   * Team Cost was a manager-only tab summing the line's CTC. It leaked
   * nothing — `maySeePay` is admin-only and a manager receives `ctc: 0` — and
   * that was the problem: it rendered a confident ₹0 for the one role it
   * existed for, while implying managers have a view of what their team costs.
   * The policy says they do not.
   */
  ok('the Team Cost screen is gone', !/PyTeamCost/.test(payroll),
    'a manager-only payroll screen that sums salaries contradicts the policy, '
    + 'which grants a manager `own` on payroll and nothing more');
  ok('no payroll tab is named team', !/v: 'team'/.test(payroll));
  ok('the menu offers no team payroll', !/'\/payroll\?v=team'/.test(nav));

  /* Whatever the manager list becomes, it must stay self-service. */
  const managerTabs = payroll.match(/app\.role === 'manager'\s*\?\s*\[([^\]]*)\]/)?.[1] ?? '';
  const labels = [...managerTabs.matchAll(/label: '([^']+)'/g)].map((m) => m[1]!);
  ok(`a manager is offered only their own payslips (${labels.join(', ') || 'none'})`,
    labels.length === 1 && labels[0] === 'My Payslips',
    `manager tabs are: ${labels.join(', ')} — anything beyond the caller's own `
    + 'record needs a policy change, not a tab');
}

console.log(failed
  ? `\n${failed} failed\n`
  : '\nprocessing payroll is deliberate, a locked cycle says so, '
    + 'and a manager sees only their own\n');
process.exit(failed ? 1 : 0);
