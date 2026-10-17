/**
 * The migration directory is deployable, in order, and append-only.
 *
 * ## Why this exists
 *
 * Commit de4b462 shipped four migrations and was deployed without them being
 * applied, and the server ran nineteen days against a database that had never
 * heard of half the schema the code assumed. `src/db/migrationState.ts` is the
 * half of that fix which notices at runtime. This is the half that notices
 * before the push, and the two catch different things: that one knows what the
 * *database* has, this one knows what *git* has.
 *
 * The specific hazard this file is pointed at: a migration file that exists on
 * the author's disk and is not tracked. Everything is green locally — the file
 * is right there, the suites apply it, every assertion passes — and the push
 * carries the code without the schema. `checks/styles.ts` learned the same
 * lesson from the other end: it reads git-tracked files, and an untracked new
 * component made its classes look unrendered.
 *
 * ## What is asserted
 *
 *   1. Every migration is tracked by git. An untracked one will never deploy.
 *   2. No migration is modified relative to HEAD. They are append-only once
 *      committed, because migrate.mjs compares checksums and refuses a file
 *      that changed after it ran — so editing one is a deployment that cannot
 *      proceed, on every database that already has it.
 *   3. Numbering is contiguous from 0001, with no gaps and no duplicates.
 *   4. Filenames match the shape the runner sorts on.
 *   5. Nothing in the directory is empty, and nothing in it is not a migration.
 *
 * Needs no database. It reads the directory and asks git.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/*
 * An argument overrides the directory, so the check can be pointed at a
 * deliberately broken copy to prove it still catches what it is for — the same
 * affordance check-routes.mjs has.
 */
const dir = process.argv[2] ?? join(here, '..', 'db', 'migrations');
const repo = join(here, '..', '..');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  } catch (e) {
    /*
     * Not in a checkout, or no git. Reported rather than thrown: the other
     * assertions are still worth running, and a missing git is a CI
     * configuration problem rather than a migration problem.
     */
    console.log(`  note  git unavailable (${e.message.split('\n')[0]})`);
    return null;
  }
};

console.log('\nthe migration directory\n');

const entries = readdirSync(dir);
const files = entries.filter((f) => f.endsWith('.sql')).sort();

ok('there are migrations at all', files.length > 0, dir);

const strays = entries.filter((f) => !f.endsWith('.sql'));
ok('nothing in the directory is not a migration', strays.length === 0,
  `${strays.join(', ')} — the runner globs *.sql, so anything else is either `
  + 'dead or silently skipped');

const empty = files.filter((f) => readFileSync(join(dir, f), 'utf8').trim() === '');
ok('no migration is empty', empty.length === 0,
  `${empty.join(', ')} — an empty migration records itself as applied and does nothing, `
  + 'which is worse than not existing');

/* ------------------------------------------------------------------ *
 * Naming and ordering
 * ------------------------------------------------------------------ */

console.log('\nnaming and order\n');

const SHAPE = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const misnamed = files.filter((f) => !SHAPE.test(f));
ok('every filename is NNNN_lower_snake_case.sql', misnamed.length === 0,
  `${misnamed.join(', ')} — the runner applies in plain string sort order, so the `
  + 'zero padding is what makes 0010 come after 0009 rather than after 0001');

const numbers = files.filter((f) => SHAPE.test(f)).map((f) => Number(SHAPE.exec(f)[1]));

const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
ok('no number is used twice', dupes.length === 0,
  `${[...new Set(dupes)].map((n) => String(n).padStart(4, '0')).join(', ')} — two `
  + 'migrations with one number is a merge that kept both and ordered neither');

ok('numbering starts at 0001', numbers[0] === 1, String(numbers[0]));

const gaps = [];
for (let i = 1; i < numbers.length; i += 1) {
  /*
   * Strictly greater, so a repeated number is reported by the duplicate
   * assertion above and not also here as a "gap" from 0002 to 0002 — which is
   * the wrong explanation printed next to the right one.
   */
  if (numbers[i] > numbers[i - 1] + 1) {
    gaps.push(`${String(numbers[i - 1]).padStart(4, '0')} → ${String(numbers[i]).padStart(4, '0')}`);
  }
}
ok('numbering is contiguous', gaps.length === 0,
  `${gaps.join(', ')} — a gap means a migration was deleted after being written, and `
  + 'any database that already applied it still has it recorded');

