/**
 * The flows real staff will run, in a browser.
 *
 * Against the in-memory dataset, so what these prove is the interface: that
 * the affordance exists, that a form accepts input and reports what it did,
 * that a page shows the data it promises. The server's half — enforcement,
 * row-level policy, what actually lands in a table — is proven by the suites
 * under `server/scripts`, which drive the services directly.
 *
 * Where a test is marked `test.fail()`, it is a defect that has been found and
 * reported and not yet decided on. It runs, it fails, and the suite stays
 * green until somebody fixes it — at which point it fails for passing, which
 * is the signal to delete the marker.
 */

import { test, expect } from '@playwright/test';
import {
  open, openHref, goHash, openUserMenu, readMenu, switchAccount, activeTab, CRASH,
} from './shell';

test.afterEach(async ({ page }) => {
  /* No flow may leave the error boundary on screen. */
  await expect(page.getByText(CRASH)).toHaveCount(0);
});

test.describe('Leave', () => {
  test('a person can apply for leave and is told it was sent', async ({ page }) => {
    await open(page, 'leave');
    await expect(page.locator('table tbody tr')).not.toHaveCount(0);

    await page.getByRole('button', { name: /Apply for leave/i }).click();

    /*
     * By position, not by label: `.field > label` carries no `for` and does
     * not wrap its control, so the text "Leave type" is not the select's
     * accessible name and `getByLabel` finds nothing. Recorded below.
     */
    const type = page.locator('select.input').first();
    await expect(type).toBeVisible();
    expect(await type.locator('option').count()).toBeGreaterThan(2);

    /* Both dates: From and To. One alone leaves the form incomplete. */
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill('2026-12-10');
    if (await dates.count() > 1) await dates.nth(1).fill('2026-12-11');
    const reason = page.locator('textarea').first();
    if (await reason.count()) await reason.fill('End-to-end check');

    await page.getByRole('button', { name: 'Submit request' }).click();
    /* The toast names the approver, which is the proof it went somewhere. */
    await expect(page.getByText(/Leave request sent to/i)).toBeVisible();
  });

  test('the balances table lists the leave types', async ({ page }) => {
    await open(page, 'leave');
    expect(await page.locator('table tbody tr').count()).toBeGreaterThan(3);
    expect(await activeTab(page)).toBe('My Leave');
  });
});

test.describe('Holidays', () => {
  test('the per-location holiday table names the sites it applies to', async ({ page }) => {
    await open(page, 'attendance?v=cal');
    expect(await activeTab(page)).toBe('Holiday Calendar');
    await expect(page.getByText('Applies to').first()).toBeVisible();
    expect(await page.locator('table tbody tr').count()).toBeGreaterThan(0);
  });
});

test.describe('Holidays — the menu route', () => {
  test('the menu item called "Holiday calendar" opens it', async ({ page }) => {
    /*
     * Driven from the menu, not from a URL this test chose: the defect was
     * that the item pointed somewhere else — `/leave?v=cal`, which the Leave
     * module renders as its Team Calendar — so a test that navigated straight
     * to the right page would have passed throughout.
     */
    await open(page);
    const menu = await readMenu(page);
    const item = menu.find((m) => m.name === 'Holiday calendar');
    expect(item, 'the menu offers a Holiday calendar').toBeDefined();

    await openHref(page, item!.href);
    expect(await activeTab(page)).toBe('Holiday Calendar');
    await expect(page.getByText('Applies to').first()).toBeVisible();
    expect(await page.locator('table tbody tr').count()).toBeGreaterThan(0);
  });
});

test.describe('Attendance', () => {
  test('my attendance offers a punch and shows the month', async ({ page }) => {
    await open(page, 'attendance?v=me');
    expect(await activeTab(page)).toBe('My Attendance');

    /*
     * The control has three legitimate states — `out` offers Punch In, `in`
     * offers Punch Out, and a day already punched in and out shows "Day
     * completed" with no button at all. Which one you get depends on what the
     * demo generated for *today*, so asserting a button was asserting the
     * date: this passed on 22 October and failed on the 27th with nothing in
     * attendance changed. The same trap `scratch-tenant.mjs` records — a
     * suite that can be made to fail by waiting.
     *
     * What is worth asserting is that the control is present and in one of
     * its three states, not which.
     */
    const punch = page.getByRole('button', { name: /Punch (in|out)/i });
    const completed = page.getByText(/Day completed/i);
    const states = await punch.count() + await completed.count();
    expect(states, 'the punch control must be in one of its three states').toBeGreaterThan(0);

    expect(await page.locator('table tbody tr').count()).toBeGreaterThan(3);
  });

  test('corrections open their own tab, not the page default', async ({ page }) => {
    await open(page, 'attendance?v=reg');
    expect(await activeTab(page)).toBe('Regularisation');
  });
});

