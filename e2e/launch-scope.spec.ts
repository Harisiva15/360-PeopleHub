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
  open, openHref, readMenu, routeOf, switchRole, activeTab, CRASH,
} from './shell';
import type { RoleKey } from './shell';

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
   * `Tabs` filters a hidden tab out of the strip, and `useTabFromUrl` refuses
   * a hidden tab *that was asked for* — but never the fallback it hands back.
   * Where a page's default is itself hidden, the tab button disappears and the
   * screen behind it still renders, with nothing in the strip selected.
   *
   *   payroll  `useTabFromUrl(tabs[0].v, …)`, and tabs[0] is `runs`
   *   planner  `useTabFromUrl('board', …)`, and `planner:board` is hidden
   *
   * So `/#/payroll` opens the draft payroll run — the screen the launch scope
   * exists to close — and `?v=inputs` falls back to it rather than away from
   * it. Recorded as expected failures: three tests that go green on a fix.
   */
  test.fail();

  /*
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

test.describe('the demo role switcher', () => {
  /*
   * Recorded as an expected failure rather than worked around, so it is in the
   * report and not in somebody's memory. It goes green the moment it is fixed,
   * which is when this `fail` should come off.
   */
  test.fail();
  test('offers each role once, and every role', async ({ page }) => {
    await open(page);
    await page.locator('header.topbar').getByText(/administrator|Employee/).first().click();

    /* Two `employee` rows in ACCOUNTS(), both labelled "Employee". */
    await expect(page.getByRole('menuitem', { name: 'Employee', exact: true })).toHaveCount(1);
    /* And no finance_admin row at all, so the role cannot be demoed. */
    await expect(page.getByRole('menuitem', { name: 'Finance administrator', exact: true }))
      .toHaveCount(1);
  });
});

test.describe('every item the menu offers opens', () => {
  /*
   * The four caller shapes that matter, which is not the same list as the four
   * roles: `finance_admin` is absent from `ACCOUNTS()` and cannot be selected,
   * and `employee` appears twice — once with reports, once without — which is
   * the distinction the manager layer turns on.
   */
  const shapes: { role: RoleKey; nth: number; as: string }[] = [
    { role: 'company_admin', nth: 0, as: 'Company administrator' },
    { role: 'hr_admin', nth: 0, as: 'HR administrator' },
    { role: 'employee', nth: 0, as: 'an employee with reports' },
    { role: 'employee', nth: 1, as: 'an employee with none' },
  ];

  for (const shape of shapes) {
    test(`as ${shape.as}`, async ({ page }) => {
      test.slow();
      await open(page);
      if (shape.role !== 'company_admin') await switchRole(page, shape.role, shape.nth);

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

      expect(broken, `${broken.length} of ${menu.length} items broken as ${shape.as}`).toEqual([]);
    });
  }
});
