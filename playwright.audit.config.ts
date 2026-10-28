/**
 * The alignment audit's own Playwright config.
 *
 * Separate from `playwright.config.ts` for one reason: `testDir` there is
 * `./e2e`, and `gate:nodeps` runs that suite before every push. The audit
 * walks forty-five pages at four widths in two themes as two roles and takes
 * tens of minutes, so it cannot live in the gate. Same dev server, same demo
 * build, a different port so an e2e run and an audit run can overlap.
 *
 *   npm run audit:align
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = 5175;

export default defineConfig({
  testDir: './audit/alignment',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  /* Each test is one whole session; the walk sets its own, longer budget. */
  timeout: 60 * 60 * 1000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
    /* The audit takes its own screenshots, named and filed; Playwright's
       failure shots would land in `test-results` under a hash. */
    screenshot: 'off',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      /* The demo build, for the same reason the e2e suite uses it: driving
         the product as two different people needs the role switcher, which
         only exists when there is no real sign-in. */
      VITE_API_URL: '',
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    },
  },
});
