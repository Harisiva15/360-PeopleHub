/**
 * Everything the migrations borrow from Supabase, CI has to stand in for.
 *
 * The schema reaches into the `auth` schema in a few places — `auth.users` for
 * the identity foreign key, `auth.uid()` in a policy, `auth.mfa_factors` for
 * the second-factor check. None of that exists in a stock PostgreSQL, so
 * `scripts/ci-bootstrap.mjs` creates a stand-in before the migrations run.
 *
 * When a migration starts using something the bootstrap does not provide, the
 * failure is late and unhelpful. PostgreSQL parses the body of a LANGUAGE sql
 * function at CREATE time, so the migration aborts with
 *
 *     42P01  relation "auth.mfa_factors" does not exist
 *
 * and GitHub reports "Process completed with exit code 1" — the actual message
 * is inside the step's log, several screens down, and the workflow has already
 * spent minutes standing a container up to get there.
 *
 * This compares the two lists as text, before anything connects to anything.
 * It runs in the static job, so a missing stand-in fails in seconds rather
 * than after a database has been provisioned.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');
const bootstrap = readFileSync(join(here, 'ci-bootstrap.mjs'), 'utf8');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

/* Every auth.<thing> named by a migration, comments included — a reference in
   a comment is harmless, and treating it as required costs nothing. */
const required = new Set();
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  const sql = readFileSync(join(migrationsDir, f), 'utf8');
  for (const m of sql.matchAll(/\bauth\.([a-z_][a-z0-9_]*)/gi)) required.add(m[1].toLowerCase());
}

/*
 * What the bootstrap *creates*, not what it mentions.
 *
 * The first version of this matched any `auth.<thing>` anywhere in the file,
 * which counted the explanatory comment above each CREATE as evidence that the
 * thing existed. Renaming the table while leaving its comment in place then
 * passed — a false negative in the one check whose whole job is to catch that
 * omission. Only a creation statement counts now.
 */
const provided = new Set(
  [...bootstrap.matchAll(
    /CREATE\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?auth\.([a-z_][a-z0-9_]*)/gi,
  )].map((m) => m[1].toLowerCase()));

for (const m of bootstrap.matchAll(
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+auth\.([a-z_][a-z0-9_]*)/gi)) {
  provided.add(m[1].toLowerCase());
}

console.log('\nwhat CI has to stand in for\n');

ok(`${files.length} migrations scanned`, files.length >= 40,
  'Far fewer migrations than expected — this check is looking in the wrong place.');
ok(`${required.size} auth objects required, ${provided.size} provided`, required.size > 0,
  'No auth.* references found at all. The pattern has stopped matching.');

const missing = [...required].filter((r) => !provided.has(r)).sort();
ok('ci-bootstrap provides every auth object the migrations use',
  missing.length === 0,
  missing.length
    ? `Missing: ${missing.map((m) => `auth.${m}`).join(', ')}\n        `
      + 'Add a stand-in to scripts/ci-bootstrap.mjs. Without it the migration '
      + 'aborts with 42P01 and CI reports only "exit code 1".'
    : '');

/*
 * The reverse is a note rather than a failure: a stand-in for something no
 * migration references yet is harmless, and may be there for the seed or a
 * test. Worth seeing, not worth blocking on.
 */
const spare = [...provided].filter((p) => !required.has(p)).sort();
if (spare.length) {
  console.log(`\n  note  ci-bootstrap also provides ${spare.map((s) => `auth.${s}`).join(', ')}`);
  console.log('        — not referenced by any migration, which is fine.');
}

console.log(`\n${failed ? `${failed} FAILED` : 'CI can stand in for everything the schema borrows'}\n`);
process.exit(failed ? 1 : 0);
