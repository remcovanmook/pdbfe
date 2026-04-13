/**
 * @fileoverview Unit tests for core/http.js.
 *
 * Tests ETag generation, 304 Not Modified handling, jsonError construction,
 * Last-Modified / If-Modified-Since utilities, frozen CORS header sets,
 * and the TextEncoder singleton.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    encoder,
    encodeJSON,
    generateETag,
    isNotModified,
    jsonError,
    handlePreflight,
    lastModifiedHeader,
    isNotModifiedSince,
    H_CORS,
    H_NOCACHE,
} from '../../../core/http.js';

// ── encoder ──────────────────────────────────────────────────────────────────

describe('encoder', () => {
    it('is a TextEncoder instance', () => {
        assert.ok(encoder instanceof TextEncoder);
    });

    it('encodes strings to Uint8Array', () => {
        const buf = encoder.encode('hello');
        assert.ok(buf instanceof Uint8Array);
        assert.equal(buf.byteLength, 5);
    });
});

// ── encodeJSON ───────────────────────────────────────────────────────────────

describe('encodeJSON', () => {
    it('encodes an object to a Uint8Array JSON payload', () => {
        const buf = encodeJSON({ data: [], meta: {} });
        const decoded = new TextDecoder().decode(buf);
        assert.deepEqual(JSON.parse(decoded), { data: [], meta: {} });
    });

    it('produces valid JSON that round-trips', () => {
        const original = { nested: [1, 'two', true] };
        const buf = encodeJSON(original);
        const decoded = JSON.parse(new TextDecoder().decode(buf));
        assert.deepEqual(decoded, original);
    });
});

// ── generateETag ─────────────────────────────────────────────────────────────

describe('generateETag', () => {
    it('returns a quoted W/ etag string', () => {
        const buf = encoder.encode('{"data":[],"meta":{}}');
        const etag = generateETag(buf);
        assert.ok(etag.startsWith('W/"'));
        assert.ok(etag.endsWith('"'));
    });

    it('returns the same hash for the same input', () => {
        const buf = encoder.encode('hello world');
        assert.equal(generateETag(buf), generateETag(buf));
    });

    it('returns different hashes for different input', () => {
        const a = generateETag(encoder.encode('aaa'));
        const b = generateETag(encoder.encode('bbb'));
        assert.notEqual(a, b);
    });
});

// ── isNotModified ────────────────────────────────────────────────────────────

describe('isNotModified', () => {
    it('returns true when If-None-Match equals the etag', () => {
        const headers = new Headers({ 'If-None-Match': 'W/"abc123"' });
        assert.equal(isNotModified(headers, 'W/"abc123"'), true);
    });

    it('returns false when etags differ', () => {
        const headers = new Headers({ 'If-None-Match': 'W/"abc123"' });
        assert.equal(isNotModified(headers, 'W/"different"'), false);
    });

    it('returns false when no If-None-Match header', () => {
        const headers = new Headers();
        assert.equal(isNotModified(headers, 'W/"abc123"'), false);
    });
});

// ── jsonError ────────────────────────────────────────────────────────────────

describe('jsonError', () => {
    it('returns a Response with the given status code', async () => {
        const resp = jsonError(400, 'bad request');
        assert.equal(resp.status, 400);
    });

    it('body contains error message in JSON', async () => {
        const resp = jsonError(404, 'not found');
        const body = await resp.text();
        const parsed = JSON.parse(body);
        assert.equal(parsed.error, 'not found');
    });

    it('sets Content-Type to application/json', () => {
        const resp = jsonError(500, 'internal');
        assert.ok(resp.headers.get('Content-Type').includes('application/json'));
    });

    it('accepts custom base headers', () => {
        const customHeaders = { 'X-Custom': 'test' };
        const resp = jsonError(400, 'msg', customHeaders);
        assert.equal(resp.headers.get('X-Custom'), 'test');
    });
});

// ── handlePreflight ──────────────────────────────────────────────────────────

describe('handlePreflight', () => {
    it('returns a 204 No Content response', () => {
        const resp = handlePreflight();
        assert.equal(resp.status, 204);
    });

    it('includes CORS headers', () => {
        const resp = handlePreflight();
        assert.ok(resp.headers.get('Access-Control-Allow-Origin'));
        assert.ok(resp.headers.get('Access-Control-Allow-Methods'));
    });
});

// ── lastModifiedHeader ───────────────────────────────────────────────────────

describe('lastModifiedHeader', () => {
    it('returns an RFC 7231 date string', () => {
        // 2024-01-01T00:00:00Z
        const epoch = Date.UTC(2024, 0, 1);
        const header = lastModifiedHeader(epoch);
        assert.ok(header.includes('Mon, 01 Jan 2024'));
        assert.ok(header.endsWith('GMT'));
    });
});

// ── isNotModifiedSince ───────────────────────────────────────────────────────

describe('isNotModifiedSince', () => {
    const epoch = Date.UTC(2024, 0, 15, 12, 0, 0);

    it('returns true when If-Modified-Since is at or after epochMs', () => {
        const headers = new Headers({
            'If-Modified-Since': new Date(epoch).toUTCString()
        });
        assert.equal(isNotModifiedSince(headers, epoch), true);
    });

    it('returns true when If-Modified-Since is after epochMs', () => {
        const headers = new Headers({
            'If-Modified-Since': new Date(epoch + 60000).toUTCString()
        });
        assert.equal(isNotModifiedSince(headers, epoch), true);
    });

    it('returns false when If-Modified-Since is before epochMs', () => {
        const headers = new Headers({
            'If-Modified-Since': new Date(epoch - 60000).toUTCString()
        });
        assert.equal(isNotModifiedSince(headers, epoch), false);
    });

    it('returns false when header is missing', () => {
        const headers = new Headers();
        assert.equal(isNotModifiedSince(headers, epoch), false);
    });
});

// ── Frozen header sets ───────────────────────────────────────────────────────

describe('H_CORS', () => {
    it('includes Access-Control-Allow-Origin', () => {
        assert.ok('Access-Control-Allow-Origin' in H_CORS);
    });

    it('is frozen', () => {
        assert.ok(Object.isFrozen(H_CORS));
    });
});

describe('H_NOCACHE', () => {
    it('includes Cache-Control: no-store', () => {
        assert.equal(H_NOCACHE['Cache-Control'], 'no-store');
    });

    it('is frozen', () => {
        assert.ok(Object.isFrozen(H_NOCACHE));
    });
});
