/**
 * @fileoverview Unit tests for the auth module.
 *
 * Tests anonymous-user favorites (add, remove, reorder, persistence),
 * input sanitization, `isFavorite`, and SID pattern validation in
 * `initAuth`. All network calls and localStorage are mocked.
 *
 * Note: auth.js uses module-level state (`_cachedSid`, `_favoritesList`,
 * `_favoritesSet`). Tests reset this state by calling `logout()` in
 * `beforeEach`, which is the same technique used in home.test.js.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDOM } from '../helpers/mock-dom.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sets up the mock DOM and a writable in-memory localStorage.
 * Returns the localStorage store so tests can inspect it.
 *
 * @returns {{ store: Record<string, string> }}
 */
function setup() {
    createMockDOM();

    /** @type {Record<string, string>} */
    const store = {};
    globalThis.localStorage = /** @type {any} */ ({
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
    });

    // Minimal fetch mock — auth.js calls fetch for profile/favorites on login
    globalThis.fetch = /** @type {any} */ (async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
    }));

    return { store };
}

// ── isFavorite ────────────────────────────────────────────────────────────────

describe('isFavorite', () => {
    beforeEach(setup);

    it('returns false for an entity not in favorites', async () => {
        const { isFavorite, logout } = await import('../../js/auth.js');
        logout();
        assert.equal(isFavorite('net', 1), false);
    });
});

// ── addFavorite (anonymous) ───────────────────────────────────────────────────

describe('addFavorite — anonymous path', () => {
    /** @type {{ store: Record<string, string> }} */
    let ctx;
    beforeEach(() => { ctx = setup(); });

    it('adds a valid entity and returns true', async () => {
        const { addFavorite, isFavorite, logout } = await import('../../js/auth.js');
        logout();

        const ok = await addFavorite('net', 694, 'Cloudflare');
        assert.equal(ok, true);
        assert.equal(isFavorite('net', 694), true);
    });

    it('writes the entry to localStorage', async () => {
        const { addFavorite, logout } = await import('../../js/auth.js');
        logout();

        await addFavorite('net', 694, 'Cloudflare');
        const raw = ctx.store['pdbfe_favorites'];
        assert.ok(raw, 'pdbfe_favorites should be written');
        const parsed = JSON.parse(raw);
        assert.ok(Array.isArray(parsed));
        assert.equal(parsed[0].entity_type, 'net');
        assert.equal(parsed[0].entity_id, 694);
    });

    it('returns true and is idempotent for already-favorited entities', async () => {
        const { addFavorite, logout } = await import('../../js/auth.js');
        logout();

        const first = await addFavorite('net', 694, 'Cloudflare');
        const second = await addFavorite('net', 694, 'Cloudflare');
        assert.equal(first, true);
        assert.equal(second, true);

        // Should only have one entry
        const raw = ctx.store['pdbfe_favorites'];
        const parsed = JSON.parse(raw);
        const matches = parsed.filter((/** @type {any} */ f) => f.entity_type === 'net' && f.entity_id === 694);
        assert.equal(matches.length, 1, 'Duplicate add should not create two entries');
    });

    it('rejects invalid entity types', async () => {
        const { addFavorite, isFavorite, logout } = await import('../../js/auth.js');
        logout();

        const ok = await addFavorite('invalidtype', 1, 'Test');
        assert.equal(ok, false);
        assert.equal(isFavorite('invalidtype', 1), false);
    });

    it('rejects non-integer entity IDs', async () => {
        const { addFavorite, logout } = await import('../../js/auth.js');
        logout();

        const ok1 = await addFavorite('net', -1, 'Test');
        const ok2 = await addFavorite('net', 0, 'Test');
        assert.equal(ok1, false);
        assert.equal(ok2, false);
    });

    it('truncates label to MAX_LABEL_LENGTH (200 chars)', async () => {
        const { addFavorite, logout } = await import('../../js/auth.js');
        logout();

        const longLabel = 'x'.repeat(300);
        await addFavorite('net', 100, longLabel);
        const raw = ctx.store['pdbfe_favorites'];
        const parsed = JSON.parse(raw);
        assert.ok(parsed[0].label.length <= 200, 'Label should be truncated to 200 chars');
    });

    it('strips control characters from label', async () => {
        const { addFavorite, logout } = await import('../../js/auth.js');
        logout();

        await addFavorite('net', 101, 'Hello\x00World\x1f');
        const raw = ctx.store['pdbfe_favorites'];
        const parsed = JSON.parse(raw);
        assert.ok(!parsed[0].label.includes('\x00'), 'Null byte should be stripped');
        assert.ok(!parsed[0].label.includes('\x1f'), 'Control char should be stripped');
    });
});

