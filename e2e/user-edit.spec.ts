import { expect, test } from '@playwright/test';
import { goHash, open, switchAccount } from './shell';

/**
 * Editing somebody's record, as the two roles that are supposed to be able to.
 *
 * `PATCH /users/:id` is the only write in the product that edits an employee's
 * own details — name, designation, department, manager, phone all land on the
 * `employee` row through it. So "User management -> Edit" is the employee
 * record edit surface, not just an account screen, and this is the flow that
 * matters for it.
 */

test.describe('editing a record from User management', () => {
  test('as Company Administrator: the list, the Edit control and a save', async ({ page }) => {
    await open(page);
    await goHash(page, 'users');

    /* The list first: no rows means no Edit control to find, and the two
       failures look identical on screen. */
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    const edit = rows.first().getByRole('button', { name: 'Edit' });
    await expect(edit).toBeVisible();
    await edit.click();

    /*
     * Located through the `.field` wrapper rather than by label.
     * `Drawers.tsx` renders `<label>Designation</label>` beside the input with
     * no `for`/`id`, so nothing associates the two and `getByLabel` finds
     * nothing — the accessibility defect already recorded on the roadmap
     * under "Form controls have no accessible name". Worth stating here
     * because this test would start passing by label the moment that is
     * fixed, and the locator below should then be simplified.
     */
    const field = page.locator('.field', { hasText: 'Designation' }).first();
    const designation = field.locator('input');
    await expect(designation).toBeVisible({ timeout: 10_000 });

    const next = `QA Edited ${Date.now().toString(36)}`;
    await designation.fill(next);
    await page.getByRole('button', { name: 'Save changes' }).click();

    /*
     * Saved, not merely submitted — and checked by reopening rather than by
     * reading the list, because Designation is not one of the list's columns.
     * Asserting against the page body would pass on a dialog that never
     * closed.
     */
    await expect(page.getByRole('heading', { name: 'Edit user' }))
      .toHaveCount(0, { timeout: 15_000 });

    await rows.first().getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('.field', { hasText: 'Designation' }).first().locator('input'))
      .toHaveValue(next, { timeout: 10_000 });
  });

  test('as HR Administrator: what the product actually offers', async ({ page }) => {
    await open(page);
    await switchAccount(page, 'HR Administrator');
    await goHash(page, 'users');

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    /*
     * Asserted as it is designed, which is NOT "hr_admin can save". The
     * server's policy gives hr_admin `users` read all and write *none*
     * (policy.ts: `users: rule(NO, [...], ALL_R, NO, ALL_RWA)`), and
     * `rbac.ts` gives them `user.edit: 'none'`. Both halves agree that
     * account administration is company_admin's, deliberately — the comment
     * beside the rule says so.
     *
     * They do hold `employees` write all. The product has no screen for that:
     * there is no `PATCH /employees/:id` at all. See the note in the spec
     * header and the report that accompanied this test.
     */
    await expect(rows.first().getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(rows.first().getByRole('button', { name: 'View' })).toBeVisible();
  });
});
