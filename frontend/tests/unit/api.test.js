/**
 * @fileoverview Unit tests for the API client module.
 *
 * Tests the SWR cache state machine, URL building, `searchWithAsn` ASN
 * injection and deduplication, and `getCacheDiagnostics` output.
 *
 * All network calls are intercepted via mocked `globalThis.fetch`.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDOM } from '../helpers/mock-dom.js';

// ── Setup ────────────────────────────────────────────────────────────────────

/**
 * Resets the minimum globals needed for api.js and its import chain.
 * Called in beforeEach to prevent shared fetch/cache state across tests.
 */
function setup() {
    createMockDOM();
}

// ── buildURL (tested via fetchList) ──────────────────────────────────────────

describe('buildURL — URL construction', () => {
    beforeEach(setup);

    it('appends __pdbfe=1 when IMAGES_ORIGIN is configured', async () => {
        /** @type {string[]} */
        const calls = [];
        globalThis.fetch = /** @type {any} */ (async (url) => {
            calls.push(String(url));
            return { ok: true, json: async () => ({ data: [], meta: {} }), headers: new Map() };
        });

        const { fetchList, clearCache } = await import('../../js/api.js');
        clearCache();
        await fetchList('net', {});

        // IMAGES_ORIGIN is set in the bundled config — __pdbfe=1 must be present
        assert.ok(calls.some(u => u.includes('__pdbfe=1')),
            'Expected __pdbfe=1 in URL when IMAGES_ORIGIN is set');
    });

    it('excludes falsy params from the query string', async () => {
        /** @type {string[]} */
        const calls = [];
        globalThis.fetch = /** @type {any} */ (async (url) => {
            calls.push(String(url));
            return { ok: true, json: async () => ({ data: [], meta: {} }), headers: new Map() };
        });

        const { fetchList, clearCache } = await import('../../js/api.js');
        clearCache();
        await fetchList('net', { name: '', asn: undefined, limit: null });

        const url = calls[0];
        assert.ok(!url.includes('name='), 'Empty string param should be excluded');
        assert.ok(!url.includes('asn='), 'Undefined param should be excluded');
        assert.ok(!url.includes('limit='), 'Null param should be excluded');
    });

    it('includes non-empty params in the query string', async () => {
        /** @type {string[]} */
        const calls = [];
        globalThis.fetch = /** @type {any} */ (async (url) => {
            calls.push(String(url));
            return { ok: true, json: async () => ({ data: [], meta: {} }), headers: new Map() };
        });

        const { fetchList, clearCache } = await import('../../js/api.js');
        clearCache();
        await fetchList('net', { asn: 20940 });

        assert.ok(calls[0].includes('asn=20940'), 'Non-empty param should appear in URL');
    });
});

// ── SWR cache ────────────────────────────────────────────────────────────────

describe('SWR cache — state machine', () => {
    beforeEach(setup);

    it('returns cached data on a fresh second request without fetching', async () => {
        let fetchCount = 0;
        globalThis.fetch = /** @type {any} */ (async () => {
            fetchCount++;
            return { ok: true, json: async () => ({ data: [{ id: 1 }], meta: {} }), headers: new Map() };
        });

        const { fetchList, clearCache } = await import('../../js/api.js');
        clearCache();

        await fetchList('ix', { limit: 1 });
        const count1 = fetchCount;
        await fetchList('ix', { limit: 1 });
        const count2 = fetchCount;

        assert.equal(count1, 1, 'First request should fetch');
        assert.equal(count2, 1, 'Second fresh request should NOT fetch again');
    });

    it('coalesces concurrent requests for the same resource', async () => {
        let fetchCount = 0;
        globalThis.fetch = /** @type {any} */ (async () => {
            fetchCount++;
            // Small delay to simulate network latency
            await new Promise(r => setTimeout(r, 10));
            return { ok: true, json: async () => ({ data: [], meta: {} }), headers: new Map() };
        });

        const { fetchList, clearCache } = await import('../../js/api.js');
        clearCache();

        // Fire 3 concurrent requests for the same uncached key
        await Promise.all([
            fetchList('fac', { limit: 5 }),
            fetchList('fac', { limit: 5 }),
            fetchList('fac', { limit: 5 }),
        ]);

        assert.equal(fetchCount, 1, 'Concurrent requests for the same key should be coalesced');
    });

    it('throws on non-2xx status', async () => {
        globalThis.fetch = /** @type {any} */ (async () => ({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            headers: new Map(),
        }));

        const { fetchList, clearCache } = await import('../../js/api.js');
        clearCache();

        await assert.rejects(
            () => fetchList('org', {}),
            (err) => /** @type {Error} */ (err).message.includes('API error'),
        );
    });

    it('dispatches pdbfe:ratelimit event on 429', async () => {
        globalThis.fetch = /** @type {any} */ (async () => ({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: new Map(),
        }));

        let eventFired = false;
        globalThis.dispatchEvent = /** @type {any} */ ((e) => {
            if (e.type === 'pdbfe:ratelimit') eventFired = true;
        });

        const { fetchList, clearCache } = await import('../../js/api.js');
        clearCache();

        await assert.rejects(() => fetchList('carrier', {}));
        assert.ok(eventFired, 'Should dispatch pdbfe:ratelimit event on 429');
    });
});

