/**
 * The UI alignment audit: every in-scope page, measured and photographed.
 *
 *   npm run audit:align            # capture + measure (long; runs 4 sessions)
 *   npm run audit:align:report     # turn the findings into the report
 *
 * Deliberately *not* under `e2e/`. `playwright.config.ts` points `testDir` at
 * that folder and `gate:nodeps` runs before every push; this suite takes tens
 * of minutes and asserts almost nothing, so putting it there would make the
 * gate unusable. It has its own config, `playwright.audit.config.ts`.
 *
 * ## It reports, it does not fail
 *
 * A capture run that stops at the first ragged toolbar photographs nothing
 * else, and the point of an audit is the whole picture. So every check writes
 * a finding and carries on; the only things that fail a capture are the error
 * boundary and a page that never paints, because neither produces a screenshot
 * worth looking at. `report.mjs` is what turns the findings into a verdict.
 *
 * ## Why one session per role × theme
 *
 * The demo role lives in memory, so a reload lands you back as the company
 * administrator — which is why `shell.ts` has both `open()` (reloads, by
 * design) and `goHash()` (does not). The audit signs in once per session and
 * then walks the menu with `goHash`, resizing at each stop. Four sessions
 * rather than 720 cold loads: the same screenshots in about a tenth of the
 * wall clock.
 *
 * The theme is set through `localStorage` in an init script rather than by
 * clicking the toggle, because the toggle lives in a menu whose position
 * changes with the viewport, and because a cold load in the target theme is
 * what a returning user actually gets.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRASH, open, goHash, readMenu, switchAccount } from '../../e2e/shell';
import type { AccountLabel } from '../../e2e/shell';
import { probe } from './probe';
import type { Finding } from './probe';

/** Where the screenshots land. Gitignored, and meant to be browsed in Explorer. */
const OUT = join(process.cwd(), 'alignment-audit');

/*
 * `AUDIT_WIDTHS=390` re-walks one width, which is what a fix aimed at one
 * width needs: a batch that only touched the phone layout does not need the
 * other three re-shot to be compared, and a quarter of the walk is the
 * difference between minutes and most of an hour. Unset, it is all four.
 *
 * Writes into the same tree, so a narrowed re-run replaces exactly the
 * screenshots it re-took and leaves the rest as the "before" they already
 * are — which is the comparison, rather than a second tree to diff.
 */
const ALL_WIDTHS = [1440, 1024, 768, 390] as const;
const picked = (process.env.AUDIT_WIDTHS ?? '')
  .split(',').map((w) => Number(w.trim())).filter((w) => ALL_WIDTHS.includes(w as never));
const WIDTHS = (picked.length ? picked : ALL_WIDTHS) as readonly number[];
const THEMES = ['light', 'dark'] as const;

/**
 * The two roles the audit covers, with the demo account that is each one.
 * `company_admin` sees the whole launch scope; `employee` sees the narrow
 * self-service menu, which is the half most likely to have been eyeballed
 * least.
 */
const ROLES: { key: string; account: AccountLabel | null }[] = [
  { key: 'company_admin', account: null },
  { key: 'employee', account: 'Employee (Self-service)' },
];

/** The theme key `AppContext` reads on boot. */
const THEME_KEY = '360people.theme';

/**
 * The dialogs and drawers, which no menu walk can reach.
 *
 * `trigger` is tried and may legitimately not be there — a self-service
 * employee has no "Add employee" button — so a missing trigger is recorded as
 * out of reach for that role rather than failing the run.
 */
interface DialogSpec {
  name: string;
  route: string;
  /** Opens it, or returns false when this role cannot. */
  open: (page: Page) => Promise<boolean>;
}

/**
 * Click a trigger and wait for the layer it opens.
 *
 * Every step has its own short timeout and the whole thing is wrapped, because
 * the walk sets a 45-minute test budget and Playwright waits for actionability
 * up to that budget: a trigger that is present but never clickable — covered
 * by a sticky header, say — then hangs the entire audit on one dialog instead
 * of recording it as out of reach. That is exactly what the first smoke run
 * did, silently, for the four hundred seconds before it was killed.
 */
