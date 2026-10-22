/**
 * The launch scope, in a browser, as each of the four roles.
 *
 * `checks/launch-scope.tsx` already asserts the scope against the tables that
 * define it, and `checks/renders.tsx` mounts ten routes in jsdom. Neither
 * clicks. This does: it reads the menu the shell actually drew, opens every
 * item in it, and fails on the error boundary — which is the only way to catch
 * a page that renders in jsdom and breaks in a layout engine, or a menu entry
 * whose href goes somewhere the router does not serve.
 */

import { test, expect } from '@playwright/test';
import {
  ACCOUNTS, open, openHref, openUserMenu, readMenu, routeOf, switchAccount, activeTab, CRASH,
} from './shell';
import type { AccountLabel } from './shell';

/** Routes closed for launch. A sample across the reasons, not all 25. */
const HIDDEN_ROUTES = ['reports', 'hiring', 'performance', 'learning', 'software',
  'integrations', 'tax', 'exit'];

/** Tabs closed for launch, as `route?v=tab`. */
const HIDDEN_TABS: [string, string][] = [
  ['payroll', 'runs'],
  ['payroll', 'inputs'],
  ['planner', 'board'],
  ['timesheet', 'rep'],
  ['helpdesk', 'kb'],
];

/** Names that must not appear in the menu at all. */
const MUST_BE_GONE = ['Sprints', 'Work board', 'Action items', 'Utilisation',
  'Payroll run', 'Payroll inputs', 'Knowledge base'];

test.describe('the menu', () => {
  test('is narrowed to the launch scope', async ({ page }) => {
    await open(page);
    const menu = await readMenu(page);

    const groups = [...new Set(menu.map((m) => m.group))];
    expect(groups).toEqual([
      'Dashboard', 'Company Setup', 'People', 'Time & Attendance', 'Timesheets',
      'Projects', 'Leave', 'Payroll & Compensation', 'Assets', 'Documents',
      'Administration',
    ]);

    /*
     * 45, not the 44 that `checks/launch-scope.tsx` counts. That check sums
     * `VISIBLE_NAV[].items.length`, and Dashboard declares no sub-views, so it
     * contributes nothing to the total while still being a thing you can click.
     * The shell renders it as a link to itself. Both numbers are right about
     * different questions; this one is about what a person can click.
     */
    expect(menu.length).toBe(45);

    for (const gone of MUST_BE_GONE) {
      expect(menu.map((m) => m.name)).not.toContain(gone);
    }
    expect(groups).not.toContain('Reports');
  });

  test('offers no item whose route is closed', async ({ page }) => {
    await open(page);
    const menu = await readMenu(page);
    const offending = menu.filter((m) => HIDDEN_ROUTES.includes(routeOf(m.href)));
    expect(offending.map((m) => `${m.group} > ${m.name}`)).toEqual([]);
  });
});

