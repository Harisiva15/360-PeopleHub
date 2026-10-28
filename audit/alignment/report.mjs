/**
 * Turn the capture run's findings into the report.
 *
 *   node audit/alignment/report.mjs
 *
 * ## One row per defect, not one per screenshot
 *
 * A ragged toolbar on forty pages at four widths is 160 findings and one bug.
 * Reporting it 160 times buries the eight things that actually need deciding,
 * so every finding is folded onto its (check, owner, element) and the row
 * carries the count, the widths and themes it shows at, and one screenshot to
 * look at. The detail of the worst instance is kept verbatim, because the
 * numbers are the evidence.
 *
 * ## Grouping by owner is grouping by root cause
 *
 * `probe.ts` attributes every finding to the nearest shared component, so the
 * report's sections are the fix list: a section with thirty rows under
 * `Table (ui.tsx)` is one file to open. A section under `page` is a page's own
 * problem and is the only kind that gets fixed page by page.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'alignment-audit/_findings';
const OUT = 'alignment-audit/REPORT.md';

if (!existsSync(DIR)) {
  console.error(`No findings at ${DIR}. Run: npm run audit:align`);
  process.exit(1);
}

/** What each check means, and what to do about it. */
const CHECKS = {
  'page-h-scroll': {
    title: 'the page scrolls sideways',
    fix: 'find the widest child and give it its own `overflow-x:auto`, or let it wrap',
  },
  'overflows-viewport': {
    title: 'content past the right edge with nothing to scroll it',
    fix: 'wrap it in a scroll container, or let the row wrap at this width',
  },
  'text-clipped': {
    title: 'text cut off by its box',
    fix: 'either `text-overflow:ellipsis` so the cut is deliberate and reversible on hover, or let the box grow',
  },
  'text-overflows': {
    title: 'text spilling out of a fixed-height box',
    fix: 'drop the fixed height, or clamp the text with `-webkit-line-clamp`',
  },
  overlap: {
    title: 'elements overlapping each other',
    fix: 'the row is narrower than its contents — make the container wrap or shrink its items',
  },
  'control-height': {
    title: 'controls in one row at different heights',
    fix: 'one control height per row: put every control on `--h-ctl` (38px) and let padding differ instead',
  },
  'control-centre': {
    title: 'equal-height controls sitting at different heights',
    fix: '`align-items:center` on the row rather than `baseline` or `stretch`',
  },
  baseline: {
    title: 'text baselines in one row not aligned',
    fix: 'the controls differ in font-size or line-height; set both on the row, not per control',
  },
  'control-height-off-token': {
    title: 'a control height off the scale',
    fix: 'use `--h-ctl-sm`/`--h-ctl`/`--h-ctl-lg` (32/38/44px) rather than padding that happens to add up',
  },
  'label-offset': {
    title: 'a form label not aligned with its field',
    fix: 'the label and the control must share the left edge — check for padding on one and not the other',
  },
  'control-not-filling': {
    title: 'a control narrower than its field',
    fix: '`width:100%` on the control; a `select` does not fill its parent by default',
  },
  'field-width': {
    title: 'fields in one row at different widths',
    fix: 'equal grid tracks with unequal boxes means an item is setting its own width — remove it',
  },
  'table-no-scroll-wrapper': {
    title: 'a table wider than its parent, with no scroll wrapper',
    fix: 'wrap it in `TableWrap` (`.tbl-wrap`, `overflow-x:auto`) — this is the bug that hid the Edit button',
  },
  'table-scrolls': {
    title: 'a table that only fits by scrolling sideways',
    fix: 'informational: decide whether the column set is right for this width, or pin the actions column',
  },
  'column-misaligned': {
    title: 'a column not aligned with its header',
    fix: 'a `colspan` or a sticky cell is off — compare the header row and the first body row',
  },
  'column-align-mismatch': {
    title: 'a header aligned differently from its own column',
    fix: 'numeric columns want `text-align:right` on both the `th` and the `td`, set from one rule',
  },
  'card-height': {
    title: 'cards in one row at uneven heights',
    fix: '`align-items:stretch` on the grid, so a short card matches its neighbour',
  },
  'card-padding': {
    title: 'cards in one row with different padding',
    fix: 'one of them is not using `.card-b` — put the padding on the component, never the page',
  },
  'icon-text-centre': {
    title: 'an icon off the centre of its text',
    fix: 'the icon and its label want `display:inline-flex; align-items:center` on their shared parent',
  },
  'empty-off-centre': {
    title: 'an empty state not centred',
    fix: '`EmptyState` should centre itself; the container is adding padding on one side',
  },
  contrast: {
    title: 'text below the contrast it needs',
    fix: 'take the colour from a `--ink`/`--ink-2`/`--ink-3` token resolved for this theme, not a literal',
  },
  'light-box-in-dark': {
    title: 'a light surface left in the dark theme',
    fix: 'the background is a literal rather than `--surface`/`--surface-2`, so it never flipped',
  },
  'spacing-off-token': {
    title: 'inline spacing off the scale',
    fix: 'move it into the stylesheet and onto `--sp-*`, or accept it as a token',
  },
};

