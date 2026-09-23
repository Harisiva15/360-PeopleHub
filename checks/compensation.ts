/**
 * Two implementations of one salary formula, and the arithmetic they share.
 *
 * The compensation drawer shows a breakdown as the CTC is typed, computed in
 * the browser by `src/lib/compensation.ts`. The server computes the same thing
 * in `server/src/modules/payroll/compensation.ts` and refuses the save if the
 * components do not reconcile. Two implementations of one rule is a deliberate
 * choice — the alternative is a round trip per keystroke — and it is only safe
 * while they agree to the rupee.
 *
 * They can disagree in ways nobody would notice by looking: a different
 * rounding point, a different order of resolution, a different opinion about
 * whether an employer contribution counts towards CTC. Any of those produce a
 * screen that says a structure balances and a server that refuses it, which is
 * the worst version of this feature — the number is right there and the button
 * does not work.
 *
 * So both are run over the same inputs and compared.
 *
 * The second half checks the parts that have no second implementation: the
 * boundary a revision supersedes on, and the seeded components in 0048 adding
 * up to exactly the CTC they claim to.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyComponents as client } from '../src/lib/compensation';
import { applyComponents as server } from '../server/src/modules/payroll/components';
import type { SalaryComponent } from '../src/services/contracts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const c = (
  code: string,
  kind: SalaryComponent['kind'],
  percent: number | null,
  percentOf: string | null = null,
  flat: number | null = null,
  order = 1,
  active = true,
): SalaryComponent => ({
  code, name: code, kind, percentOf, percent, flat, taxable: true, order, active,
});

/* ------------------------------------------------------------------ *
 * 1. The two implementations agree
 * ------------------------------------------------------------------ */

console.log('\nthe browser and the server compute the same breakdown\n');

/** The shapes that have actually caused trouble, not a tidy sample. */
const CASES: { label: string; comps: SalaryComponent[]; ctcs: number[] }[] = [
  {
    label: 'the seeded India structure',
    comps: [
      c('BASIC', 'earning', 40, null, null, 1),
      c('HRA', 'earning', 50, 'BASIC', null, 2),
      c('LTA', 'earning', 8, 'BASIC', null, 3),
      c('SPECIAL', 'earning', 30.076, null, null, 4),
      c('PF_ER', 'employer_contribution', 12, 'BASIC', null, 5),
      c('GRATUITY', 'employer_contribution', 4.81, 'BASIC', null, 6),
    ],
    /* Odd numbers, because rounding only diverges where it has to round. */
    ctcs: [1_000_000, 1_234_567, 999_999, 750_001, 87_654_321, 1, 0],
  },
  {
    label: 'a flat component in the mix',
    comps: [
      c('BASIC', 'earning', 40, null, null, 1),
      c('MEDINS', 'employer_contribution', null, null, 12_000, 2),
    ],
    ctcs: [1_000_000, 333_333, 12_000],
  },
  {
    label: 'an inactive component, and one that depends on it',
    comps: [
      c('BASIC', 'earning', 40, null, null, 1, false),
      c('HRA', 'earning', 50, 'BASIC', null, 2),
    ],
    ctcs: [1_000_000, 7],
  },
  {
    label: 'a deduction, which does not count towards CTC',
    comps: [
      c('BASIC', 'earning', 100, null, null, 1),
      c('PF_EE', 'deduction', 12, 'BASIC', null, 2),
    ],
    ctcs: [600_000, 1],
  },
  {
    label: 'a percentage of a component that is not there',
    comps: [c('HRA', 'earning', 50, 'GHOST', null, 1)],
    ctcs: [1_000_000],
  },
];

for (const { label, comps, ctcs } of CASES) {
  let same = true;
  let first = '';
  for (const ctc of ctcs) {
    const a = client(comps, ctc);
    const b = server(comps as never, ctc);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      same = false;
      if (!first) {
        first = `at CTC ${ctc}:\n        browser ${JSON.stringify(a)}\n        server  ${JSON.stringify(b)}`;
      }
    }
  }
  ok(`${label} — ${ctcs.length} amounts`, same, first);
}

/* ------------------------------------------------------------------ *
 * 2. What the arithmetic must be, regardless of who computes it
 * ------------------------------------------------------------------ */

console.log('\nthe formula reconciles, and says so when it does not\n');

const SEEDED = CASES[0]!.comps;

