/**
 * @fileoverview E2E tests for the header typeahead search.
 *
 * All tests start on a non-home page (/net/694) because the homepage
 * hides the header search wrapper via CSS (`body[data-page="home"] .search-wrapper
 * { display: none }`). The search bar is only visible on interior pages.
 *
 * Verifies:
 *   - No dropdown for < 2 chars
 *   - Dropdown appears with grouped results after debounce
 *   - Keyboard navigation (ArrowDown, Enter, Escape)
 *   - Enter with no selection navigates to /search
 *   - Clicking outside closes the dropdown
 */

import { test, expect } from '@playwright/test';
import { mockApi } from './helpers/api-mock.js';

test.beforeEach(async ({ page }) => {
    await mockApi(page);
    // Navigate to an interior page — the homepage hides the header search
    await page.goto('/net/694');
    await expect(page.locator('h1')).toContainText('Cloudflare', { timeout: 10_000 });
});

// ── Minimum length ────────────────────────────────────────────────────────────

test('no dropdown appears for a single-character query', async ({ page }) => {
    const input = page.locator('#header-search');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('c');
    // Wait past debounce (250ms)
    await page.waitForTimeout(400);
    await expect(page.locator('.search-dropdown.is-open')).not.toBeVisible();
});

// ── Dropdown appears ──────────────────────────────────────────────────────────

test('dropdown appears with results after typing 2+ chars', async ({ page }) => {
    const input = page.locator('#header-search');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('cl');
    // Wait past debounce
    await page.waitForTimeout(400);

    const dropdown = page.locator('.search-dropdown');
    await expect(dropdown).toBeVisible();
    // Should have at least one search-dropdown__item (from the fixture)
    await expect(dropdown.locator('.search-dropdown__item').first()).toBeVisible();
});

test('dropdown shows entity type labels', async ({ page }) => {
    const input = page.locator('#header-search');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('cloud');
    await page.waitForTimeout(400);

    const dropdown = page.locator('.search-dropdown');
    await expect(dropdown).toBeVisible();
    // Entity badge labels appear in group headers
    await expect(dropdown.locator('.entity-badge').first()).toBeVisible();
});

// ── Keyboard navigation ───────────────────────────────────────────────────────

test('ArrowDown highlights the first dropdown item', async ({ page }) => {
    const input = page.locator('#header-search');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('cloud');
    await page.waitForTimeout(400);

    await input.press('ArrowDown');

    const firstItem = page.locator('.search-dropdown__item').first();
    await expect(firstItem).toHaveClass(/is-active/);
});

test('Escape closes the dropdown', async ({ page }) => {
    const input = page.locator('#header-search');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('cloud');
    await page.waitForTimeout(400);
    await expect(page.locator('.search-dropdown')).toBeVisible();

    await input.press('Escape');
    await expect(page.locator('.search-dropdown.is-open')).not.toBeVisible();
});

test('Enter with no highlighted item navigates to /search', async ({ page }) => {
    const input = page.locator('#header-search');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('cloud');
    await page.waitForTimeout(400);

    // Press Enter without ArrowDown — navigateOnEnter=true (default)
    await input.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=cloud/i);
});

test('ArrowDown + Enter navigates to the highlighted item', async ({ page }) => {
    const input = page.locator('#header-search');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('Cloudflare');
    await page.waitForTimeout(400);

    await input.press('ArrowDown');
    await input.press('Enter');

    // Should navigate to /net/694 (the first result from the fixture)
    await expect(page).toHaveURL(/\/net\/694/);
});

// ── Click-to-navigate ─────────────────────────────────────────────────────────

test('clicking a dropdown item navigates to the entity page', async ({ page }) => {
    const input = page.locator('#header-search');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('Cloud');
    await page.waitForTimeout(400);

    const firstItem = page.locator('.search-dropdown__item').first();
    await expect(firstItem).toBeVisible();
    await firstItem.click();

    // Should have navigated to a detail page
    await expect(page).toHaveURL(/\/(net|ix|fac|org|carrier|campus)\/\d+/);
});

// ── Click-outside closes dropdown ─────────────────────────────────────────────

test('clicking outside the search area closes the dropdown', async ({ page }) => {
    const input = page.locator('#header-search');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('cloud');
    await page.waitForTimeout(400);
    await expect(page.locator('.search-dropdown.is-open')).toBeVisible();

    // Click somewhere not in the search wrapper
    await page.locator('h1').click();
    await expect(page.locator('.search-dropdown.is-open')).not.toBeVisible();
});
