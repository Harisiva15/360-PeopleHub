/**
 * The row-actions menu, measured open.
 *
 * Every other spec measures a page at rest, and this bug only exists while a
 * menu is open — which is why an audit of 3,900 findings never mentioned it
 * and a screenshot did. So this one opens the ⋯ on the **last** row, where
 * there is least room below and a panel has to flip, and runs the same probe.
 *
 * Checks it exists for: `popover-clipped`, `popover-offscreen` and
 * `action-cell-wrapped`. Also `invalid-value-text`, which has nothing to do
 * with menus but needs a page with real rows on it.
 *
 * Writes the findings beside the screenshots so a run can be compared with the
 * one before it.
 */

import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { open } from '../../e2e/shell';
import { probe } from './probe';
import type { Finding } from './probe';

/*
 * Beside the capture spec's output, under the one directory `.gitignore`
 * already excludes. A second location would be a second thing to remember to
 * ignore, and a megabyte of PNGs would have gone into the repo the first time
 * somebody ran `git add -A`.
 */
const OUT = process.env.ROWMENU_OUT ?? join(process.cwd(), 'alignment-audit', 'rowmenu');
const WIDTHS = [
  { w: 1440, h: 900, k: '1440' },
  { w: 1024, h: 768, k: '1024' },
  { w: 390, h: 844, k: '390' },
];
const THEMES = ['light', 'dark'] as const;
/* The three the menu can be cut off by, plus the text one. */
const WATCHED = [
  'popover-clipped', 'popover-offscreen', 'action-cell-wrapped', 'invalid-value-text',
];

for (const theme of THEMES) {
  test(`row menu: ${theme}`, async ({ page }) => {
    test.setTimeout(6 * 60 * 1000);
    page.setDefaultTimeout(10_000);

    mkdirSync(OUT, { recursive: true });
    const all: Finding[] = [];

    for (const { w, h, k } of WIDTHS) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: theme });
      await open(page, 'users');
      await page.evaluate(
        (t) => document.documentElement.setAttribute('data-theme', t), theme);

      const rows = page.locator('table.tbl tbody tr');
      const n = await rows.count();
      expect(n, 'user management has rows to act on').toBeGreaterThan(0);

      /*
       * The last row, deliberately. The first row's menu has the whole table
       * below it and looks fine even when the positioning is wrong; the last
       * row is where a panel either flips or runs off the bottom.
       */
      const trigger = rows.nth(n - 1).locator('.menu-wrap button').first();
      if (!(await trigger.count())) continue;

      /* Measure the cell before opening: the wrap is there either way. */
      all.push(...(await page.evaluate(probe, theme))
        .filter((f) => f.check === 'action-cell-wrapped' || f.check === 'invalid-value-text')
        .map((f) => ({ ...f, detail: `[${k}px, closed] ${f.detail}` })));

      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const panel = page.locator('[role="menu"]');
      await expect(panel.first()).toBeVisible();
      /* Let the placement effect run before measuring where it landed. */
      await page.waitForTimeout(150);

      await page.screenshot({
        path: join(OUT, `users-rowmenu-${k}-${theme}.png`),
        fullPage: false,
      });

      const found = await page.evaluate(probe, theme);
      all.push(...found
        .filter((f) => WATCHED.includes(f.check))
        .map((f) => ({ ...f, detail: `[${k}px, open] ${f.detail}` })));

      /* Report what the panel's geometry actually was, pass or fail. */
      const box = await panel.first().boundingBox();
      const note = box
        ? `${k}px ${theme}: panel at x=${Math.round(box.x)} y=${Math.round(box.y)} `
          + `w=${Math.round(box.width)} h=${Math.round(box.height)}; `
          + `viewport ${w}x${h}; `
          + `right edge ${Math.round(box.x + box.width)} `
          + `bottom edge ${Math.round(box.y + box.height)}`
        : `${k}px ${theme}: no panel box`;
      console.log(`  ${note}`);

      await page.keyboard.press('Escape');
    }

    /*
     * Prove the text rule can see the fault before trusting that it sees none.
     *
     * The demo dataset writes `2026-09-18T09:30`, so the "NaN Invalid Date"
     * that shipped against the real API cannot occur here at all — a zero
     * from this page is therefore not evidence by itself. This injects what
     * the old formatter actually produced for the real stored value and
     * requires the probe to report it, so the zero above means "clean" rather
     * than "blind".
     */
    /* Exactly what `whenOf('2026-11-06 08:11:47.450537+00')` used to return. */
    await page.evaluate(() => {
      const cell = document.querySelector('table.tbl tbody tr td');
      if (!cell) return;
      cell.setAttribute('data-was', cell.textContent ?? '');
      cell.textContent = 'NaN Invalid Date';
    });
    const selfTest = await page.evaluate(probe, theme);
    await page.evaluate(() => {
      const cell = document.querySelector('table.tbl tbody tr td');
      if (cell) cell.textContent = cell.getAttribute('data-was') ?? '';
    });
    expect(
      selfTest.filter((f) => f.check === 'invalid-value-text').length,
      'the probe must report "NaN Invalid Date" while it is on the page, or '
      + 'the zero above means blind rather than clean',
    ).toBeGreaterThan(0);

    writeFileSync(
      join(OUT, `findings-${theme}.json`), `${JSON.stringify(all, null, 2)}\n`);

    const summary = WATCHED
      .map((c) => `${c}: ${all.filter((f) => f.check === c).length}`)
      .join(', ');
    console.log(`\n  ${theme} — ${summary}\n`);
    for (const f of all) console.log(`  ${f.check}  ${f.sel}\n      ${f.detail}`);

    expect(all, `${theme}: ${summary}`).toEqual([]);
  });
}
