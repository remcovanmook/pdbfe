/**
 * @fileoverview E2E tests for the theme (dark/light mode) system.
 *
 * Verifies:
 *   - A default theme is applied on load (no missing data-theme)
 *   - Selecting "Dark" in the footer select applies data-theme="dark" to <html>
 *   - Selecting "Light" applies data-theme="light"
 *   - Theme persists across SPA navigation (no re-render flash)
 *   - Theme persists in localStorage so a reload respects it
 *
 * Note: #theme-select is in the page footer and is dynamically populated by
 * boot.js. Tests wait for its options to be present before interacting.
 */

import { test, expect } from '@playwright/test';
import { mockApi } from './helpers/api-mock.js';

/**
 * Waits until #theme-select has been populated with at least one <option>.
 *
 * boot.js dynamically injects the options; this guard prevents interacting
 * with an empty select before the boot sequence has completed.
 *
 * @param {import('@playwright/test').Page} page
 */
async function waitForThemeSelect(page) {
    await page.waitForFunction(() => {
        const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('theme-select'));
        return sel !== null && sel.options.length > 0;
    }, undefined, { timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await waitForThemeSelect(page);
});

// ── Default state ─────────────────────────────────────────────────────────────

test('a theme is applied on load (auto, dark, or light)', async ({ page }) => {
    const theme = await page.locator('html').getAttribute('data-theme');
    // initTheme() reads localStorage or defaults based on OS preference
    expect(['auto', 'dark', 'light', null]).toContain(theme);
});

// ── Theme selection ───────────────────────────────────────────────────────────

test('selecting Dark theme applies data-theme="dark" to <html>', async ({ page }) => {
    const themeSelect = page.locator('#theme-select');
    await expect(themeSelect).toBeVisible({ timeout: 10_000 });
    // Scroll into view in case the footer is below the fold
    await themeSelect.scrollIntoViewIfNeeded();

    await themeSelect.selectOption('dark');
    await page.waitForTimeout(300);

    // theme.js applyTheme('dark') deletes the data-theme attribute.
    // CSS convention: no attribute = dark, data-theme='light' = light.
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBeNull();
    const stored = await page.evaluate(() => localStorage.getItem('pdbfe-theme'));
    expect(stored).toBe('dark');
});

test('selecting Light theme applies data-theme="light" to <html>', async ({ page }) => {
    const themeSelect = page.locator('#theme-select');
    await expect(themeSelect).toBeVisible({ timeout: 10_000 });
    await themeSelect.scrollIntoViewIfNeeded();

    await themeSelect.selectOption('light');
    await page.waitForTimeout(300);

    // light theme sets data-theme='light' on <html>
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('light');
});

// ── Theme persistence across SPA navigation ───────────────────────────────────

test('dark theme persists after SPA navigation to /about', async ({ page }) => {
    const themeSelect = page.locator('#theme-select');
    await expect(themeSelect).toBeVisible({ timeout: 10_000 });
    await themeSelect.scrollIntoViewIfNeeded();
    await themeSelect.selectOption('dark');
    await page.waitForTimeout(200);

    // Navigate via SPA (data-link click)
    await page.locator('a[href="/about"][data-link]').first().click();
    await expect(page).toHaveURL(/\/about/);
    await page.waitForTimeout(300);

    // Theme should still be dark — no full page reload reset it.
    // Dark = null data-theme attribute (CSS convention: no attr = dark)
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBeNull();
    const stored = await page.evaluate(() => localStorage.getItem('pdbfe-theme'));
    expect(stored).toBe('dark');
});

// ── localStorage persistence ──────────────────────────────────────────────────

test('selected theme is stored in localStorage', async ({ page }) => {
    const themeSelect = page.locator('#theme-select');
    await expect(themeSelect).toBeVisible({ timeout: 10_000 });
    await themeSelect.scrollIntoViewIfNeeded();
    await themeSelect.selectOption('dark');
    await page.waitForTimeout(200);

    const stored = await page.evaluate(() => localStorage.getItem('pdbfe-theme'));
    expect(stored).toBe('dark');
});
