/**
 * No deployed code reads a table the target database does not have yet.
 *
 * ## Why this exists
 *
 * On 29 October I wrote the deploy order down — migration first, verify it,
 * then the reads — and then pushed both commits together. Render deploys from
 * `main` on push, so the reads went out ahead of `0063_employee_shift_history`
 * and queried a table production had never heard of. Because the shift lookup
 * was embedded as a subquery in statements that do other work, Postgres
 * refused the whole plan: raising an attendance correction, approving one,
 * changing anyone's shift, and creating an employee on both hiring paths all
 * failed, for every tenant, until the reads were reverted.
 *
 * Two things already existed and neither could have stopped it.
 * `src/db/migrationState.ts` knows the database is behind the build, and said
 * so — `pending: 1, behind: true` — but it cannot know whether the code in
 * that build *depends* on the difference. Most of the time it does not: a
 * migration can sit unapplied for an hour with nothing referring to it and
 * nothing breaks. `migrations.test.mjs` knows what git has, which is a
 * different question again. The gap between them is this check: which tables
 * does the code need, and does the database it is about to be deployed against
 * actually have them.
 *
 * ## The invariant
 *
 * For every relation referenced by `src/`, the migration that creates it must
 * already be applied to the target database, and must not have been dropped by
 * another migration that is also applied.
 *
 * "Already applied" is the whole point: not *present in this build*, which is
 * what made the outage possible, but applied — a push that carries both the
 * migration and its first reader fails this check, and is meant to. The
 * migration goes out on its own, gets applied, gets verified, and the reads
 * follow in a second push.
 *
 * ## Where "already applied" is read from
 *
 * From `db/applied-in-production.txt`, a committed list of the migrations that
 * have been run against production. Three alternatives were considered:
 *
 *   - **Query production's `schema_migration`.** Exact, and rejected: it needs
 *     a credential in CI, and this repo deliberately keeps every migration
 *     credential on one machine. A read-only secret is still a secret that did
 *     not exist before.
 *   - **Read the names from `/health`.** That endpoint is unauthenticated,
 *     answered before the rate limiter and before any token is looked at, so
 *     it carries counts and never filenames. That is a deliberate decision in
 *     `migrationState.ts` and not one to undo for a convenience here.
 *   - **Infer the applied set from `/health`'s count** — if 62 are applied,
 *     assume it is the first 62 in sort order. Unsound: `migrate.mjs --only`
 *     can apply a migration out of order, so a count does not identify a set,
 *     and a check that is quietly wrong about which table exists is worse than
 *     no check.
 *
 * So the list is maintained by hand, by the person who runs the migration, in
 * the same commit that follows the run. That is one more step in a procedure
 * that already has four, and it is the step that makes the push order
 * enforceable rather than remembered.
 *
 * A hand-maintained file can lie, so it is not trusted alone: the live check
 * below reads `/health` and requires the number of recorded migrations to
 * equal the number the database reports. Marking something applied without
 * applying it fails, which leaves the file honest without it having to carry
 * the names.
 *
 * ## What is deliberately out of scope
 *
 * `scripts/` is not scanned. Those run from a developer's machine against a
 * database that developer chose, and several legitimately exercise schema that
 * production does not have yet — `shift-history.test.mjs` is exactly that, and
 * refusing it would mean a migration could never be tested before it shipped.
 * `src/` is scanned because `src/` is what Render runs.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { get as getHttp } from 'node:http';
import { get as getHttps } from 'node:https';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, '..');
const repoDir = join(serverDir, '..');
const MIGRATIONS = join(serverDir, 'db', 'migrations');
const RECORD = join(serverDir, 'db', 'applied-in-production.txt');
const SRC = join(serverDir, 'src');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};

/* ------------------------------------------------------------------ *
 * The relations, and which migration created or dropped each
 * ------------------------------------------------------------------ */