// ── getCacheDiagnostics ──────────────────────────────────────────────────────

describe('getCacheDiagnostics', () => {
    beforeEach(setup);

    it('returns entries with correct shape after a fetch', async () => {
        globalThis.fetch = /** @type {any} */ (async () => ({
            ok: true,
            json: async () => ({ data: [], meta: {} }),
            headers: new Map([
                ['X-Cache', 'L1'],
                ['X-Cache-Hits', '5'],
                ['X-Timer', 'S100,VS0,VE1'],
                ['X-Served-By', 'cache-AMS'],
                ['X-Isolate-ID', 'abc'],
            ]),
        }));

        const { fetchList, clearCache, getCacheDiagnostics } = await import('../../js/api.js');
        clearCache();
        await fetchList('net', { limit: 1 });

        const stats = getCacheDiagnostics();
        assert.ok(stats.length >= 1);

        const entry = stats.find(s => s.key.includes('/api/net'));
        assert.ok(entry, 'Should have a net entry');
        assert.equal(typeof entry.ageMs, 'number');
        assert.ok(entry.ageMs >= 0);
        assert.equal(entry.swrState, 'FRESH');
        assert.equal(entry.telemetry.tier, 'L1');
        assert.equal(entry.telemetry.hits, '5');
    });

    it('does not expose auth-prefixed cache keys', async () => {
        globalThis.fetch = /** @type {any} */ (async () => ({
            ok: true,
            json: async () => ({ data: [], meta: {} }),
            headers: new Map(),
        }));

        const { fetchList, clearCache, getCacheDiagnostics } = await import('../../js/api.js');
        clearCache();
        await fetchList('net', {});

        const stats = getCacheDiagnostics();
        const authEntries = stats.filter(s => s.key.startsWith('auth:'));
        assert.equal(authEntries.length, 0, 'auth: prefixed keys must not appear in diagnostics');
    });
});

// ── searchWithAsn ────────────────────────────────────────────────────────────

describe('searchWithAsn — ASN injection and deduplication', () => {
    beforeEach(setup);

    it('injects exact ASN match at the top of results.net', async () => {
        const exactNet = { id: 1, name: 'Cloudflare', asn: 13335 };
        const otherNet = { id: 2, name: 'Cloudflare-2', asn: 99999 };

        globalThis.fetch = /** @type {any} */ (async (url) => {
            const u = String(url);
            // asn= lookup → exact match
            if (u.includes('asn=13335')) {
                return { ok: true, json: async () => ({ data: [exactNet], meta: {} }), headers: new Map() };
            }
            // name__contains lookup → other results (no exact match)
            return { ok: true, json: async () => ({ data: [otherNet], meta: {} }), headers: new Map() };
        });

        const { searchWithAsn, clearCache } = await import('../../js/api.js');
        clearCache();

        const results = await searchWithAsn('13335');
        assert.ok(results.net, 'results.net should exist');
        assert.equal(results.net[0].id, exactNet.id, 'Exact ASN match should be first');
    });

    it('deduplicates the exact ASN match when already in search results', async () => {
        const exactNet = { id: 1, name: 'Cloudflare', asn: 13335 };

        globalThis.fetch = /** @type {any} */ (async (url) => {
            const u = String(url);
            if (u.includes('asn=13335')) {
                return { ok: true, json: async () => ({ data: [exactNet], meta: {} }), headers: new Map() };
            }
            // name__contains also returns the exact match (already in list)
            return { ok: true, json: async () => ({ data: [exactNet, { id: 2, name: 'Other' }], meta: {} }), headers: new Map() };
        });

        const { searchWithAsn, clearCache } = await import('../../js/api.js');
        clearCache();

        const results = await searchWithAsn('13335');
        const ids = results.net.map(n => n.id);
        const uniqueIds = new Set(ids);
        assert.equal(ids.length, uniqueIds.size, 'No duplicate entries after ASN injection');
        assert.equal(results.net[0].id, exactNet.id, 'Exact match should be first after deduplication');
    });

    it('does not inject ASN match when query is not ASN-shaped', async () => {
        let asnFetchFired = false;

        globalThis.fetch = /** @type {any} */ (async (url) => {
            const u = String(url);
            if (u.includes('asn=')) asnFetchFired = true;
            return { ok: true, json: async () => ({ data: [], meta: {} }), headers: new Map() };
        });

        const { searchWithAsn, clearCache } = await import('../../js/api.js');
        clearCache();

        await searchWithAsn('cloudflare');
        assert.equal(asnFetchFired, false, 'Non-ASN query should not trigger ASN lookup');
    });
});

// ── clearCache ───────────────────────────────────────────────────────────────

describe('clearCache', () => {
    beforeEach(setup);

    it('empties the cache so the next request goes to the network', async () => {
        let fetchCount = 0;
        globalThis.fetch = /** @type {any} */ (async () => {
            fetchCount++;
            return { ok: true, json: async () => ({ data: [], meta: {} }), headers: new Map() };
        });

        const { fetchList, clearCache } = await import('../../js/api.js');
        clearCache();
        await fetchList('campus', {});
        clearCache();
        await fetchList('campus', {});

        assert.equal(fetchCount, 2, 'Clearing cache should force a new fetch');
    });
});