// ── removeFavorite (anonymous) ────────────────────────────────────────────────

describe('removeFavorite — anonymous path', () => {
    /** @type {{ store: Record<string, string> }} */
    let ctx;
    beforeEach(() => { ctx = setup(); });

    it('removes an existing favorite and returns true', async () => {
        const { addFavorite, removeFavorite, isFavorite, logout } = await import('../../js/auth.js');
        logout();

        await addFavorite('ix', 26, 'AMS-IX');
        assert.equal(isFavorite('ix', 26), true);

        const ok = await removeFavorite('ix', 26);
        assert.equal(ok, true);
        assert.equal(isFavorite('ix', 26), false);
    });

    it('removes the entry from localStorage', async () => {
        const { addFavorite, removeFavorite, logout } = await import('../../js/auth.js');
        logout();

        await addFavorite('fac', 1, 'Equinix');
        await removeFavorite('fac', 1);

        const raw = ctx.store['pdbfe_favorites'];
        const parsed = raw ? JSON.parse(raw) : [];
        const remaining = parsed.filter((/** @type {any} */ f) => f.entity_type === 'fac' && f.entity_id === 1);
        assert.equal(remaining.length, 0, 'Removed entry should not appear in localStorage');
    });

    it('returns true when entity is not in favorites (idempotent)', async () => {
        const { removeFavorite, logout } = await import('../../js/auth.js');
        logout();

        const ok = await removeFavorite('net', 9999);
        assert.equal(ok, true);
    });
});

// ── reorderFavorites (anonymous) ──────────────────────────────────────────────

describe('reorderFavorites — anonymous path', () => {
    /** @type {{ store: Record<string, string> }} */
    let ctx;
    beforeEach(() => { ctx = setup(); });

    it('reorders the in-memory list and persists to localStorage', async () => {
        const { addFavorite, reorderFavorites, getFavorites, logout } = await import('../../js/auth.js');
        logout();

        await addFavorite('net', 1, 'A');
        await addFavorite('net', 2, 'B');
        await addFavorite('net', 3, 'C');

        // Reverse the order
        reorderFavorites(['net:3', 'net:2', 'net:1']);

        const list = getFavorites();
        assert.equal(list[0].entity_id, 3);
        assert.equal(list[1].entity_id, 2);
        assert.equal(list[2].entity_id, 1);

        // Check localStorage
        const raw = ctx.store['pdbfe_favorites'];
        const parsed = JSON.parse(raw);
        assert.equal(parsed[0].entity_id, 3);
    });
});

// ── initAuth — SID validation ─────────────────────────────────────────────────

