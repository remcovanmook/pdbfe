/**
 * @fileoverview Unit tests for API key generation, verification, and
 * account management functions.
 *
 * Uses mock D1 databases instead of mock KV namespaces. The verifyApiKey
 * function now queries `SELECT 1 FROM api_keys WHERE hash = ?` on D1.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateApiKey, resolveAllowedOrigin } from '../../../auth/account.js';
import { verifyApiKey, extractApiKey, hashKey } from '../../../core/auth.js';

// ── Mock D1 database ─────────────────────────────────────────────────────────

/**
 * Creates a mock D1Database backed by an in-memory row store.
 * Supports the subset of the D1 API used by verifyApiKey:
 *   db.prepare(sql).bind(...params).first() → row | null
 *
 * The store maps SQL query substrings to result-producing functions,
 * but for key verification tests we only need to match hash lookups.
 *
 * @param {Array<{hash: string}>} apiKeys - API key rows to seed.
 * @returns {D1Database}
 */
function mockD1(apiKeys = []) {
    const hashSet = new Set(apiKeys.map(k => k.hash));

    return /** @type {any} */ ({
        prepare(/** @type {string} */ _sql) {
            return {
                /** @type {any[]} */
                _params: [],
                bind(/** @type {...any} */ ...params) {
                    this._params = params;
                    return this;
                },
                first() {
                    // Respond to: SELECT user_id FROM api_keys WHERE hash = ?
                    const hash = this._params[0];
                    return Promise.resolve(hashSet.has(hash) ? { user_id: 1 } : null);
                },
                run() {
                    return Promise.resolve({ success: true, meta: {}, results: [] });
                },
                all() {
                    return Promise.resolve({ success: true, meta: {}, results: [] });
                },
            };
        },
        batch(/** @type {any[]} */ stmts) {
            return Promise.resolve(stmts.map(() => ({ success: true, meta: {}, results: [] })));
        },
    });
}

// ── generateApiKey ───────────────────────────────────────────────────────────

describe('generateApiKey', () => {
    it('returns a string starting with pdbfe.', () => {
        const key = generateApiKey();
        assert.ok(key.startsWith('pdbfe.'), `Expected key to start with 'pdbfe.', got: ${key}`);
    });

    it('has the correct total length (pdbfe. + 32 hex chars = 38)', () => {
        const key = generateApiKey();
        assert.equal(key.length, 38);
    });

    it('hex portion contains only valid hex characters', () => {
        const key = generateApiKey();
        const hex = key.slice(6); // Remove 'pdbfe.'
        assert.match(hex, /^[0-9a-f]{32}$/);
    });

    it('generates unique keys on successive calls', () => {
        const keys = new Set(Array.from({ length: 20 }, () => generateApiKey()));
        assert.equal(keys.size, 20, 'Expected 20 unique keys');
    });
});

// ── verifyApiKey ─────────────────────────────────────────────────────────────

describe('verifyApiKey', () => {
    it('returns true for a key that exists in D1 (hashed)', async () => {
        const testKey = 'pdbfe.abcd1234abcd1234abcd1234abcd1234';
        const hashed = await hashKey(testKey);
        const db = mockD1([{ hash: hashed }]);

        const result = await verifyApiKey(db, testKey);
        assert.equal(result.valid, true);
        assert.equal(result.userId, 1);
    });

    it('returns false for a key that does not exist in D1', async () => {
        const db = mockD1([]);
        const result = await verifyApiKey(db, 'pdbfe.nonexistent0000000000000000');
        assert.equal(result.valid, false);
        assert.equal(result.userId, null);
    });

    it('returns false for null key', async () => {
        const db = mockD1([]);
        const result = await verifyApiKey(db, null);
        assert.equal(result.valid, false);
    });

    it('returns false for empty string key', async () => {
        const db = mockD1([]);
        const result = await verifyApiKey(db, '');
        assert.equal(result.valid, false);
    });

    it('caches results to avoid repeated D1 queries', async () => {
        let queryCount = 0;
        const db = /** @type {any} */ ({
            prepare() {
                return {
                    bind() {
                        return {
                            first() {
                                queryCount++;
                                return Promise.resolve({ user_id: 99 });
                            },
                        };
                    },
                };
            },
        });

        const key = 'pdbfe.cachetest_d1_000000000000000';
        await verifyApiKey(db, key);
        await verifyApiKey(db, key);
        await verifyApiKey(db, key);

        // Should only hit D1 once, then cache for subsequent calls
        assert.equal(queryCount, 1, 'Expected 1 D1 query, got ' + queryCount);
    });
});

// ── extractApiKey with verifyApiKey integration ──────────────────────────────