{
  const r = client(SEEDED, 1_000_000);
  ok('the seeded components come to exactly the CTC', r.balances,
    `they come to ${r.counted} against 1,000,000 — a difference of ${r.difference}. `
    + 'The migration seeds these, so a company applying 0048 would be unable to '
    + 'save any compensation at all until it edited them.');
  ok('basic is 40% of CTC',
    r.lines.find((l) => l.code === 'BASIC')?.annual === 400_000);
  ok('HRA is half of basic, not half of CTC',
    r.lines.find((l) => l.code === 'HRA')?.annual === 200_000);
  ok('a deduction is not counted towards CTC',
    client([c('BASIC', 'earning', 100), c('X', 'deduction', 50, 'BASIC')], 500_000)
      .counted === 500_000,
    'a deduction comes out of the earnings; counting it would double-count the pay');
}

{
  /* The residue that rounding leaves is reported, never absorbed. */
  const odd = client(SEEDED, 999_999);
  ok('a CTC that does not divide cleanly reports its difference',
    odd.difference === odd.counted - odd.ctc);
  ok('nothing is silently adjusted to make a total balance',
    odd.lines.every((l) => Number.isInteger(l.annual)),
    'every line is whole rupees; a fractional line would mean a component had '
    + 'been nudged to close the gap');
}

{
  /* An unreachable base contributes nothing rather than throwing. */
  const ghost = client([c('HRA', 'earning', 50, 'GHOST')], 1_000_000);
  ok('a percentage of a missing component is zero, not a crash',
    ghost.lines[0]?.annual === 0);
  ok('and that shows up as not reconciling', !ghost.balances);
}

/* ------------------------------------------------------------------ *
 * 3. The migration seeds what this check was run against
 * ------------------------------------------------------------------ */

console.log('\n0048 seeds the components this check verifies\n');

const sql = readFileSync(join(root, 'server/db/migrations/0048_compensation.sql'), 'utf8');

/* The VALUES rows: ('CODE', 'Name', 'kind', base, pct, taxable, ord) */
const seeded = [...sql.matchAll(
  /\('([A-Z_]+)',\s*'[^']*',\s*'(\w+)',\s*(NULL|'[A-Z_]+'),\s*([\d.]+),/g)]
  .map((m) => ({
    code: m[1]!,
    kind: m[2]! as SalaryComponent['kind'],
    base: m[3] === 'NULL' ? null : m[3]!.replace(/'/g, ''),
    pct: Number(m[4]),
  }));

ok('the component rows in 0048 can be read', seeded.length === 6,
  `${seeded.length} rows parsed, expected 6 — the INSERT has changed shape and `
  + 'this check has stopped seeing it');

if (seeded.length === 6) {
  const asComponents: SalaryComponent[] = seeded.map((s, i) =>
    c(s.code, s.kind, s.pct, s.base, null, i + 1));
  const r = client(asComponents, 1_000_000);
  ok('the components the migration actually seeds reconcile to CTC', r.balances,
    `they come to ${r.counted} against 1,000,000 — ${r.difference} out. `
    + 'Applying 0048 would leave the company unable to save a compensation.');

  const codes = seeded.map((s) => s.code).sort().join(',');
  ok('and they are the six this check tested',
    codes === 'BASIC,GRATUITY,HRA,LTA,PF_ER,SPECIAL', codes);
}

/* ------------------------------------------------------------------ *
 * 4. The demo refuses what the server refuses
 * ------------------------------------------------------------------ */

console.log('\nthe demo starts from a formula that balances\n');

{
  const mockSrc = readFileSync(join(root, 'src/services/mock/compensation.ts'), 'utf8');
  const pcts = [...mockSrc.matchAll(/code: '([A-Z_]+)'[^}]*?percent: ([\d.]+)/g)]
    .map((m) => ({ code: m[1]!, pct: Number(m[2]) }));
  ok('the demo defines the same six components', pcts.length === 6,
    `${pcts.length} parsed — the mock's component list has changed shape`);

  const byCode = new Map(seeded.map((s) => [s.code, s.pct]));
  const drifted = pcts.filter((p) => byCode.get(p.code) !== p.pct);
  ok('the demo and the migration use the same percentages', drifted.length === 0,
    drifted.map((d) => `${d.code}: demo ${d.pct}%, migration ${byCode.get(d.code)}%`).join('; ')
    + ' — the demo would then teach a structure production would refuse');
}

console.log(failed
  ? `\n${failed} failed\n`
  : '\nboth implementations agree, and the seeded formula balances\n');
process.exit(failed ? 1 : 0);
