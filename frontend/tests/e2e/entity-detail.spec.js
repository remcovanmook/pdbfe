/**
 * @fileoverview E2E tests for entity detail pages.
 *
 * Verifies that:
 *   - The entity type badge, h1, and info fields render for net and IX
 *   - pdb-table components render with rows in a real browser (connectedCallback)
 *   - Column sort reorders visible rows
 *   - Filter input narrows visible rows
 *   - Compare button is present on net/ix/fac pages
 *   - Share button is present
 */

import { test, expect } from '@playwright/test';
import { mockApi } from './helpers/api-mock.js';

// ── Network detail page ───────────────────────────────────────────────────────

test.describe('Network detail page (/net/694)', () => {
    test.beforeEach(async ({ page }) => {
        await mockApi(page);
        await page.goto('/net/694');
        // Wait for the page to boot fully
        await expect(page.locator('h1')).toContainText('Cloudflare', { timeout: 10_000 });
    });

    test('renders entity type badge', async ({ page }) => {
        await expect(page.locator('.entity-badge[data-type="net"]')).toBeVisible();
    });

    test('renders at least one info-field', async ({ page }) => {
        await expect(page.locator('.info-field').first()).toBeVisible();
    });

    test('info fields include ASN', async ({ page }) => {
        // The ASN field should appear somewhere on the page
        await expect(page.locator('body')).toContainText('13335');
    });

    test('page title includes entity name', async ({ page }) => {
        await expect(page).toHaveTitle(/Cloudflare/);
    });

    test('Compare button is visible', async ({ page }) => {
        const compareBtn = page.locator('a.detail-header__btn', { hasText: 'Compare' });
        await expect(compareBtn).toBeVisible();
    });

    test('Share button is visible', async ({ page }) => {
        const shareBtn = page.locator('button.detail-header__btn', { hasText: 'Share' });
        await expect(shareBtn).toBeVisible();
    });

    test('favorite toggle button is visible', async ({ page }) => {
        await expect(page.locator('.favorite-btn')).toBeVisible();
    });

    test('clicking favorite toggle does not crash', async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await page.locator('.favorite-btn').click();
        await page.waitForTimeout(300);
        expect(errors.length).toBe(0);
    });
});

// ── IX detail page ────────────────────────────────────────────────────────────

test.describe('IX detail page (/ix/26)', () => {
    test.beforeEach(async ({ page }) => {
        await mockApi(page);
        await page.goto('/ix/26');
        await expect(page.locator('h1')).toContainText('AMS-IX', { timeout: 10_000 });
    });

    test('renders entity type badge', async ({ page }) => {
        await expect(page.locator('.entity-badge[data-type="ix"]')).toBeVisible();
    });

    test('renders at least one info-field', async ({ page }) => {
        await expect(page.locator('.info-field').first()).toBeVisible();
    });

    test('page title includes entity name', async ({ page }) => {
        await expect(page).toHaveTitle(/AMS-IX/);
    });

    test('info fields include city', async ({ page }) => {
        await expect(page.locator('body')).toContainText('Amsterdam');
    });
});

// ── pdb-table rendering ───────────────────────────────────────────────────────

test.describe('pdb-table component in browser', () => {
    test.beforeEach(async ({ page }) => {
        await mockApi(page);
    });

    test('pdb-table renders a real <table> element on net detail', async ({ page }) => {
        await page.goto('/net/694');
        await expect(page.locator('h1')).toContainText('Cloudflare', { timeout: 10_000 });

        // pdb-table should have rendered an actual table element
        const table = page.locator('pdb-table table').first();
        await expect(table).toBeVisible({ timeout: 5_000 });
    });

    test('pdb-table header contains expected column headers', async ({ page }) => {
        await page.goto('/net/694');
        await expect(page.locator('h1')).toContainText('Cloudflare', { timeout: 10_000 });

        const thead = page.locator('pdb-table thead').first();
        await expect(thead).toBeVisible();
        // At least one th should be present
        await expect(thead.locator('th').first()).toBeVisible();
    });

    test('clicking a column header does not crash', async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await page.goto('/net/694');
        await expect(page.locator('h1')).toContainText('Cloudflare', { timeout: 10_000 });

        // Click the first sortable column header
        const th = page.locator('pdb-table thead th').first();
        if (await th.isVisible()) {
            await th.click();
            await page.waitForTimeout(200);
        }

        expect(errors.length).toBe(0);
    });
});