test.describe('Timesheets', () => {
  test('my timesheet shows a week and offers submission', async ({ page }) => {
    await open(page, 'timesheet?v=entry');
    expect(await activeTab(page)).toBe('My Timesheet');
    /* Scoped to `main`: `PageActions` renders a copy into the topbar too. */
    await expect(page.locator('main').getByRole('button', { name: /Submit for approval/i }))
      .toBeVisible();
  });

  test('team timesheets and approvals open for a manager', async ({ page }) => {
    await open(page, 'timesheet?v=team');
    expect(await activeTab(page)).toBe('Team Timesheets');
    await open(page, 'timesheet?v=appr');
    expect(await activeTab(page)).toBe('Pending Approvals');
  });
});

test.describe('Projects', () => {
  test('the projects list is what time is booked against', async ({ page }) => {
    await open(page, 'timesheet?v=proj');
    expect(await activeTab(page)).toBe('Projects');
    expect(await page.locator('table tbody tr').count()).toBeGreaterThan(0);
  });
});

test.describe('Assets', () => {
  test('the register lists kit and issue & return opens', async ({ page }) => {
    await open(page, 'assets?v=reg');
    expect(await activeTab(page)).toBe('Asset Register');
    expect(await page.locator('table tbody tr').count()).toBeGreaterThan(0);

    await open(page, 'assets?v=alloc');
    expect(await activeTab(page)).toBe('Issue & Return');
  });
});

