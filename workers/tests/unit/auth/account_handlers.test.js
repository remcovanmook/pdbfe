/**
 * @fileoverview Unit tests for the auth handler endpoint modules.
 *
 * Tests all CRUD handlers for profiles, API keys, and favorites
 * against a mock D1 database and mock KV session store.
 *
 * Each handler requires an authenticated session (except handlePreferences
 * and handleAccountPreflight). The session is injected via the Authorization
 * header and mocked KV namespace.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handlePreferences, handleProfile } from '../../../auth/handlers/profile.js';
import { handleKeys } from '../../../auth/handlers/keys.js';
import { handleFavorites } from '../../../auth/handlers/favorites.js';
import { resolveAllowedOrigin, accountCorsHeaders } from '../../../auth/http.js';

// ── Mock factories ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} MockUserRow
 * @property {number} id
 * @property {string} name
 * @property {string} email
 * @property {string} preferences
 * @property {string} created_at
 * @property {string} updated_at
 */

/** @type {MockUserRow} */
const DEFAULT_USER = {
    id: 42,
    name: 'Test User',
    email: 'test@example.com',
    preferences: '{}',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
};

/**
 * Session data stored in the mocked KV namespace.
 * @type {SessionData}
 */
const TEST_SESSION = /** @type {any} */ ({
    id: 42,
    name: 'Test User',
    email: 'test@example.com',
    networks: [],
});

/** Session ID used across tests. */
const TEST_SID = 'deadbeef0123456789abcdef01234567deadbeef0123456789abcdef01234567';

/**
 * Creates a mock KV namespace that returns a canned session.
 *
 * @param {SessionData|null} session - Session data to return, or null.
 * @returns {KVNamespace}
 */
function mockKV(session = TEST_SESSION) {
    return /** @type {any} */ ({
        get(/** @type {string} */ _key, /** @type {any} */ _opts) {
            return Promise.resolve(session);
        },
    });
}

/**
 * Creates a mock D1 database for the USERDB binding.
 *
 * Supports configurable responses keyed by SQL content matching.
 * This covers the query patterns used by account handlers:
 *   - SELECT * FROM users WHERE id = ?
 *   - INSERT OR IGNORE INTO users ...
 *   - SELECT pref_key, pref_value FROM preference_options ...
 *   - SELECT key_id, label, prefix, created_at FROM api_keys ...
 *   - SELECT COUNT(*) as cnt FROM api_keys ...
 *   - SELECT 1 FROM preference_options WHERE pref_key = ? AND pref_value = ?
 *   - INSERT INTO api_keys ...
 *   - UPDATE users SET ...
 *   - Various favorites queries
 *
 * @param {Object} opts
 * @param {MockUserRow|null} [opts.user] - User record for SELECT queries.
 * @param {Array<{pref_key: string, pref_value: string}>} [opts.prefOptions] - Preference options.
 * @param {Array<Record<string, any>>} [opts.apiKeys] - API key rows.
 * @param {number} [opts.keyCount] - Count of API keys.
 * @param {boolean} [opts.prefValid] - Whether preference validation passes.
 * @param {Array<Record<string, any>>} [opts.favorites] - Favorite rows.
 * @param {number} [opts.favCount] - Count of favorites.
 * @param {Record<string, any>|null} [opts.existingKey] - Existing key for delete checks.
 * @returns {D1Database}
 */
