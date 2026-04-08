/**
 * @fileoverview Unit tests for the core/auth.js module.
 *
 * Tests session ID extraction (Bearer header, cookie), session
 * resolution (KV lookup), session lifecycle (write, delete), and
 * session ID generation. Also tests the existing API-Key extraction.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractApiKey,
    verifyApiKey,
    extractSessionId,
    resolveSession,
    generateSessionId,
    writeSession,
    deleteSession,
} from '../../core/auth.js';

// ── Mock KV namespace ────────────────────────────────────────────────────────

/**
 * Creates a mock KVNamespace backed by an object store.
 * Tracks get/put/delete calls for assertion.
 *
 * @param {Record<string, any>} store - Initial key-value store contents.
 * @returns {{kv: KVNamespace, calls: {get: string[], put: Array<{key: string, value: string, opts: any}>, delete: string[]}}}
 */
function mockKV(store = {}) {
    /** @type {{get: string[], put: Array<{key: string, value: string, opts: any}>, delete: string[]}} */
    const calls = { get: [], put: [], delete: [] };

    const kv = /** @type {any} */ ({
        get: async (/** @type {string} */ key, /** @type {any} */ opts) => {
            calls.get.push(key);
            const value = store[key];
            if (value === undefined) return null;
            if (opts?.type === 'json') {
                return typeof value === 'string' ? JSON.parse(value) : value;
            }
            return value;
        },
        put: async (/** @type {string} */ key, /** @type {string} */ value, /** @type {any} */ opts) => {
            calls.put.push({ key, value, opts });
            store[key] = value;
        },
        delete: async (/** @type {string} */ key) => {
            calls.delete.push(key);
            delete store[key];
        },
    });

    return { kv, calls };
}

/**
 * Creates a mock Request with the given headers.
 *
 * @param {Record<string, string>} headers - Request headers.
 * @returns {Request}
 */
function mockRequest(headers = {}) {
    return new Request('https://api.example.com/api/net', { headers });
}

// ── extractApiKey ────────────────────────────────────────────────────────────

describe('extractApiKey', () => {
    it('extracts key from Api-Key header', () => {
        const req = mockRequest({ 'Authorization': 'Api-Key test.key123' });
        assert.equal(extractApiKey(req), 'test.key123');
    });

    it('is case-insensitive for the prefix', () => {
        const req = mockRequest({ 'Authorization': 'api-key TEST.KEY' });
        assert.equal(extractApiKey(req), 'TEST.KEY');
    });

    it('returns null for missing Authorization header', () => {
        const req = mockRequest({});
        assert.equal(extractApiKey(req), null);
    });

    it('returns null for Bearer token header', () => {
        const req = mockRequest({ 'Authorization': 'Bearer some-session-id' });
        assert.equal(extractApiKey(req), null);
    });

    it('returns null for empty key after prefix', () => {
        const req = mockRequest({ 'Authorization': 'Api-Key   ' });
        assert.equal(extractApiKey(req), null);
    });
});

// ── verifyApiKey ─────────────────────────────────────────────────────────────

describe('verifyApiKey', () => {
    it('returns false when key is not in KV', async () => {
        const { kv } = mockKV({});
        assert.equal(await verifyApiKey(kv, 'any-key'), false);
    });

    it('returns true when key exists in KV', async () => {
        const testKey = 'pdbfe.test1234';
        const { hashKey } = await import('../../core/account.js');
        const hashed = await hashKey(testKey);
        const { kv } = mockKV({ [`apikey:${hashed}`]: '{}' });
        assert.equal(await verifyApiKey(kv, testKey), true);
    });

    it('returns false for null', async () => {
        const { kv } = mockKV({});
        assert.equal(await verifyApiKey(kv, null), false);
    });
});

// ── extractSessionId ─────────────────────────────────────────────────────────

