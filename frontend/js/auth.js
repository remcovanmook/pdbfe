/**
 * @fileoverview Frontend authentication state management.
 *
 * Handles OAuth session tokens received from the pdbfe-auth worker.
 * The auth callback redirects to the frontend with a URL fragment
 * containing the session ID (#sid=<token>). This module:
 *
 *   1. Checks the URL fragment on page load for a new session token
 *   2. Stores the token in localStorage
 *   3. Verifies the session via GET /auth/me on the auth worker
 *   4. Fetches the user profile (including preferences and favorites)
 *   5. Applies server-side language preference if set
 *   6. Updates the header UI to show login/logout state
 *
 * Favorites work for both anonymous and authenticated users:
 *   - Anonymous: stored in localStorage under 'pdbfe_favorites'
 *   - Authenticated: stored server-side in D1 via the auth worker
 *   - On login, any localStorage favorites are merged into D1 and
 *     the local copy is cleared
 *
 * The session ID is sent to the API worker as an Authorization: Bearer
 * header on API requests that need authenticated access.
 */

import { AUTH_ORIGIN } from './config.js';
import { clearCache } from './api.js';
import { t, setLanguage, getCurrentLang, LANGUAGES } from './i18n.js';

/** @type {string} localStorage key for the session token. */
const STORAGE_KEY = 'pdbfe_sid';

/** @type {string} localStorage key for anonymous favorites. */
const LOCAL_FAVS_KEY = 'pdbfe_favorites';

/** @type {number} Maximum favorites for anonymous users (same as server cap). */
const MAX_LOCAL_FAVORITES = 50;

/** @type {number} Maximum label length stored in favorites. */
const MAX_LABEL_LENGTH = 200;

/**
 * Allowed entity types for favorites. Must match the server-side
 * VALID_FAVORITE_TYPES set in account.js.
 *
 * @type {Set<string>}
 */
const VALID_ENTITY_TYPES = new Set(['net', 'ix', 'fac', 'org', 'carrier', 'campus']);

/**
 * Expected format for session IDs: 64 lowercase hex characters,
 * matching the output of generateSessionId() in the auth worker.
 * Used to reject malformed or injected sid query parameters.
 *
 * @type {RegExp}
 */
const SID_PATTERN = /^[0-9a-f]{64}$/;

/** @type {string|null} Cached session ID for the current page load. */
let _cachedSid = null;

/** @type {SessionData|null} Cached user profile for the current page load. */
let _cachedUser = null;

/**
 * In-memory favorites cache. Populated from localStorage (anonymous)
 * or from the profile fetch (authenticated). Updated optimistically
 * on add/remove. Keyed as "type:id" strings for O(1) lookups.
 *
 * @type {Set<string>}
 */
const _favoritesSet = new Set();

/**
 * Full favorites list (with labels and timestamps) for rendering.
 *
 * @type {Array<{entity_type: string, entity_id: number, label: string, created_at: string}>}
 */
let _favoritesList = [];

// ── localStorage helpers for anonymous favorites ─────────────────────────────

/**
 * Validates and normalises a single favorite entry. Returns null if the
 * entry is malformed or contains an invalid entity type. Treats the input
 * as untrusted — localStorage can be modified by browser extensions,
 * devtools, or other scripts on the same origin.
 *
 * @param {any} entry - Raw parsed entry from localStorage.
 * @returns {{entity_type: string, entity_id: number, label: string, created_at: string}|null}
 */
function _sanitizeFavorite(entry) {
    if (typeof entry !== 'object' || entry === null) return null;

    const entityType = entry.entity_type;
    if (typeof entityType !== 'string' || !VALID_ENTITY_TYPES.has(entityType)) return null;

    const entityId = Number(entry.entity_id);
    if (!Number.isInteger(entityId) || entityId <= 0) return null;

    // Label: coerce to string, truncate, strip control characters
    const rawLabel = typeof entry.label === 'string' ? entry.label : '';
    const label = rawLabel.replace(/[\x00-\x1f]/g, '').trim().slice(0, MAX_LABEL_LENGTH);

    // created_at: coerce to string, fall back to epoch
    const createdAt = typeof entry.created_at === 'string' ? entry.created_at : new Date(0).toISOString();

    return { entity_type: entityType, entity_id: entityId, label, created_at: createdAt };
}

