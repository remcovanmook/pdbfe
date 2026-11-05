/**
 * @fileoverview Unit tests for api/http.js.
 *
 * Tests API-specific response helpers: serveJSON (no ETag, Content-Type),
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
    NO_TRANSFORM_MAX_BYTES,
    encoder,
} from '../../../api/http.js';

// ── serveJSON ────────────────────────────────────────────────────────────────

describe('serveJSON', () => {
    const buf = encoder.encode('{"data":[],"meta":{}}');

    it('returns a 200 response with JSON Content-Type', () => {
        const resp = serveJSON(buf);
        assert.equal(resp.status, 200);
        assert.ok(resp.headers.get('Content-Type').includes('application/json'));
    });

    it('sends no ETag and ignores If-None-Match', () => {
        const resp = serveJSON(buf);
        assert.equal(resp.status, 200);
        assert.equal(resp.headers.get('ETag'), null);
    });

    it('private responses expire at the next sync too', () => {
        assert.match(serveJSON(buf, undefined, H_API_AUTH).headers.get('Cache-Control'), /^private, max-age=\d+, stale-while-revalidate=\d+, no-transform$/);
    });

    it('marks bodies below the first-flight threshold no-transform', () => {
        assert.match(serveJSON(buf).headers.get('Cache-Control'), /^public, .*, no-transform$/);
        assert.match(serveJSON(buf, undefined, H_API_AUTH).headers.get('Cache-Control'), /^private, .*, no-transform$/);
    });

    it('leaves larger bodies compressible', () => {
        const big = new Uint8Array(NO_TRANSFORM_MAX_BYTES);
        assert.doesNotMatch(serveJSON(big).headers.get('Cache-Control'), /no-transform/);
    });

    it('includes X-Cache header from meta', () => {
        const resp = serveJSON(buf, { tier: 'L1', hits: 5 });
        assert.equal(resp.headers.get('X-Cache'), 'L1');
    });

    it('includes X-Cache-Hits header from meta', () => {
        const resp = serveJSON(buf, { tier: 'MISS', hits: 0 });
        assert.equal(resp.headers.get('X-Cache-Hits'), '0');
    });

    it('accepts custom base headers', () => {
        const resp = serveJSON(buf, { tier: 'MISS', hits: 0 }, H_API_AUTH);
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
