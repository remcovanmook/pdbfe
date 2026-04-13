/**
 * @fileoverview Unit tests for api/http.js.
 *
 * Tests API-specific response helpers: serveJSON (ETag, 304, Content-Type),
 * withLastModified (header injection, no-op for falsy epoch), and the
 * frozen header set composition (H_API, H_API_AUTH, H_API_ANON).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    serveJSON,
    withLastModified,
    H_API,
    H_API_AUTH,
    H_API_ANON,
    H_NOCACHE_AUTH,
    H_NOCACHE_ANON,
    encoder,
} from '../../../api/http.js';

// ── serveJSON ────────────────────────────────────────────────────────────────

describe('serveJSON', () => {
    const buf = encoder.encode('{"data":[],"meta":{}}');

    it('returns a 200 response with JSON Content-Type', () => {
        const req = new Request('https://example.com/api/net');
        const resp = serveJSON(req, buf);
        assert.equal(resp.status, 200);
        assert.ok(resp.headers.get('Content-Type').includes('application/json'));
    });

    it('includes an ETag header', () => {
        const req = new Request('https://example.com/api/net');
        const resp = serveJSON(req, buf);
        assert.ok(resp.headers.get('ETag'));
    });

    it('returns 304 when If-None-Match matches ETag', () => {
        const req1 = new Request('https://example.com/api/net');
        const resp1 = serveJSON(req1, buf);
        const etag = resp1.headers.get('ETag');

        const req2 = new Request('https://example.com/api/net', {
            headers: { 'If-None-Match': etag },
        });
        const resp2 = serveJSON(req2, buf);
        assert.equal(resp2.status, 304);
    });

    it('includes X-Cache header from meta', () => {
        const req = new Request('https://example.com/api/net');
        const resp = serveJSON(req, buf, { tier: 'L1', hits: 5 });
        assert.equal(resp.headers.get('X-Cache'), 'L1');
    });

    it('includes X-Cache-Hits header from meta', () => {
        const req = new Request('https://example.com/api/net');
        const resp = serveJSON(req, buf, { tier: 'MISS', hits: 0 });
        assert.equal(resp.headers.get('X-Cache-Hits'), '0');
    });

    it('accepts custom base headers', () => {
        const req = new Request('https://example.com/api/net');
        const resp = serveJSON(req, buf, { tier: 'MISS', hits: 0 }, H_API_AUTH);
        assert.equal(resp.headers.get('X-Auth-Status'), 'authenticated');
    });
});

// ── withLastModified ─────────────────────────────────────────────────────────

describe('withLastModified', () => {
    it('adds Last-Modified header when epochMs is truthy', () => {
        const original = new Response('body', { status: 200 });
        const result = withLastModified(original, Date.UTC(2024, 0, 1));
        assert.ok(result.headers.get('Last-Modified'));
        assert.ok(result.headers.get('Last-Modified').includes('2024'));
    });

    it('returns the original response unchanged when epochMs is 0', () => {
        const original = new Response('body', { status: 200 });
        const result = withLastModified(original, 0);
        assert.equal(result, original);
    });

    it('returns the original response unchanged when epochMs is undefined', () => {
        const original = new Response('body', { status: 200 });
        const result = withLastModified(original, undefined);
        assert.equal(result, original);
    });

    it('preserves original status and headers', () => {
        const original = new Response('body', {
            status: 201,
            headers: { 'X-Custom': 'value' },
        });
        const result = withLastModified(original, Date.now());
        assert.equal(result.status, 201);
        assert.equal(result.headers.get('X-Custom'), 'value');
    });
});

// ── Frozen header sets ───────────────────────────────────────────────────────

describe('H_API header sets', () => {
    it('H_API is frozen', () => {
        assert.ok(Object.isFrozen(H_API));
    });

    it('H_API includes CORS and Content-Type', () => {
        assert.ok('Access-Control-Allow-Origin' in H_API);
        assert.ok('Content-Type' in H_API);
    });

    it('H_API includes Allow and X-App-Version', () => {
        assert.ok('Allow' in H_API);
        assert.ok('X-App-Version' in H_API);
    });

    it('H_API_AUTH has X-Auth-Status authenticated', () => {
        assert.equal(H_API_AUTH['X-Auth-Status'], 'authenticated');
    });

    it('H_API_ANON has X-Auth-Status unauthenticated', () => {
        assert.equal(H_API_ANON['X-Auth-Status'], 'unauthenticated');
    });

    it('H_NOCACHE_AUTH has Cache-Control no-store', () => {
        assert.equal(H_NOCACHE_AUTH['Cache-Control'], 'no-store');
        assert.equal(H_NOCACHE_AUTH['X-Auth-Status'], 'authenticated');
    });

    it('H_NOCACHE_ANON has Cache-Control no-store', () => {
        assert.equal(H_NOCACHE_ANON['Cache-Control'], 'no-store');
        assert.equal(H_NOCACHE_ANON['X-Auth-Status'], 'unauthenticated');
    });
});