test.describe('closed by URL, not only absent from the menu', () => {
  for (const route of HIDDEN_ROUTES) {
    test(`/#/${route} lands on the dashboard`, async ({ page }) => {
      await page.goto(`/#/${route}`);
      await expect(page.locator('nav.nav')).toBeVisible();
      await expect(page).toHaveURL(/#\/dashboard$/);
      await expect(page.getByText(CRASH)).toHaveCount(0);
    });
  }

  /*
   * `timesheet` and `helpdesk` default to a visible tab, so asking for a
   * hidden one lands somewhere in scope. `payroll` and `planner` do not — see
   * the describe below, which is where that is recorded.
   */
  for (const [route, tab] of [['timesheet', 'rep'], ['helpdesk', 'kb']] as const) {
    test(`/#/${route}?v=${tab} falls back to the page default`, async ({ page }) => {
      await open(page, route);
      const fallback = await activeTab(page);
      expect(fallback, 'the page must have a selected tab to fall back to').not.toBeNull();

      await open(page, `${route}?v=${tab}`);
      expect(await activeTab(page)).toBe(fallback);
      await expect(page.getByText(CRASH)).toHaveCount(0);
    });
  }
});

test.describe('a hidden tab is not rendered as a page default', () => {
  /*
   * `Tabs` filters a hidden tab out of the strip, and `useTabFromUrl` used to
   * refuse a hidden tab *that was asked for* but never the fallback it handed
   * back. Where a page's default was itself hidden the button disappeared and
   * the screen behind it still rendered, with nothing in the strip selected:
   * `/#/payroll` opened the draft payroll run, and `?v=inputs` fell back to it
   * rather than away from it. The hook picks the first tab in scope now.
   *
   * Each route is asserted against the screen it actually shows, because the
   * symptom differs: payroll keeps three visible tabs with none selected,
   * while planner has only one visible tab so the strip is suppressed
   * altogether and there is nothing to look selected or not.
   */
  for (const route of ['payroll', 'payroll?v=inputs']) {
    test(`/#/${route} does not open the payroll run`, async ({ page }) => {
      await open(page, route);
      /* A strip with two or more buttons and none selected means the page is
         showing something the strip will not admit to. */
      expect(await activeTab(page)).not.toBeNull();
      await expect(page.locator('main')).not.toContainText(/payroll — Draft|net payable/i);
    });
  }

  test('/#/planner does not open the work board', async ({ page }) => {
    /* `?v=mine` is the only visible planner tab, and what the menu links to. */
    await open(page, 'planner?v=mine');
    const mine = (await page.locator('main').innerText()).trim();
    expect(mine).toContain('Assigned to me');

    await open(page, 'planner');
    expect((await page.locator('main').innerText()).trim()).toContain('Assigned to me');
  });
});

test.describe('the demo account switcher', () => {
  test('offers every account exactly once, and each one works', async ({ page }) => {
    /*
     * It used to label all five from `ROLE_LABEL[a.role]`, so the menu read
     * "Employee" twice with nothing to tell them apart, React saw two
     * children keyed `employee`, both rows ticked at once, and `signInAs`
     * matched on the role — reaching the first of the two every time, so the
     * self-service account could not be selected at all.
     */
    await open(page);
    await openUserMenu(page);

    for (const label of Object.keys(ACCOUNTS)) {
      await expect(page.getByRole('menuitem', { name: label, exact: true }),
        `${label} appears once`).toHaveCount(1);
    }
    /* Exactly one is ticked: the one you are signed in as. */
    await expect(page.locator('.menu-row.on')).toHaveCount(1);
    await page.keyboard.press('Escape');

    /* And each one actually lands on the person it names. */
    for (const label of Object.keys(ACCOUNTS) as (keyof typeof ACCOUNTS)[]) {
      await switchAccount(page, label);
      await openUserMenu(page);
      await expect(page.locator('.menu-row.on')).toHaveText(label);
      await page.keyboard.press('Escape');
    }
  });

  test('the two employee accounts are different people', async ({ page }) => {
    /* One has reports and one does not, which is what the manager layer
       turns on — so they must not resolve to the same employee. */
    await open(page);

    await switchAccount(page, 'Reporting Manager (has reports)');
    const managerSees = (await readMenu(page)).length;

    await switchAccount(page, 'Employee (Self-service)');
    const employeeSees = (await readMenu(page)).length;

    expect(managerSees).toBeGreaterThan(employeeSees);
  });
});

test.describe('every item the menu offers opens', () => {
  /*
   * The four caller shapes that matter, which is not the same list as the four
   * roles: `finance_admin` is absent from `ACCOUNTS()` and cannot be selected,
   * and `employee` appears twice — once with reports, once without — which is
   * the distinction the manager layer turns on.
   */
  const shapes: AccountLabel[] = [
    'Company Administrator',
    'HR Administrator',
    'Finance Administrator',
    'Reporting Manager (has reports)',
    'Employee (Self-service)',
  ];

  for (const account of shapes) {
    test(`as ${account}`, async ({ page }) => {
      /*
       * Forty-five cold document loads, each waiting for its page's content.
       * `test.slow()` gives 90 seconds and the walk lands within a few
       * seconds of it — Sign-in Activity alone renders 500 rows from the demo
       * dataset — so one slow page failed the whole walk with "no content"
       * rather than for any reason in the product. The budget is explicit
       * instead, with room to spare.
       */
      test.setTimeout(300_000);
      await open(page);
      if (account !== 'Company Administrator') await switchAccount(page, account);

      const menu = await readMenu(page);
      expect(menu.length).toBeGreaterThan(0);

      const broken: string[] = [];
      for (const item of menu) {
        /*
         * One item's failure must not end the walk — the whole point is to
         * come back with every broken page, not the first one.
         */
        try {
          await openHref(page, item.href);
        } catch (e) {
          broken.push(`${item.group} > ${item.name} (${item.href}) :: no content`
            + ` — ${(e as Error).message.split('\n')[0]}`);
          continue;
        }
        if (await page.getByText(CRASH).count()) {
          const detail = (await page.locator('main').innerText()).trim();
          broken.push(`${item.group} > ${item.name} (${item.href}) :: ${detail.slice(0, 160)}`);
        }
      }

      expect(broken, `${broken.length} of ${menu.length} items broken as ${account}`).toEqual([]);
    });
  }
});
