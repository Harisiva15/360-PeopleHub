/**
 * When a payroll cycle may be processed, and when it may not.
 *
 * A real September 2026 run was processed from the UI during development, in
 * one click, on live data. The payslip survived — a payslip is stored rather
 * than recomputed, so nothing after it could change what was paid — but the
 * guard around `processRun` turned out to be thinner than it looked.
 *
 * It refused a `paid` cycle and nothing else. Two states walked straight past:
 *
 *   `locked` on a run that is not paid. The schema's CHECK runs one way — a
 *   paid run is always locked — so `locked = true, status = 'draft'` is a row
 *   the database permits, and processing it would have overwritten the
 *   payslips of a cycle somebody had deliberately closed.
 *
 *   `cancelled`. Processing one would have produced payslips and a bank advice
 *   for a month the company had decided not to pay.
 *
 * The rule is pure so it can be checked here without a database, and the
 * service calls exactly this function rather than restating it.
 */

import { refusalToProcess } from '../src/modules/payroll/rules.ts';

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

console.log('\na cycle that may be processed\n');

ok('a fresh draft is processable',
  refusalToProcess({ status: 'draft', locked: false }) === null);

console.log('\nand the four states that refuse\n');

{
  const r = refusalToProcess({ status: 'paid', locked: true });
  ok('paid is refused', r !== null);
  ok('  and says so plainly', r?.message.includes('already been paid'), r?.message);
  ok('  with a code that maps to 409', !['forbidden', 'not_found', 'invalid'].includes(r?.code ?? ''),
    `code was ${r?.code} — app.ts maps forbidden/not_found/invalid to 403/404/400 and `
    + 'everything else to 409, which is what a repeated process is');
}

{
  const r = refusalToProcess({ status: 'cancelled', locked: false });
  ok('cancelled is refused', r !== null,
    'a cancelled cycle used to process, producing payslips and a bank advice for '
    + 'a month the company had decided not to pay');
  ok('  and names cancellation rather than payment', r?.message.includes('cancelled'), r?.message);
}

{
  const r = refusalToProcess({ status: 'draft', locked: true });
  ok('a locked draft is refused', r !== null,
    'the schema permits locked on a non-paid run — CHECK (status <> \'paid\' OR ...) '
    + 'only constrains the paid direction — and this used to process');
  ok('  and names the lock, not the status', r?.message.includes('locked'), r?.message);
}

{
  const r = refusalToProcess({ status: 'processing', locked: false });
  ok('a cycle mid-process is refused', r !== null);
}

console.log('\nevery status the schema defines is decided\n');

/* 0005: CHECK (status IN ('draft', 'processing', 'paid', 'cancelled')) */
const STATUSES = ['draft', 'processing', 'paid', 'cancelled'];
for (const status of STATUSES) {
  for (const locked of [false, true]) {
    const r = refusalToProcess({ status, locked });
    const shouldPass = status === 'draft' && !locked;
    ok(`${status.padEnd(11)} locked=${String(locked).padEnd(5)} -> ${shouldPass ? 'process' : 'refuse'}`,
      (r === null) === shouldPass,
      `got ${r === null ? 'processable' : `refused: ${r.message}`}`);
  }
}

/*
 * An unknown status must refuse rather than fall through. If somebody adds a
 * state to the schema and not to this function, the safe default is to decline
 * — a payroll run is not the place to guess.
 */
/*
 * The allowlist. Only `draft` processes, so a state added to the schema later
 * and forgotten here fails closed — a payroll that will not run, rather than
 * one that runs on a cycle nobody approved.
 */
console.log('\nan unrecognised status fails closed\n');
{
  const r = refusalToProcess({ status: 'under_review', locked: false });
  ok('a status this function has never heard of is refused', r !== null,
    'it fell through to processable — the guard is a denylist and anything '
    + 'added to the schema later escapes it');
  ok('  and the message names the status', r?.message.includes('under_review'), r?.message);
}

console.log(failed ? `\n${failed} failed\n` : '\nevery run state is accounted for\n');
process.exit(failed ? 1 : 0);