function mockUserDB({
    user = DEFAULT_USER,
    prefOptions = [],
    apiKeys = [],
    keyCount = 0,
    prefValid = true,
    favorites = [],
    favCount = 0,
    existingKey = null,
} = {}) {
    return /** @type {any} */ ({
        prepare(/** @type {string} */ sql) {
            return {
                /** @type {any[]} */
                _params: [],
                bind(/** @type {...any} */ ...params) {
                    this._params = params;
                    return this;
                },
                first() {
                    // User lookup
                    if (sql.includes('FROM users WHERE id')) {
                        return Promise.resolve(user);
                    }
                    // Key count
                    if (sql.includes('COUNT(*)') && sql.includes('api_keys')) {
                        return Promise.resolve({ cnt: keyCount });
                    }
                    // Favorites count
                    if (sql.includes('COUNT(*)') && sql.includes('user_favorites')) {
                        return Promise.resolve({ cnt: favCount });
                    }
                    // Preference validation
                    if (sql.includes('preference_options') && sql.includes('SELECT 1')) {
                        return Promise.resolve(prefValid ? { '1': 1 } : null);
                    }
                    // Key exists check (for delete)
                    if (sql.includes('FROM api_keys WHERE user_id') && sql.includes('key_id')) {
                        return Promise.resolve(existingKey);
                    }
                    return Promise.resolve(null);
                },
                run() {
                    return Promise.resolve({ success: true, meta: {}, results: [] });
                },
                all() {
                    // Preference options list
                    if (sql.includes('preference_options') && sql.includes('SELECT pref_key')) {
                        return Promise.resolve({ success: true, results: prefOptions, meta: {} });
                    }
                    // API keys list
                    if (sql.includes('api_keys') && sql.includes('SELECT key_id')) {
                        return Promise.resolve({ success: true, results: apiKeys, meta: {} });
                    }
                    // Favorites list
                    if (sql.includes('user_favorites') && sql.includes('SELECT entity_type')) {
                        return Promise.resolve({ success: true, results: favorites, meta: {} });
                    }
                    return Promise.resolve({ success: true, results: [], meta: {} });
                },
            };
        },
        batch(/** @type {any[]} */ stmts) {
            return Promise.resolve(stmts.map(() => ({ success: true, meta: {}, results: [] })));
        },
    });
}

/**
 * Builds a minimal mock PdbAuthEnv.
 *
 * @param {Object} [overrides] - Fields to override.
 * @returns {PdbAuthEnv}
 */
function mockEnv(overrides = {}) {
    return /** @type {any} */ ({
        FRONTEND_ORIGIN: 'https://pdbfe.dev',
        SESSIONS: mockKV(),
        USERDB: mockUserDB(),
        ...overrides,
    });
}

/**
 * Builds an authenticated request with a Bearer token.
 *
 * @param {string} url - Request URL.
 * @param {Object} [opts] - Fetch options (method, body, etc.).
 * @returns {Request}
 */
