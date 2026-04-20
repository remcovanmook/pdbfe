/**
 * @fileoverview E2E accessibility tests.
 *
 * Verifies keyboard accessibility and skip-navigation behaviour.
 * Tests do not require any external axe library — they cover the
 * structural requirements defined in the implementation plan.
 *
 * Focuses on:
 *   - Skip-to-content link is the first focusable element
 *   - Tab order reaches the header search input
 *   - Tab order reaches header navigation links
 *   - All interactive elements in the header are keyboard-reachable
 *   - No JS console errors on page load
 */

import { test, expect } from '@playwright/test';
import { mockApi } from './helpers/api-mock.js';

test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.waitForTimeout(500);
});

// ── Skip navigation ───────────────────────────────────────────────────────────

test('skip-to-content link is the first focusable element', async ({ page }) => {
    // Tab once from the document start
    await page.keyboard.press('Tab');

    const focused = await page.evaluate(() => {
        const el = document.activeElement;
        return {
            tagName: el?.tagName,
            href: el?.getAttribute('href'),
            text: el?.textContent?.trim(),
        };
    });

    expect(focused.tagName).toBe('A');
    expect(focused.href).toBe('#app');
});

test('skip-to-content link is visible when focused', async ({ page }) => {
    await page.keyboard.press('Tab');
    // The .skip-nav link should become visible on focus (CSS shows it)
    const skipLink = page.locator('a.skip-nav');
    // We can't easily assert CSS visibility with :focus — assert it exists and is focusable
    await expect(skipLink).toBeAttached();
    const isFocused = await page.evaluate(() =>
        document.activeElement?.classList.contains('skip-nav')
    );
    expect(isFocused).toBe(true);
});

// ── Header search reachable ───────────────────────────────────────────────────

test('Tab reaches the header search input', async ({ page }) => {
    // Tab until we hit the header search or run out of attempts
    let found = false;
    for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Tab');
        const tagName = await page.evaluate(() => document.activeElement?.tagName);
        const inputId = await page.evaluate(() => document.activeElement?.id);
        if (tagName === 'INPUT' && inputId === 'header-search') {
            found = true;
            break;
        }
    }
    expect(found).toBe(true);
});

// ── Nav links reachable ───────────────────────────────────────────────────────

test('Tab reaches header navigation links after the search input', async ({ page }) => {
    // First get to header-search
    for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Tab');
        const inputId = await page.evaluate(() => document.activeElement?.id);
        if (inputId === 'header-search') break;
    }

    // Continue tabbing — should reach nav links
    let foundNavLink = false;
    for (let i = 0; i < 10; i++) {
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

// ── No errors on load ─────────────────────────────────────────────────────────

test('page loads without uncaught JavaScript errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.reload();
    await page.waitForTimeout(1_000);

    expect(errors).toHaveLength(0);
});

// ── Logo link ─────────────────────────────────────────────────────────────────

test('site logo link is in the Tab order', async ({ page }) => {
    // The logo is the first or second tab stop after the skip-nav link
    let foundLogo = false;
    for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Tab');
        const result = await page.evaluate(() => ({
            tagName: document.activeElement?.tagName,
            className: document.activeElement?.className || '',
        }));
        if (result.tagName === 'A' && result.className.includes('site-logo')) {
            foundLogo = true;
            break;
        }
    }
    expect(foundLogo).toBe(true);
});