describe('extractApiKey + verifyApiKey integration', () => {
    it('extracts and verifies a valid key from request header', async () => {
        const fullKey = generateApiKey();
        const hashed = await hashKey(fullKey);
        const db = mockD1([{ hash: hashed }]);

        const request = new Request('https://api.example.com/api/net', {
            headers: { 'Authorization': `Api-Key ${fullKey}` },
        });

        const extracted = extractApiKey(request);
        assert.equal(extracted, fullKey);

        const result = await verifyApiKey(db, extracted);
        assert.equal(result.valid, true);
    });

    it('returns false for a valid format key that is not in D1', async () => {
        const db = mockD1([]);

        const request = new Request('https://api.example.com/api/net', {
            headers: { 'Authorization': 'Api-Key pdbfe.0000000000000000000000000000dead' },
        });

        const extracted = extractApiKey(request);
        const result = await verifyApiKey(db, extracted);
        assert.equal(result.valid, false);
    });
});

// ── resolveAllowedOrigin ─────────────────────────────────────────────────────

/**
 * Builds a minimal mock Request with the given Origin header.
 *
 * @param {string} [origin] - Origin header value. Omit for no Origin.
 * @returns {Request}
 */
function mockRequest(origin) {
    const headers = new Headers();
    if (origin) headers.set('Origin', origin);
    return new Request('https://pdbfe-auth.remco-vanmook.workers.dev/account/preferences/options', { headers });
}

/**
 * Builds a minimal mock PdbAuthEnv with FRONTEND_ORIGIN and optional PAGES_PROJECT.
 *
 * @param {string} frontendOrigin - Production frontend origin.
 * @param {string} [pagesProject] - Cloudflare Pages project name.
 * @returns {PdbAuthEnv}
 */
function mockEnv(frontendOrigin, pagesProject) {
    return /** @type {any} */ ({ FRONTEND_ORIGIN: frontendOrigin, PAGES_PROJECT: pagesProject });
}

describe('resolveAllowedOrigin', () => {
    it('returns FRONTEND_ORIGIN when request has no Origin header', () => {
        const result = resolveAllowedOrigin(mockRequest(), mockEnv('https://www.pdbfe.dev'));
        assert.equal(result, 'https://www.pdbfe.dev');
    });

    it('reflects exact match', () => {
        const result = resolveAllowedOrigin(
            mockRequest('https://www.pdbfe.dev'),
            mockEnv('https://www.pdbfe.dev')
        );
        assert.equal(result, 'https://www.pdbfe.dev');
    });

    it('reflects apex when FRONTEND_ORIGIN has www', () => {
        const result = resolveAllowedOrigin(
            mockRequest('https://pdbfe.dev'),
            mockEnv('https://www.pdbfe.dev')
        );
        assert.equal(result, 'https://pdbfe.dev');
    });

    it('reflects www when FRONTEND_ORIGIN is apex', () => {
        const result = resolveAllowedOrigin(
            mockRequest('https://www.pdbfe.dev'),
            mockEnv('https://pdbfe.dev')
        );
        assert.equal(result, 'https://www.pdbfe.dev');
    });

    it('reflects subdomain of production host', () => {
        const result = resolveAllowedOrigin(
            mockRequest('https://staging.pdbfe.dev'),
            mockEnv('https://www.pdbfe.dev')
        );
        assert.equal(result, 'https://staging.pdbfe.dev');
    });

    it('reflects Cloudflare Pages preview subdomain', () => {
        const result = resolveAllowedOrigin(
            mockRequest('https://abc123.pdbfe-frontend.pages.dev'),
            mockEnv('https://www.pdbfe.dev')
        );
        assert.equal(result, 'https://abc123.pdbfe-frontend.pages.dev');
    });

    it('reflects custom PAGES_PROJECT preview subdomain', () => {
        const result = resolveAllowedOrigin(
            mockRequest('https://feature-x.my-project.pages.dev'),
            mockEnv('https://pdbfe.dev', 'my-project')
        );
        assert.equal(result, 'https://feature-x.my-project.pages.dev');
    });

    it('falls back to FRONTEND_ORIGIN for unrelated origin', () => {
        const result = resolveAllowedOrigin(
            mockRequest('https://evil.example.com'),
            mockEnv('https://www.pdbfe.dev')
        );
        assert.equal(result, 'https://www.pdbfe.dev');
    });

    it('falls back to FRONTEND_ORIGIN for malformed origin', () => {
        const result = resolveAllowedOrigin(
            mockRequest('not-a-url'),
            mockEnv('https://www.pdbfe.dev')
        );
        assert.equal(result, 'https://www.pdbfe.dev');
    });
});
