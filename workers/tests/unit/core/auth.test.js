/**
 * @fileoverview Unit tests for the authentication module (core/auth.js).
 *
 * Tests API key extraction, verification, hashing, session ID extraction
 * (Bearer header, cookie), session resolution (KV lookup), session
 * lifecycle (write, delete), session ID generation, and the top-level
 * resolveAuth() pipeline.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractApiKey,
    verifyApiKey,
    hashKey,
    extractSessionId,
    resolveSession,
    generateSessionId,
    writeSession,
    deleteSession,
    resolveAuth,
} from '../../../core/auth.js';

// ── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a minimal Request object with the given Authorization header.
 *
 * @param {string|null} authHeader - Value for the Authorization header, or null to omit it.
 * @returns {Request} A mock GET request.
 */
function makeRequest(authHeader) {
    const headers = new Headers();
    if (authHeader !== null) {
        headers.set('Authorization', authHeader);
    }
    return new Request('https://test.workers.dev/api/poc', {
        method: 'GET',
        headers,
    });
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

// ── extractApiKey ────────────────────────────────────────────────────────────

describe('extractApiKey', () => {
    it('should extract a valid Api-Key header', () => {
        const key = extractApiKey(makeRequest('Api-Key abc123'));
        assert.equal(key, 'abc123');
    });

    it('should be case-insensitive on the scheme prefix', () => {
        assert.equal(extractApiKey(makeRequest('api-key mykey')), 'mykey');
        assert.equal(extractApiKey(makeRequest('API-KEY MYKEY')), 'MYKEY');
        assert.equal(extractApiKey(makeRequest('Api-key test')), 'test');
    });

    it('should return null when no Authorization header is present', () => {
        assert.equal(extractApiKey(makeRequest(null)), null);
    });

    it('should return null for empty Authorization header', () => {
        assert.equal(extractApiKey(makeRequest('')), null);
    });

    it('should return null for Bearer scheme', () => {
        assert.equal(extractApiKey(makeRequest('Bearer token123')), null);
    });

    it('should return null for Basic auth', () => {
        assert.equal(extractApiKey(makeRequest('Basic dXNlcjpwYXNz')), null);
    });

    it('should return null for Api-Key with empty value', () => {
        assert.equal(extractApiKey(makeRequest('Api-Key ')), null);
        assert.equal(extractApiKey(makeRequest('Api-Key    ')), null);
    });

    it('should trim whitespace around the key', () => {
        assert.equal(extractApiKey(makeRequest('Api-Key   spaced-key  ')), 'spaced-key');
    });

    it('should preserve keys with special characters', () => {
        const key = extractApiKey(makeRequest('Api-Key a1b2c3-d4e5f6.key_v2'));
        assert.equal(key, 'a1b2c3-d4e5f6.key_v2');
    });
});

// ── hashKey ──────────────────────────────────────────────────────────────────

describe('hashKey', () => {
    it('should produce a deterministic 64-char hex digest', async () => {
        const h1 = await hashKey('pdbfe.test1234');
        const h2 = await hashKey('pdbfe.test1234');
        assert.equal(h1, h2);
        assert.equal(h1.length, 64);
        assert.match(h1, /^[0-9a-f]{64}$/);
    });

    it('should produce different hashes for different keys', async () => {
        const h1 = await hashKey('pdbfe.aaaa');
        const h2 = await hashKey('pdbfe.bbbb');
        assert.notEqual(h1, h2);
    });
});

// ── verifyApiKey ─────────────────────────────────────────────────────────────

describe('verifyApiKey', () => {
    /** @returns {any} */
    function emptyKV() {
        return { get: async () => null };
    }

    it('should return false when key is not in KV', async () => {
        assert.equal(await verifyApiKey(emptyKV(), 'any-key'), false);
        assert.equal(await verifyApiKey(emptyKV(), ''), false);
        assert.equal(await verifyApiKey(emptyKV(), 'valid-looking-key-12345'), false);
    });

    it('should return true when hashed key exists in KV', async () => {
        const testKey = 'pdbfe.real';
        const testHash = await hashKey(testKey);
        const kv = /** @type {any} */ ({
            get: async (/** @type {string} */ key) => key === 'apikey:' + testHash ? '{}' : null,
        });
        assert.equal(await verifyApiKey(kv, testKey), true);
    });

    it('should return false when cleartext key is in KV but hash is not', async () => {
        // Pre-hashing migration scenario: old cleartext entries should not match
        const kv = /** @type {any} */ ({
            get: async (/** @type {string} */ key) => key === 'apikey:pdbfe.old' ? '{}' : null,
        });
        assert.equal(await verifyApiKey(kv, 'pdbfe.old'), false);
    });

    it('should return false for null', async () => {
        const { kv } = mockKV({});
        assert.equal(await verifyApiKey(kv, null), false);
    });

    it('should cache results to avoid repeated KV lookups', async () => {
        let getCount = 0;
        const kv = /** @type {any} */ ({
            get: async (/** @type {string} */ _key) => {
                getCount++;
                return '{}';
            },
        });

        const key = 'pdbfe.cachetest000000000000000000';
        await verifyApiKey(kv, key);
        await verifyApiKey(kv, key);
        await verifyApiKey(kv, key);

        // Should only hit KV once, then cache for subsequent calls
        assert.equal(getCount, 1, 'Expected 1 KV get call, got ' + getCount);
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

// ── resolveAuth ─────────────────────────────────────────────────────────────────

describe('resolveAuth', () => {
    /**
     * Builds a mock env with USERS and SESSIONS KV namespaces.
     *
     * @param {Record<string, any>} users - USERS KV store.
     * @param {Record<string, any>} sessions - SESSIONS KV store.
     * @returns {{USERS: KVNamespace, SESSIONS: KVNamespace}}
     */
    function mockEnv(users = {}, sessions = {}) {
        return {
            USERS: /** @type {any} */ (mockKV(users).kv),
            SESSIONS: /** @type {any} */ (mockKV(sessions).kv),
        };
    }

    it('returns authenticated for a valid pdbfe API key', async () => {
        const key = 'pdbfe.aabbccdd00112233445566778899aabb';
        const hashed = await hashKey(key);
        const env = mockEnv({ [`apikey:${hashed}`]: '{}' });
        const req = makeRequest(`Api-Key ${key}`);

        const result = await resolveAuth(req, env);
        assert.equal(result.authenticated, true);
        assert.equal(result.identity, key);
        assert.equal(result.rejection, null);
    });

    it('rejects upstream PeeringDB keys with a rejection message', async () => {
        const env = mockEnv();
        const req = makeRequest('Api-Key 12345678-abcd-1234-abcd-123456789abc');

        const result = await resolveAuth(req, env);
        assert.equal(result.authenticated, false);
        assert.equal(result.identity, null);
        assert.equal(typeof result.rejection, 'string');
        assert.ok(result.rejection.includes('not valid on this mirror'));
    });

    it('falls back to session auth when no API key', async () => {
        const sid = 'abc123session';
        const env = mockEnv({}, { [`session:${sid}`]: { id: 1, name: 'Test' } });
        const req = mockRequest({ 'Authorization': `Bearer ${sid}` });

        const result = await resolveAuth(req, env);
        assert.equal(result.authenticated, true);
        assert.equal(result.identity, sid);
        assert.equal(result.rejection, null);
    });

    it('returns unauthenticated when no credentials provided', async () => {
        const env = mockEnv();
        const req = mockRequest({});

        const result = await resolveAuth(req, env);
        assert.equal(result.authenticated, false);
        assert.equal(result.identity, null);
        assert.equal(result.rejection, null);
    });

    it('returns unauthenticated for invalid API key', async () => {
        const env = mockEnv();
        const req = makeRequest('Api-Key pdbfe.nonexistent');

        const result = await resolveAuth(req, env);
        assert.equal(result.authenticated, false);
        assert.equal(result.identity, null);
        assert.equal(result.rejection, null);
    });

    it('returns unauthenticated for invalid session', async () => {
        const env = mockEnv();
        const req = mockRequest({ 'Authorization': 'Bearer invalid_session_id' });

        const result = await resolveAuth(req, env);
        assert.equal(result.authenticated, false);
        assert.equal(result.identity, null);
        assert.equal(result.rejection, null);
    });
});
