/**
 * @fileoverview Unit tests for API key generation, verification, and
 * account management functions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateApiKey } from '../../core/account.js';
import { verifyApiKey, extractApiKey } from '../../core/auth.js';

// ── Mock KV namespace ────────────────────────────────────────────────────────

/**
 * Creates a mock KVNamespace backed by an in-memory store.
 *
 * @param {Record<string, string>} store - Initial key-value contents.
 * @returns {{kv: KVNamespace, store: Record<string, string>}}
 */
function mockKV(store = {}) {
    const kv = /** @type {any} */ ({
        get: async (/** @type {string} */ key, /** @type {any} */ opts) => {
            const value = store[key];
            if (value === undefined) return null;
            if (opts?.type === 'json') {
                return typeof value === 'string' ? JSON.parse(value) : value;
            }
            return value;
        },
        put: async (/** @type {string} */ key, /** @type {string} */ value) => {
            store[key] = value;
        },
        delete: async (/** @type {string} */ key) => {
            delete store[key];
        },
        list: async (/** @type {{prefix?: string}} */ opts) => {
            const prefix = opts?.prefix || '';
            const keys = Object.keys(store)
                .filter(k => k.startsWith(prefix))
                .map(name => ({ name }));
            return { keys };
        },
    });
    return { kv, store };
}

// ── generateApiKey ───────────────────────────────────────────────────────────

describe('generateApiKey', () => {
    it('returns a string starting with pdbfe.', () => {
        const key = generateApiKey();
        assert.ok(key.startsWith('pdbfe.'), `Expected key to start with 'pdbfe.', got: ${key}`);
    });

    it('has the correct total length (pdbfe. + 32 hex chars = 38)', () => {
        const key = generateApiKey();
        assert.equal(key.length, 38);
    });

    it('hex portion contains only valid hex characters', () => {
        const key = generateApiKey();
        const hex = key.slice(6); // Remove 'pdbfe.'
        assert.match(hex, /^[0-9a-f]{32}$/);
    });

    it('generates unique keys on successive calls', () => {
        const keys = new Set(Array.from({ length: 20 }, () => generateApiKey()));
        assert.equal(keys.size, 20, 'Expected 20 unique keys');
    });
});

// ── verifyApiKey ─────────────────────────────────────────────────────────────

describe('verifyApiKey', () => {
    it('returns true for a key that exists in KV', async () => {
        const { kv } = mockKV({
            'apikey:pdbfe.abcd1234abcd1234abcd1234abcd1234': JSON.stringify({
                user_id: 42,
                label: 'test key',
                created_at: '2026-04-06T10:00:00Z',
            }),
        });

        const result = await verifyApiKey(kv, 'pdbfe.abcd1234abcd1234abcd1234abcd1234');
        assert.equal(result, true);
    });

    it('returns false for a key that does not exist in KV', async () => {
        const { kv } = mockKV({});
        const result = await verifyApiKey(kv, 'pdbfe.nonexistent0000000000000000');
        assert.equal(result, false);
    });

    it('returns false for null key', async () => {
        const { kv } = mockKV({});
        const result = await verifyApiKey(kv, null);
        assert.equal(result, false);
    });

    it('returns false for empty string key', async () => {
        const { kv } = mockKV({});
        const result = await verifyApiKey(kv, '');
        assert.equal(result, false);
    });

    it('caches results to avoid repeated KV lookups', async () => {
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

// ── extractApiKey with verifyApiKey integration ──────────────────────────────

describe('extractApiKey + verifyApiKey integration', () => {
    it('extracts and verifies a valid key from request header', async () => {
        const fullKey = generateApiKey();
        const { kv } = mockKV({
            [`apikey:${fullKey}`]: JSON.stringify({ user_id: 1, label: 'test', created_at: '' }),
        });

        const request = new Request('https://api.example.com/api/net', {
            headers: { 'Authorization': `Api-Key ${fullKey}` },
        });

        const extracted = extractApiKey(request);
        assert.equal(extracted, fullKey);

        const valid = await verifyApiKey(kv, extracted);
        assert.equal(valid, true);
    });

    it('returns false for a valid format key that is not in KV', async () => {
        const { kv } = mockKV({});

        const request = new Request('https://api.example.com/api/net', {
            headers: { 'Authorization': 'Api-Key pdbfe.0000000000000000000000000000dead' },
        });

        const extracted = extractApiKey(request);
        const valid = await verifyApiKey(kv, extracted);
        assert.equal(valid, false);
    });
});
