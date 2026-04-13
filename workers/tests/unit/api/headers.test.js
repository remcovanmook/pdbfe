/**
 * @fileoverview Unit tests for HTTP response header helpers.
 *
 * Tests the Last-Modified / If-Modified-Since helpers added to core/http.js,
 * verifies H_API contains the expected static headers (Allow, X-App-Version),
 * and checks that Access-Control-Expose-Headers includes all custom headers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    H_CORS,
    H_NOCACHE,
    lastModifiedHeader,
    isNotModifiedSince,
} from '../../../core/http.js';

import {
    H_API,
    H_API_AUTH,
    H_API_ANON,
    H_NOCACHE_AUTH,
    H_NOCACHE_ANON,
} from '../../../api/http.js';

// ── lastModifiedHeader ──────────────────────────────────────────────────────

describe('lastModifiedHeader', () => {
    it('converts epoch-ms to HTTP-date format', () => {
        // 2026-01-15T12:30:00Z = 1768569000000 ms
        const epochMs = Date.UTC(2026, 0, 15, 12, 30, 0);
        const result = lastModifiedHeader(epochMs);
        assert.equal(result, 'Thu, 15 Jan 2026 12:30:00 GMT');
    });

    it('handles epoch zero', () => {
        const result = lastModifiedHeader(0);
        assert.equal(result, 'Thu, 01 Jan 1970 00:00:00 GMT');
    });

    it('produces a string parseable by Date.parse', () => {
        const epochMs = Date.UTC(2026, 3, 10, 8, 15, 30);
        const httpDate = lastModifiedHeader(epochMs);
        const parsed = Date.parse(httpDate);
        // Round-trip: parsed should match original truncated to seconds
        assert.equal(parsed, Math.floor(epochMs / 1000) * 1000);
    });
});

// ── isNotModifiedSince ──────────────────────────────────────────────────────

describe('isNotModifiedSince', () => {
    it('returns false when no If-Modified-Since header is present', () => {
        const headers = new Headers();
        assert.equal(isNotModifiedSince(headers, Date.now()), false);
    });

    it('returns false for an unparseable date', () => {
        const headers = new Headers({ 'If-Modified-Since': 'not-a-date' });
        assert.equal(isNotModifiedSince(headers, Date.now()), false);
    });

    it('returns true when IMS is equal to last-modified (same second)', () => {
        const epochMs = Date.UTC(2026, 3, 10, 12, 0, 0);
        const httpDate = new Date(epochMs).toUTCString();
        const headers = new Headers({ 'If-Modified-Since': httpDate });
        assert.equal(isNotModifiedSince(headers, epochMs), true);
    });

    it('returns true when IMS is after last-modified', () => {
        const epochMs = Date.UTC(2026, 3, 10, 12, 0, 0);
        const later = new Date(epochMs + 60_000).toUTCString();
        const headers = new Headers({ 'If-Modified-Since': later });
        assert.equal(isNotModifiedSince(headers, epochMs), true);
    });

    it('returns false when IMS is before last-modified', () => {
        const epochMs = Date.UTC(2026, 3, 10, 12, 0, 0);
        const earlier = new Date(epochMs - 60_000).toUTCString();
        const headers = new Headers({ 'If-Modified-Since': earlier });
        assert.equal(isNotModifiedSince(headers, epochMs), false);
    });

    it('truncates sub-second precision from epochMs', () => {
        // epochMs has sub-second component, IMS is the same second
        const epochMs = Date.UTC(2026, 3, 10, 12, 0, 0) + 500;
        const sameSecond = new Date(Date.UTC(2026, 3, 10, 12, 0, 0)).toUTCString();
        const headers = new Headers({ 'If-Modified-Since': sameSecond });
        assert.equal(isNotModifiedSince(headers, epochMs), true);
    });
});

// ── H_API static headers ───────────────────────────────────────────────────

describe('H_API static headers', () => {
    it('includes Allow header with GET, HEAD, OPTIONS', () => {
        assert.equal(H_API['Allow'], 'GET, HEAD, OPTIONS');
    });

    it('includes X-App-Version header', () => {
        const version = H_API['X-App-Version'];
        assert.ok(version, 'X-App-Version should be present');
        assert.match(version, /^\d+\.\d+\.\d+$/,
            'X-App-Version should be a semver string like "2.77.1"');
    });

    it('includes Content-Type', () => {
        assert.equal(H_API['Content-Type'], 'application/json; charset=utf-8');
    });

    it('includes Cache-Control', () => {
        assert.ok(H_API['Cache-Control']);
    });
});

// ── Access-Control-Expose-Headers ───────────────────────────────────────────

describe('Access-Control-Expose-Headers', () => {
    const exposed = H_CORS['Access-Control-Expose-Headers'];
    const exposedSet = new Set(exposed.split(', ').map(s => s.trim()));

    for (const header of [
        'X-Cache', 'X-Cache-Hits', 'X-Timer', 'X-Served-By',
        'X-Isolate-ID', 'ETag', 'Allow', 'X-Auth-Status',
        'X-App-Version', 'Last-Modified'
    ]) {
        it(`exposes ${header}`, () => {
            assert.ok(exposedSet.has(header),
                `${header} should be in Access-Control-Expose-Headers`);
        });
    }
});

// ── H_NOCACHE ───────────────────────────────────────────────────────────────

describe('H_NOCACHE', () => {
    it('inherits CORS headers', () => {
        assert.ok(H_NOCACHE['Access-Control-Allow-Origin']);
    });

    it('sets Cache-Control to no-store', () => {
        assert.equal(H_NOCACHE['Cache-Control'], 'no-store');
    });
});

// ── Pre-cooked auth header sets ─────────────────────────────────────────────

describe('pre-cooked auth header sets', () => {
    it('H_API_AUTH has X-Auth-Status: authenticated', () => {
        assert.equal(H_API_AUTH['X-Auth-Status'], 'authenticated');
    });

    it('H_API_ANON has X-Auth-Status: unauthenticated', () => {
        assert.equal(H_API_ANON['X-Auth-Status'], 'unauthenticated');
    });

    it('H_NOCACHE_AUTH has X-Auth-Status: authenticated', () => {
        assert.equal(H_NOCACHE_AUTH['X-Auth-Status'], 'authenticated');
    });

    it('H_NOCACHE_ANON has X-Auth-Status: unauthenticated', () => {
        assert.equal(H_NOCACHE_ANON['X-Auth-Status'], 'unauthenticated');
    });

    it('H_API_AUTH inherits Allow from H_API', () => {
        assert.equal(H_API_AUTH['Allow'], H_API['Allow']);
    });

    it('H_API_ANON inherits X-App-Version from H_API', () => {
        assert.equal(H_API_ANON['X-App-Version'], H_API['X-App-Version']);
    });

    it('H_NOCACHE_AUTH has no-store Cache-Control', () => {
        assert.equal(H_NOCACHE_AUTH['Cache-Control'], 'no-store');
    });

    it('all sets are frozen', () => {
        assert.ok(Object.isFrozen(H_API_AUTH));
        assert.ok(Object.isFrozen(H_API_ANON));
        assert.ok(Object.isFrozen(H_NOCACHE_AUTH));
        assert.ok(Object.isFrozen(H_NOCACHE_ANON));
    });
});
