/**
 * @fileoverview Playwright configuration for the PDBFE frontend E2E test suite.
 *
 * Tests run against a local `wrangler pages dev` server. The server is started
 * automatically before the test run and torn down afterwards.
 *
 * API calls are intercepted via `page.route()` in each spec, so no live
 * pdbfe-api or pdbfe-auth worker is required.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',

    /** Fail the build on CI if you accidentally left a test.only. */
    forbidOnly: !!process.env.CI,

    /** Retry failed tests twice on CI to reduce flakiness from timing. */
    retries: process.env.CI ? 2 : 0,

    /** Run tests in parallel across workers. */
    workers: process.env.CI ? 2 : undefined,

    /** Reporter: dot for CI, list for local interactive. */
    reporter: process.env.CI ? 'github' : 'list',

    use: {
        /** Base URL for all page.goto() calls using relative paths. */
        baseURL: 'http://localhost:8788',

        /** Collect trace on the first retry for post-mortem analysis. */
        trace: 'on-first-retry',

        /** Viewport matching the layout's desktop breakpoint. */
        viewport: { width: 1280, height: 800 },
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],

    /**
     * Starts `wrangler pages dev` to serve the static frontend.
     * Playwright waits for the URL to respond before running tests.
     * `--no-bundle` is not needed — wrangler pages dev serves static files as-is.
     */
    webServer: {
        command: 'npx wrangler pages dev . --port 8788 --log-level error',
        url: 'http://localhost:8788',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
