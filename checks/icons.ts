/**
 * One icon family, kept that way.
 *
 * The product used emoji as icons until the set moved to Lucide. That was a
 * change across a hundred files, and the way it comes undone is one emoji
 * typed into one new button — which looks fine to whoever wrote it and wrong
 * next to everything around it, because an emoji is a bitmap in somebody
 * else's palette and cannot take the theme's ink.
 *
 * So this fails the build on a glyph used as an icon, and says where.
 *
 * **What it does not object to.** A glyph inside a sentence is writing, not
 * iconography: an arrow in "→ see settings", a degree sign, a currency symbol
 * in a label. The patterns below target the places an *icon* goes — a control's
 * leading character, an `icon=` prop — and leave prose alone.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = execSync('git ls-files src', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.tsx?$/.test(f));

/*
 * The ranges that render as pictures rather than letters. Deliberately not
 * "anything non-ASCII": the product is written in English with en dashes,
 * curly quotes and ₹, and those are typography.
 */
const PICTORIAL = '[\\u{1F300}-\\u{1FAFF}\\u{1F000}-\\u{1F2FF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}]';

interface Hit { file: string; line: number; text: string; why: string }
const hits: Hit[] = [];

for (const rel of files) {
  const src = readFileSync(join(root, rel), 'utf8');
  const lines = src.split(/\r?\n/);

  lines.forEach((line, i) => {
    const at = (why: string) =>
      hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 78), why });

    /* An icon prop holding a glyph rather than an <Icon>. */
    if (new RegExp(`icon=["'\`]?${PICTORIAL}`, 'u').test(line)) at('icon prop');

    /* A control whose visible label opens with a glyph. */
    if (new RegExp(`<(?:button|a|Link)\\b[^>]*>\\s*${PICTORIAL}`, 'u').test(line)) at('control label');

    /* A nav or registry entry declaring a glyph. */
    if (new RegExp(`\\bic:\\s*["'\`]${PICTORIAL}`, 'u').test(line)) at('nav entry');
  });
}

console.log('\nicons\n');

if (hits.length) {
  for (const h of hits) {
    console.error(`  FAIL  ${h.file}:${h.line}  (${h.why})\n        ${h.text}`);
  }
  console.error(
    `\n${hits.length} glyph(s) used as an icon. Use <Icon n="…" /> from `
    + 'src/components/icons.tsx — add a name there if none fits.',
  );
  process.exit(1);
}

/* The registry is only useful if it is actually what the app draws. */
const registry = readFileSync(join(root, 'src/components/icons.tsx'), 'utf8');
const declared = new Set(
  [...registry.matchAll(/^\s{2}([a-zA-Z][\w]*):\s*[A-Z]\w*,/gm)].map((m) => m[1]!),
);

const used = new Set<string>();
for (const rel of files) {
  const src = readFileSync(join(root, rel), 'utf8');
  for (const m of src.matchAll(/<Icon\s+n="([^"]+)"/g)) used.add(m[1]!);
  for (const m of src.matchAll(/\bic:\s*'([a-zA-Z]\w*)'/g)) used.add(m[1]!);
}

const unknown = [...used].filter((n) => !declared.has(n));
if (unknown.length) {
  console.error(`  FAIL  icons used but not declared: ${unknown.join(', ')}`);
  process.exit(1);
}

/*
 * An unused name is not a failure — a registry is allowed a little slack for
 * the next screen — but a lot of them means it has stopped being deliberate.
 */
const unused = [...declared].filter((n) => !used.has(n));
console.log(`  ok    ${files.length} files carry no glyph where an icon belongs`);
console.log(`  ok    ${used.size} icon names used, all declared`);
if (unused.length) {
  console.log(`  note  ${unused.length} declared but unused: ${unused.slice(0, 12).join(', ')}`);
}

console.log('\none icon family, and it is the one in the registry');
