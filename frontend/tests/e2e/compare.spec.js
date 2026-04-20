/**
 * @fileoverview E2E tests for the compare page.
 *
 * Verifies:
 *   - /compare loads without errors in empty state
 *   - /compare?a=net:694 pre-fills entity A
 *   - Mocked /api/compare response renders the overlap section
 */

import { test, expect } from '@playwright/test';
import { mockApi } from './helpers/api-mock.js';

test.beforeEach(async ({ page }) => {
    await mockApi(page);
});

// ── Empty state ───────────────────────────────────────────────────────────────

test('compare page loads without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/compare');
    await page.waitForTimeout(500);

    expect(errors.length).toBe(0);
    await expect(page.locator('body')).toBeVisible();
});

test('compare page title is set', async ({ page }) => {
    await page.goto('/compare');
    await expect(page).toHaveTitle(/Compare/);
});

// ── Pre-filled entity A via URL ───────────────────────────────────────────────

test('visiting /compare?a=net:694 pre-fills entity A', async ({ page }) => {
    await page.goto('/compare?a=net:694');
    await page.waitForTimeout(1_000);

    // The compare page should show entity A's name somewhere
    await expect(page.locator('body')).toContainText('Cloudflare', { timeout: 8_000 });
});

// ── Overlap results ───────────────────────────────────────────────────────────

test('compare page renders shared exchanges from mocked response', async ({ page }) => {
    // Navigate with both entities set — the page fetches /api/compare
    await page.goto('/compare?a=net:694&b=net:2914');
    await page.waitForTimeout(3_000);

    // The compare fixture has a shared IX (AMS-IX)
    await expect(page.locator('body')).toContainText('AMS-IX', { timeout: 12_000 });
});
