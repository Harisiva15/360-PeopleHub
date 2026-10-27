/**
 * A read that is wrapped in `unbacked` is dead in production.
 *
 * ## The incident
 *
 * `unbacked(run, empty)` is `apiConfigured ? () => Promise.resolve(empty) : run`.
 * It exists so a demo build can show something where no server backs it. In a
 * configured build it resolves to the empty value **without calling** — which
 * is the point, and also the trap.
 *
 * `useLetterContext` was wrapped in `unbacked(…, null)`. So in production the
 * facts a letter prints from were never fetched, `LetterDoc` saw null, and
 * every letter — including the five that quote no pay and were described as
 * live — sat on "Preparing the letter…" indefinitely. There is no endpoint
 * either: `/documents/letter-context/:id` answers 404.
 *
 * **The Playwright suite could not catch this class**, and that is the part
 * worth fixing structurally. The e2e runs against the demo build, where
 * `unbacked` passes the real call through and the mock answers it. A test
 * that drives the demo proves the demo. So the rule is enforced here, by
 * reading the source, rather than hoped for in a browser.
 *
 * ## The rule
 *
 * Every `unbacked` call site must be listed below with a reason. An
 * unexplained one fails, because the default outcome of adding one is a
 * screen that works for the person who built it and is blank for everybody
 * else.
 *
 * ## The two-way lock
 *
 * While `letterContext` is wrapped, `LETTER_CONTEXT_BACKED` must be false, so
 * the letter screens refuse with a sentence instead of spinning. When the
 * endpoint lands and the wrapper goes, the flag must become true. Asserting
 * both directions means neither can be changed alone and leave the product
 * lying about itself.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LETTER_CONTEXT_BACKED } from '../src/nav';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
};

/**
 * Call sites that are deliberate, each with the reason and what retires it.
 *
 * Keyed `file#symbol`. Adding an entry is a decision somebody has to defend
 * in review; the point is that it cannot be done silently.
 */
const REVIEWED = new Map<string, string>([
  ['src/modules/documents/data.ts#letterContext',
    'No server route exists (/documents/letter-context/:id is 404). While this '
    + 'stands, LETTER_CONTEXT_BACKED is false and the letter screens refuse '
    + 'with a sentence rather than spinning. Retired by the phase 5 endpoint.'],
]);

/* ---------------------------------------------------------------------------
 * Find every call site
 * ------------------------------------------------------------------------ */

const found: { file: string; line: number; symbol: string }[] = [];

const walk = (dir: string): void => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (!/\.tsx?$/.test(entry)) continue;
    /* The helper's own definition is not a call site. */
    if (full.replace(/\\/g, '/').endsWith('src/services/unbacked.ts')) continue;

    const text = readFileSync(full, 'utf8');
    text.split(NL).forEach((text_line, i) => {
      /* A comment mentioning it is not a call. */
      const code = text_line.replace(/^\s*(\*|\/\/).*/, '');
      if (!/\bunbacked\s*\(/.test(code)) return;
      /*
       * The symbol is whatever is being read: `s.documents.letterContext(…)`
       * yields `letterContext`. Falls back to the line number, which still
       * forces an entry rather than letting an unnamed one through.
       */
      const m = /unbacked\(\s*\([^)]*\)\s*=>\s*[A-Za-z0-9_.]*\.([A-Za-z0-9_]+)\s*\(/.exec(code);
      found.push({
        file: full.replace(/\\/g, '/'),
        line: i + 1,
        symbol: m?.[1] ?? `line-${i + 1}`,
      });
    });
  }
};
walk('src');

console.log(`${NL}every unbacked read is accounted for${NL}`);

ok(`${found.length} call site(s) found`, found.length > 0,
  'the detector found none at all, which means it has stopped working');

const unexplained = found.filter((f) => !REVIEWED.has(`${f.file}#${f.symbol}`));
ok(`every call site is reviewed (${unexplained.length} unexplained)`,
  unexplained.length === 0,
  unexplained.map((f) => `${f.file}:${f.line} ${f.symbol}`).join(', '));

for (const [key, why] of REVIEWED) {
  const [file, symbol] = key.split('#') as [string, string];
  const present = found.some((f) => f.file === file && f.symbol === symbol);
  ok(`reviewed exception still applies: ${symbol}`, present,
    `${key} is no longer wrapped — delete the entry and flip its flag. ${why}`);
}

/* ---------------------------------------------------------------------------
 * The two-way lock
 * ------------------------------------------------------------------------ */

const letterWrapped = found.some((f) => f.symbol === 'letterContext');

ok('while letterContext is unbacked, LETTER_CONTEXT_BACKED is false',
  !letterWrapped || LETTER_CONTEXT_BACKED === false,
  'the flag says letters work and the read is still stubbed — a configured '
  + 'build would spin on "Preparing the letter…"');

ok('and once it is not, the flag must say so',
  letterWrapped || LETTER_CONTEXT_BACKED === true,
  'the wrapper is gone but the flag still refuses every letter');

/*
 * The refusal has to be reachable, not merely defined. A message nobody
 * renders is the same defect as the flag nobody read — which is how
 * LAUNCH_LETTERS sat unused for a fortnight.
 */
const issue = readFileSync('src/modules/documents/issue.ts', 'utf8');
ok('the verdict consults the flag', /LETTER_CONTEXT_BACKED/.test(issue));
ok('  and only in a configured build, so the demo still works',
  /apiConfigured\s*&&\s*!LETTER_CONTEXT_BACKED/.test(issue),
  'refusing in the demo would break the one place letters render');

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`no read is stubbed out in production without a reason${NL}`);
process.exit(0);
