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

// ── initAuth — background profile fetch ──────────────────────────────────────

describe('initAuth — profile loads without blocking', () => {
    beforeEach(setup);

    /**
     * Signed-in fetch mock: /auth/me succeeds at once; /account/* waits for
     * the returned release() so a test can hold the profile back.
     *
     * @param {any[]} favorites - Server favorites to return.
     */
    function signedIn(favorites) {
        globalThis.location = /** @type {any} */ ({ href: 'http://localhost/', pathname: '/', search: '' });
        localStorage.setItem('pdbfe_sid', 'a'.repeat(64));
        /** @type {() => void} */
        let release = () => {};
        const gate = new Promise((r) => { release = () => r(undefined); });
        globalThis.fetch = /** @type {any} */ (async (url) => {
            const u = String(url);
            if (u.includes('/auth/me')) {
                return { ok: true, status: 200, json: async () => ({ authenticated: true, user: { id: 1, name: 'T' } }) };
            }
            await gate;
            if (u.includes('/account/favorites')) return { ok: true, status: 200, json: async () => ({ favorites }) };
            return { ok: true, status: 200, json: async () => ({ preferences: {} }) };
        });
        return { release: () => release() };
    }

    it('resolves before the profile arrives, then reports favorites as redispatch', async () => {
        const { release } = signedIn([{ entity_type: 'net', entity_id: 694, label: 'x', created_at: '' }]);
        const { initAuth, profileReady, isFavorite, isAuthenticated } = await import('../../js/auth.js');

        await initAuth();
        assert.equal(isAuthenticated(), true, 'session is known before the profile');
        assert.equal(isFavorite('net', 694), false, 'favorites not loaded yet');

        release();
        assert.equal(await profileReady(), 'redispatch');
        assert.equal(isFavorite('net', 694), true);
    });

    it('reports nothing to do when the profile changes nothing', async () => {
        const { release } = signedIn([]);
        const { initAuth, profileReady } = await import('../../js/auth.js');

        await initAuth();
        release();
        assert.equal(await profileReady(), null);
    });
});

// ── initAuth — optimistic start for a returning user ─────────────────────────

describe('initAuth — routes before /auth/me for a returning user', () => {
    beforeEach(setup);

    const USER = { id: 7, username: 'u7', name: 'Seven', email: 's@example.invalid', networks: [{ id: 1, asn: 64500, name: 'N' }] };

    /**
     * Returning-user mock: a stored sid and cached user; /auth/me answers
     * only after release(), with `me` (a status code, or 'network' to throw).
     *
     * @param {number|'network'} me
     */
    function returning(me) {
        globalThis.location = /** @type {any} */ ({ href: 'http://localhost/', pathname: '/', search: '' });
        localStorage.setItem('pdbfe_sid', 'b'.repeat(64));
        localStorage.setItem('pdbfe_user', JSON.stringify(USER));
        /** @type {() => void} */
        let release = () => {};
        const gate = new Promise((r) => { release = () => r(undefined); });
        globalThis.fetch = /** @type {any} */ (async (url) => {
            const u = String(url);
            if (u.includes('/auth/me')) {
                await gate;
                if (me === 'network') throw new TypeError('fetch failed');
                if (me === 200) return { ok: true, status: 200, json: async () => ({ authenticated: true, user: USER }) };
                return { ok: false, status: me, json: async () => ({}) };
            }
            return { ok: true, status: 200, json: async () => (u.includes('favorites') ? { favorites: [] } : { preferences: {} }) };
        });
        return { release: () => release() };
    }

    it('is signed in from the cached user before /auth/me answers', async () => {
        const { release } = returning(200);
        const { initAuth, isAuthenticated, getUser, getSessionId, profileReady } = await import('../../js/auth.js');
        await initAuth();
        assert.equal(isAuthenticated(), true);
        assert.equal(getUser()?.name, 'Seven');
        assert.equal(getSessionId(), 'b'.repeat(64));
        release();
        assert.equal(await profileReady(), null, 'confirmed and unchanged: nothing to re-render');
    });

    it('clears a rejected session and asks for a re-render', async () => {
        const { release } = returning(401);
        const { initAuth, isAuthenticated, profileReady } = await import('../../js/auth.js');
        await initAuth();
        assert.equal(isAuthenticated(), true, 'optimistic until /auth/me answers');
        release();
        assert.equal(await profileReady(), 'redispatch');
        assert.equal(isAuthenticated(), false);
        assert.equal(localStorage.getItem('pdbfe_sid'), null);
        assert.equal(localStorage.getItem('pdbfe_user'), null);
    });

    it('keeps the session when /auth/me is unreachable', async () => {
        const { release } = returning('network');
        const { initAuth, isAuthenticated, profileReady } = await import('../../js/auth.js');
        await initAuth();
        release();
        assert.equal(await profileReady(), null);
        assert.equal(isAuthenticated(), true);
        assert.equal(localStorage.getItem('pdbfe_sid'), 'b'.repeat(64));
    });

    it('ignores a malformed cached user and waits for /auth/me instead', async () => {
        const { release } = returning(200);
        localStorage.setItem('pdbfe_user', '{"id":"x"}');
        const { initAuth, isAuthenticated } = await import('../../js/auth.js');
        let done = false;
        const p = initAuth().then(() => { done = true; });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(done, false, 'still waiting for /auth/me');
        release();
        await p;
        assert.equal(isAuthenticated(), true);
        assert.equal(JSON.parse(localStorage.getItem('pdbfe_user') ?? '{}').name, 'Seven', 'cached after validation');
    });

    it('logout clears the cached user', async () => {
        returning(200);
        const { initAuth, logout } = await import('../../js/auth.js');
        await initAuth();
        logout();
        assert.equal(localStorage.getItem('pdbfe_user'), null);
    });
});
