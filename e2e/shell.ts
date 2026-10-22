/**
 * Driving the shell: the few things every spec needs.
 *
 * Kept to the markup the shell actually renders — `.nav-top` for a section,
 * `a.nav-fly-i` for an item inside one — rather than text the copy editor will
 * change. The one place text is unavoidable is the role switcher, where the
 * label is the identity of the thing being clicked.
 */

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** What the error boundary says. Its presence is a failed test, anywhere. */
export const CRASH = 'This page could not be displayed';

/** The four role labels, as `ROLE_LABEL` in `src/state/rbac.ts` spells them. */
export const ROLE_LABELS = {
  company_admin: 'Company administrator',
  hr_admin: 'HR administrator',
  finance_admin: 'Finance administrator',
  employee: 'Employee',
} as const;

export type RoleKey = keyof typeof ROLE_LABELS;

/**
 * The demo accounts, as `ACCOUNTS()` labels them and the switcher now draws
 * them. Five, not four: two of them are employees, one with reports and one
 * without, which is the distinction the manager layer turns on. Each maps to
 * the role label the top bar shows once you are signed in as them.
 */
export const ACCOUNTS = {
  'Company Administrator': 'company_admin',
  'HR Administrator': 'hr_admin',
  'Finance Administrator': 'finance_admin',
  'Reporting Manager (has reports)': 'employee',
  'Employee (Self-service)': 'employee',
} as const satisfies Record<string, RoleKey>;

export type AccountLabel = keyof typeof ACCOUNTS;

/**
 * Open the app at a hash route, as a cold load.
 *
 * ## Why `about:blank` first
 *
 * The app mounts a `HashRouter`, so every route differs only in the fragment.
 * `page.goto('/#/leave')` from `/#/dashboard` is a same-document navigation:
 * the browser updates `location.hash`, fires no load, and resolves the call
 * immediately — before React has re-rendered anything. Every assertion that
 * followed then ran against the page that was already there.
 *
 * That is not a slow-test problem, it is a wrong-test problem: a walk over
 * forty-five menu items checked item N-1 forty-five times and passed. The
 * blank page forces a real document load, so arriving at the route is an event
 * Playwright can wait for, and each route is also proven to load cold — which
 * is what a bookmark or a pasted link actually does.
 */
export async function open(page: Page, route = 'dashboard'): Promise<void> {
  await page.goto('about:blank');
  await page.goto(`/#/${route}`, { waitUntil: 'load' });
  await expect(page.locator('nav.nav')).toBeVisible();
  /*
   * The shell paints before the page does — the route's chunk is lazy and its
   * queries are in flight — so waiting on `nav.nav` alone measures an empty
   * frame, and `main` is already non-empty while still holding nothing but a
   * heading. Poll for real content, which is the only signal that works for
   * every route without naming something route-specific.
   */
  await expect.poll(
    async () => (await page.locator('main').innerText()).trim().length,
    { message: `no content at #/${route}`, timeout: 15_000 },
  ).toBeGreaterThan(60);
}

/** The tab strip: plain buttons in a `.tabs` div, with no ARIA roles. */
export const tabStrip = (page: Page) => page.locator('.tabs button');

/** The label of the tab currently selected, or null where there is no strip. */
export async function activeTab(page: Page): Promise<string | null> {
  const on = page.locator('.tabs button.on');
  return (await on.count()) ? (await on.first().innerText()).trim() : null;
}

/**
 * Move to a route *without* reloading, for when the page holds state worth
 * keeping — the demo role, above all. `open()` reloads by design, and the
 * demo role lives in memory, so a cold load lands you back as the company
 * administrator. Callers do their own waiting, with a retrying assertion:
 * setting the hash is synchronous and React re-renders after it.
 */
export async function goHash(page: Page, route: string): Promise<void> {
  await page.evaluate((r) => { window.location.hash = `#/${r}`; }, route);
}

/** The same, for an href the menu gave us (`#/leave?v=cal` or `/#/leave`). */
export async function openHref(page: Page, href: string): Promise<void> {
  const hash = href.slice(href.indexOf('#/') + 1);
  await open(page, hash.replace(/^\//, ''));
}

/** Open the top bar's own menu, where the demo accounts live. */
export async function openUserMenu(page: Page): Promise<void> {
  await page.locator('header.topbar').getByText(/administrator|Employee/i).first().click();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
}

/**
 * Sign in as one of the demo accounts, and wait until the shell agrees.
 *
 * Selected by the account's own label rather than by role, because a role is
 * not an identity: two accounts are employees, and picking by role reached
 * only the first of them.
 */
export async function switchAccount(page: Page, account: AccountLabel): Promise<void> {
  await openUserMenu(page);
  await page.getByRole('menuitem', { name: account, exact: true }).click();
  const role = ROLE_LABELS[ACCOUNTS[account]];
  await expect(page.locator('header.topbar').getByText(role, { exact: true }).first())
    .toBeVisible();
}

export interface MenuItem { group: string; name: string; href: string }

/**
 * Every item the menu offers, by opening each section in turn.
 *
 * A section with no sub-views is a link to itself, so it contributes itself —
 * which is what the shell does, and what a person clicking it gets.
 */
export async function readMenu(page: Page): Promise<MenuItem[]> {
  const out: MenuItem[] = [];
  const tops = page.locator('nav.nav .nav-top');
  const count = await tops.count();

  for (let i = 0; i < count; i += 1) {
    const top = tops.nth(i);
    const group = (await top.locator('.nav-label').innerText()).trim();
    const tag = await top.evaluate((el) => el.tagName.toLowerCase());

    if (tag === 'a') {
      out.push({ group, name: group, href: (await top.getAttribute('href')) ?? '' });
      continue;
    }

    await top.click();
    const fly = page.locator('.nav-fly');
    await expect(fly).toBeVisible();
    const items = fly.locator('a.nav-fly-i');
    for (let j = 0; j < await items.count(); j += 1) {
      out.push({
        group,
        name: (await items.nth(j).locator('.nav-fly-i-t').innerText()).trim().split('\n')[0]!,
        href: (await items.nth(j).getAttribute('href')) ?? '',
      });
    }
    await page.keyboard.press('Escape');
    await expect(fly).toBeHidden();
  }
  return out;
}

/** The route part of a hash href: `#/leave?v=cal` becomes `leave`. */
export const routeOf = (href: string): string =>
  (href.split('#/')[1] ?? '').split('?')[0]!.replace(/\/$/, '');
