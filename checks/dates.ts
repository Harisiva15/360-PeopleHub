/**
 * No date a formatter is handed can come out as "NaN", "Invalid Date" or
 * "undefined", and nothing in the app formats a date without going through one.
 *
 * ## Why a check rather than a look
 *
 * User management printed "NaN Invalid Date" in the Last login column for three
 * of five real users, and every screenshot of the product looked right. The
 * reason is that the two datasets disagree about one character:
 *
 *   demo dataset   2026-09-18T09:30                 (ISO, with the T)
 *   real API       2026-11-06 08:11:47.450537+00    (Postgres, with a space)
 *
 * `last_login_at` is returned as `last_login_at::text`, and `timestamptz::text`
 * is space-separated. The formatter split on 'T', kept the whole string as the
 * date, and `new Date` of that is an invalid Date: `getDate()` is NaN and
 * `toLocaleString` is the literal string "Invalid Date". So the fault could
 * only ever appear against the real server, which is exactly where nobody is
 * taking screenshots.
 *
 * `fmtD` and `fmtDS` had the same latent fault by a different route —
 * `MON[NaN]` is `undefined`, so they would have printed "NaN undefined NaN".
 *
 * The first half of this check is therefore adversarial inputs rather than
 * representative ones: every shape a timestamp arrives in, and a pile of
 * values that are not timestamps at all. The second half is the structural
 * half, and it is the one that keeps this fixed — a formatter is only safe if
 * it is the only formatter, so nothing may build a date string out of
 * `getMonth()` or `toLocaleDateString` on its own.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fmtD, fmtDS, fmtDT, parseInstant } from '../src/lib/dates';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};

/* ---------------- what must never appear ---------------- */

const POISON = ['NaN', 'Invalid Date', 'undefined', 'null', 'Infinity'];
const clean = (s: string) => !POISON.some((p) => s.includes(p));

/*
 * Everything a stored value has been observed to be, plus the shapes that
 * would be mistakes. Nothing here may produce poison from any formatter.
 */
const HOSTILE: unknown[] = [
  /* the real API's shapes */
  '2026-11-06 08:11:47.450537+00',
  '2026-10-21 06:33:37.800021+00',
  '2026-11-06 08:11:47+00',
  '2026-11-06 08:11:47.45+05:30',
  /* the demo dataset's shapes */
  '2026-09-18T09:30',
  '2026-09-18T09:30:00',
  '2026-09-18T09:30:00.000Z',
  '2026-09-18',
  /* absent */
  null, undefined, '', '   ',
  /* wrong, but arriving anyway */
  'Never', '—', 'not a date', '0000-00-00', '2026-13-45',
  '2026-11-06 99:99:99+00', 'NaN', 'Invalid Date', '[object Object]',
  Number.NaN, Number.POSITIVE_INFINITY, -1, 0,
  new Date('nonsense'), new Date(0),
  {}, [], true, false,
];

for (const [name, fn] of [
  ['fmtD', fmtD], ['fmtDS', fmtDS], ['fmtDT', fmtDT],
] as [string, (v: never) => string][]) {
  const bad: string[] = [];
  for (const v of HOSTILE) {
    let out: string;
    try {
      out = fn(v as never);
    } catch (e) {
      bad.push(`${JSON.stringify(v) ?? String(v)} threw ${(e as Error).message}`);
      continue;
    }
    if (typeof out !== 'string') { bad.push(`${String(v)} -> ${typeof out}`); continue; }
    if (!clean(out)) bad.push(`${JSON.stringify(v) ?? String(v)} -> "${out}"`);
  }
  ok(`${name} never prints NaN, Invalid Date or undefined`, bad.length === 0,
    bad.join('\n        '));
}

/* ---------------- and still reads the real shapes correctly ---------------- */

ok('a space-separated Postgres timestamp parses',
  parseInstant('2026-11-06 08:11:47.450537+00') !== null,
  'this is the exact value that printed "NaN Invalid Date"');

