/**
 * The file list a check scans — from the filesystem, not from git.
 *
 * ## Why this exists
 *
 * Nine suites built their list with `git ls-files src`, which has a failure
 * mode that is the opposite of the one you look for: it does not see too much,
 * it sees too little. A file that has been written but not yet added to the
 * index **does not exist** as far as `git ls-files` is concerned, so the check
 * passes, the commit lands, and CI fails on the same suite — because committing
 * is what made the file visible.
 *
 * That cost two pushes in one day. `checks/auth-gate.tsx` asserts that only one
 * module reads the credential which bypasses every row-level security policy in
 * the schema; a new server module that read it passed locally while untracked
 * and failed in CI. Worse, the replacement assertions written to fix it
 * reported **zero** readers and passed *vacuously*, for the same reason.
 *
 * A check that can report green about a file it cannot see is not a check. So
 * the list comes from the filesystem, and every one of those suites now sees a
 * new file the moment it is written.
 *
 * ## When git semantics are the right ones
 *
 * Sometimes the question genuinely is "what will the push carry" —
 * `server/scripts/migrations.test.mjs` asks exactly that, because an applied
 * migration is history and its checksum must match what was committed. That
 * suite uses `git ls-tree HEAD` deliberately, and it also asserts that nothing
 * is on disk and absent from the commit, with the message "green locally and
 * absent from the push". That is the shape to copy: use git *and* refuse to be
 * silent about what git cannot see.
 *
 * `untrackedUnder` is here for that case.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Directories never worth walking into. */
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.vite', 'coverage']);

/**
 * Every file under `dir` whose name matches, as paths relative to `root` with
 * forward slashes — the same shape `git ls-files` produced, so this is a
 * drop-in replacement at the call sites.
 *
 * `dir` is relative to `root`. A directory that does not exist yields nothing
 * rather than throwing: a suite that guards a path which has not been created
 * yet should report zero files, not fall over.
 */
export function sourceFiles(root: string, dir: string, match: RegExp): string[] {
  const start = join(root, dir);
  if (!existsSync(start)) return [];

  const out: string[] = [];
  (function walk(d: string) {
    for (const name of readdirSync(d)) {
      if (SKIP.has(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (match.test(name)) out.push(relative(root, p).split('\\').join('/'));
    }
  }(start));
  return out.sort();
}

/**
 * Files under `dir` that exist on disk and are not tracked by git.
 *
 * For a suite whose question really is about the commit. Pair it with an
 * assertion so the suite refuses to be quietly incomplete:
 *
 *     const invisible = untrackedUnder(root, 'server/db/migrations');
 *     fail('nothing is on disk and absent from the push',
 *          invisible.length === 0, invisible.join(', '));
 *
 * Returns paths in the same shape as `sourceFiles`. Ignored files do not count
 * as untracked — `.env` and the like are deliberately absent and are not the
 * oversight this is looking for.
 */
export function untrackedUnder(root: string, dir: string): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', dir],
    { cwd: root, encoding: 'utf8' },
  );
  return out.split('\n').filter(Boolean).map((f) => f.split('\\').join('/')).sort();
}
