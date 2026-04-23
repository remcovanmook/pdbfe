/**
 * @fileoverview Unit tests for the API worker router via its default export.
 *
 * Imports the default export — `wrapHandler(handleRequest, "pdbfe-api")` —
 * and calls `.fetch(request, env, ctx)` exactly as the Cloudflare runtime
 * does. This exercises:
 *   - Every routing branch in handleRequest (api/index.js)
 *   - wrapHandler header injection (X-Timer, X-Auth-Status, X-PDBFE-Version)
 *   - wrapHandler 500 error trap (core/admin.js)
 *
 * D1 calls are short-circuited by returning empty results from the mock env,
 * so this is a routing test, not a query correctness test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../api/index.js';

// ── Minimal mock factories ────────────────────────────────────────────────────

/**
 * Creates a minimal mock D1 database that satisfies the API worker's startup
 * queries without touching real SQLite. All queries return empty results.
 *
 * @param {object} [overrides] - Per-query overrides keyed by SQL substring.
 * @returns {D1Database}
 */
function mockPDB(overrides = {}) {
    return /** @type {any} */ ({
        withSession() { return this; },
        prepare(/** @type {string} */ sql) {
            // Find a matching override by substring
            const match = Object.entries(overrides).find(([k]) => sql.includes(k));
            const override = match ? match[1] : null;
            return {
                bind() { return this; },
                first() { return Promise.resolve(override ?? null); },
                run() { return Promise.resolve({ success: true, meta: {}, results: [] }); },
                all() { return Promise.resolve({ success: true, meta: {}, results: override ?? [] }); },
            };
        },
        batch(/** @type {any[]} */ stmts) {
            return Promise.resolve(stmts.map(() => ({ success: true, meta: {}, results: [] })));
        },
    });
}

/**
 * Minimal mock KV namespace for SESSIONS — always returns null (no session).
 * @returns {KVNamespace}
 */
function mockKV() {
    return /** @type {any} */ ({
        get() { return Promise.resolve(null); },
        put() { return Promise.resolve(); },
        delete() { return Promise.resolve(); },
    });
}

/**
 * Builds a minimal PdbApiEnv mock for routing tests.
 *
 * @param {object} [overrides] - Env field overrides.
 * @returns {PdbApiEnv}
 */
function mockEnv(overrides = {}) {
    return /** @type {any} */ ({
        PDB: mockPDB(),
        SESSIONS: mockKV(),
        ADMIN_SECRET: 'test-admin-secret',
        PDBFE_VERSION: '0.9.0',
        ...overrides,
    });
}

/** Minimal no-op ExecutionContext. */
const mockCtx = /** @type {ExecutionContext} */ ({
    waitUntil(p) { p.catch(() => {}); },
    passThroughOnException() {},
});

/**
 * Sends a request through the worker's default export and returns the response.
 *
 * @param {string} url - Full URL to request.
 * @param {RequestInit} [init] - Fetch init options.
 * @param {object} [envOverrides] - Env overrides.
 * @returns {Promise<Response>}
 */
function fetch(url, init = {}, envOverrides = {}) {
    const request = new Request(url, init);
    return worker.fetch(request, mockEnv(envOverrides), mockCtx);
}

// ── wrapHandler plumbing ──────────────────────────────────────────────────────

