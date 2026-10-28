/**
 * What makes a page scroll sideways.
 *
 * `page-h-scroll` is a document-level finding — it says the page is 2350px
 * wide in a 1440px viewport and nothing more, because by the time the document
 * is too wide, every ancestor is too. The element responsible is somewhere
 * below, and the only honest way to name it is to walk down: an element is the
 * culprit when it is wider than the viewport and its parent is not, which is
 * the point where the width is introduced rather than inherited.
 *
 * Pointed at a route with `WIDE_ROUTE`, and defaulting to the roster, which is
 * the one screen left scrolling sideways after the first alignment batch — at
 * every width, including 1440px, which rules out a phone-layout cause.
 *
 *   WIDE_ROUTE=shifts npx playwright test --config playwright.audit.config.ts wide
 */

import { test } from '@playwright/test';

import { open, goHash } from '../../e2e/shell';

const ROUTE = process.env.WIDE_ROUTE ?? 'shifts';
const WIDTHS = [1440, 390];

test('what makes the page wider than the viewport', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  page.setDefaultTimeout(10_000);

  await open(page, 'dashboard');
  await goHash(page, ROUTE);
  await page.waitForTimeout(1500);

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: Math.round(width * 0.62) });
    await page.waitForTimeout(600);

    const found = await page.evaluate((vw) => {
      const out: string[] = [];
      const doc = document.documentElement;
      out.push(`document scrollWidth ${doc.scrollWidth}, body ${document.body.scrollWidth}, in ${vw}px`);
      /*
       * Right edges, not widths.
       *
       * An element can push the document sideways without being wide at all:
       * something absolutely positioned at `left: 2000px` is 100px across and
       * adds 1700px of scroll. The first pass of this file looked for elements
       * wider than the viewport, found none at 1440px, and said nothing about
       * a document that was 910px too wide.
       *
       * Reported where the edge is introduced — past its own parent's edge —
       * so one element is named rather than its whole ancestry.
       */
      /*
       * The element that actually scrolls: scrollWidth past clientWidth with
       * overflow-x visible, so the excess is handed up to its parent instead
       * of being absorbed. Walked from the body down and reported closest-to-
       * the-document first, because that is the one to wrap or constrain —
       * every ancestor above it shows the same number and none of them is the
       * cause.
       */
      const walk = (el: Element, depth: number): void => {
        const s2 = getComputedStyle(el);
        const over = el.scrollWidth - el.clientWidth;
        if (over > 1 && s2.overflowX === 'visible' && el.clientWidth > 0) {
          out.push(
            '  '.repeat(Math.min(depth, 8))
            + (el.tagName.toLowerCase() + '.' + el.className.toString().slice(0, 26)).padEnd(34)
            + ('scroll ' + el.scrollWidth + ' / client ' + el.clientWidth).padEnd(28)
            + 'display ' + s2.display);
        }
        for (const c of Array.from(el.children)) walk(c, depth + 1);
      };
      walk(document.body, 0);
      return out;
    }, width);

    console.log(`\n=== ${ROUTE} @ ${width}px ===\n  ${found.join('\n  ')}`);
  }
});