/*
 * SQL comments go first. A commented-out `CREATE TABLE` creates nothing, and a
 * migration that explains itself above the statement — most of them do — must
 * not have its prose read as schema.
 */
const stripSql = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');

/*
 * One pattern for both verbs, so the matches arrive in the order they are
 * written. That ordering is the whole of it: 0031 drops `export_run` and
 * recreates it eight lines later, and a pass that took every CREATE in a file
 * before every DROP recorded the view as dropped and flagged its two readers.
 * A drop followed by a create is a redefinition, which is only visible if you
 * read the statements in sequence.
 */
const RELATION = /\b(CREATE|DROP)\s+(?:TABLE|(?:MATERIALIZED\s+)?VIEW)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
ok('there are migrations to read', files.length > 0, `found ${files.length}`);

/** relation -> { created: filename, dropped: filename | null } */
const relations = new Map();
for (const file of files) {
  const sql = stripSql(readFileSync(join(MIGRATIONS, file), 'utf8'));
  for (const m of sql.matchAll(RELATION)) {
    const verb = m[1].toUpperCase();
    const name = m[2].toLowerCase();
    const seen = relations.get(name);
    if (verb === 'CREATE') {
      /*
       * First creation wins, and a creation after a drop reopens the relation
       * — which is how a redefinition reads, and `export_run` is one.
       */
      if (!seen || seen.dropped) relations.set(name, { created: file, dropped: null });
    } else if (seen && !seen.dropped) {
      seen.dropped = file;
    }
  }
}

ok('the migrations create relations this check can map',
  relations.size > 100, `mapped ${relations.size}`);
console.log(`  note  ${relations.size} relation(s) across ${files.length} migration(s); `
  + `${[...relations.values()].filter((r) => r.dropped).length} since dropped`);

/* ------------------------------------------------------------------ *
 * What production has
 * ------------------------------------------------------------------ */

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  } catch {
    return null;
  }
};

/*
 * The record has to be tracked, for the same reason the migrations do: an
 * untracked one is green on this machine and absent from the push, so CI would
 * read a different applied set from the one the author is looking at.
 */
const tracked = git('ls-files', '--error-unmatch', 'server/db/applied-in-production.txt');
ok('the applied-migration record is tracked by git', tracked !== null,
  'server/db/applied-in-production.txt is not tracked. git add it — CI reads it, '
  + 'and an untracked record means CI and this machine disagree about what '
  + 'production has.');

let recordText = '';
try {
  recordText = readFileSync(RECORD, 'utf8');
} catch {
  ok('the applied-migration record exists', false,
    `${relative(repoDir, RECORD)} is missing. It lists the migrations that have `
    + 'been applied to production, one filename per line.');
}

const applied = recordText
  .split('\n')
  .map((l) => l.replace(/#.*$/, '').trim())
  .filter(Boolean);
const appliedSet = new Set(applied);

ok('the record lists migrations', applied.length > 0,
  'no filenames found in the record');
ok('the record has no duplicates', appliedSet.size === applied.length,
  `${applied.length} line(s), ${appliedSet.size} distinct`);

const unknownInRecord = applied.filter((f) => !files.includes(f));
ok('every migration in the record exists in this build',
  unknownInRecord.length === 0,
  `the record names ${unknownInRecord.length} file(s) this build does not have: `
  + `${unknownInRecord.join(', ')}. Either the record has a typo, or this build `
  + 'is older than the database — which is its own problem.');

const pending = files.filter((f) => !appliedSet.has(f));
console.log(`  note  ${applied.length} applied, ${pending.length} pending`
  + `${pending.length ? `: ${pending.join(', ')}` : ''}`);

/* ------------------------------------------------------------------ *
 * What the deployed code references
 * ------------------------------------------------------------------ */

/*
 * TypeScript comments go too, and for a sharper reason than the SQL ones.
 * `shifts/service.ts` explains that an old migration "dropped `roster_entry`",
 * and `FROM roster_entry` appears nowhere in this codebase — but the words
 * "from the", "from a" and "from it" appear in prose more than thirty times.
 * Scanning comments would flag a dropped table on the strength of a sentence
 * describing its removal.
 *
 * `//` is left alone when a colon precedes it, so `https://…` inside a string
 * survives. Mangling the rest of such a string is harmless here: this scan
 * only ever looks for a relation name after a SQL keyword.
 */
const stripTs = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const sources = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) sources.push(full);
  }
};
walk(SRC);
ok('there are source files to scan', sources.length > 0, `found ${sources.length}`);

