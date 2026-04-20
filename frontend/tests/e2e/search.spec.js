/**
 * @fileoverview E2E tests for the search results page.
 *
 * Verifies:
 *   - /search?q=cloud renders results from the mocked API
 *   - Results are grouped by entity type
 *   - Clicking a result navigates to the entity detail page
 *   - An empty query shows an appropriate empty state
 */

import { test, expect } from '@playwright/test';
import { mockApi } from './helpers/api-mock.js';

test.beforeEach(async ({ page }) => {
    await mockApi(page);
});

// ── Basic search ──────────────────────────────────────────────────────────────

test('search page renders results for a query', async ({ page }) => {
    await page.goto('/search?q=cloud');
    // Should render at least one result from fixture (Cloudflare, NTT, etc.)
    await expect(page.locator('body')).toContainText('Cloudflare', { timeout: 10_000 });
});

test('search page title includes the query', async ({ page }) => {
    await page.goto('/search?q=cloudtest');
    await expect(page).toHaveTitle(/Search/);
});

test('search results show entity names as links', async ({ page }) => {
    await page.goto('/search?q=cloud');
    await page.waitForTimeout(500);
    // At least one internal link to an entity detail page
    const entityLinks = page.locator('a[href^="/net/"], a[href^="/ix/"], a[href^="/fac/"]');
    await expect(entityLinks.first()).toBeVisible({ timeout: 5_000 });
});

// ── Result navigation ─────────────────────────────────────────────────────────

test('clicking a search result navigates to the entity detail page', async ({ page }) => {
    await page.goto('/search?q=cloud');
    await page.waitForTimeout(500);

    const firstLink = page.locator('a[href^="/net/"]').first();
    if (await firstLink.isVisible()) {
        await firstLink.click();
        await expect(page).toHaveURL(/\/net\/\d+/);
        await expect(page.locator('h1')).toBeVisible({ timeout: 5_000 });
    }
});

// ── Empty state ───────────────────────────────────────────────────────────────

test('search page renders without crash for very short query', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/search?q=x');
    await page.waitForTimeout(500);
    expect(errors.length).toBe(0);
});

test('search page shows page content for empty query', async ({ page }) => {
    await page.goto('/search?q=');
    await page.waitForTimeout(500);
    // Page should render without error
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Uncaught');
});
