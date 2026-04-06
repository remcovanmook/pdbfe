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
 *   4. Updates the header UI to show login/logout state
 *
 * The session ID is sent to the API worker as an Authorization: Bearer
 * header on API requests that need authenticated access.
 */

import { AUTH_ORIGIN } from '/js/config.js';

/** @type {string} localStorage key for the session token. */
const STORAGE_KEY = 'pdbfe_sid';

/** @type {string|null} Cached session ID for the current page load. */
let _cachedSid = null;

/** @type {SessionData|null} Cached user profile for the current page load. */
let _cachedUser = null;

/**
 * Initialises the auth module. Should be called once during page boot.
 *
 * 1. Checks URL fragment for a new session token from OAuth callback
 * 2. Clears the fragment from the URL bar (keeps it out of browser history)
 * 3. Validates the session against the auth worker
 * 4. Updates the header UI
 */
export async function initAuth() {
    // Check for session token in URL query params (from OAuth callback redirect).
    // Query params are used instead of URL fragments because Cloudflare Access
    // strips fragments during its auth redirect chain.
    const urlParams = new URLSearchParams(window.location.search);

    const sid = urlParams.get('sid');
    if (sid) {
        localStorage.setItem(STORAGE_KEY, sid);
        // Clean the query param from the URL without triggering a page reload
        history.replaceState(null, '', window.location.pathname);
    }

    const authError = urlParams.get('auth_error');
    if (authError) {
        console.warn('Auth error:', authError);
        history.replaceState(null, '', window.location.pathname);
    }

    // Load cached session ID
    _cachedSid = localStorage.getItem(STORAGE_KEY);

    // Validate session if we have one
    if (_cachedSid) {
        _cachedUser = await validateSession(_cachedSid);
        if (!_cachedUser) {
            // Session expired or invalid — clear it
            localStorage.removeItem(STORAGE_KEY);
            _cachedSid = null;
        }
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
 * Logs the user out by clearing the local session and redirecting
 * to the auth worker's logout endpoint (which deletes the KV entry).
 */
export function logout() {
    const sid = _cachedSid;
    localStorage.removeItem(STORAGE_KEY);
    _cachedSid = null;
    _cachedUser = null;
    renderAuthUI();

    // Redirect to auth worker logout to clean up KV
    // Pass the session ID as a Bearer token so the auth worker can delete it
    if (sid) {
        window.location.href = `${AUTH_ORIGIN}/auth/logout`;
    }
}

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
 * Updates the header UI to reflect the current auth state.
 * Shows either a "Sign in" link or the user's name + "Sign out".
 */
function renderAuthUI() {
    const container = document.getElementById('auth-container');
    if (!container) return;

    if (_cachedUser) {
        container.innerHTML = `
            <span class="auth-user">${escapeHtml(_cachedUser.given_name || _cachedUser.name)}</span>
            <a href="/account" class="auth-link" data-link>Account</a>
            <a href="#" id="auth-logout" class="auth-link">Sign out</a>
        `;
        const logoutLink = document.getElementById('auth-logout');
        if (logoutLink) {
            logoutLink.addEventListener('click', (e) => {
                e.preventDefault();
                logout();
            });
        }
    } else {
        const loginUrl = `${AUTH_ORIGIN}/auth/login`;
        container.innerHTML = `
            <a href="${loginUrl}" class="auth-link">Sign in with PeeringDB</a>
        `;
    }
}

/**
 * HTML-escapes a string to prevent XSS when inserting user-supplied
 * text into the DOM via innerHTML.
 *
 * @param {string} str - The string to escape.
 * @returns {string} The escaped string.
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}
