/**
 * Text that the key screens actually render, measured against the background
 * it actually lands on.
 *
 * ## Why this exists alongside `checks/contrast.ts`
 *
 * That check reads the stylesheet, resolves token pairs and measures them. It
 * is deterministic, needs no browser, and runs in two seconds — and it can
 * only measure pairs somebody thought to list. Two real AA failures shipped
 * underneath it:
 *
 *   - the timesheet's today column and week total, `--brand` as text on
 *     `--surface-2`: 4.12:1 in light, 3.49:1 in dark
 *   - the calendar's weekly-off cell, `--ink-3` on `--line-2`: 3.45 and 3.26
 *
 * Neither pair was in the list, so neither was measured. A rendered page does
 * not care which combinations were anticipated: it composites whatever the
 * cascade produced, including a colour set on an element three levels above
 * the text. That is what this measures.
 *
 * ## What it runs
 *
 * The audit's own `probe`, filtered to its `contrast` findings — the same
 * function `capture.spec.ts` uses, so there is one measurement in this repo
 * and not two that can disagree. The screens are the ones where getting it
 * wrong costs the most: the first screen after signing in, the three people
 * use every day, the one administrators work in, and the sign-in page itself,
 * which is the only screen a customer sees before they are a customer.
 *
 * ## Why it fails rather than counts
 *
 * The full audit is a report with a ratchet. This is a gate: on these six
 * screens, in both themes, text below its AA threshold fails the build. The
 * list is deliberately short so that staying at zero is achievable; widening
 * it is a decision to take once these are held.
 */

import { expect, test } from '@playwright/test';
import { probe } from './probe';

/** The theme key `AppContext` reads on boot. */
const THEME_KEY = '360people.theme';

const SCREENS: { name: string; hash: string; wait: string }[] = [
  { name: 'sign-in', hash: '#/', wait: '.login-card' },
  { name: 'dashboard', hash: '#/dashboard', wait: '.stack' },
  { name: 'attendance', hash: '#/attendance', wait: '.stack' },
  { name: 'timesheets', hash: '#/timesheet', wait: '.stack' },
  { name: 'leave calendar', hash: '#/leave', wait: '.stack' },
  { name: 'user management', hash: '#/users', wait: '.stack' },
];

const THEMES = ['light', 'dark'] as const;

for (const theme of THEMES) {
  test(`runtime contrast: ${theme}`, async ({ page }) => {
    await page.addInitScript(([key, value]) => {
      try { localStorage.setItem(key as string, value as string); } catch { /* private mode */ }
    }, [THEME_KEY, theme]);

    const failures: string[] = [];

    for (const screen of SCREENS) {
      /*
       * The sign-in screen is the signed-out state, so it needs its own
       * context — every other screen is reached as the demo administrator,
       * who is signed in from boot. Clearing storage would sign that session
       * out for the rest of the walk, so sign-in is visited first and the
       * others follow in one session.
       */
      await page.goto(`/${screen.hash}`, { waitUntil: 'networkidle' });
      await page.waitForSelector(screen.wait, { timeout: 20_000 }).catch(() => null);
      await page.waitForTimeout(500);

      const found = await page.evaluate(probe, theme);
      const contrast = found.filter((f) => f.check === 'contrast');

      for (const f of contrast) {
        failures.push(`${screen.name} [${theme}]  ${f.detail}\n      ${f.sel}`);
      }
      console.log(`  ${contrast.length === 0 ? 'ok  ' : 'FAIL'}  ${
        screen.name.padEnd(16)} ${theme.padEnd(5)} ${contrast.length} below AA`);
    }

    expect(failures, `${failures.length} text element(s) below their AA threshold:\n\n      `
      + `${failures.join('\n\n      ')}\n\n      `
      + 'Each is text the page actually rendered against the background it '
      + 'actually landed on. Fix the colour, or if the pair is genuinely '
      + 'decorative give it a token that measures.').toEqual([]);
  });
}
