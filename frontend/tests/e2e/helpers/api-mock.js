/**
 * @fileoverview Shared Playwright API route interception helper.
 *
 * Provides `mockApi(page, overrides?)` which intercepts all `/api/*`
 * and `/status` requests and returns fixture JSON. Individual tests can
 * pass `overrides` to inject specific responses for their URL pattern.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dir, '../fixtures');

/**
 * Reads a fixture file and returns its parsed content.
 *
 * @param {string} name - Fixture filename without path (e.g. 'net-694.json').
 * @returns {any}
 */
function fixture(name) {
    return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

/** Empty list response used as a fallback for unmatched list endpoints. */
const EMPTY_LIST = { data: [], meta: { generated: 0, limit: 0, offset: 0, total: 0 } };

/**
 * Attaches `page.route()` handlers that intercept API and status requests,
 * returning fixture JSON without hitting any live worker.
 *
 * Call at the start of `test.beforeEach` or inside individual tests.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object.
 * @param {Record<string, any>} [overrides] - Map of URL substring → response body.
 *   Checked before the built-in fixture routing. Use to inject error responses,
 *   empty lists, or custom payloads for specific tests.
 */
export async function mockApi(page, overrides = {}) {
    await page.route('**/**', async (route) => {
        const url = route.request().url();

        // Check caller-supplied overrides first
        for (const [pattern, body] of Object.entries(overrides)) {
            if (url.includes(pattern)) {
                await route.fulfill({
                    status: typeof body === 'number' ? body : 200,
                    contentType: 'application/json',
                    body: typeof body === 'number' ? '' : JSON.stringify(body),
                });
                return;
            }
        }

        // /status endpoint
        if (url.includes('/status')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(fixture('status.json')),
            });
            return;
        }

        // /api/net/694 — single entity with depth
        if (url.match(/\/api\/net\/694/)) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(fixture('net-694.json')),
            });
            return;
        }

        // /api/ix/26 — single entity with depth
        if (url.match(/\/api\/ix\/26/)) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(fixture('ix-26.json')),
            });
            return;
        }

        // /api/compare
        if (url.includes('/api/compare')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(fixture('compare.json')),
            });
            return;
        }

        // /api/net with name__contains or asn= (search / typeahead)
        if (url.match(/\/api\/net(\?|$)/)) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(fixture('search-net.json')),
            });
            return;
        }

        // /api/netixlan (IX peer table)
        if (url.includes('/api/netixlan')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(EMPTY_LIST),
            });
            return;
        }

        // /search — search worker endpoint (typeahead + search page API calls).
        // Match only the exact /search path (with optional query string), not
        // static assets that contain "search" in their path (/js/pages/search.js).
        if (/\/search(\?|$)/.test(url) && route.request().resourceType() !== 'document') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(fixture('search-multi.json')),
            });
            return;
        }

        // Catch-all: empty list for all other /api/* requests
        if (url.includes('/api/')) {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(EMPTY_LIST),
            });
            return;
        }

        // /auth/* — reject all auth calls (no authenticated state in tests)
        if (url.includes('/auth/') || url.includes('/account/')) {
            await route.fulfill({ status: 401, body: '{"error":"unauthorized"}' });
            return;
        }

        // All other requests (static assets, locales, etc.) — pass through
        await route.continue();
    });
}