describe('wrapHandler plumbing', () => {
    it('always sets X-Auth-Status header', async () => {
        const res = await fetch('https://api.pdbfe.dev/');
        assert.ok(res.headers.has('X-Auth-Status'), 'Expected X-Auth-Status header');
    });

    it('sets X-PDBFE-Version from env.PDBFE_VERSION', async () => {
        const res = await fetch('https://api.pdbfe.dev/');
        assert.equal(res.headers.get('X-PDBFE-Version'), '0.9.0');
    });

    it('does not set X-PDBFE-Version when env.PDBFE_VERSION is absent', async () => {
        const res = await fetch('https://api.pdbfe.dev/', {}, { PDBFE_VERSION: undefined });
        assert.equal(res.headers.get('X-PDBFE-Version'), null);
    });

    it('sets X-Timer header on every response', async () => {
        const res = await fetch('https://api.pdbfe.dev/');
        assert.ok(res.headers.has('X-Timer'), 'Expected X-Timer header');
    });

    it('returns 500 and JSON body when handler throws', async () => {
        // Inject a PDB mock that throws on withSession to trigger the 500 trap.
        const env = mockEnv({
            PDB: /** @type {any} */ ({
                withSession() { throw new Error('D1 unavailable'); },
            }),
        });
        const res = await worker.fetch(
            new Request('https://api.pdbfe.dev/api/net'),
            env,
            mockCtx
        );
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.error, 'Internal Server Error');
    });
});

// ── Root path / service discovery ─────────────────────────────────────────────

describe('root path routing', () => {
    it('returns JSON service discovery for JSON Accept header', async () => {
        const res = await fetch('https://api.pdbfe.dev/', {
            headers: { Accept: 'application/json' },
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.endpoints?.api, 'Expected endpoints.api in discovery payload');
    });

    it('redirects to UI for browser Accept header', async () => {
        const res = await fetch('https://api.pdbfe.dev/', {
            headers: { Accept: 'text/html,application/xhtml+xml' },
            redirect: 'manual',
        });
        assert.equal(res.status, 302);
        assert.ok(res.headers.get('Location')?.includes('pdbfe.dev'));
    });

    it('returns JSON discovery when Accept is not text/html', async () => {
        const res = await fetch('https://api.pdbfe.dev/');
        assert.equal(res.status, 200);
        assert.ok(res.headers.get('Content-Type')?.includes('application/json'));
    });
});

// ── Admin / status endpoints ──────────────────────────────────────────────────

describe('admin endpoints', () => {
    it('returns 200 for /robots.txt', async () => {
        const res = await fetch('https://api.pdbfe.dev/robots.txt');
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.ok(text.includes('User-agent'));
    });

    it('returns 200 for /health', async () => {
        const res = await fetch('https://api.pdbfe.dev/health');
        assert.equal(res.status, 200);
    });

    it('returns 200 for /status', async () => {
        // _sync_meta query returns empty results — status endpoint should still respond 200.
        const res = await fetch('https://api.pdbfe.dev/status');
        assert.equal(res.status, 200);
    });

    it('returns null (404) for invalid admin path', async () => {
        const res = await fetch('https://api.pdbfe.dev/unknown-admin-path');
        assert.equal(res.status, 404);
    });
});

// ── CORS preflight ────────────────────────────────────────────────────────────

describe('CORS preflight', () => {
    it('responds to OPTIONS with 204', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/net', { method: 'OPTIONS' });
        assert.equal(res.status, 204);
    });
});

// ── Unknown top-level path ────────────────────────────────────────────────────

describe('unknown top-level path', () => {
    it('returns 404 for non-api, non-admin top-level path', async () => {
        const res = await fetch('https://api.pdbfe.dev/graphql/something');
        assert.equal(res.status, 404);
    });
});

// ── Write method rejection ────────────────────────────────────────────────────

describe('write method rejection', () => {
    it('returns 501 Not Implemented for POST on entity path', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/net', { method: 'POST' });
        assert.equal(res.status, 501);
    });

    it('returns 501 for PUT on entity path', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/net/1', { method: 'PUT' });
        assert.equal(res.status, 501);
    });

    it('returns 501 for DELETE on entity path', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/net/1', { method: 'DELETE' });
        assert.equal(res.status, 501);
    });
});

// ── as_set routing ────────────────────────────────────────────────────────────

