/**
 * @fileoverview Unit tests for the authentication module (core/auth.js).
 * Tests API key extraction from the Authorization header and the
 * verifyApiKey stub.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractApiKey, verifyApiKey } from '../../core/auth.js';
import { hashKey } from '../../core/account.js';

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
});