ok('a bare +00 offset parses, not just +00:00',
  parseInstant('2026-11-06 08:11:47+00') !== null,
  'Postgres writes +00; the spec wants +00:00, so it has to be widened');

ok('microseconds do not defeat it',
  parseInstant('2026-11-06 08:11:47.450537+00') !== null);

/*
 * A date with no time is local midnight, not UTC midnight. `new Date('2026-11-06')`
 * is UTC, which is 5 Nov for every viewer west of Greenwich — so a joining date
 * would read a day early in New York, which is where this product's users are.
 */
const dayOnly = parseInstant('2026-11-06');
ok('a date alone resolves to local midnight, not UTC',
  dayOnly !== null && dayOnly.getDate() === 6 && dayOnly.getHours() === 0,
  `${dayOnly?.toString()} — off-by-one days come from UTC parsing of YYYY-MM-DD`);

ok('fmtD renders a plain date',
  fmtD('2026-11-06') === '6 Nov 2026', fmtD('2026-11-06'));

ok('the two dataset shapes agree once parsed',
  fmtD('2026-09-18T09:30') === fmtD('2026-09-18'),
  `${fmtD('2026-09-18T09:30')} vs ${fmtD('2026-09-18')}`);

/* An absent value is the caller's word, and 'Never' is never the default. */
ok('an absent instant is not called "Never" by default',
  fmtDT(null) === '—' && fmtD(null) === '—',
  `${fmtDT(null)} / ${fmtD(null)} — "Never" is a claim about history, and only `
  + 'a caller holding the evidence may make it');

ok('a caller may still ask for its own fallback',
  fmtDT(null, 'Never') === 'Never' && fmtD(null, 'n/a') === 'n/a');

/* ---------------- nothing formats dates on its own ---------------- */

/*
 * Tracked files only, and via git rather than a directory walk — an untracked
 * file is invisible to CI, so finding one here would be a local-only green.
 */
const tracked = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
  .split('\n').map((s) => s.trim())
  .filter((f) => /\.(ts|tsx)$/.test(f) && f !== 'src/lib/dates.ts');

/*
 * Narrow on purpose. The first version of this rule flagged
 * `Number.prototype.toLocaleString('en-IN')`, which formats money and has
 * nothing to do with dates, and `MON[d.getMonth()]` on a Date the caller had
 * just constructed for a month axis — 14 findings, none of them this bug. A
 * check that cries about correct code gets switched off.
 *
 * What is left is the two ways a *stored string* gets turned into a date
 * without being parsed: the locale formatters, which print the literal text
 * "Invalid Date" rather than throwing, and splitting on 'T' — which is the
 * exact line that failed, because a Postgres timestamp has a space there.
 */
const DATE_LOCALE = /\.toLocale(?:Date|Time)String\s*\(/;
const LOCALE_WITH_DATE_PART = /\.toLocaleString\s*\([^)]*\b(?:month|weekday|day|year)\s*:/;
const RAW_SPLIT_T = /\.split\(\s*['"]T['"]\s*\)/;

const offenders: string[] = [];
for (const f of tracked) {
  const src = readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    const t = line.trimStart();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    for (const [why, re] of [
      ['calls a locale date formatter, which prints the text "Invalid Date"', DATE_LOCALE],
      ['formats a date part via toLocaleString', LOCALE_WITH_DATE_PART],
      ["splits a timestamp on 'T' — a Postgres timestamp has a space there", RAW_SPLIT_T],
    ] as [string, RegExp][]) {
      if (re.test(line)) offenders.push(`${f}:${i + 1} ${why}\n          ${line.trim()}`);
    }
  });
}

ok('every date is formatted by src/lib/dates and nothing else',
  offenders.length === 0,
  `${offenders.join('\n        ')}\n        `
  + 'A second formatter is a second chance to print "Invalid Date". Add what '
  + 'is missing to src/lib/dates.ts and call it from here.');

console.log();
if (failed) {
  console.error(`${failed} date check(s) failed`);
  process.exit(1);
}
console.log('no formatter can print NaN or Invalid Date, and there is only one formatter');
