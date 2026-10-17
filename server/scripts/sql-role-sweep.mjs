/*
 * Every mention of a role inside a SQL string, classified.
 *
 * The migration sweep found four CHECK constraints and concluded the SQL
 * surface was those four. It was not: SQL also lives in template literals in
 * TypeScript, and two comparisons were hiding there — one of them the
 * last-administrator guard, which after step B would have matched nothing and
 * stopped protecting the final account.
 *
 * So this extracts the string literals, keeps the ones that are SQL, and looks
 * inside those. Looking at whole lines does not work: a multi-line query puts
 * `WHERE role = 'admin'` on a line with no SQL keyword on it, and a line-based
 * search either misses it or drowns in TypeScript conditionals that happen to
 * mention a role. TypeScript comparisons are role-gates.ts's job, not this
 * one's.
 *
 * It classifies rather than just listing, because several hits are other
 * domains that reuse the same words: a recruiter's part, a task owner, an
 * interview stage. Those must be left alone, and a sweep that cannot tell them
 * apart would break them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] ?? 'src';

const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
};

/** Pull every string literal out, with the line it starts on. */
const literals = (src) => {
  const out = [];
  const re = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({ text: m[0], line: src.slice(0, m.index).split('\n').length });
  }
  return out;
};

const IS_SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WHERE|ORDER\s+BY|JOIN|VALUES|SET)\b/i;

/* A role column being compared, or a role word quoted inside the query. */
const ROLE_COMPARISON = /\b(app_role|role)\b\s*(=|<>|!=|IN|ILIKE|::)/i;
const ROLE_WORDS = ['admin', 'manager', 'employee', 'company_admin', 'hr_admin', 'finance_admin'];

const OTHER_DOMAIN = [
  { re: /\b(primary|backup)\b/i, why: "recruiter's part on a job order" },
  { re: /\b(candidate|applied|screen|hired)\b/i, why: 'interview stage or candidate' },
  { re: /owner/i, why: 'a task owner — a team, not a role' },
];

const files = walk(ROOT);
const vocab = [];
const other = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const { text, line } of literals(src)) {
    if (!IS_SQL.test(text)) continue;

    const cmp = ROLE_COMPARISON.test(text);
    const quoted = ROLE_WORDS.filter((w) => text.includes(`'${w}'`));
    if (!cmp && !quoted.length) continue;

    /* The fragment that matters, so the report is readable. */
    const frag = (text.match(/[^\n`'"]*\b(app_role|role)\b[^\n`'"]{0,60}/i) ?? [text.slice(0, 80)])[0]
      .trim().replace(/\s+/g, ' ');

    const dom = OTHER_DOMAIN.find((o) => o.re.test(frag));
    const row = { file, line, frag, quoted };
    if (dom) other.push({ ...row, why: dom.why });
    else vocab.push(row);
  }
}

console.log(`\n${files.length} files scanned under ${ROOT}\n`);

console.log(`== role vocabulary inside SQL: ${vocab.length} ==\n`);
for (const h of vocab) {
  const lits = h.quoted.length ? `   literals: ${h.quoted.map((q) => `'${q}'`).join(', ')}` : '';
  console.log(`  ${h.file}:${h.line}${lits}`);
  console.log(`      ${h.frag}`);
}

console.log(`\n== other domains, left alone: ${other.length} ==\n`);
for (const h of other) {
  console.log(`  ${h.file}:${h.line}  (${h.why})`);
  console.log(`      ${h.frag}`);
}

/*
 * Only a hard-coded old literal is a failure. A parameterised comparison
 * (`role = $1`) is fine whatever the vocabulary, and the new names are fine by
 * definition.
 */
const bad = vocab.filter((h) => h.quoted.some((q) => q === 'admin' || q === 'manager'));
console.log('');
if (bad.length) {
  console.error(`${bad.length} query/queries hard-code an old role value:\n`);
  for (const h of bad) console.error(`  ${h.file}:${h.line}  ${h.frag}`);
  console.error('');
  process.exit(1);
}
console.log('no query hard-codes an old role value\n');