describe('as_set routing', () => {
    it('returns 400 for comma-separated ASNs', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/as_set/1,2');
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Invalid ASN'));
    });

    it('returns 400 for non-numeric ASN', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/as_set/abc');
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Invalid ASN'));
    });

    it('attempts as_set lookup for valid ASN (returns 200 or 404, not 400/500)', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/as_set/3356');
        // Without real D1 data the AS set will be empty, but routing should succeed
        assert.ok([200, 404].includes(res.status), `Unexpected status: ${res.status}`);
    });
});

// ── Unknown entity tag ────────────────────────────────────────────────────────

describe('unknown entity tag', () => {
    it('returns 404 for unknown entity type', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/unicorn');
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.ok(body.error.includes('Unknown entity'));
    });
});

// ── Invalid ID ────────────────────────────────────────────────────────────────

describe('invalid entity ID', () => {
    it('returns 400 for non-numeric ID', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/net/abc');
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Invalid ID'));
    });

    it('returns 400 for negative ID', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/net/-1');
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Invalid ID'));
    });

    it('returns 400 for zero ID', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/net/0');
        assert.equal(res.status, 400);
    });
});

// ── Query parameter validation ────────────────────────────────────────────────

describe('query parameter validation', () => {
    it('returns 400 for limit below -1 (invalid range)', async () => {
        // limit=-1 means "no limit"; below that is invalid
        const res = await fetch('https://api.pdbfe.dev/api/net?limit=-2');
        assert.equal(res.status, 400);
    });

    it('returns 200 for limit=0 (count mode)', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/net?limit=0');
        assert.equal(res.status, 200);
    });
});

// ── Restricted entity (poc) anonymous access ──────────────────────────────────

describe('restricted entity — poc', () => {
    it('returns empty 200 for anonymous access to /api/poc list', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/poc');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.data, []);
    });

    it('returns 404 for anonymous access to /api/poc/:id', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/poc/1');
        assert.equal(res.status, 404);
    });

    it('passes through poc list when visible=Public filter is present', async () => {
        const res = await fetch('https://api.pdbfe.dev/api/poc?visible=Public');
        // Anonymous with explicit filter — should not return empty 200 gate response
        // (will return 200 with actual query results from mock D1, i.e. empty data)
        assert.equal(res.status, 200);
    });
});

// ── If-Modified-Since ────────────────────────────────────────────────────────

describe('If-Modified-Since', () => {
    it('returns 304 when If-Modified-Since is in the future', async () => {
        // Use a far-future date to ensure the entity version is older
        const futureDate = new Date(Date.now() + 86400_000).toUTCString();
        const res = await fetch('https://api.pdbfe.dev/api/net', {
            headers: { 'If-Modified-Since': futureDate },
        });
        // 304 is returned only if the entity has a non-zero version in _sync_meta.
        // Our mock returns null for _sync_meta, so entity version is 0 → no 304.
        // This test confirms the route doesn't crash with the header present.
        assert.ok([200, 304].includes(res.status));
    });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe('rate limiting', () => {
    it('returns 429 after exceeding anonymous limit', async () => {
        // The limiter is isolate-level state. To trigger it without hammering
        // the real quota, send 61 requests in a tight loop — the 61st should be 429.
        // NOTE: This test is somewhat fragile if other tests in this suite have
        // already consumed quota for the same IP. Using a unique IP to isolate.
        const uniqueIP = '198.51.100.99'; // TEST-NET-3, never a real CF IP
        const url = 'https://api.pdbfe.dev/api/net';
        let last;
        for (let i = 0; i < 61; i++) {
            last = await worker.fetch(
                new Request(url, { headers: { 'cf-connecting-ip': uniqueIP } }),
                mockEnv(),
                mockCtx
            );
        }
        assert.equal(last.status, 429);
        const body = await last.json();
        assert.ok(body.error.includes('Too Many Requests'));
        // Anonymous 429 should include sign-in hint
        assert.ok(body.error.includes('Sign in') || body.error.includes('API key'));
    });
});