describe('extractSessionId', () => {
    it('extracts session ID from Bearer token header', () => {
        const req = mockRequest({ 'Authorization': 'Bearer abc123def456' });
        assert.equal(extractSessionId(req), 'abc123def456');
    });

    it('is case-insensitive for Bearer prefix', () => {
        const req = mockRequest({ 'Authorization': 'bearer ABC123' });
        assert.equal(extractSessionId(req), 'ABC123');
    });

    it('extracts session ID from pdbfe_sid cookie', () => {
        const req = mockRequest({ 'Cookie': 'other=x; pdbfe_sid=session_token_here; another=y' });
        assert.equal(extractSessionId(req), 'session_token_here');
    });

    it('extracts session ID from pdbfe_sid cookie at start', () => {
        const req = mockRequest({ 'Cookie': 'pdbfe_sid=first_cookie' });
        assert.equal(extractSessionId(req), 'first_cookie');
    });

    it('prefers Bearer token over cookie', () => {
        const req = mockRequest({
            'Authorization': 'Bearer from_header',
            'Cookie': 'pdbfe_sid=from_cookie',
        });
        assert.equal(extractSessionId(req), 'from_header');
    });

    it('returns null when no auth header or cookie', () => {
        const req = mockRequest({});
        assert.equal(extractSessionId(req), null);
    });

    it('returns null for Api-Key header (not a session)', () => {
        const req = mockRequest({ 'Authorization': 'Api-Key some.key' });
        assert.equal(extractSessionId(req), null);
    });

    it('returns null for empty Bearer token', () => {
        const req = mockRequest({ 'Authorization': 'Bearer   ' });
        assert.equal(extractSessionId(req), null);
    });

    it('returns null for cookie without pdbfe_sid', () => {
        const req = mockRequest({ 'Cookie': 'other_cookie=value' });
        assert.equal(extractSessionId(req), null);
    });
});

// ── resolveSession ───────────────────────────────────────────────────────────

describe('resolveSession', () => {
    const sampleSession = {
        id: 42,
        name: 'Test User',
        given_name: 'Test',
        family_name: 'User',
        email: 'test@example.com',
        verified_user: true,
        verified_email: true,
        networks: [{ perms: 15, asn: 12345, name: 'TestNet', id: 1 }],
        created_at: '2026-04-05T12:00:00Z',
    };

    it('returns session data for a valid session ID', async () => {
        const { kv, calls } = mockKV({ 'session:abc123': sampleSession });
        const result = await resolveSession(kv, 'abc123');
        assert.deepEqual(result, sampleSession);
        assert.equal(calls.get.length, 1);
        assert.equal(calls.get[0], 'session:abc123');
    });

    it('returns null for a missing session ID', async () => {
        const { kv } = mockKV({});
        const result = await resolveSession(kv, 'nonexistent');
        assert.equal(result, null);
    });

    it('returns null for null session ID', async () => {
        const { kv } = mockKV({});
        const result = await resolveSession(kv, null);
        assert.equal(result, null);
    });

    it('returns null for empty string session ID', async () => {
        const { kv } = mockKV({});
        const result = await resolveSession(kv, '');
        assert.equal(result, null);
    });
});

// ── generateSessionId ────────────────────────────────────────────────────────

describe('generateSessionId', () => {
    it('returns a 64-character hex string', () => {
        const sid = generateSessionId();
        assert.match(sid, /^[0-9a-f]{64}$/);
    });

    it('returns exactly 64 characters', () => {
        const sid = generateSessionId();
        assert.equal(sid.length, 64);
    });

    it('generates different IDs on successive calls', () => {
        const a = generateSessionId();
        const b = generateSessionId();
        assert.notEqual(a, b);
    });
});

// ── writeSession ─────────────────────────────────────────────────────────────

describe('writeSession', () => {
    it('writes session data to KV with correct key and TTL', async () => {
        const { kv, calls } = mockKV({});
        const data = /** @type {any} */ ({ id: 1, name: 'Test' });
        await writeSession(kv, 'sid123', data, 3600);

        assert.equal(calls.put.length, 1);
        assert.equal(calls.put[0].key, 'session:sid123');
        assert.equal(calls.put[0].value, JSON.stringify(data));
        assert.deepEqual(calls.put[0].opts, { expirationTtl: 3600 });
    });

    it('uses default TTL of 86400 seconds', async () => {
        const { kv, calls } = mockKV({});
        const data = /** @type {any} */ ({ id: 1 });
        await writeSession(kv, 'sid456', data);

        assert.equal(calls.put[0].opts.expirationTtl, 86400);
    });
});

// ── deleteSession ────────────────────────────────────────────────────────────

describe('deleteSession', () => {
    it('deletes the session key from KV', async () => {
        const { kv, calls } = mockKV({ 'session:sid789': '{}' });
        await deleteSession(kv, 'sid789');

        assert.equal(calls.delete.length, 1);
        assert.equal(calls.delete[0], 'session:sid789');
    });

    it('does nothing for null session ID', async () => {
        const { kv, calls } = mockKV({});
        await deleteSession(kv, null);
        assert.equal(calls.delete.length, 0);
    });

    it('does nothing for empty session ID', async () => {
        const { kv, calls } = mockKV({});
        await deleteSession(kv, '');
        assert.equal(calls.delete.length, 0);
    });
});
