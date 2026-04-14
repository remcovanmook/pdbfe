/**
 * @fileoverview API equivalence test suite.
 * Compares responses from the pdbfe mirror against the live PeeringDB API
 * to verify structural compatibility. Tests response shape, field presence,
 * and data consistency — not exact value equality (our snapshot may lag).
 *
 * Environment variables:
 *   PDBFE_URL          - Mirror URL (default: http://localhost:8787)
 *   PEERINGDB_API_KEY  - API key for authenticated PeeringDB requests
 *
 * Usage:
 *   PDBFE_URL=http://localhost:8787 \
 *   PEERINGDB_API_KEY=... \
 *   node --test workers/tests/test_equivalence.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const PDBFE = process.env.PDBFE_URL || 'http://localhost:8787';
const PEERINGDB = 'https://www.peeringdb.com';
const PDB_API_KEY = process.env.PEERINGDB_API_KEY || '';

/**
 * Delay for the given number of milliseconds.
 *
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetches JSON from a URL with a timeout. Includes API key for PeeringDB
 * requests and retries once on throttle (429).
 *
 * @param {string} url - Full URL to fetch.
 * @param {number} [timeoutMs=15000] - Request timeout in milliseconds.
 * @returns {Promise<{status: number, body: any, headers: Headers}>}
 */
async function fetchJSON(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        /** @type {Record<string, string>} */
        const headers = { 'Accept': 'application/json' };
        if (PDB_API_KEY && url.startsWith(PEERINGDB)) {
            headers['Authorization'] = `Api-Key ${PDB_API_KEY}`;
        }
        const res = await fetch(url, { signal: controller.signal, headers });
        const body = await res.json();

        // Retry once on throttle
        if (res.status === 429 && url.startsWith(PEERINGDB)) {
            clearTimeout(timer);
            const retryAfter = Number.parseInt(res.headers.get('retry-after') || '5', 10);
            await delay((retryAfter + 1) * 1000);
            const timer2 = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res2 = await fetch(url, { signal: controller.signal, headers });
                const body2 = await res2.json();
                return { status: res2.status, body: body2, headers: res2.headers };
            } finally {
                clearTimeout(timer2);
            }
        }
        return { status: res.status, body, headers: res.headers };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fetches the same endpoint from both pdbfe and PeeringDB sequentially,
 * with a short delay between to avoid rate-limiting.
 *
 * @param {string} path - API path (e.g. "/api/net?limit=1").
 * @returns {Promise<{mirror: any, upstream: any}>}
 */
async function fetchBoth(path) {
    const mirror = await fetchJSON(`${PDBFE}${path}`);
    await delay(300);
    const upstream = await fetchJSON(`${PEERINGDB}${path}`);
    return { mirror: mirror.body, upstream: upstream.body };
}

/**
 * Asserts that response body has a data array with at least one row.
 * Provides a clear error if the upstream returned a throttle response.
 *
 * @param {any} body - Parsed JSON response body.
 * @param {string} label - Label for error messages.
 */
function assertHasData(body, label) {
    assert.ok(body, `${label} returned empty body`);
    assert.ok(
        Array.isArray(body.data),
        `${label} data is not an array (status=${body.meta?.error || 'unknown'}, message=${body.message || 'none'})`
    );
    assert.ok(body.data.length > 0, `${label} returned empty data array`);
}

// ── Entity list endpoints ────────────────────────────────────────────────────

const ENTITIES = [
    'net', 'org', 'fac', 'ix', 'ixlan', 'ixpfx',
    'netfac', 'netixlan', 'poc', 'carrier', 'carrierfac', 'ixfac', 'campus'
];

describe('Equivalence: response envelope', { concurrency: 1 }, () => {
    for (const entity of ENTITIES) {
        it(`/api/${entity}?limit=1&depth=0 — has data array`, async () => {
            const { mirror } = await fetchBoth(`/api/${entity}?limit=1&depth=0`);
            assertHasData(mirror, `mirror /api/${entity}`);
        });
    }
});

describe('Equivalence: field sets match', { concurrency: 1 }, () => {
    for (const entity of ENTITIES) {
        it(`/api/${entity}?limit=1 — mirror has all upstream fields`, async () => {
            const { mirror, upstream } = await fetchBoth(`/api/${entity}?limit=1&depth=0`);

            assertHasData(upstream, `upstream /api/${entity}`);
            assertHasData(mirror, `mirror /api/${entity}`);

            const upstreamKeys = new Set(Object.keys(upstream.data[0]));
            const mirrorKeys = new Set(Object.keys(mirror.data[0]));

            const missing = [...upstreamKeys].filter(k => !mirrorKeys.has(k));
            assert.deepStrictEqual(
                missing, [],
                `mirror /api/${entity} missing fields: ${missing.join(', ')}`
            );
        });
    }
});

// ── Specific lookups ─────────────────────────────────────────────────────────