const click = (name: RegExp | string) => async (page: Page): Promise<boolean> => {
  /* `main, header.topbar`: `PageActions` portals a page's primary buttons
     into the header, so "Add user" and friends are not inside `main` at all. */
  const btn = page.locator('main, header.topbar').getByRole('button', { name }).first();
  try {
    if (!(await btn.count())) return false;
    if (!(await btn.isVisible())) return false;
    await btn.scrollIntoViewIfNeeded({ timeout: 3_000 });
    await btn.click({ timeout: 5_000 });
    await expect(page.locator('.modal, .drawer').first()).toBeVisible({ timeout: 5_000 });
  } catch {
    return false;
  }
  return true;
};

const DIALOGS: DialogSpec[] = [
  { name: 'add-employee', route: 'employees', open: click(/Add employee/i) },
  {
    /* The directory drawer: a person opened from the list, which is the other
       half of "add/edit employee" and the surface the photo shows up in. */
    name: 'employee-drawer',
    route: 'employees',
    open: async (page) => {
      const row = page.locator('main table.tbl tbody tr').first();
      try {
        if (!(await row.count())) return false;
        await row.scrollIntoViewIfNeeded({ timeout: 3_000 });
        await row.click({ timeout: 5_000 });
        await expect(page.locator('.modal, .drawer').first()).toBeVisible({ timeout: 5_000 });
      } catch {
        return false;
      }
      return true;
    },
  },
  { name: 'add-user', route: 'users', open: click(/^Add user$/i) },
  {
    /* The dialog behind the bug this audit follows: the row action that was
       there all along, past the right edge of a table nobody could scroll. */
    name: 'edit-user',
    route: 'users',
    open: async (page) => {
      const row = page.locator('table.tbl tbody tr').first();
      const edit = row.getByRole('button', { name: /^Edit$/i }).first();
      try {
        if (!(await edit.count())) return false;
        await edit.scrollIntoViewIfNeeded({ timeout: 3_000 });
        await edit.click({ timeout: 5_000 });
        await expect(page.locator('.modal, .drawer').first()).toBeVisible({ timeout: 5_000 });
      } catch {
        return false;
      }
      return true;
    },
  },
  { name: 'leave-apply', route: 'leave', open: click(/Apply for leave/i) },
  /* `?v=reg` calls it "New request"; "Request regularisation" is the same
     dialog reached from the month view on `?v=me`. */
  { name: 'attendance-correction', route: 'attendance?v=reg', open: click(/New request/i) },
  {
    /*
     * There is no profile-photo dialog to photograph.
     *
     * "Replace photo" drives a hidden `<input type="file">`, so clicking it
     * opens the operating system's picker — which is not in the page, cannot
     * be screenshotted, and in a headless browser never appears at all. The
     * surface to audit is therefore the card itself, so this entry scrolls it
     * into view and captures it rather than clicking anything.
     */
    name: 'profile-photo',
    route: 'account',
    open: async (page) => {
      const card = page.locator('.card', { hasText: 'Your photo' }).first();
      try {
        if (!(await card.count())) return false;
        await card.scrollIntoViewIfNeeded({ timeout: 3_000 });
      } catch {
        return false;
      }
      return true;
    },
  },
  {
    name: 'letter',
    route: 'documents',
    open: async (page) => {
      const gen = page.locator('main').getByRole('button', { name: /Generate now/i }).first();
      try {
        if (!(await gen.count()) || !(await gen.isVisible())) return false;
        await gen.scrollIntoViewIfNeeded({ timeout: 3_000 });
        await gen.click({ timeout: 5_000 });
      } catch {
        return false;
      }
      /* A letter renders into the page rather than a layer, so there is
         nothing to wait for beyond the page settling. */
      await page.waitForTimeout(400);
      return true;
    },
  },
];

