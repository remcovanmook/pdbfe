/**
 * @fileoverview E2E tests for keyboard accessibility.
 *
 * All tests that interact with the header search start on /net/694 because
 * the homepage hides `.search-wrapper` via CSS: the header search is only
 * present on interior pages.
 *
 * Verifies:
 *   - Skip-to-content link is the first focusable element on an interior page
 *   - Tab order reaches the header search input
 *   - Tab order reaches header navigation links
 *   - No JS console errors on page load
 */

import { test, expect } from '@playwright/test';
import { mockApi } from './helpers/api-mock.js';

// ── Skip navigation (interior page) ──────────────────────────────────────────

test('skip-to-content link is the first focusable element', async ({ page }) => {
    await mockApi(page);
    // Use an interior page so the search bar is visible
    await page.goto('/net/694');
    await expect(page.locator('h1')).toContainText('Cloudflare', { timeout: 10_000 });

    // Tab once from the document start
    await page.keyboard.press('Tab');

    const focused = await page.evaluate(() => {
        const el = document.activeElement;
        return {
            tagName: el?.tagName,
            href: el?.getAttribute('href'),
        };
    });

    expect(focused.tagName).toBe('A');
    expect(focused.href).toBe('#app');
});

test('skip-to-content link is focusable (in tab order)', async ({ page }) => {
    await mockApi(page);
    await page.goto('/net/694');
    await expect(page.locator('h1')).toContainText('Cloudflare', { timeout: 10_000 });

    await page.keyboard.press('Tab');
    const isFocused = await page.evaluate(() =>
        document.activeElement?.getAttribute('href') === '#app'
    );
    expect(isFocused).toBe(true);
});

// ── Header search reachable ───────────────────────────────────────────────────

test('Tab reaches the header search input on an interior page', async ({ page }) => {
    await mockApi(page);
    await page.goto('/net/694');
    await expect(page.locator('h1')).toContainText('Cloudflare', { timeout: 10_000 });

    // Tab until we find the header search or run out of attempts
    let found = false;
    for (let i = 0; i < 15; i++) {
        await page.keyboard.press('Tab');
        const inputId = await page.evaluate(() => document.activeElement?.id);
        if (inputId === 'header-search') {
            found = true;
            break;
        }
    }
    expect(found).toBe(true);
});

// ── Nav links reachable ───────────────────────────────────────────────────────

test('Tab reaches header navigation links', async ({ page }) => {
    await mockApi(page);
    await page.goto('/net/694');
    await expect(page.locator('h1')).toContainText('Cloudflare', { timeout: 10_000 });

    // Tab through the entire header focus order
    let foundNavLink = false;
    for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const result = await page.evaluate(() => ({
            tagName: document.activeElement?.tagName,
            className: document.activeElement?.className || '',
        }));
        if (result.tagName === 'A' && result.className.includes('header-nav-link')) {
            foundNavLink = true;
            break;
        }
    }
    expect(foundNavLink).toBe(true);
});

// ── No errors on page load ─────────────────────────────────────────────────────

test('page loads without uncaught JavaScript errors', async ({ page }) => {
    await mockApi(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await page.waitForTimeout(1_500);

    expect(errors).toHaveLength(0);
});

// ── Logo link in tab order ─────────────────────────────────────────────────────

test('site logo link is in the Tab order', async ({ page }) => {
    await mockApi(page);
    await page.goto('/net/694');
    await expect(page.locator('h1')).toContainText('Cloudflare', { timeout: 10_000 });

    let foundLogo = false;
    for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Tab');
        const result = await page.evaluate(() => ({
            tagName: document.activeElement?.tagName,
            href: document.activeElement?.getAttribute('href') || '',
        }));
        // The logo is an <a href="/"> link
        if (result.tagName === 'A' && result.href === '/') {
            foundLogo = true;
            break;
        }
    }
    expect(foundLogo).toBe(true);
});