const SEV_ORDER = { high: 0, med: 1, low: 2 };

/* ------------------------------------------------------------ load and fold */

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'css-tokens.json');
if (!files.length) {
  console.error(`No capture findings in ${DIR}. Run: npm run audit:align`);
  process.exit(1);
}

/** key → folded row */
const rows = new Map();
const notes = [];
let shots = 0;

for (const f of files) {
  const data = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
  for (const n of data.notes || []) notes.push(`${data.role}/${data.theme}: ${n}`);

  for (const [shot, findings] of Object.entries(data.findings || {})) {
    shots += 1;
    /* `company_admin/employee-directory_default_1024_light.png` */
    const base = shot.split('/').pop();
    const parts = base.replace(/\.png$/, '').split('_');
    const theme = parts.pop();
    const width = Number(parts.pop());
    const tab = parts.pop();
    const page = parts.join('_');

    for (const fd of findings) {
      const key = `${fd.check}|${fd.owner}|${fd.sel}`;
      const row = rows.get(key) || {
        check: fd.check,
        owner: fd.owner,
        sel: fd.sel,
        severity: fd.severity,
        pages: new Set(),
        widths: new Set(),
        themes: new Set(),
        roles: new Set(),
        count: 0,
        worst: fd.detail,
        shot,
      };
      row.count += 1;
      row.pages.add(`${page}${tab === 'default' ? '' : `?v=${tab}`}`);
      row.widths.add(width);
      row.themes.add(theme);
      row.roles.add(data.role);
      if (SEV_ORDER[fd.severity] < SEV_ORDER[row.severity]) {
        row.severity = fd.severity;
        row.worst = fd.detail;
        row.shot = shot;
      }
      rows.set(key, row);
    }
  }
}

/* ------------------------------------------------------------------ arrange */

const byOwner = new Map();
for (const row of rows.values()) {
  const list = byOwner.get(row.owner) || [];
  list.push(row);
  byOwner.set(row.owner, list);
}

/*
 * A section's weight is severity × reach, where reach is *pages* and not raw
 * instances.
 *
 * Counting instances ranked by how many rows a list happened to render: one
 * avatar defect appears forty times on a forty-person directory and once on a
 * five-person one, which says nothing about which is worth fixing first.
 * Pages reached is the honest measure of blast radius.
 */
const weigh = (list) => list.reduce(
  (n, r) => n + r.pages.size * (r.severity === 'high' ? 10 : r.severity === 'med' ? 3 : 1), 0,
);
const sections = [...byOwner.entries()].sort((a, b) => weigh(b[1]) - weigh(a[1]));

/* Sort each owner's rows here, not in the detail loop below. The summary
   table names each owner's worst defect, and reading `items[0]` from an
   unsorted list put a low-severity token nit under a column headed "Worst". */
for (const [, items] of sections) {
  items.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.count - a.count);
}