/* ------------------------------------------------------------------ *
 * Git: the part that catches a file that will not deploy
 * ------------------------------------------------------------------ */

console.log('\nwhat git will actually carry\n');

const tracked = git('ls-files', '--', 'server/db/migrations');
if (tracked === null) {
  ok('git assertions ran', false, 'without git this file cannot check the thing it is for');
} else {
  const trackedSet = new Set(
    tracked.split('\n').filter(Boolean).map((p) => p.split('/').pop()));

  const untracked = files.filter((f) => !trackedSet.has(f));
  ok('every migration is tracked by git', untracked.length === 0,
    `${untracked.join(', ')} — green locally and absent from the push. `
    + 'git add it, or delete it.');

  /*
   * Modified, not merely different: a brand-new migration is fine.
   *
   * "Committed" has to mean *present in HEAD*, which is why this asks
   * `ls-tree HEAD` rather than reusing `trackedSet`. That set comes from
   * `ls-files`, which counts the index — so a newly added migration was in it,
   * `diff HEAD` listed it as changed by definition, and this assertion failed
   * on every new migration ever written. 0057 was the first one added since
   * the check existed, so it was the first to trip it.
   *
   * `trackedSet` is still the right question for the assertion above, where
   * the point is "will this be pushed".
   */
  const committed = git('ls-tree', '-r', 'HEAD', '--name-only', '--', 'server/db/migrations');
  const committedSet = new Set(
    (committed ?? '').split('\n').filter(Boolean).map((p) => p.split('/').pop()));

  const changed = git('diff', '--name-only', 'HEAD', '--', 'server/db/migrations');
  if (changed !== null) {
    const modified = changed.split('\n').filter(Boolean)
      .map((p) => p.split('/').pop())
      .filter((f) => committedSet.has(f));
    ok('no committed migration has been modified', modified.length === 0,
      `${modified.join(', ')} — migrate.mjs refuses a file whose checksum no longer `
      + 'matches what it recorded, so this cannot be deployed to any database that '
      + 'already ran it. Write a new migration instead.');
  }

  const deleted = [...trackedSet].filter((f) => {
    try { statSync(join(dir, f)); return false; } catch { return true; }
  });
  ok('no tracked migration has been deleted', deleted.length === 0,
    `${deleted.join(', ')} — removing one does not remove it from the ledger of any `
    + 'database that applied it, and migrate.mjs then reports a migration it cannot find');

  /*
   * The byte-for-byte one, which the three assertions above cannot see.
   *
   * `git diff` compares *normalised* content, so a file whose line endings were
   * rewritten on checkout reads as unmodified — while migrate.mjs, which
   * hashes the file as it finds it on disk, sees a different migration. That
   * happened here: core.autocrlf=true with no .gitattributes, a plain
   * `git checkout --` on one migration, and its sha256 no longer matched the
   * checksum production had recorded. Nobody had edited it, `git status` was
   * clean, and a deploy would have refused every migration with
   * "0050_survey_participation.sql has changed since it was applied".
   *
   * .gitattributes pins `*.sql` to eol=lf, which is what makes this pass. The
   * assertion stays because a .gitattributes can be removed, a global config
   * can override a repository, and the failure is invisible to every other
   * check in this file.
   */
  const divergent = [];
  for (const f of files) {
    if (!trackedSet.has(f)) continue;
    let blob;
    try {
      blob = execFileSync('git', ['show', `HEAD:server/db/migrations/${f}`],
        { cwd: repo, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      /* Tracked but not in HEAD: staged and not yet committed. Nothing to compare. */
      continue;
    }
    if (!readFileSync(join(dir, f)).equals(blob)) divergent.push(f);
  }
  ok('every migration on disk is byte-identical to what git committed',
    divergent.length === 0,
    `${divergent.join(', ')} — the checkout and the commit disagree, almost always `
    + 'line endings. migrate.mjs hashes what is on disk, so this is a migration it '
    + 'will refuse even though git reports no change. See .gitattributes.');
}

console.log();
console.log(`${files.length} migration(s): ${files[0]} … ${files.at(-1)}`);

if (failed) {
  console.error(`\n${failed} migration check(s) failed`);
  process.exit(1);
}
console.log('every migration is tracked, numbered in order, and unmodified since it was committed');
