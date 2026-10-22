/**
 * The end-to-end suite: a real browser, the real shell, every in-scope page.
 *
 *   npm run e2e                 # all of it
 *   npm run e2e -- --headed     # watch it
 *
 * Deliberately outside `check:all`. These tests start a dev server and drive a
 * browser, which takes a minute rather than the few seconds the gate is held
 * to, and `gate:nodeps` runs the gate before every push.
 *
 * ## Why the demo build, and what that costs
 *
 * The three `VITE_` variables are emptied here for the same reason
 * `checks/demo-mode.mjs` empties them, and for one more. A configured build
 * verifies its session against Supabase's remote JWKS — there is no local
 * issuer and no bypass — so driving the product as four different people would
 * mean four real Supabase accounts and their passwords. The demo build needs
 * none: `TopBar` draws a "Demo · switch role" menu precisely when there is no
 * sign-in, which is the supported way to be somebody else.
 *
 * What that buys: the shell, the menu, the launch scope, every route's render,
 * the tabs, and the forms, in Chromium, as all four roles.
 *
 * What it does not: the server. The demo resolves everything from the
 * in-memory dataset, so nothing here proves an endpoint, a row-level policy or
 * a migration. Those are covered by the suites under `server/scripts` and by
 * `checks/e2e/data-integrity.mjs`, which asks the live database directly.
 *
 * Chromium only, by decision — one engine, pinned, rather than three to keep
 * installed on a Windows laptop.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = 5174;

export default defineConfig({
  testDir: './e2e',
  /* The suite shares one dev server and one dataset; parallel workers would
     race on a role switch that is global to the page. */
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  /*
   * `localhost`, not `127.0.0.1`.
   *
   * Vite's dev server binds `localhost`, which on this Windows host resolves to
   * `::1` and *only* `::1` — nothing listens on 127.0.0.1, so a readiness probe
   * against that address never answers and the whole suite dies on
   * "Timed out waiting 120000ms from config.webServer" while the server behind
   * it is up and serving in a third of a second.
   */
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      /* Empty, not absent: Vite gives `process.env` priority over every
         `.env` file, and a developer's `.env.local` holds real values. */
      VITE_API_URL: '',
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    },
  },
});
