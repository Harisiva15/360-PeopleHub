/**
 * A button may not say a thing happened unless something happened.
 *
 * Twenty-eight handlers across the product raised a success toast and did no
 * work at all. Not edge cases — "Settings saved" on the leave policy and on
 * the company profile, "Bank advice generated", "Reminder emails sent to
 * employees with incomplete files", "Thank you — your response has been
 * recorded" on a survey that stored nothing. Each one looked finished, and the
 * person pressing it had no way to tell it was not.
 *
 * Nothing caught them because nothing was broken in any sense a type or a test
 * could see: the handler ran, the toast appeared, the screen was consistent
 * with itself. Only the database disagreed, and nobody was asking it.
 *
 * So this asks the question directly, of every click handler in the product:
 * if you raise a success toast, show me the work. The work may be a service
 * call, a mutation, a download, a navigation — anything that leaves the
 * component. What it may not be is nothing.
 *
 * ## What counts as work
 *
 * Deliberately generous. A false positive here is a developer arguing with a
 * check that is wrong, which is expensive and teaches them to route around it.
 * The list below is everything that plausibly leaves the browser or the
 * component, and the check only fires when a handler does *none* of it.
 *
 * ## The escape hatch, and why it is narrow
 *
 * Some actions really are local and really did happen — filling a form from
 * the device's position, for instance. Those may keep a success toast, and
 * they are listed in `LOCAL` by file and reason. The list is short on purpose:
 * every entry is a place where a reader has to take somebody's word for it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Handlers whose success toast is true without leaving the browser.
 *
 * Keyed by `file:line-ish` is too brittle — a line moves and the entry goes
 * stale silently — so these are keyed by the toast's own text, which changes
 * only when somebody means it to.
 */
const LOCAL: Record<string, string> = {
  'Filled from your current position':
    'the form really is filled, from the device — nothing is claimed to be stored',
};

/** Anything that might reach the server, the router, or the filesystem. */
const WORK = [
  'await ', '.then(', '.mutate(', 'downloadCSV(', 'window.print()',
  'navigate(', 'location.assign', 'Promise.all', 'setTimeout',
];

const files: string[] = [];
const walk = (dir: string) => readdirSync(dir).forEach((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) walk(p);
  else if (/\.tsx$/.test(f)) files.push(p);
});
walk(join('src', 'modules'));
walk(join('src', 'shell'));

interface Hit { file: string; text: string; line: number }
const hits: Hit[] = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');

  for (const m of src.matchAll(/onClick=\{/g)) {
    /* The handler body, by brace balance from the opening brace. */
    let i = m.index! + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    const body = src.slice(m.index!, i);

    /* Only success toasts. An error toast reports a failure and needs no work. */
    const toast = body.match(/toast\(\s*([^;]*?),\s*'ok'\s*\)/s);
    if (!toast) continue;
    if (WORK.some((w) => body.includes(w))) continue;

    const text = toast[1]!.replace(/\s+/g, ' ').trim().slice(0, 70);
    if (Object.keys(LOCAL).some((k) => text.includes(k))) continue;

    hits.push({ file, text, line: src.slice(0, m.index!).split('\n').length });
  }
}

for (const h of hits) {
  console.error(`  FAIL  ${h.file}:${h.line}`);
  console.error(`        raises a success toast and does no work: ${h.text}`);
}

/* An exemption whose toast no longer exists is one nobody will notice is stale. */
const allSrc = files.map((f) => readFileSync(f, 'utf8')).join('\n');
let stale = 0;
for (const [text, why] of Object.entries(LOCAL)) {
  if (!allSrc.includes(text)) {
    stale += 1;
    console.error(`  FAIL  "${text}" is listed as a local success and no longer appears — drop the entry`);
  } else {
    console.log(`  ok    "${text}"\n        ${why}`);
  }
}

console.log(hits.length || stale
  ? `\n${hits.length + stale} problem(s)`
  : `\nno click handler claims success without doing something (${files.length} files)`);
process.exit(hits.length || stale ? 1 : 0);
