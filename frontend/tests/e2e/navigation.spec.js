/**
 * @fileoverview E2E tests for SPA navigation behaviour.
 *
 * Verifies that:
 *   - The homepage renders correctly with expected content
 *   - data-link clicks navigate without a full page reload
 *   - Back/forward browser buttons work within the SPA
 *   - Direct URL visits (deep links) render the correct page
 *   - Footer navigation links resolve without errors
 *   - Unknown routes do not crash the application
 */

import { test, expect } from '@playwright/test';
import { mockApi } from './helpers/api-mock.js';

test.beforeEach(async ({ page }) => {
    await mockApi(page);
});

// ── Homepage ──────────────────────────────────────────────────────────────────

test('homepage loads and contains expected headings', async ({ page }) => {
    await page.goto('/');

    // The h1 on the homepage
    await expect(page.locator('h1')).toContainText('The Interconnection Database');

    // Tagline
    await expect(page.locator('body')).toContainText('Synced. Read Only. Fast.');

    // Page title
    await expect(page).toHaveTitle('PDBFE');
});

test('homepage renders Most Recent Updates section', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toContainText('Most Recent Updates');
});

// ── SPA navigation ────────────────────────────────────────────────────────────

test('clicking a data-link navigates without a full page reload', async ({ page }) => {
    await page.goto('/');

    // Read the JS object identity of #app to detect if the DOM was fully torn down.
    // In a true SPA navigation, the existing elements persist; a full reload
    // would destroy and recreate them.
    await page.evaluate(() => {
        // Tag the app container so we can detect if it survived navigation
        const app = document.getElementById('app');
        if (app) app.dataset.spaMarker = 'alive';
    });

    // Navigate via data-link SPA routing
    const aboutLink = page.locator('a[href="/about"][data-link]').first();
    await aboutLink.click();

    // URL should have changed via pushState
    await expect(page).toHaveURL(/\/about/);

    // The About page content should render
    await expect(page.locator('body')).toContainText('About');

    // The #app container should still carry our data-spa-marker attribute,
    // proving it was not destroyed by a full page reload.
    const survived = await page.evaluate(() =>
        document.getElementById('app')?.dataset.spaMarker === 'alive'
    );
    expect(survived).toBe(true);
});

test('browser back button returns to previous page', async ({ page }) => {
    await page.goto('/');

    // The /about page fetches content/about.md asynchronously. If that fetch
    // resolves after goBack() fires, its callback can overwrite the homepage.
    // Mock the response so we control when the fetch settles.
    await page.route('**/content/about.md', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'text/markdown',
            body: '# About This Mirror\n\nTest content.',
        })
    );

    const aboutLink = page.locator('a[href="/about"][data-link]').first();
    await aboutLink.click();
    await expect(page).toHaveURL(/\/about/);
    // Wait until /about is fully rendered (fetch settled) before going back
    await expect(page.locator('h1')).toContainText('About', { timeout: 5_000 });

    await page.goBack();
    await expect(page).toHaveURL(/localhost:8788\/?$/);
    await expect(page.locator('h1')).toContainText('The Interconnection Database', { timeout: 10_000 });
});

// ── Deep links ────────────────────────────────────────────────────────────────

test('direct visit to /about renders the About page', async ({ page }) => {
    // Mock the about.md fetch
    await page.route('**/content/about.md', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/markdown',
            body: '# About This Mirror\n\nA read-only mirror of PeeringDB.',
        });
    });

    await page.goto('/about');
    await expect(page.locator('body')).toContainText('About');
    await expect(page).toHaveTitle(/About/);
});

test('direct visit to /net/694 renders the network detail page', async ({ page }) => {
    await page.goto('/net/694');
    await expect(page.locator('h1')).toContainText('Cloudflare');
    await expect(page).toHaveTitle(/Cloudflare/);
});

test('direct visit to /ix/26 renders the exchange detail page', async ({ page }) => {
    await page.goto('/ix/26');
    await expect(page.locator('h1')).toContainText('AMS-IX');
});

// ── Footer navigation ─────────────────────────────────────────────────────────

test('Compare link in footer navigates to /compare', async ({ page }) => {
    await page.goto('/');
    await page.locator('footer a[href="/compare"][data-link]').click();
    await expect(page).toHaveURL(/\/compare/);
    await expect(page.locator('body')).not.toContainText('error', { ignoreCase: true });
});

// ── Unknown route ─────────────────────────────────────────────────────────────

test('navigating to an unknown route does not crash', async ({ page }) => {
    await page.goto('/this-page-does-not-exist');
    // App should still be functional — no uncaught JS errors
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForTimeout(500);
    expect(errors.length).toBe(0);
});
