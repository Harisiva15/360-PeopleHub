/**
 * An icon is drawn, never spelled.
 *
 * ## What went wrong
 *
 * The sign-in page — the one screen every customer sees before they see
 * anything else — rendered six tiles reading "people", "schedule",
 * "document", "chart", "star" and "laptop", two of them overlapping. The
 * markup was `<span className="cap-ic">{c.ic}</span>` over a list whose `ic`
 * held Material Symbols ligature names.
 *
 * A ligature name is only an icon if a font is loaded that maps it to a glyph.
 * None was ever loaded here, and none should be: this product draws its icons
 * as SVG from `src/components/icons.tsx`, so a ligature font would be a second
 * icon set, a request on the critical path, and a page that renders its own
 * source when that request fails.
 *
 * ## Why `checks/icons.ts` could not have caught it
 *
 * That check refuses a *glyph* where an icon belongs, and asserts every icon
 * name used is declared. Both passed here, and correctly: the names were real
 * entries in our own set — `people` and `schedule` are in the registry — and
 * no emoji was involved. The data was right and the *render* was wrong, so a
 * check that reads names cannot see it. This one reads the markup instead, and
 * the two are deliberately separate files rather than one with four jobs.
 *
 * ## The rules
 *
 * 1. Nothing references Material Symbols or Material Icons, by class, font
 *    family or URL — stylesheet and `index.html` included.
 * 2. No element whose class marks it an icon slot renders a *name*. A glyph is
 *    not this check's business: emoji sit in icon slots in forty-odd places
 *    and they render, which is `checks/icons.ts`'s argument to have. What is
 *    refused is a name reaching the DOM where a drawing belongs.
 * 3. Every module named by `LAUNCH_SCOPE` exists in `NAV`, so the five areas
 *    the sign-in page promises cannot drift from what is behind the login.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};

/* Tracked and new-but-not-ignored, so a file nobody has `git add`ed is seen. */
const listed = (args: string) => {
  try {
    return execSync(`git ls-files ${args}`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const sources = [...new Set([
  ...listed('"src/*.tsx" "src/**/*.tsx" "src/*.ts" "src/**/*.ts"'),
  ...listed('--others --exclude-standard "src/*.tsx" "src/**/*.tsx" "src/*.ts" "src/**/*.ts"'),
])].sort();

ok('there are source files to scan', sources.length > 0, `found ${sources.length}`);

const read = (f: string) => {
  try { return readFileSync(f, 'utf8'); } catch { return ''; }
};
/* Comments out: this file's own prose names the thing it refuses. */
const strip = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ---------------- 1. no icon font, anywhere ---------------- */

const FONT = /material[-\s]?(symbols|icons)|fonts\.googleapis\.com\/(icon|css2\?family=Material)/i;
const fontHits: string[] = [];
for (const f of [...sources, 'index.html', 'src/styles/global.css']) {
  strip(read(f)).split('\n').forEach((line, i) => {
    if (FONT.test(line)) fontHits.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
}
ok('nothing references an external icon font', fontHits.length === 0,
  `${fontHits.length} reference(s):\n        ${fontHits.join('\n        ')}\n        `
  + 'Icons are drawn from src/components/icons.tsx. A ligature font is a second '
  + 'icon set and a request on the critical path, and when it fails the page '
  + 'renders the names.');

/* ---------------- 2. no name in an icon slot ---------------- */

/*
 * An opening tag whose className marks an icon slot, then everything up to
 * that element's close. These are always a `span` or `div` with no nesting of
 * the same tag, so matching to the first close tag is exact here.
 */
const SLOT = /<(span|div)([^>]*\bclassName=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})[^>]*)>([\s\S]*?)<\/\1>/g;
const ICON_CLASS = /(^|[\s-])(ic|icon)(?=$|[\s-])/;

/** A bare word: a name, not a glyph. */
const BARE_WORD = /^[A-Za-z][A-Za-z0-9_]*$/;
/** `{'people'}` — a quoted name in an expression slot. */
const QUOTED_WORD = /^\{\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]\s*\}$/;
/** `{x.ic}` / `{x.icon}` — a field whose name says it holds an icon. */
const NAME_FIELD = /^\{\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(ic|icon)\s*\}$/;
/**
 * `ic: 'people'` — a declaration holding a *name*.
 *
 * This is what makes rule 2 precise rather than noisy. Reading `{x.icon}` into
 * an icon slot is only wrong when that field holds a name; several screens keep
 * an emoji map and read it exactly the same way, and those render correctly.
 * So a field read is flagged only when the same file declares such a field
 * with a bare word in it — which is the sign-in page's shape and not theirs.
 */
const DECLARES_NAME = /\b(?:ic|icon)\s*:\s*'[A-Za-z][A-Za-z0-9_]*'/;

const slotHits: string[] = [];
for (const f of sources) {
  const text = strip(read(f));
  const declaresName = DECLARES_NAME.test(text);
  for (const m of text.matchAll(SLOT)) {
    const cls = m[3] ?? m[4] ?? m[5] ?? '';
    if (!cls.split(/\s+/).some((c) => ICON_CLASS.test(c))) continue;
    const inner = m[6]!.trim();
    if (!inner || inner.includes('<Icon')) continue;
    const isName = BARE_WORD.test(inner) || QUOTED_WORD.test(inner)
      || (NAME_FIELD.test(inner) && declaresName);
    if (!isName) continue;
    slotHits.push(`${f}:${text.slice(0, m.index).split('\n').length}`
      + `  class="${cls}"  renders ${inner}`);
  }
}
ok('no icon slot renders a name instead of a drawing', slotHits.length === 0,
  `${slotHits.length} slot(s):\n        ${slotHits.join('\n        ')}\n        `
  + 'Pass the name to the component instead: <Icon n={...} />. A name in the '
  + 'DOM is the sign-in page bug — the word renders where the picture should.');

/* ---------------- 3. the sign-in promise matches the app ---------------- */

const nav = read('src/nav.ts');
const navKeys = new Set([...nav.matchAll(/\bk:\s*'([^']+)'/g)].map((m) => m[1]!));
const scope = nav.slice(nav.indexOf('export const LAUNCH_SCOPE'));
const scopeModules = [...scope.matchAll(/modules:\s*\[([^\]]*)\]/g)]
  .flatMap((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));

ok('the sign-in page names some modules', scopeModules.length > 0,
  'LAUNCH_SCOPE in src/nav.ts lists no modules — if it moved, point this at it');

const missing = scopeModules.filter((k) => !navKeys.has(k));
ok('every module the sign-in page promises exists in NAV', missing.length === 0,
  `LAUNCH_SCOPE names ${missing.join(', ')}, which NAV does not have. The front `
  + 'door is advertising something that is not behind it — rename the entry or '
  + 'drop it from the launch scope.');

/*
 * And is reachable, which is the stronger half.
 *
 * `HIDDEN_ROUTES` is this product's real launch scope: 72 of 116 menu items
 * are closed for go-live, `performance`, `engagement` and `benefits` among
 * them. The sign-in page used to promise exactly those three, so a visitor's
 * first impression was a list of the areas they could not reach. Existing in
 * NAV is not enough — a module can be registered and closed.
 */
const hidden = new Set(
  [...read('src/nav.ts')
    .slice(nav.indexOf('export const HIDDEN_ROUTES'))
    .slice(0, nav.slice(nav.indexOf('export const HIDDEN_ROUTES')).indexOf(']'))
    .matchAll(/'([^']+)'/g)].map((m) => m[1]!),
);
ok('the hidden-route set was read', hidden.size > 10, `found ${hidden.size}`);

const closed = scopeModules.filter((k) => hidden.has(k));
ok('every module the sign-in page promises is open at launch', closed.length === 0,
  `LAUNCH_SCOPE promises ${closed.join(', ')}, which HIDDEN_ROUTES closes. The `
  + 'sign-in page would be advertising a module that redirects when reached.');

console.log(`  note  launch scope covers ${scopeModules.length} module(s): ${
  scopeModules.join(', ')}`);

console.log();
if (failed) {
  console.error(`${failed} ligature check(s) failed`);
  process.exit(1);
}
console.log('every icon is drawn, and the sign-in page promises only what exists');