test.describe('Documents', () => {
  test('a letter refuses to print until a signatory is named', async ({ page }) => {
    /*
     * The demo starts with no signatory, which is the honest state: 0061
     * keeps both columns nullable with no default, and `mayIssueLetter`
     * refuses rather than printing an unsigned letter to a bank.
     */
    await open(page, 'documents');
    const card = page.locator('.card', { hasText: 'Address Proof Letter' }).first();
    await card.getByRole('button', { name: 'Generate now' }).click();

    await expect(page.getByText(/Set a signatory in Company profile first/i)).toBeVisible();
    /* And no way to print the refusal, which would still be a document. */
    await expect(page.getByRole('button', { name: /Print \/ Save PDF/i })).toHaveCount(0);
  });

  test('and prints once one is set', async ({ page }) => {
    /*
     * Driven through the screen rather than seeded, because the point is that
     * the two halves meet: what Company Profile saves is what the letter
     * reads.
     *
     * `goHash` for the second navigation, never `open` — the demo keeps the
     * signatory in module memory, so a reload would throw it away and this
     * test would prove the opposite of what it says.
     */
    await open(page, 'settings?v=company');
    const sig = page.locator('.card', { hasText: 'Letter signatory' }).first();
    await expect(sig.getByText(/letters will not print/i)).toBeVisible();

    await sig.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#signatory-name').fill('Hari Sivakumar');
    await page.locator('#signatory-title').fill('Director');
    await sig.getByRole('button', { name: 'Save' }).click();
    await expect(sig.getByText('Hari Sivakumar')).toBeVisible();

    await goHash(page, 'documents');
    const card = page.locator('.card', { hasText: 'Address Proof Letter' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole('button', { name: 'Generate now' }).click();

    await expect(page.getByRole('button', { name: /Print \/ Save PDF/i })).toBeVisible();
    /* The signature block carries what was just saved, not a placeholder. */
    await expect(page.getByText('Director').first()).toBeVisible();
    /*
     * And the letter is about the person it names. The superseded
     * previews-and-prints test was the only one asserting that; it could not
     * survive the refusal, so its one unique assertion moves here.
     *
     * Address Proof is `self: true`, so it carries "Generate now" and opens
     * straight away — the HR-issued ones queue instead. The letter opens
     * through `layer.modal`, a portal outside `main`, so these are page-wide.
     */
    await expect(page.getByText(/Priya Raghavan/i).first()).toBeVisible();
  });

});

test.describe('Documents — the pay letters', () => {
  test('no letter that quotes pay is offered', async ({ page }) => {
    /*
     * `LAUNCH_LETTERS` had no reader, so the page offered all eight types —
     * and the three that quote pay are `self: true`, which is "Generate now"
     * rather than a request to HR, over a `letterContext` wrapped in
     * `unbacked(…, null)`. `isHiddenLetter` is the gate now, and
     * `checks/launch-scope.tsx` 20-25 holds the wiring in place.
     */
    await open(page, 'documents');
    for (const name of ['Salary Certificate', 'Increment / Revision Letter', 'Form 16']) {
      await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    }
  });
});

test.describe('Administration', () => {
  test('user management lists accounts', async ({ page }) => {
    await open(page, 'users');
    expect(await activeTab(page)).toBe('All Users');
    expect(await page.locator('table tbody tr').count()).toBeGreaterThan(0);
  });

  test('login history opens from its own URL, not the default tab', async ({ page }) => {
    /* The HashRouter bug this pins: `?v=` lived in the fragment and was never
       read, so every menu item naming a tab landed on the page default. */
    await open(page, 'users?v=signins');
    expect(await activeTab(page)).toBe('Sign-in Activity');
    expect(await page.locator('table tbody tr').count()).toBeGreaterThan(0);
  });

  test('the audit log and role screens open', async ({ page }) => {
    await open(page, 'settings?v=audit');
    await expect(page.locator('main')).toContainText(/audit/i);
    await open(page, 'settings?v=rbac');
    await expect(page.locator('main')).toContainText(/role|permission/i);
  });
});

test.describe('Accessibility of the pieces these flows touch', () => {
  test.fail();
  test('a form control is named by its own label', async ({ page }) => {
    /*
     * `src/components/ui.tsx` renders `<div class="field"><label>…</label>
     * <select class="input">`: no `for`, no `id`, no wrapping. So nothing
     * programmatically associates the two, `getByLabel('Leave type')` finds
     * nothing, and a screen reader announces an unnamed combobox.
     */
    await open(page, 'leave');
    await page.getByRole('button', { name: /Apply for leave/i }).click();
    await expect(page.getByLabel('Leave type')).toBeVisible();
  });

  test.fail();
  test('the tab strip is a tablist', async ({ page }) => {
    /*
     * `Tabs` renders a `div.tabs` of plain buttons, with the current one
     * carrying `class="on"` and nothing else. There is no `role="tablist"`,
     * no `role="tab"`, and no `aria-selected`, so assistive technology is
     * given a row of unlabelled buttons and no way to tell which is current.
     */
    await open(page, 'leave');
    await expect(page.locator('[role="tablist"]')).toHaveCount(1);
  });
});

test.describe('My account', () => {
  /*
   * The photo card, for the two ends of the role range. It is the only
   * control in the product that can upload a photo, and it rendered only
   * once a directory lookup for yourself had resolved — so in production the
   * signed-in administrator had no way to set one.
   *
   * This proves the screen works. It does not prove the fix: the demo's
   * directory always contains the demo people, so this test passed throughout
   * the outage. `checks/account-photo.tsx` is the one that empties the
   * directory and requires the card to survive it.
   */
  for (const account of ['Company Administrator', 'Employee (Self-service)'] as const) {
    test(`the photo card and Upload are there as ${account}`, async ({ page }) => {
      await open(page);
      if (account !== 'Company Administrator') await switchAccount(page, account);

      await goHash(page, 'account');
      const card = page.locator('.card', { hasText: 'Your photo' });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.getByRole('button', { name: /Upload|Replace/ })).toBeVisible();

      /* And the tile names you, rather than showing a dash. */
      await expect(page.getByText('Signed in as')).toBeVisible();
      await expect(page.locator('.tile', { hasText: 'Signed in as' }))
        .not.toContainText('—');
    });
  }

  test('and "My profile" in the menu opens it', async ({ page }) => {
    /* It linked to /employees, the directory, where nothing can change a
       photo — which is how somebody looking for the upload found nothing. */
    await open(page);
    await openUserMenu(page);
    await page.getByRole('menuitem', { name: 'My profile' }).click();
    await expect(page).toHaveURL(/#\/account$/);
    await expect(page.locator('.card', { hasText: 'Your photo' }))
      .toBeVisible({ timeout: 15_000 });
  });
});

test.describe('An employee sees less', () => {
  test('no Administration or Company Setup in the menu', async ({ page }) => {
    await open(page);
    await switchAccount(page, 'Employee (Self-service)');
    const labels = await page.locator('nav.nav .nav-label').allInnerTexts();
    expect(labels).not.toContain('Administration');
    expect(labels).not.toContain('Company Setup');
  });

  test('and an admin route reached by URL explains itself', async ({ page }) => {
    /*
     * `App.tsx:57` answers a route the role cannot open with `AccessDenied`
     * rather than a redirect, which is the better of the two: a bounce to the
     * dashboard leaves somebody who typed the URL with no idea why. The thing
     * to assert is that the page itself does not render behind it.
     */
    await open(page);
    await switchAccount(page, 'Employee (Self-service)');

    for (const route of ['settings', 'users']) {
      /*
       * `goHash`, not `open`: the demo role is in memory, so reloading would
       * put us back as the company administrator and the page would render
       * perfectly — proving nothing. The retrying assertion does the waiting.
       */
      await goHash(page, route);
      await expect(page.locator('main'))
        .toContainText('You do not have access to this', { timeout: 15_000 });
      /* It says what to do about it, rather than only that you cannot. */
      await expect(page.locator('main')).toContainText(/an administrator can change/i);
      /* And the page itself is not rendered behind the message. */
      await expect(page.locator('.tabs button')).toHaveCount(0);
    }
  });
});