describe('initAuth — code exchange (PKCE hand-off)', () => {
    beforeEach(setup);

    /**
     * Installs writable local + session storage mocks. `setItems` records every
     * localStorage.setItem so a stored sid can be asserted even if a later
     * /auth/me invalidation removes it.
     */
    function mockStores() {
        /** @type {Record<string, string>} */ const local = {};
        /** @type {Record<string, string>} */ const session = {};
        /** @type {Array<[string, string]>} */ const setItems = [];
        globalThis.localStorage = /** @type {any} */ ({
            getItem: (k) => local[k] ?? null,
            setItem: (k, v) => { local[k] = v; setItems.push([k, v]); },
            removeItem: (k) => { delete local[k]; },
        });
        globalThis.sessionStorage = /** @type {any} */ ({
            getItem: (k) => session[k] ?? null,
            setItem: (k, v) => { session[k] = v; },
            removeItem: (k) => { delete session[k]; },
        });
        return { local, session, setItems };
    }

    it('exchanges the code for the sid when the verifier is present', async () => {
        globalThis.location = /** @type {any} */ ({ href: 'http://localhost/?code=CODE', pathname: '/', search: '?code=CODE' });
        const { session, setItems } = mockStores();
        session['pdbfe_login_verifier'] = 'v'.repeat(64);
        const sid = 'a'.repeat(64);
        let exchangeBody = null;
        globalThis.fetch = /** @type {any} */ (async (url, opts) => {
            if (String(url).includes('/auth/exchange')) {
                exchangeBody = JSON.parse(opts.body);
                return { ok: true, status: 200, json: async () => ({ sid }) };
            }
            return { ok: false, status: 401, json: async () => ({}) };
        });

        const { initAuth } = await import('../../js/auth.js');
        await initAuth();

        assert.equal(exchangeBody.code, 'CODE');
        assert.equal(exchangeBody.verifier, 'v'.repeat(64));
        assert.ok(setItems.some(([k, v]) => k === 'pdbfe_sid' && v === sid), 'sid from exchange stored');
        assert.equal(session['pdbfe_login_verifier'], undefined, 'verifier consumed');
    });

    it('ignores an injected ?code= when no verifier was set (fixation defence)', async () => {
        globalThis.location = /** @type {any} */ ({ href: 'http://localhost/?code=ATTACKER', pathname: '/', search: '?code=ATTACKER' });
        const { setItems } = mockStores(); // no verifier stashed
        let exchangeAttempted = false;
        globalThis.fetch = /** @type {any} */ (async (url) => {
            if (String(url).includes('/auth/exchange')) exchangeAttempted = true;
            return { ok: false, status: 401, json: async () => ({}) };
        });

        const { initAuth } = await import('../../js/auth.js');
        await initAuth();

        assert.equal(exchangeAttempted, false, 'no exchange without a browser-held verifier');
        assert.ok(!setItems.some(([k]) => k === 'pdbfe_sid'), 'no session adopted from an injected code');
    });

    it('stores nothing when the exchange fails', async () => {
        globalThis.location = /** @type {any} */ ({ href: 'http://localhost/?code=CODE', pathname: '/', search: '?code=CODE' });
        const { session, setItems } = mockStores();
        session['pdbfe_login_verifier'] = 'v'.repeat(64);
        globalThis.fetch = /** @type {any} */ (async (url) => {
            if (String(url).includes('/auth/exchange')) return { ok: false, status: 400, json: async () => ({}) };
            return { ok: false, status: 401, json: async () => ({}) };
        });

        const { initAuth } = await import('../../js/auth.js');
        await initAuth();

        assert.ok(!setItems.some(([k]) => k === 'pdbfe_sid'), 'no sid stored on failed exchange');
    });

    it('rejects a malformed sid returned by the exchange', async () => {
        globalThis.location = /** @type {any} */ ({ href: 'http://localhost/?code=CODE', pathname: '/', search: '?code=CODE' });
        const { session, setItems } = mockStores();
        session['pdbfe_login_verifier'] = 'v'.repeat(64);
        globalThis.fetch = /** @type {any} */ (async (url) => {
            if (String(url).includes('/auth/exchange')) return { ok: true, status: 200, json: async () => ({ sid: 'not-valid' }) };
            return { ok: false, status: 401, json: async () => ({}) };
        });

        const { initAuth } = await import('../../js/auth.js');
        await initAuth();

        assert.ok(!setItems.some(([k]) => k === 'pdbfe_sid'), 'malformed sid from exchange not stored');
    });
});