describe('Equivalence: specific lookups', { concurrency: 1 }, () => {
    it('/api/net?asn=13335 — Cloudflare exists', async () => {
        const { mirror, upstream } = await fetchBoth('/api/net?asn=13335&depth=0');

        assertHasData(upstream, 'upstream Cloudflare');
        assertHasData(mirror, 'mirror Cloudflare');
        assert.equal(mirror.data[0].asn, 13335);
        assert.equal(mirror.data[0].name, upstream.data[0].name);
    });

    it('/api/net/1 — detail returns single item', async () => {
        const { mirror, upstream } = await fetchBoth('/api/net/1?depth=0');

        assertHasData(upstream, 'upstream net/1');
        assertHasData(mirror, 'mirror net/1');
        assert.equal(mirror.data[0].id, 1);
        assert.equal(mirror.data[0].id, upstream.data[0].id);
    });

    it('/api/org?name__contains=Cloudflare — filter works', async () => {
        const { mirror, upstream } = await fetchBoth('/api/org?name__contains=Cloudflare&limit=20&depth=0');

        assertHasData(upstream, 'upstream org Cloudflare');
        assertHasData(mirror, 'mirror org Cloudflare');
        const upstreamNames = upstream.data.map(/** @param {any} r */ r => r.name);
        const mirrorNames = mirror.data.map(/** @param {any} r */ r => r.name);
        for (const name of upstreamNames) {
            assert.ok(mirrorNames.includes(name), `mirror missing org: ${name}`);
        }
    });

    it('/api/ix?name__contains=AMS-IX — IX search', async () => {
        const { mirror, upstream } = await fetchBoth('/api/ix?name__contains=AMS-IX&limit=20&depth=0');

        assertHasData(upstream, 'upstream AMS-IX');
        assertHasData(mirror, 'mirror AMS-IX');
    });
});

// ── Pagination ───────────────────────────────────────────────────────────────

describe('Equivalence: pagination', { concurrency: 1 }, () => {
    it('/api/net?limit=5&skip=10 — pagination returns correct count', async () => {
        const { mirror, upstream } = await fetchBoth('/api/net?limit=5&skip=10&depth=0');

        assertHasData(mirror, 'mirror pagination');
        assertHasData(upstream, 'upstream pagination');
        assert.equal(mirror.data.length, 5, 'mirror should return 5 rows');
        assert.equal(upstream.data.length, 5, 'upstream should return 5 rows');

        // IDs should be in ascending order (default sort)
        const mirrorIds = mirror.data.map(/** @param {any} r */ r => r.id);
        for (let i = 1; i < mirrorIds.length; i++) {
            assert.ok(mirrorIds[i] > mirrorIds[i - 1],
                `mirror IDs should be ascending: ${mirrorIds[i - 1]} < ${mirrorIds[i]}`);
        }
    });
});

// ── Data types ───────────────────────────────────────────────────────────────

describe('Equivalence: data types', { concurrency: 1 }, () => {
    it('/api/net?limit=1 — social_media is array', async () => {
        const { mirror } = await fetchBoth('/api/net?limit=1');
        assertHasData(mirror, 'mirror net');
        assert.ok(
            Array.isArray(mirror.data[0].social_media),
            `social_media should be array, got ${typeof mirror.data[0].social_media}`
        );
    });

    it('/api/net?limit=1 — numeric fields are numbers', async () => {
        const { mirror, upstream } = await fetchBoth('/api/net?limit=1');
        assertHasData(mirror, 'mirror net');
        assertHasData(upstream, 'upstream net');

        for (const field of ['id', 'asn', 'org_id']) {
            assert.equal(typeof mirror.data[0][field], typeof upstream.data[0][field],
                `type mismatch for ${field}: mirror=${typeof mirror.data[0][field]}, upstream=${typeof upstream.data[0][field]}`);
        }
    });

    it('/api/fac?limit=1 — lat/lon are numbers or null', async () => {
        const { mirror } = await fetchBoth('/api/fac?limit=1');
        assertHasData(mirror, 'mirror fac');

        const row = mirror.data[0];
        if (row.latitude !== null) {
            assert.equal(typeof row.latitude, 'number');
        }
        if (row.longitude !== null) {
            assert.equal(typeof row.longitude, 'number');
        }
    });
});

// ── Depth expansion ──────────────────────────────────────────────────────────

describe('Equivalence: depth expansion', { concurrency: 1 }, () => {
    it('/api/net/1?depth=1 — has relationship sets', async () => {
        const { mirror, upstream } = await fetchBoth('/api/net/1?depth=1');
        assertHasData(mirror, 'mirror net/1 depth=1');
        assertHasData(upstream, 'upstream net/1 depth=1');

        for (const field of ['netfac_set', 'netixlan_set', 'poc_set']) {
            assert.ok(Array.isArray(upstream.data[0][field]), `upstream should have ${field}`);
            assert.ok(Array.isArray(mirror.data[0][field]), `mirror should have ${field}`);
        }
    });

    it('/api/ix/1?depth=1 — has ixlan_set', async () => {
        const { mirror, upstream } = await fetchBoth('/api/ix/1?depth=1');
        assertHasData(mirror, 'mirror ix/1 depth=1');
        assertHasData(upstream, 'upstream ix/1 depth=1');

        assert.ok(Array.isArray(upstream.data[0].ixlan_set));
        assert.ok(Array.isArray(mirror.data[0].ixlan_set));
    });
});

// ── Write method rejection ───────────────────────────────────────────────────

describe('Equivalence: write endpoints', { concurrency: 1 }, () => {
    it('POST /api/net — mirror returns 501', async () => {
        const res = await fetch(`${PDBFE}/api/net`, { method: 'POST' });
        assert.equal(res.status, 501);
    });

    it('PUT /api/net/1 — mirror returns 501', async () => {
        const res = await fetch(`${PDBFE}/api/net/1`, { method: 'PUT' });
        assert.equal(res.status, 501);
    });

    it('DELETE /api/net/1 — mirror returns 501', async () => {
        const res = await fetch(`${PDBFE}/api/net/1`, { method: 'DELETE' });
        assert.equal(res.status, 501);
    });
});

// ── CORS ─────────────────────────────────────────────────────────────────────

describe('Equivalence: CORS', { concurrency: 1 }, () => {
    it('OPTIONS /api/net — returns CORS headers', async () => {
        const res = await fetch(`${PDBFE}/api/net`, { method: 'OPTIONS' });
        assert.equal(res.status, 204);
        assert.ok(res.headers.get('access-control-allow-origin'));
        assert.ok(res.headers.get('access-control-allow-methods'));
    });
});