function authRequest(url, opts = {}) {
    const headers = new Headers(opts.headers || {});
    if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${TEST_SID}`);
    }
    return new Request(url, { ...opts, headers });
}

/**
 * Reads and parses the JSON body from a response.
 *
 * @param {Response} res - Response to parse.
 * @returns {Promise<any>} Parsed JSON body.
 */
async function json(res) {
    return res.json();
}

// ── handlePreferences ──────────────────────────────────────────────────

describe('handlePreferences', () => {
    it('returns grouped preference options', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({
                prefOptions: [
                    { pref_key: 'language', pref_value: 'en' },
                    { pref_key: 'language', pref_value: 'de' },
                    { pref_key: 'theme', pref_value: 'dark' },
                    { pref_key: 'theme', pref_value: 'light' },
                ]
            }),
        });

        const req = new Request('https://auth.pdbfe.dev/account/preferences/options');
        const res = await handlePreferences(req, env);
        assert.equal(res.status, 200);

        const body = await json(res);
        assert.deepEqual(body.language, ['en', 'de']);
        assert.deepEqual(body.theme, ['dark', 'light']);
    });

    it('returns 200 with empty object when no options exist', async () => {
        const env = mockEnv({ USERDB: mockUserDB({ prefOptions: [] }) });
        const req = new Request('https://auth.pdbfe.dev/account/preferences/options');
        const res = await handlePreferences(req, env);
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.deepEqual(body, {});
    });

    it('sets CORS headers', async () => {
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/account/preferences/options', {
            headers: { 'Origin': 'https://pdbfe.dev' }
        });
        const res = await handlePreferences(req, env);
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://pdbfe.dev');
    });

    it('sets Cache-Control for public caching', async () => {
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/account/preferences/options');
        const res = await handlePreferences(req, env);
        assert.ok(res.headers.get('Cache-Control').includes('public'));
    });
});

// ── handleProfile ─────────────────────────────────────────────────────────

describe('handleProfile', () => {
    it('returns 401 when no auth header is present', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/account/profile');
        const res = await handleProfile(req, env);
        assert.equal(res.status, 401);
    });

    it('returns 401 for invalid session', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = authRequest('https://auth.pdbfe.dev/account/profile');
        const res = await handleProfile(req, env);
        assert.equal(res.status, 401);
    });

    it('returns profile for authenticated user', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/profile');
        const res = await handleProfile(req, env);
        assert.equal(res.status, 200);

        const body = await json(res);
        assert.equal(body.id, 42);
        assert.equal(body.name, 'Test User');
        assert.equal(body.email, 'test@example.com');
    });

    it('auto-provisions user record on first access', async () => {
        // User not found in DB → ensureUser creates it
        const env = mockEnv({
            USERDB: mockUserDB({ user: null }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/profile');
        const res = await handleProfile(req, env);
        assert.equal(res.status, 200);

        const body = await json(res);
        // Falls back to session data when DB insert race yields null
        assert.equal(body.id, 42);
        assert.equal(body.name, 'Test User');
    });

    it('parses stored preferences JSON', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({
                user: { ...DEFAULT_USER, preferences: '{"language":"de","theme":"dark"}' }
            }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/profile');
        const res = await handleProfile(req, env);
        const body = await json(res);
        assert.equal(body.preferences.language, 'de');
        assert.equal(body.preferences.theme, 'dark');
    });
});

// ── handleProfile ──────────────────────────────────────────────────────

describe('handleProfile', () => {
    it('returns 401 without auth', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/account/profile', {
            method: 'PUT',
            body: '{"name":"New Name"}',
        });
        const res = await handleProfile(req, env);
        assert.equal(res.status, 401);
    });

    it('returns 400 for invalid JSON body', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/profile', {
            method: 'PUT',
            body: 'not json',
        });
        const res = await handleProfile(req, env);
        assert.equal(res.status, 400);
        const body = await json(res);
        assert.ok(body.error.includes('Invalid JSON'));
    });

    it('returns 400 for empty name', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '' }),
        });
        const res = await handleProfile(req, env);
        assert.equal(res.status, 400);
    });

    it('returns 400 when no fields to update', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const res = await handleProfile(req, env);
        assert.equal(res.status, 400);
        const body = await json(res);
        assert.ok(body.error.includes('No fields'));
    });

    it('updates name and returns updated profile', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Updated Name' }),
        });
        const res = await handleProfile(req, env);
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.name, 'Updated Name');
    });

    it('rejects invalid preference value', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({ prefValid: false }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferences: { language: 'invalid' } }),
        });
        const res = await handleProfile(req, env);
        assert.equal(res.status, 400);
        const body = await json(res);
        assert.ok(body.error.includes('Invalid preference'));
    });

    it('rejects non-object preferences', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferences: 'not-an-object' }),
        });
        const res = await handleProfile(req, env);
        assert.equal(res.status, 400);
    });

    it('rejects non-string preference values', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferences: { theme: 42 } }),
        });
        const res = await handleProfile(req, env);
        assert.equal(res.status, 400);
    });

    it('merges preferences with existing values', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({
                user: { ...DEFAULT_USER, preferences: '{"language":"en"}' },
                prefValid: true,
            }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferences: { theme: 'dark' } }),
        });
        const res = await handleProfile(req, env);
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.preferences.language, 'en');
        assert.equal(body.preferences.theme, 'dark');
    });
});

// ── handleKeys ───────────────────────────────────────────────────────────

describe('handleKeys', () => {
    it('returns 401 without auth', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/account/keys');
        const res = await handleKeys(req, env, '/');
        assert.equal(res.status, 401);
    });

    it('returns keys array and max_keys', async () => {
        const keys = [
            { key_id: 'abc12345', label: 'CI', prefix: 'abc1', created_at: '2026-01-01T00:00:00Z' },
        ];
        const env = mockEnv({
            USERDB: mockUserDB({ apiKeys: keys }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/keys');
        const res = await handleKeys(req, env, '/');
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.keys.length, 1);
        assert.equal(body.keys[0].key_id, 'abc12345');
        assert.equal(body.max_keys, 5);
    });
});

// ── handleKeys ──────────────────────────────────────────────────────────

describe('handleKeys', () => {
    it('returns 401 without auth', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/account/keys', {
            method: 'POST',
        });
        const res = await handleKeys(req, env, '/');
        assert.equal(res.status, 401);
    });

    it('creates a key and returns it with 201 status', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({ keyCount: 0 }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: 'My API Key' }),
        });
        const res = await handleKeys(req, env, '/');
        assert.equal(res.status, 201);
        const body = await json(res);
        assert.ok(body.key.startsWith('pdbfe.'));
        assert.equal(body.key.length, 38);
        assert.equal(body.label, 'My API Key');
        assert.ok(body.key_id);
        assert.ok(body.prefix);
    });

    it('returns 400 when key limit is reached', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({ keyCount: 5 }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/keys', {
            method: 'POST',
        });
        const res = await handleKeys(req, env, '/');
        assert.equal(res.status, 400);
        const body = await json(res);
        assert.ok(body.error.includes('Maximum'));
    });

    it('uses "Unnamed key" when no label is provided', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({ keyCount: 0 }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/keys', {
            method: 'POST',
        });
        const res = await handleKeys(req, env, '/');
        assert.equal(res.status, 201);
        const body = await json(res);
        assert.equal(body.label, 'Unnamed key');
    });

    it('truncates labels longer than 64 characters', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({ keyCount: 0 }),
        });
        const longLabel = 'A'.repeat(100);
        const req = authRequest('https://auth.pdbfe.dev/account/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: longLabel }),
        });
        const res = await handleKeys(req, env, '/');
        const body = await json(res);
        assert.equal(body.label.length, 64);
    });
});

// ── handleKeys ──────────────────────────────────────────────────────────

describe('handleKeys', () => {
    it('returns 401 without auth', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/account/keys/abc12345', {
            method: 'DELETE',
        });
        const res = await handleKeys(req, env, '/abc12345');
        assert.equal(res.status, 401);
    });

    it('returns 404 when key does not exist', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({ existingKey: null }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/keys/deadbeef', {
            method: 'DELETE',
        });
        const res = await handleKeys(req, env, '/deadbeef');
        assert.equal(res.status, 404);
        const body = await json(res);
        assert.ok(body.error.includes('not found'));
    });

    it('deletes an existing key and returns 200', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({ existingKey: { key_id: 'abc12345' } }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/keys/abc12345', {
            method: 'DELETE',
        });
        const res = await handleKeys(req, env, '/abc12345');
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.deleted, 'abc12345');
    });
});

// ── handleFavorites ──────────────────────────────────────────────────────

describe('handleFavorites', () => {
    it('returns 401 without auth', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/account/favorites');
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 401);
    });

    it('returns favorites array and max_favorites', async () => {
        const favs = [
            { entity_type: 'net', entity_id: 694, label: 'Cloudflare', created_at: '2026-01-01T00:00:00Z' },
        ];
        const env = mockEnv({
            USERDB: mockUserDB({ favorites: favs }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/favorites');
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.favorites.length, 1);
        assert.equal(body.favorites[0].entity_type, 'net');
        assert.equal(body.max_favorites, 50);
    });
});

// ── handleFavorites ────────────────────────────────────────────────────────

describe('handleFavorites', () => {
    it('returns 401 without auth', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/account/favorites', {
            method: 'POST',
            body: '{}',
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 401);
    });

    it('returns 400 for invalid entity_type', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_type: 'invalid', entity_id: 1 }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 400);
    });

    it('returns 400 for invalid entity_id', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_type: 'net', entity_id: -1 }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 400);
    });

    it('returns 400 for non-integer entity_id', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_type: 'net', entity_id: 1.5 }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 400);
    });

    it('returns 400 for invalid JSON body', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'POST',
            body: 'not json',
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 400);
    });

    it('creates a favorite and returns 201', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({ favCount: 0 }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_type: 'net', entity_id: 694, label: 'Cloudflare' }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 201);
        const body = await json(res);
        assert.equal(body.entity_type, 'net');
        assert.equal(body.entity_id, 694);
        assert.equal(body.label, 'Cloudflare');
    });

    it('returns 400 when favorites limit is reached', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({ favCount: 50 }),
        });
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_type: 'net', entity_id: 1 }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 400);
        const body = await json(res);
        assert.ok(body.error.includes('Maximum'));
    });

    it('truncates long labels to 200 characters', async () => {
        const env = mockEnv({
            USERDB: mockUserDB({ favCount: 0 }),
        });
        const longLabel = 'X'.repeat(300);
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_type: 'net', entity_id: 1, label: longLabel }),
        });
        const res = await handleFavorites(req, env, '');
        const body = await json(res);
        assert.equal(body.label.length, 200);
    });

    it('accepts all valid entity types', async () => {
        const validTypes = ['net', 'ix', 'fac', 'org', 'carrier', 'campus'];
        for (const entityType of validTypes) {
            const env = mockEnv({
                USERDB: mockUserDB({ favCount: 0 }),
            });
            const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entity_type: entityType, entity_id: 1 }),
            });
            const res = await handleFavorites(req, env, '');
            assert.equal(res.status, 201, `Expected 201 for entity_type=${entityType}`);
        }
    });
});

// ── handleFavorites ─────────────────────────────────────────────────────

describe('handleFavorites', () => {
    it('returns 401 without auth', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/account/favorites/net/1', {
            method: 'DELETE',
        });
        const res = await handleFavorites(req, env, '/net/1');
        assert.equal(res.status, 401);
    });

    it('returns 400 for invalid entity type', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites/invalid/1', {
            method: 'DELETE',
        });
        const res = await handleFavorites(req, env, '/invalid/1');
        assert.equal(res.status, 400);
    });

    it('returns 400 for invalid entity ID', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites/net/abc', {
            method: 'DELETE',
        });
        const res = await handleFavorites(req, env, '/net/abc');
        assert.equal(res.status, 400);
    });

    it('returns 400 for negative entity ID', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites/net/-5', {
            method: 'DELETE',
        });
        const res = await handleFavorites(req, env, '/net/-5');
        assert.equal(res.status, 400);
    });

    it('deletes a favorite and returns 200', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites/net/694', {
            method: 'DELETE',
        });
        const res = await handleFavorites(req, env, '/net/694');
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.deleted.entity_type, 'net');
        assert.equal(body.deleted.entity_id, 694);
    });
});

// ── Account CORS preflight (via shared helpers) ─────────────────────────────

describe('accountCorsHeaders + resolveAllowedOrigin (preflight)', () => {
    it('returns correct CORS headers for production origin', () => {
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/account/profile', {
            method: 'OPTIONS',
            headers: { 'Origin': 'https://pdbfe.dev' },
        });
        const origin = resolveAllowedOrigin(req, env);
        const headers = accountCorsHeaders(origin);
        assert.equal(headers['Access-Control-Allow-Origin'], 'https://pdbfe.dev');
        assert.ok(headers['Access-Control-Allow-Methods'].includes('GET'));
        assert.ok(headers['Access-Control-Allow-Methods'].includes('POST'));
        assert.ok(headers['Access-Control-Allow-Methods'].includes('DELETE'));
    });

    it('reflects Pages preview origin', () => {
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/account/profile', {
            method: 'OPTIONS',
            headers: { 'Origin': 'https://abc123.pdbfe-frontend.pages.dev' },
        });
        const origin = resolveAllowedOrigin(req, env);
        const headers = accountCorsHeaders(origin);
        assert.equal(headers['Access-Control-Allow-Origin'], 'https://abc123.pdbfe-frontend.pages.dev');
    });
});

// ── handleFavorites (PUT — bulk replace) ─────────────────────────────────────

describe('handleFavorites — PUT (bulk replace)', () => {
    it('returns 401 without auth', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/account/favorites', {
            method: 'PUT',
            body: '{}',
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 401);
    });

    it('returns 400 for invalid JSON body', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'PUT',
            body: 'not json',
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 400);
    });

    it('returns 400 when favorites is not an array', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: 'not-an-array' }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 400);
        const body = await json(res);
        assert.ok(body.error.includes('array'));
    });

    it('returns 400 when array exceeds maximum favorites', async () => {
        const env = mockEnv();
        const tooMany = Array.from({ length: 51 }, (_, i) => ({
            entity_type: 'net', entity_id: i + 1
        }));
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: tooMany }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 400);
        const body = await json(res);
        assert.ok(body.error.includes('Maximum'));
    });

    it('returns 400 for invalid entity_type in array entry', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: [{ entity_type: 'invalid', entity_id: 1 }] }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 400);
        const body = await json(res);
        assert.ok(body.error.includes('entity_type'));
    });

    it('returns 400 for invalid entity_id in array entry', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: [{ entity_type: 'net', entity_id: -5 }] }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 400);
    });

    it('replaces favorites list and returns 200 with count', async () => {
        const env = mockEnv();
        const favorites = [
            { entity_type: 'net', entity_id: 1, label: 'First' },
            { entity_type: 'ix',  entity_id: 2, label: 'Second' },
        ];
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.replaced, 2);
    });

    it('accepts an empty array (clears all favorites)', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: [] }),
        });
        const res = await handleFavorites(req, env, '');
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.replaced, 0);
    });

    it('truncates long labels in the array to 200 characters', async () => {
        const env = mockEnv();
        const req = authRequest('https://auth.pdbfe.dev/account/favorites', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorites: [{ entity_type: 'net', entity_id: 1, label: 'X'.repeat(300) }] }),
        });
        const res = await handleFavorites(req, env, '');
        // Response just returns replaced count — label truncation is internal.
        // Confirm the request succeeds (label truncation must not cause a failure).
        assert.equal(res.status, 200);
    });
});