const REF = /\b(?:FROM|JOIN|INSERT\s+INTO|INTO|UPDATE|TRUNCATE)\s+(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
/* `to_regclass('public.x')` names a relation without any SQL keyword before it. */
const REGCLASS = /to_regclass\s*\(\s*'(?:public\.)?([a-z_][a-z0-9_]*)'/gi;
/* `FROM ${table}` — the name is a variable, resolved below. */
const DYNAMIC = /\b(?:FROM|JOIN|INSERT\s+INTO|INTO|UPDATE)\s+\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g;

/** Every reference found: { file, line, relation } */
const refs = [];
/** Dynamic references whose variable could not be resolved to literal names. */
const unresolved = [];

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

for (const full of sources) {
  const rel = relative(repoDir, full).replace(/\\/g, '/');
  const code = stripTs(readFileSync(full, 'utf8'));

  for (const re of [REF, REGCLASS]) {
    for (const m of code.matchAll(re)) {
      const name = m[1].toLowerCase();
      if (!relations.has(name)) continue;
      refs.push({ file: rel, line: lineOf(code, m.index), relation: name });
    }
  }

  /*
   * A table name built from a variable. Both of today's two are a parameter
   * typed as a union of string literals — `table: 'site' | 'department'` — so
   * the candidates are right there to be read. Anything that cannot be
   * resolved that way is reported as a failure rather than skipped: an
   * unreadable reference is exactly the one that would slip a pending table
   * past this check.
   */
  for (const m of code.matchAll(DYNAMIC)) {
    const varName = m[1];
    const line = lineOf(code, m.index);
    const decl = new RegExp(
      `\\b${varName.replace(/\$/g, '\\$')}\\s*:\\s*((?:'[a-z_][a-z0-9_]*'\\s*\\|\\s*)+'[a-z_][a-z0-9_]*'|'[a-z_][a-z0-9_]*')`,
    ).exec(code);
    const names = decl
      ? [...decl[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((x) => x[1])
      : [];
    const known = names.filter((n) => relations.has(n));
    if (!known.length) {
      unresolved.push({ file: rel, line, varName });
      continue;
    }
    for (const n of known) refs.push({ file: rel, line, relation: n });
  }
}

const referenced = new Set(refs.map((r) => r.relation));
console.log(`  note  ${refs.length} reference(s) to ${referenced.size} relation(s) `
  + `in ${sources.length} source file(s)`);

ok('every table name built from a variable resolves to literal names',
  unresolved.length === 0,
  unresolved.map((u) => `${u.file}:${u.line}  \${${u.varName}}`).join('\n        ')
  + '\n        Type the parameter as a union of string literals '
  + "(table: 'site' | 'department') so this check can see which tables it can "
  + 'be. A name this check cannot read is a name it cannot verify.');

/* ------------------------------------------------------------------ *
 * The invariant
 * ------------------------------------------------------------------ */

const tooEarly = [];
const alreadyGone = [];
for (const r of refs) {
  const { created, dropped } = relations.get(r.relation);
  if (!appliedSet.has(created)) tooEarly.push({ ...r, migration: created });
  else if (dropped && appliedSet.has(dropped)) {
    alreadyGone.push({ ...r, migration: dropped });
  }
}

const show = (list) => [...new Map(
  list.map((r) => [`${r.file}:${r.line}`, r]),
).values()]
  .slice(0, 12)
  .map((r) => `${r.file}:${r.line}  ${r.relation}  (${r.migration})`)
  .join('\n        ');

ok('no deployed code reads a table whose migration is not applied yet',
  tooEarly.length === 0,
  `${tooEarly.length} reference(s) to ${
    new Set(tooEarly.map((r) => r.relation)).size} relation(s) production does `
  + `not have:\n        ${show(tooEarly)}\n        `
  + 'Deploy the migration on its own, apply it to production, add its filename '
  + 'to db/applied-in-production.txt, and push the reads after that. Shipping '
  + 'both together is the 29 October outage.');

ok('no deployed code reads a table that has since been dropped',
  alreadyGone.length === 0,
  `${alreadyGone.length} reference(s) to a dropped relation:\n        ${
    show(alreadyGone)}`);

/* ------------------------------------------------------------------ *
 * The record, held against the live database
 * ------------------------------------------------------------------ */

/*
 * Counts only, which is all `/health` offers and all this needs: if the record
 * claims a migration the database has not applied, the two numbers differ.
 * That is what stops the record being a sticky note.
 *
 * A network failure is a note, not a failure. This check's job is the push
 * order, and it does that job offline; making every CI run depend on reaching
 * a third party would mean a flaky network turns the gate off, which is the
 * wrong way round. `--offline` skips it outright.
 */
const HEALTH = process.env.HEALTH_URL
  ?? 'https://three60-peoplehub-api.onrender.com/health';

if (process.argv.includes('--offline')) {
  console.log('  note  --offline: the live cross-check was skipped');
} else {
  /*
   * `node:http(s)` with `agent: false` rather than global `fetch`. Fetch keeps
   * the socket in undici's connection pool, and a pooled handle still open
   * when this script calls `process.exit(1)` aborts the process on Windows —
   * `!(handle->flags & UV_HANDLE_CLOSING)` in libuv, exit code 127. A gate
   * whose failure exit code is 127 rather than 1 is a gate CI reads as a
   * crashed step instead of a refusal. Unpooled, the socket closes with the
   * response.
   */
  const getJson = (url) => new Promise((resolve, reject) => {
    const mod = new URL(url).protocol === 'http:' ? getHttp : getHttps;
    const req = mod(url, { agent: false, timeout: 20_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`unparseable response (${e.message})`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out after 20s')));
    req.on('error', reject);
  });

  let live = null;
  try {
    live = (await getJson(HEALTH)).migrations ?? null;
  } catch (e) {
    console.log(`  note  could not reach ${HEALTH} (${e.message}) — `
      + 'the live cross-check was skipped; the push-order check above still ran');
  }

  if (live) {
    if (live.readable === false) {
      console.log('  note  the live server cannot read its own ledger, so there '
        + 'is nothing to compare the record against');
    } else {
      ok('the record agrees with what the live database reports',
        live.applied === applied.length,
        `the record lists ${applied.length} applied migration(s); ${HEALTH} `
        + `reports ${live.applied}. ${
          applied.length > live.applied
            ? 'The record claims migrations production has not applied — it was '
              + 'updated before the migration was run, or the run failed.'
            : 'Production has applied migrations the record does not list — '
              + 'add them, or this check is guarding a stale picture.'
        } (measured ${live.checkedAt})`);
      ok('the live database reports no drifted or unknown migrations',
        live.drifted === 0 && live.unknown === 0,
        `drifted ${live.drifted}, unknown ${live.unknown} — the database and the `
        + 'deployed build disagree about what has already run, and no comparison '
        + 'of counts means anything until that is resolved');
      console.log(`  note  live: expected ${live.expected}, applied ${live.applied}`
        + `, pending ${live.pending}, behind ${live.behind}`);
    }
  }
}

/* ------------------------------------------------------------------ */

console.log();
if (failed) {
  console.error(`${failed} table-readiness check(s) failed`);
  process.exit(1);
}
console.log('every table the deployed code reads is already in production');