/**
 * Reads favorites from localStorage, validates each entry, and drops
 * any malformed rows. Returns an empty array on parse failure or if
 * the key doesn't exist.
 *
 * @returns {Array<{entity_type: string, entity_id: number, label: string, created_at: string}>}
 */
function _readLocalFavorites() {
    try {
        const raw = localStorage.getItem(LOCAL_FAVS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];

        /** @type {Array<{entity_type: string, entity_id: number, label: string, created_at: string}>} */
        const valid = [];
        const seen = new Set();
        for (const entry of parsed) {
            const clean = _sanitizeFavorite(entry);
            if (!clean) continue;
            // Deduplicate (in case localStorage was hand-edited)
            const key = `${clean.entity_type}:${clean.entity_id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            valid.push(clean);
            if (valid.length >= MAX_LOCAL_FAVORITES) break;
        }
        return valid;
    } catch {
        return [];
    }
}

/**
 * Writes the current _favoritesList to localStorage.
 * Only called for anonymous users.
 */
function _writeLocalFavorites() {
    try {
        localStorage.setItem(LOCAL_FAVS_KEY, JSON.stringify(_favoritesList));
    } catch {
        // localStorage full or disabled — fail silently
    }
}

/**
 * Clears localStorage favorites. Called after merging into D1
 * on authenticated login.
 */
function _clearLocalFavorites() {
    localStorage.removeItem(LOCAL_FAVS_KEY);
}

/**
 * Populates the in-memory cache from localStorage.
 * Called during initAuth when the user is not authenticated.
 */
function _loadLocalFavorites() {
    _favoritesList = _readLocalFavorites();
    _favoritesSet.clear();
    for (const f of _favoritesList) {
        _favoritesSet.add(`${f.entity_type}:${f.entity_id}`);
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialises the auth module. Should be called once during page boot.
 *
 * 1. Checks URL fragment for a new session token from OAuth callback
 * 2. Clears the fragment from the URL bar (keeps it out of browser history)
 * 3. Validates the session against the auth worker
 * 4. Fetches the user profile (preferences, favorites) from the account API
 * 5. Merges any localStorage favorites into the server-side store
 * 6. Applies server-side language preference if it differs from the current locale
 * 7. Updates the header UI
 *
 * For anonymous users, loads favorites from localStorage instead.
 */
export async function initAuth() {
    // Check for session token in URL query params (from OAuth callback redirect).
    // Query params are used instead of URL fragments because Cloudflare Access
    // strips fragments during its auth redirect chain.
    const urlParams = new URLSearchParams(globalThis.location.search);

    const sid = urlParams.get('sid');
    if (sid && SID_PATTERN.test(sid)) {
        localStorage.setItem(STORAGE_KEY, sid);
        // Clean the query param from the URL without triggering a page reload
        history.replaceState(null, '', globalThis.location.pathname);
    }

    const authError = urlParams.get('auth_error');
    if (authError) {
        console.warn('Auth error:', authError);
        history.replaceState(null, '', globalThis.location.pathname);
    }

    // Load cached session ID
    _cachedSid = localStorage.getItem(STORAGE_KEY);

    // Validate session if we have one
    if (_cachedSid) {
        _cachedUser = await validateSession(_cachedSid);
        if (_cachedUser) {
            // Auth state changed — flush stale anonymous API responses
            clearCache();

            // Fetch the D1-backed profile to pick up preferences and favorites.
            // This enriches _cachedUser with server-side data not in the KV session.
            await _fetchProfile(_cachedSid);
        } else {
            // Session expired or invalid — clear it
            localStorage.removeItem(STORAGE_KEY);
            _cachedSid = null;
        }
    }

    // If not authenticated, load favorites from localStorage
    if (!isAuthenticated()) {
        _loadLocalFavorites();
    }

    renderAuthUI();
}

/**
 * Returns the current session ID, or null if not logged in.
 * Used by the API module to attach Authorization headers.
 *
 * @returns {string|null} The session ID.
 */
export function getSessionId() {
    return _cachedSid;
}

/**
 * Returns the cached user profile, or null if not logged in.
 *
 * @returns {SessionData|null} The user profile data.
 */
export function getUser() {
    return _cachedUser;
}

/**
 * Returns true if the user is currently authenticated.
 *
 * @returns {boolean}
 */
export function isAuthenticated() {
    return _cachedSid !== null && _cachedUser !== null;
}

/**
 * Returns the full favorites list for rendering.
 * Works for both anonymous (localStorage) and authenticated (D1) users.
 *
 * @returns {Array<{entity_type: string, entity_id: number, label: string, created_at: string}>}
 */
export function getFavorites() {
    return _favoritesList;
}

/**
 * Checks if a given entity is in the user's favorites.
 * O(1) lookup against the in-memory Set. Works for both
 * anonymous and authenticated users.
 *
 * @param {string} entityType - Entity type tag (net, ix, fac, etc.).
 * @param {number} entityId - Entity ID.
 * @returns {boolean}
 */
export function isFavorite(entityType, entityId) {
    return _favoritesSet.has(`${entityType}:${entityId}`);
}

/**
 * Adds an entity to the user's favorites.
 *
 * - Authenticated: optimistic cache update + POST to auth worker;
 *   rolls back on failure.
 * - Anonymous: writes directly to localStorage (synchronous, always
 *   succeeds unless storage is full).
 *
 * @param {string} entityType - Entity type tag.
 * @param {number} entityId - Entity ID.
 * @param {string} label - Display label for the entity.
 * @returns {Promise<boolean>} True on success.
 */
export async function addFavorite(entityType, entityId, label) {
    // Validate inputs before they touch localStorage or the network
    if (!VALID_ENTITY_TYPES.has(entityType)) return false;
    entityId = Number(entityId);
    if (!Number.isInteger(entityId) || entityId <= 0) return false;
    label = (typeof label === 'string' ? label : '')
        .replace(/[\x00-\x1f]/g, '').trim().slice(0, MAX_LABEL_LENGTH);

    const key = `${entityType}:${entityId}`;
    if (_favoritesSet.has(key)) return true; // already favorited

    const entry = { entity_type: entityType, entity_id: entityId, label, created_at: new Date().toISOString() };

    // Anonymous path: localStorage only
    if (!_cachedSid) {
        if (_favoritesList.length >= MAX_LOCAL_FAVORITES) return false;
        _favoritesSet.add(key);
        _favoritesList.unshift(entry);
        _writeLocalFavorites();
        return true;
    }

    // Authenticated path: optimistic update + server POST
    _favoritesSet.add(key);
    _favoritesList.unshift(entry);

    try {
        const res = await fetch(`${AUTH_ORIGIN}/account/favorites`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${_cachedSid}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ entity_type: entityType, entity_id: entityId, label }),
        });
        if (!res.ok) {
            // Roll back
            _favoritesSet.delete(key);
            _favoritesList = _favoritesList.filter(f => !(f.entity_type === entityType && f.entity_id === entityId));
            return false;
        }
        return true;
    } catch {
        // Roll back on network error
        _favoritesSet.delete(key);
        _favoritesList = _favoritesList.filter(f => !(f.entity_type === entityType && f.entity_id === entityId));
        return false;
    }
}

/**
 * Removes an entity from the user's favorites.
 *
 * - Authenticated: optimistic cache update + DELETE to auth worker;
 *   rolls back on failure.
 * - Anonymous: removes directly from localStorage.
 *
 * @param {string} entityType - Entity type tag.
 * @param {number} entityId - Entity ID.
 * @returns {Promise<boolean>} True on success.
 */
export async function removeFavorite(entityType, entityId) {
    const key = `${entityType}:${entityId}`;
    if (!_favoritesSet.has(key)) return true; // already not favorited

    // Save for rollback (authenticated path)
    const oldEntry = _favoritesList.find(f => f.entity_type === entityType && f.entity_id === entityId);

    // Anonymous path: localStorage only
    if (!_cachedSid) {
        _favoritesSet.delete(key);
        _favoritesList = _favoritesList.filter(f => !(f.entity_type === entityType && f.entity_id === entityId));
        _writeLocalFavorites();
        return true;
    }

    // Authenticated path: optimistic update + server DELETE
    _favoritesSet.delete(key);
    _favoritesList = _favoritesList.filter(f => !(f.entity_type === entityType && f.entity_id === entityId));

    try {
        const res = await fetch(`${AUTH_ORIGIN}/account/favorites/${entityType}/${entityId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${_cachedSid}` },
        });
        if (!res.ok) {
            // Roll back
            _favoritesSet.add(key);
            if (oldEntry) _favoritesList.unshift(oldEntry);
            return false;
        }
        return true;
    } catch {
        // Roll back on network error
        _favoritesSet.add(key);
        if (oldEntry) _favoritesList.unshift(oldEntry);
        return false;
    }
}

/**
 * Logs the user out by clearing the local session and redirecting
 * to the auth worker's logout endpoint (which deletes the KV entry).
 * Server-side favorites remain in D1 for the next login.
 * The in-memory cache is repopulated from localStorage (which may
 * be empty if the user had no anonymous favorites before login).
 */
export function logout() {
    const sid = _cachedSid;
    localStorage.removeItem(STORAGE_KEY);
    _cachedSid = null;
    _cachedUser = null;
    _favoritesSet.clear();
    _favoritesList = [];
    clearCache();

    // Reload anonymous favorites from localStorage (may be empty)
    _loadLocalFavorites();

    renderAuthUI();

    // Redirect to auth worker logout to clean up KV
    if (sid) {
        globalThis.location.href = `${AUTH_ORIGIN}/auth/logout`;
    }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Validates a session ID by calling the auth worker's /auth/me endpoint.
 * Returns the user profile on success, or null if the session is invalid.
 *
 * @param {string} sid - The session ID to validate.
 * @returns {Promise<SessionData|null>} User profile or null.
 */
async function validateSession(sid) {
    try {
        const response = await fetch(`${AUTH_ORIGIN}/auth/me`, {
            headers: { 'Authorization': `Bearer ${sid}` },
        });

        if (!response.ok) return null;

        const data = await response.json();
        if (data.authenticated && data.user) {
            return /** @type {SessionData} */ (data.user);
        }
        return null;
    } catch (err) {
        console.warn('Session validation failed:', err);
        return null;
    }
}

/**
 * Fetches the user profile from the auth worker's /account/profile
 * endpoint. Enriches _cachedUser with server-side preferences, and
 * loads the favorites list. If the server has a language preference
 * that differs from the current locale, applies it.
 *
 * Also merges any localStorage favorites into the server-side store
 * (fire-and-forget POSTs for each local favorite not already present
 * on the server). After merging, the localStorage copy is cleared.
 *
 * @param {string} sid - The session ID.
 */
async function _fetchProfile(sid) {
    try {
        const [profileRes, favsRes] = await Promise.all([
            fetch(`${AUTH_ORIGIN}/account/profile`, {
                headers: { 'Authorization': `Bearer ${sid}` },
            }),
            fetch(`${AUTH_ORIGIN}/account/favorites`, {
                headers: { 'Authorization': `Bearer ${sid}` },
            }),
        ]);

        // Profile
        if (profileRes.ok) {
            const profile = await profileRes.json();
            if (_cachedUser && profile.preferences) {
                _cachedUser.preferences = profile.preferences;

                // Apply server-side language preference if it differs from
                // the current locale. This makes the preference follow the
                // user across browsers/devices.
                const serverLang = profile.preferences.language;
                if (serverLang && serverLang in LANGUAGES && serverLang !== getCurrentLang()) {
                    await setLanguage(serverLang);
                    // Also update localStorage so the footer selector and
                    // subsequent page loads use the right locale without
                    // waiting for the profile fetch.
                    localStorage.setItem('pdbfe-lang', serverLang);
                }
            }
        }

        // Server favorites → in-memory cache
        if (favsRes.ok) {
            const favsData = await favsRes.json();
            _favoritesList = favsData.favorites || [];
            _favoritesSet.clear();
            for (const f of _favoritesList) {
                _favoritesSet.add(`${f.entity_type}:${f.entity_id}`);
            }
        }

        // Merge localStorage favorites into server (one-time on login)
        await _mergeLocalFavorites(sid);

    } catch (err) {
        console.warn('Profile/favorites fetch failed:', err);
    }
}

/**
 * Merges any anonymous localStorage favorites into the authenticated
 * user's server-side store. For each local favorite not already present
 * on the server, fires a POST. After processing, clears localStorage.
 *
 * This is a best-effort merge — individual POST failures are logged
 * but don't block the login flow.
 *
 * @param {string} sid - The session ID.
 */
async function _mergeLocalFavorites(sid) {
    const localFavs = _readLocalFavorites();
    if (localFavs.length === 0) return;

    // Find favorites that exist locally but not on the server
    const toMerge = localFavs.filter(f => !_favoritesSet.has(`${f.entity_type}:${f.entity_id}`));

    if (toMerge.length > 0) {
        // Fire-and-forget POSTs in parallel
        const results = await Promise.allSettled(
            toMerge.map(f =>
                fetch(`${AUTH_ORIGIN}/account/favorites`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${sid}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        entity_type: f.entity_type,
                        entity_id: f.entity_id,
                        label: f.label,
                    }),
                })
            )
        );

        // Add merged favorites to in-memory cache
        for (let i = 0; i < toMerge.length; i++) {
            const result = results[i];
            if (result.status === 'fulfilled' && result.value.ok) {
                const f = toMerge[i];
                const key = `${f.entity_type}:${f.entity_id}`;
                if (!_favoritesSet.has(key)) {
                    _favoritesSet.add(key);
                    _favoritesList.push(f);
                }
            }
        }
    }

    // Clear localStorage regardless — server is now the source of truth
    _clearLocalFavorites();
}

/**
 * Updates the header UI to reflect the current auth state.
 * Shows either a "Sign in" link or the user's name + "Account" + "Sign out".
 * All user data goes through textContent.
 */
function renderAuthUI() {
    const container = document.getElementById('auth-container');
    if (!container) return;

    if (_cachedUser) {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'auth-user';
        nameSpan.textContent = _cachedUser.given_name || _cachedUser.name;

        const accountLink = document.createElement('a');
        accountLink.href = '/account';
        accountLink.className = 'auth-link';
        accountLink.dataset.link = '';
        accountLink.textContent = t('Account');

        const logoutLink = document.createElement('a');
        logoutLink.href = '#';
        logoutLink.className = 'auth-link';
        logoutLink.textContent = t('Sign out');
        logoutLink.addEventListener('click', (e) => {
            e.preventDefault();
            logout();
        });

        container.replaceChildren(nameSpan, accountLink, logoutLink);
    } else {
        const loginLink = document.createElement('a');
        loginLink.href = `${AUTH_ORIGIN}/auth/login`;
        loginLink.className = 'auth-link';
        loginLink.textContent = t('Sign in with PeeringDB');

        container.replaceChildren(loginLink);
    }
}
