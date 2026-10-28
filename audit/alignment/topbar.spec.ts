/**
 * What is actually too wide in the header at 390px.
 *
 * The audit's report names `TopBar (shell)` as the biggest-reach defect — 91
 * pages with content past the right edge and nothing to scroll it — and names
 * the overflowing elements, but an element's own right edge does not say which
 * sibling pushed it there. Four controls that each fit can still not fit
 * together, and the one to change is whichever refuses to give up width.
 *
 * So this measures the row rather than inferring it: every child of
 * `header.topbar`, its width, and its resolved `flex` — on a page with a
 * primary action portaled into the header and on one without, because the
 * report's worst case (a right edge at 515px in a 390px viewport) was a page
 * with a CTA and its mildest (400px) was a page without.
 *
 * Not a test. It prints a table and asserts nothing; it is here so the fix is
 * aimed at a measurement, and so the same measurement can be repeated after.
 *
 *   npx playwright test --config playwright.audit.config.ts topbar
 */

import { test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { open, goHash } from '../../e2e/shell';

interface Child {
  tag: string;
  cls: string;
  width: number;
  right: number;
  flexGrow: string;
  flexShrink: string;
  flexBasis: string;
  minWidth: string;
  overflow: string;
  text: string;
}

async function measure(page: Page): Promise<{
  viewport: number; barWidth: number; scrollWidth: number;
  overflow: string; children: Child[];
}> {
  return page.evaluate(() => {
    const bar = document.querySelector('header.topbar');
    if (!bar) return { viewport: 0, barWidth: 0, scrollWidth: 0, overflow: '', children: [] };
    const kids = Array.from(bar.children).map((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        cls: el.className.toString().slice(0, 28),
        width: Math.round(r.width * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        flexGrow: s.flexGrow,
        flexShrink: s.flexShrink,
        flexBasis: s.flexBasis,
        minWidth: s.minWidth,
        overflow: s.overflowX,
        text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24),
      };
    });
    return {
      viewport: window.innerWidth,
      barWidth: Math.round(bar.getBoundingClientRect().width * 10) / 10,
      scrollWidth: bar.scrollWidth,
      overflow: getComputedStyle(bar).overflowX,
      children: kids,
    };
  });
}

/* A page with a primary action in the header, and one without. */
const STOPS = ['jobtitles', 'timesheet?v=entry', 'dashboard'];

test('what is too wide in the header at 390px', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  page.setDefaultTimeout(10_000);

  await open(page, 'dashboard');
  await page.setViewportSize({ width: 390, height: 844 });

  for (const stop of STOPS) {
    await goHash(page, stop);
    /*
     * Long enough for `PageActions` to portal the page's primary action into
     * `.topbar-cta`. At 400ms the first run of this file measured that slot at
     * zero width and concluded the header fitted — while the audit, which
     * arrives at each page by a slower route, measured the same header 137px
     * past the viewport. The CTA is the whole difference.
     */
    await page.waitForTimeout(1500);
    const settled = await measure(page);

    /*
     * And again immediately after a full-page screenshot, which is exactly
     * what `capture.spec.ts` does: `page.screenshot({ fullPage: true })` and
     * then `page.evaluate(probe)` with nothing in between. Chromium takes a
     * full-page shot by resizing the viewport to the content height and back,
     * so the question is whether the probe measured the page mid-reflow.
     */
    await page.screenshot({ fullPage: true, path: 'alignment-audit/_probe-check.png' });
    const afterShot = await measure(page);

    console.log(`\n### ${stop}: settled scrollWidth ${settled.scrollWidth}`
      + `  vs after a fullPage shot ${afterShot.scrollWidth}`);

    /* Every descendant past the viewport, which is what actually overflows. */
    const past = await page.evaluate(() => {
      const out: string[] = [];
      const bar = document.querySelector('header.topbar');
      if (!bar) return out;
      for (const el of Array.from(bar.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right <= window.innerWidth + 0.5) continue;
        const s = getComputedStyle(el);
        const parent = el.parentElement;
        const pr = parent ? parent.getBoundingClientRect().right : 0;
        out.push(
          `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 26)}`.padEnd(34)
          + `right ${Math.round(r.right * 10) / 10}`.padEnd(14)
          + `w ${Math.round(r.width * 10) / 10}`.padEnd(10)
          + `pos ${s.position}`.padEnd(14)
          + `parent right ${Math.round(pr * 10) / 10}`);
      }
      return out;
    });
    console.log(past.length
      ? `past the ${390}px viewport:\n  ${past.join('\n  ')}`
      : 'nothing past the viewport');

    const m = afterShot;

    console.log(`\n=== ${stop} @ ${m.viewport}px ===`);
    console.log(
      `header: width ${m.barWidth}  scrollWidth ${m.scrollWidth}  `
      + `overflow-x: ${m.overflow}  →  ${m.scrollWidth - Math.round(m.barWidth)}px clipped`);
    console.log(
      'child'.padEnd(32) + 'w'.padStart(7) + 'right'.padStart(8)
      + '  grow/shrink/basis'.padEnd(22) + 'min'.padEnd(8) + 'text');
    for (const c of m.children) {
      console.log(
        `${c.tag}.${c.cls}`.padEnd(32)
        + String(c.width).padStart(7)
        + String(c.right).padStart(8)
        + `  ${c.flexGrow}/${c.flexShrink}/${c.flexBasis}`.padEnd(22)
        + c.minWidth.padEnd(8)
        + c.text);
    }
  }
});
