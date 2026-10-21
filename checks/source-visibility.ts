/**
 * A check cannot report green about a file it is unable to see.
 *
 * ## The bug this exists for
 *
 * Nine suites enumerated their inputs with `git ls-files`, which means a file
 * written but not yet added to the index **does not exist** as far as they are
 * concerned. The failure mode is the inverse of the one anybody looks for: not
 * too much scanned, but too little, and the symptom is a green local run
 * followed by a red CI run on the same suite — because committing is what made
 * the file visible.
 *
 * It cost two pushes in one day. `checks/auth-gate.tsx` asserts that only one
 * module reads the credential which bypasses every row-level security policy
 * in the schema. A new server module that read it passed locally while
 * untracked and failed in CI. Then the assertions written to fix *that*
 * reported **zero** readers and passed vacuously, for the same reason, until
 * the new file was added to the index.
 *
 * ## What this holds
 *
 * Three things, and the third is the one that matters:
 *
 *   1. `sourceFiles` finds a file that git does not know about.
 *   2. `untrackedUnder` reports that same file, for the suites whose question
 *      really is "what will the push carry".
 *   3. **`check:gate` fails when an untracked module reads the service key.**
 *      Asserted by planting one and running the suite as a subprocess, because
 *      the property is about the suite's behaviour and nothing short of running
 *      it proves anything.
 *
 * (3) is a meta-test: it tests a test. That is justified here because the
 * failure it guards against is specifically "the check said green and was not
 * looking", which no assertion inside that check can catch about itself.
 *
 *   vite-node checks/source-visibility.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles, untrackedUnder } from './lib/sources';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failed += 1;
};

/*
 * A name no real module would take, under a directory the guarded suites scan.
 * Removed in a finally, and the suite refuses to start if one is left over from
 * an interrupted run rather than overwriting it.
 */
const PLANTED_DIR = join(root, 'server/src/zz_visibility_probe');
const PLANTED = join(PLANTED_DIR, 'reader.ts');
const PLANTED_REL = 'server/src/zz_visibility_probe/reader.ts';

if (existsSync(PLANTED_DIR)) {
  console.error(`\nSTOPPING: ${PLANTED_REL} already exists — an earlier run did not clean up.`);
  console.error('Delete it and run again; this suite will not overwrite it.\n');
  process.exit(1);
}

console.log('\na check sees a file the moment it is written\n');

try {
  mkdirSync(PLANTED_DIR, { recursive: true });
  /*
   * Reads the credential, which is exactly what auth-gate forbids outside
   * config.ts and serviceKey.ts. Never imported by anything, so it changes no
   * behaviour; it exists to be noticed.
   */
  writeFileSync(PLANTED, [
    '/* Planted by checks/source-visibility.ts. Deleted in the same run. */',
    "import { config } from '../config.ts';",
    '',
    'export const probe = (): string => config.supabaseServiceKey;',
    '',
  ].join('\n'));

  /* 1. The filesystem enumeration sees it. */
  const seen = sourceFiles(root, 'server/src', /\.(ts|tsx)$/);
  ok('1. sourceFiles finds an untracked file',
    seen.includes(PLANTED_REL),
    `${seen.length} file(s) scanned and the planted one is not among them`);

  /* 2. And the git-semantics helper reports it as invisible to the commit. */
  const invisible = untrackedUnder(root, 'server/src');
  ok('2. untrackedUnder reports it as absent from the push',
    invisible.includes(PLANTED_REL),
    invisible.join(', ') || 'nothing reported untracked');

  /*
   * 3. The real assertion. `check:gate` must now refuse this.
   *
   * Run with the repository's own script so this tests what CI runs, not a
   * reimplementation of it. A zero exit here is the exact bug: the suite looked
   * at a tree that did not include a module reading the credential.
   */
  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync('npm', ['run', '--silent', 'check:gate'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true,
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    exitCode = err.status ?? 1;
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  ok('3. check:gate fails with an untracked reader present',
    exitCode !== 0,
    'it exited 0 — the suite passed while a module it could not see read the key');
  ok('    and names the file it found',
    output.includes('zz_visibility_probe'),
    output.split('\n').filter((l) => /read the value|FAIL/.test(l)).join(' | ').slice(0, 200));
} finally {
  rmSync(PLANTED_DIR, { recursive: true, force: true });
}

/* And with the plant gone, the suite is green again — so (3) was the plant and
   not some unrelated breakage. */
let afterCode = 0;
try {
  execFileSync('npm', ['run', '--silent', 'check:gate'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true,
  });
} catch (e) {
  afterCode = (e as { status?: number }).status ?? 1;
}
ok('4. and passes again once it is removed', afterCode === 0,
  'check:gate is failing for a reason other than the plant');

console.log('');
if (failed) { console.error(`${failed} FAILED\n`); process.exit(1); }
console.log('no suite can report green about a file it cannot see\n');
process.exit(0);