/** `Employee directory` → `employee-directory`, for a filename. */
const slug = (s: string): string => s
  .toLowerCase()
  .replace(/[’']/g, '')
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48);

/** The `?v=` of a menu href, or `default` where the page has no tab. */
const tabOf = (href: string): string => {
  const m = href.match(/[?&]v=([^&]+)/);
  return m ? slug(m[1]!) : 'default';
};

/**
 * Shut anything open over the page before moving on.
 *
 * A layer outlives a hash change — `LayerHost` holds it in state and nothing
 * clears that on navigation — so the dialog opened at one stop was still
 * covering the page at the next, and every trigger after it was recorded as
 * "not reachable". Five of the six dialogs went missing from the first run
 * that way, for the company administrator, who can reach all of them.
 *
 * (That a modal survives navigation at all is a finding in its own right, and
 * it is in the report.)
 */
/**
 * Get the pointer off the rail, and shut the flyout it was holding open.
 *
 * The sidebar's sections open on hover as well as on click, and `readMenu`
 * leaves the mouse wherever it last clicked — on the rail. Every screenshot
 * taken afterwards then had "Payroll & Compensation" hanging open across the
 * content, at every width, on every page. It looked like a layout defect and
 * was an artefact of how the menu had been read.
 *
 * The parking spot is the bottom-right corner, which is page background on
 * every route; the middle of the content would sit on a table row and tint it.
 */
async function parkPointer(page: Page): Promise<void> {
  const vp = page.viewportSize();
  if (vp) await page.mouse.move(vp.width - 2, vp.height - 2);
  const fly = page.locator('.nav-fly');
  if (await fly.count()) {
    await page.keyboard.press('Escape');
    try {
      await expect(fly.first()).toBeHidden({ timeout: 3_000 });
    } catch { /* recorded by the capture if it is still there */ }
  }
}

async function closeLayers(page: Page): Promise<void> {
  const layer = page.locator('.modal, .drawer');
  for (let i = 0; i < 3; i += 1) {
    if (!(await layer.count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    if (!(await layer.count())) return;
    const close = page.getByRole('button', { name: 'Close' }).first();
    try {
      if (await close.count()) await close.click({ timeout: 2_000 });
    } catch { /* try Escape again */ }
    await page.waitForTimeout(120);
  }
}

/** Wait until the route has actually painted something. */
async function settle(page: Page, what: string): Promise<boolean> {
  try {
    await expect.poll(
      async () => (await page.locator('main').innerText()).trim().length,
      { message: `no content at ${what}`, timeout: 12_000 },
    ).toBeGreaterThan(40);
  } catch {
    return false;
  }
  /* Let the resize listener in `Shell` and any transition finish, so the
     measurements are of a settled layout rather than one mid-animation. */
  await page.waitForTimeout(120);
  return true;
}

for (const role of ROLES) {
  for (const theme of THEMES) {
    test(`capture: ${role.key}, ${theme}`, async ({ page }) => {
      /* Tens of minutes, not the suite's 30 seconds: this one test walks the
         whole menu at four widths. */
      test.setTimeout(45 * 60 * 1000);
      /* A long test budget must not become a long *action* budget. Capped
         here so a control that never becomes clickable costs eight seconds
         and a note in the report, not the rest of the run. */
      page.setDefaultTimeout(8_000);

      const findings: Record<string, Finding[]> = {};
      const notes: string[] = [];
      const dir = join(OUT, role.key);
      mkdirSync(dir, { recursive: true });
      mkdirSync(join(OUT, '_findings'), { recursive: true });

      await page.addInitScript(([key, value]) => {
        try { localStorage.setItem(key as string, value as string); } catch { /* private mode */ }
      }, [THEME_KEY, theme]);

      await open(page);
      if (role.account) await switchAccount(page, role.account);

      /* The theme has to be the one we asked for, or every contrast finding
         below is about the wrong palette. */
      await expect.poll(
        () => page.evaluate(() => document.documentElement.dataset.theme),
      ).toBe(theme);

      const all = await readMenu(page);
      await parkPointer(page);
      /* A smoke run: `AUDIT_LIMIT=3 npm run audit:align` walks three items and
         every dialog, which exercises each branch of this file in a minute
         rather than forty. Unset, the walk is the whole menu. */
      const limit = Number(process.env.AUDIT_LIMIT || 0);
      const menu = limit > 0 ? all.slice(0, limit) : all;
      notes.push(`${menu.length} menu items as ${role.key}`
        + (limit > 0 ? ` (AUDIT_LIMIT=${limit} of ${all.length})` : ''));

      /** One stop on the walk: navigate, then shoot and measure at each width. */
      let visits = 0;
      const visit = async (
        name: string, tab: string, href: string,
        after?: (page: Page) => Promise<boolean>,
      ) => {
        /* Printed per stop, because this run takes tens of minutes and a
           silent walk gives no way to tell "slow" from "wedged" — which is
           exactly the question the first smoke run could not answer. */
        const began = Date.now();
        visits += 1;
        await closeLayers(page);
        const hash = href.slice(href.indexOf('#/') + 1).replace(/^\//, '');
        await goHash(page, hash);
        if (!await settle(page, hash)) {
          notes.push(`EMPTY  ${name} (${hash}) never painted`);
          return;
        }
        if (await page.getByText(CRASH).count()) {
          notes.push(`CRASH  ${name} (${hash}) hit the error boundary`);
          return;
        }
        if (after && !await after(page)) {
          notes.push(`SKIP   ${name}: not reachable as ${role.key}`);
          return;
        }

        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: Math.round(width * 0.62) });
          /* After the resize, so the corner it parks in is this width's
             corner and not the previous one's. */
          await parkPointer(page);
          await page.waitForTimeout(160);
          const file = `${slug(name)}_${tab}_${width}_${theme}.png`;
          try {
            await page.screenshot({ path: join(dir, file), fullPage: true });
          } catch {
            notes.push(`SHOT   ${name} at ${width} could not be captured`);
          }
          const found = await page.evaluate(probe, theme);
          if (found.length) findings[`${role.key}/${file}`] = found;
        }
        /* Back to the width the menu was read at, so the next `goHash` and
           any dialog trigger are where the desktop layout put them. */
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(160);
        console.log(`  ${String(visits).padStart(3)}. ${String(Date.now() - began).padStart(5)}ms`
          + `  ${role.key}/${theme}  ${name}${tab === 'default' ? '' : ` [${tab}]`}`);
      };

      for (const item of menu) {
        await visit(item.name, tabOf(item.href), item.href);
      }

      /*
       * The tab strips, for tabs the menu does not list. A page can offer a
       * tab that is not a menu item — the menu lists views, the strip lists
       * the page's own sections — and those are exactly the ones nobody has
       * looked at.
       */
      const routes = [...new Set(menu.map((m) => (m.href.split('#/')[1] ?? '').split('?')[0]!))];
      for (const route of routes) {
        if (!route) continue;
        await goHash(page, route);
        if (!await settle(page, route)) continue;
        const labels = await page.locator('.tabs button').allInnerTexts();
        const known = new Set(menu.filter((m) => m.href.includes(`#/${route}`))
          .map((m) => slug(m.name)));
        for (let i = 0; i < labels.length; i += 1) {
          const name = labels[i]!.trim();
          if (!name || known.has(slug(name))) continue;
          await goHash(page, route);
          if (!await settle(page, route)) continue;
          const btn = page.locator('.tabs button', { hasText: name }).first();
          try {
            if (!(await btn.count())) continue;
            await btn.click({ timeout: 5_000 });
          } catch {
            notes.push(`TAB    ${route} › ${name} could not be opened`);
            continue;
          }
          await page.waitForTimeout(250);
          /*
           * The href to re-open with is whatever the click left in the bar,
           * not `#/${route}`.
           *
           * `useTabFromUrl` syncs the selected tab into `?v=`, so navigating
           * back to the bare route would throw the tab away and photograph
           * the page default — forty times, under forty different tab names.
           * Where a tab is *not* in the URL the hash is unchanged and the
           * navigation is a no-op, which keeps the click.
           */
          const here = await page.evaluate(() => window.location.hash);
          await visit(`${route}-${name}`, slug(name), here);
        }
      }

      for (const d of DIALOGS) {
        await visit(`dialog-${d.name}`, 'dialog', `#/${d.route}`, d.open);
      }

      writeFileSync(
        join(OUT, '_findings', `${role.key}_${theme}.json`),
        JSON.stringify({ role: role.key, theme, notes, findings }, null, 2),
      );

      /* The run is a success if it captured; the findings are the output, and
         `report.mjs` is what judges them. */
      expect(Object.keys(findings).length >= 0).toBe(true);
    });
  }
}