const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const list = (set, n = 4) => {
  const items = [...set].sort();
  return items.length > n ? `${items.slice(0, n).join(', ')} +${items.length - n}` : items.join(', ');
};
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/* ------------------------------------------------------------------- write */

const totals = { high: 0, med: 0, low: 0 };
for (const r of rows.values()) totals[r.severity] += 1;

const out = [];
out.push('# UI alignment audit — the live launch scope');
out.push('');
out.push(`Captured from the demo build at 1440 / 1024 / 768 / 390px, light and dark,`);
out.push(`as company_admin and as employee. ${shots} screenshots carried at least one`);
out.push(`finding; ${rows.size} distinct defects after folding repeats, across`);
out.push(`${sections.length} owners.`);
out.push('');
out.push(`**${totals.high} high**, ${totals.med} medium, ${totals.low} low.`);
out.push('');
out.push('Screenshots are in `alignment-audit/<role>/`, named');
out.push('`menu-item_tab_width_theme.png`.');
out.push('');

out.push('## What to fix, in order');
out.push('');
out.push('| | Owner | Defects | Reach | Worst |');
out.push('|---|---|---|---|---|');
sections.forEach(([owner, items], i) => {
  const high = items.filter((r) => r.severity === 'high').length;
  const pages = new Set(items.flatMap((r) => [...r.pages]));
  out.push(`| ${i + 1} | ${cell(owner)} | ${items.length} (${high} high) | `
    + `${pages.size} page${pages.size === 1 ? '' : 's'} | ${cell(short(CHECKS[items[0].check]?.title ?? items[0].check, 60))} |`);
});
out.push('');

for (const [owner, items] of sections) {
  out.push(`## ${owner}`);
  out.push('');
  const checks = [...new Set(items.map((r) => r.check))];
  for (const c of checks) {
    const f = CHECKS[c];
    if (f) out.push(`- **${f.title}** → ${f.fix}`);
  }
  out.push('');
  out.push('| Page | Issue | Width / theme | Screenshot | Element | Measured |');
  out.push('|---|---|---|---|---|---|');
  for (const r of items) {
    const sev = r.severity === 'high' ? '🔴' : r.severity === 'med' ? '🟠' : '·';
    out.push(`| ${cell(list(r.pages, 3))}${r.pages.size > 3 ? '' : ''} `
      + `| ${sev} ${cell(CHECKS[r.check]?.title ?? r.check)} `
      + `| ${list(r.widths)} / ${list(r.themes)} `
      + `| \`${cell(r.shot)}\` `
      + `| \`${cell(short(r.sel, 52))}\` `
      + `| ${cell(short(r.worst, 150))} |`);
  }
  out.push('');
}

/* ------------------------------------------------------- the stylesheet half */

const cssPath = join(DIR, 'css-tokens.json');
if (existsSync(cssPath)) {
  const css = JSON.parse(readFileSync(cssPath, 'utf8'));
  const byValue = new Map();
  for (const d of css) {
    const l = byValue.get(d.px) || [];
    l.push(d);
    byValue.set(d.px, l);
  }
  out.push('## Spacing tokens, read from the stylesheet');
  out.push('');
  out.push(`${css.length} declarations hard-code a px value for margin, padding or gap`);
  out.push('that is not on the `--sp` scale (6 / 10 / 16 / 22 / 32px).');
  out.push('');
  out.push('| Value | Uses | Nearest token |');
  out.push('|---|---|---|');
  [...byValue.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([px, l]) => {
    out.push(`| ${px}px | ${l.length} | ${cell(l[0].nearest)} |`);
  });
  out.push('');
}

if (notes.length) {
  out.push('## Pages the walk could not measure');
  out.push('');
  for (const n of notes.filter((n) => !/^\S+: \d+ menu items/.test(n))) out.push(`- ${n}`);
  out.push('');
  for (const n of notes.filter((n) => /menu items/.test(n))) out.push(`- ${n}`);
  out.push('');
}

writeFileSync(OUT, `${out.join('\n')}\n`);
console.log(`${rows.size} distinct defects (${totals.high} high) across ${sections.length} owners`);
console.log(`written: ${OUT}`);
