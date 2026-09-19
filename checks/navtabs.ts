/**
 * Every `?v=` in the menu names a tab its module actually has.
 *
 * This is the failure this codebase keeps repeating. The sidebar pointed at
 * the timesheet's old tab names for a week after they were renamed, and
 * `checks/routes.tsx` did not notice because the *route* still rendered — it
 * just rendered its default tab, so the menu quietly stopped taking you where
 * it said. A dead `?v=` is invisible to every check that asks whether a page
 * loads, because it does.
 *
 * The allowed tabs are read out of each module's `useTabFromUrl` call, which
 * is the same list the module itself falls back against. Reading the source
 * rather than importing it keeps this from having to mount thirty screens.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NAV, hrefOf } from '../src/nav';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const fail = (msg: string) => { failed++; console.error(`  FAIL  ${msg}`); };

/* ---- what tabs does each module accept? ---- */

const files = execSync('git ls-files src/modules', { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => /\.tsx?$/.test(f));

/** route key -> the tab values its `useTabFromUrl` will accept */
const tabsFor = new Map<string, Set<string>>();

for (const rel of files) {
  const src = readFileSync(join(root, rel), 'utf8');

  /* The module a file registers, which is the route the menu links to. */
  const key = /registerModule\(\{\s*key:\s*'([^']+)'/.exec(src)?.[1];
  if (!key) continue;

  /* A module that does not read the URL at all cannot honour any `?v=`. */
  if (!/useTabFromUrl/.test(src)) {
    tabsFor.set(key, new Set());
    continue;
  }

  /*
   * The tab values come from `type Tab = 'a' | 'b' | 'c'`, not from the
   * `useTabFromUrl` call.
   *
   * The call site looked like the obvious place and is the wrong one: most
   * modules build their allow-list from a `tabs` array they filter by role,
   * so the argument is `tabs.map(t => t.v)` and there is nothing to read. The
   * type union is a literal in every module, and it is the same set — the
   * arrays are typed by it.
   */
  const union = /^type Tab = ([^;]+);/m.exec(src)?.[1]
    ?? /^type Tab =\s*\n([\s\S]*?);/m.exec(src)?.[1];
  const values = union
    ? [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    /* Reports keys its views by report id rather than a Tab union. */
    : [...src.matchAll(/\{\s*id:\s*'([^']+)'[^}]*Body:/g)].map((m) => m[1]!);

  if (!values.length) continue;

  /* A module can be registered from more than one file; union the lists. */
  const already = tabsFor.get(key) ?? new Set<string>();
  for (const v of values) already.add(v);
  tabsFor.set(key, already);
}

console.log(`\nnav tabs\n`);
console.log(`  ${tabsFor.size} modules declare a tab list`);

/* ---- every menu link that names a tab ---- */

let checked = 0;
for (const g of NAV) {
  for (const item of g.items) {
    const href = hrefOf(item);
    const v = /[?&]v=([^&]+)/.exec(href)?.[1];
    if (!v) continue;

    checked++;
    const allowed = tabsFor.get(item.k);
    if (!allowed) {
      /*
       * The module takes no tab parameter at all, so `?v=` is ignored and the
       * link silently lands on the module's own default.
       */
      fail(`${g.group} → ${item.n}: ${href} names a tab, but ${item.k} reads none`);
      continue;
    }
    if (!allowed.has(v)) {
      fail(
        `${g.group} → ${item.n}: ${href} is not a tab ${item.k} has\n`
        + `        it accepts: ${[...allowed].sort().join(', ')}`,
      );
    }
  }
}

console.log(`  ${checked} menu links name a tab`);

/* ---- and the reverse: a tab nothing links to ---- */

const linked = new Set<string>();
for (const g of NAV) {
  for (const item of g.items) {
    const v = /[?&]v=([^&]+)/.exec(hrefOf(item))?.[1];
    if (v) linked.add(`${item.k}:${v}`);
  }
}

/*
 * Not a failure. Plenty of tabs are reached by a click inside their own
 * module — a job order, a create form — and were never meant to be in the
 * menu. Worth printing, because a tab nobody links to and nobody clicks is a
 * screen nobody can reach.
 */
const unlinked: string[] = [];
for (const [k, tabs] of tabsFor) {
  for (const t of tabs) if (!linked.has(`${k}:${t}`)) unlinked.push(`${k}?v=${t}`);
}
if (unlinked.length) {
  console.log(`  note  ${unlinked.length} tabs are reached from inside their module rather than the menu`);
}

console.log();
if (failed) {
  console.error(`${failed} menu link(s) name a tab that does not exist`);
  process.exit(1);
}
console.log('every menu link lands on the tab it names');
