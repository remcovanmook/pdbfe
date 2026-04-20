/**
 * @fileoverview Unit tests for the OAuth2 factory (core/oauth.js) and the
 * PeeringDB-specific handler (auth/handlers/oauth.js).
 *
 * Tests are grouped by concern:
 *   - createOAuthHandler factory — CSRF / login redirect / callback flow
 *   - parsePeeringDbProfile      — profile validation and session mapping
 *   - handleAuth                 — method guard and routing
 *   - handleMe                   — session inspection endpoint
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthHandler } from '../../../core/oauth.js';
import { handleAuth } from '../../../auth/handlers/oauth.js';

/**
 * Normalises a fetch `input` argument to a plain string URL.
 * The first argument to `fetch` may be a string, URL object, or Request.
 *
 * @param {RequestInfo | URL} input
 * @returns {string}
 */
function urlString(input) {
    if (input instanceof Request) return input.url;
    if (input instanceof URL) return input.href;
    return String(input);
}

// ── Mock factories ───────────────────────────────────────────────────────────

/** @returns {KVNamespace} */
function mockKV(session = null) {
    const store = new Map();
    return /** @type {any} */ ({
        get(_key, _opts) { return Promise.resolve(session); },
        put(key, value, _opts) { store.set(key, value); return Promise.resolve(); },
        delete(key) { store.delete(key); return Promise.resolve(); },
        _store: store,
    });
}

/**
 * Builds a minimal mock PdbAuthEnv suitable for OAuth tests.
 *
 * @param {Object} [overrides]
 * @returns {PdbAuthEnv}
 */
function mockEnv(overrides = {}) {
    return /** @type {any} */ ({
        FRONTEND_ORIGIN:      'https://pdbfe.dev',
        OAUTH_CLIENT_ID:      'test-client-id',
        OAUTH_CLIENT_SECRET:  'test-client-secret',
        OAUTH_REDIRECT_URI:   'https://auth.pdbfe.dev/auth/callback',
        PEERINGDB_API_KEY:    'test-api-key',
        ALLOWED_ORIGINS:      'https://pdbfe.dev',
        SESSIONS:             mockKV(),
        ...overrides,
    });
}

/**
 * Builds a minimal OAuthHandlerConfig with stubs for required callbacks.
 *
 * @param {Object} [overrides]
 * @returns {import('../../../core/oauth.js').OAuthHandlerConfig}
 */
function minimalConfig(overrides = {}) {
    return {
        authorizeUrl: 'https://provider.example/oauth/authorize',
        tokenUrl:     'https://provider.example/oauth/token',
        profileUrl:   'https://provider.example/oauth/profile',
        scopes:       'openid profile',
        cookiePrefix: 'test',

        parseProfile: (profile) => ({
            valid: true,
            sessionData: { id: profile.sub, name: profile.name },
        }),

        getCorsHeaders: (_request, _env) => ({
            'Access-Control-Allow-Origin': 'https://pdbfe.dev',
        }),

        ...overrides,
    };
}

/**
 * Reads the value of a Set-Cookie header matching a given name prefix.
 *
 * @param {Response} response
 * @param {string} prefix
 * @returns {string|null}
 */
function getCookie(response, prefix) {
    for (const [header, value] of response.headers.entries()) {
        if (header === 'set-cookie' && value.startsWith(prefix)) {
            return value;
        }
    }
    return null;
}

/**
 * Parses the value portion of a Set-Cookie string.
 *
 * @param {string} cookieStr - Full Set-Cookie header value.
 * @returns {string}
 */
function cookieValue(cookieStr) {
    return cookieStr.split(';')[0].split('=').slice(1).join('=');
}

// ── createOAuthHandler — handleLogin ─────────────────────────────────────────

describe('createOAuthHandler / handleLogin', () => {
    it('redirects to the authorize URL with correct params', () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/login');

        const res = handler.handleLogin(req, env);

        assert.equal(res.status, 302);
        const location = new URL(res.headers.get('Location'));
        assert.equal(location.origin + location.pathname, 'https://provider.example/oauth/authorize');
        assert.equal(location.searchParams.get('client_id'), 'test-client-id');
        assert.equal(location.searchParams.get('response_type'), 'code');
        assert.equal(location.searchParams.get('scope'), 'openid profile');
        assert.ok(location.searchParams.get('state'), 'state nonce should be present');
        assert.equal(location.searchParams.get('redirect_uri'), 'https://auth.pdbfe.dev/auth/callback');
    });

    it('sets test_state and test_return cookies', () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/login');
        const res = handler.handleLogin(req, env);

        const stateCookie  = getCookie(res, 'test_state=');
        const returnCookie = getCookie(res, 'test_return=');

        assert.ok(stateCookie,  'test_state cookie should be set');
        assert.ok(returnCookie, 'test_return cookie should be set');
        assert.ok(stateCookie.includes('HttpOnly'));
        assert.ok(stateCookie.includes('Secure'));
    });

    it('uses the provided returnOrigin in the return cookie', () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/login');
        const res = handler.handleLogin(req, env, 'https://staging.pdbfe.dev');

        const returnCookie = getCookie(res, 'test_return=');
        assert.ok(returnCookie);
        assert.ok(decodeURIComponent(cookieValue(returnCookie)).includes('staging.pdbfe.dev'));
    });

    it('defaults return origin to FRONTEND_ORIGIN', () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/login');
        const res = handler.handleLogin(req, env);

        const returnCookie = getCookie(res, 'test_return=');
        assert.ok(decodeURIComponent(cookieValue(returnCookie)).includes('pdbfe.dev'));
    });
});

// ── createOAuthHandler — handleCallback CSRF ─────────────────────────────────

describe('createOAuthHandler / handleCallback — CSRF', () => {
    it('redirects with auth_error when state cookie is missing', async () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/callback?code=abc&state=xyz');

        const res = await handler.handleCallback(req, env);
        assert.equal(res.status, 302);
        const location = res.headers.get('Location');
        assert.ok(location.includes('auth_error'), `Expected auth_error, got: ${location}`);
    });

    it('redirects with auth_error when state nonce does not match', async () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/callback?code=abc&state=WRONG', {
            headers: { 'Cookie': 'test_state=CORRECT; test_return=https%3A%2F%2Fpdbfe.dev' },
        });

        const res = await handler.handleCallback(req, env);
        const location = res.headers.get('Location');
        assert.ok(location.includes('auth_error'));
        assert.ok(location.toLowerCase().includes('mismatch') || location.includes('CSRF'));
    });

    it('clears oauth cookies on state mismatch', async () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/callback?code=abc&state=WRONG', {
            headers: { 'Cookie': 'test_state=CORRECT; test_return=https%3A%2F%2Fpdbfe.dev' },
        });

        const res = await handler.handleCallback(req, env);
        const stateClear  = getCookie(res, 'test_state=;');
        const returnClear = getCookie(res, 'test_return=;');
        assert.ok(stateClear,  'test_state should be cleared');
        assert.ok(returnClear, 'test_return should be cleared');
    });

    it('redirects with auth_error when provider sends error param', async () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv();
        const req = new Request(
            'https://auth.pdbfe.dev/auth/callback?error=access_denied&error_description=User+denied',
            { headers: { 'Cookie': 'test_state=s; test_return=https%3A%2F%2Fpdbfe.dev' } }
        );

        const res = await handler.handleCallback(req, env);
        const location = res.headers.get('Location');
        assert.ok(location.includes('auth_error'));
        assert.ok(location.includes('User+denied') || location.includes('User%20denied'));
    });

    it('redirects with error when code or state param is missing', async () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/callback', {
            headers: { 'Cookie': 'test_state=abc; test_return=https%3A%2F%2Fpdbfe.dev' },
        });

        const res = await handler.handleCallback(req, env);
        const location = res.headers.get('Location');
        assert.ok(location.includes('auth_error'));
    });
});

// ── createOAuthHandler — handleCallback full flow ────────────────────────────

/**
 * Builds a config whose token and profile fetches are stubbed via
 * globalThis.fetch replacement.
 *
 * @param {object} [parseProfileOverride]
 * @returns {import('../../../core/oauth.js').OAuthHandlerConfig}
 */
function configWithFetchStubs(parseProfileOverride) {
    return minimalConfig({
        parseProfile: parseProfileOverride ?? ((profile) => ({
            valid: true,
            sessionData: { id: profile.sub, name: profile.name },
        })),
    });
}

describe('createOAuthHandler / handleCallback — token + session', () => {

    it('creates a session and redirects with sid on valid callback', async () => {
        const originalFetch = globalThis.fetch;
        let fetchCallCount = 0;

        globalThis.fetch = async (urlArg, opts) => {
            const url = urlString(urlArg);
            fetchCallCount++;
            if (url.includes('/oauth/token')) {
                return new Response(JSON.stringify({ access_token: 'tok123' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.includes('/oauth/profile')) {
                return new Response(JSON.stringify({ sub: '99', name: 'Alice' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return originalFetch(url, opts);
        };

        try {
            const handler = createOAuthHandler(configWithFetchStubs());
            const kv = mockKV();
            const env = mockEnv({ SESSIONS: kv });
            const req = new Request('https://auth.pdbfe.dev/auth/callback?code=CODE&state=NONCE', {
                headers: { 'Cookie': 'test_state=NONCE; test_return=https%3A%2F%2Fpdbfe.dev' },
            });

            const res = await handler.handleCallback(req, env);
            assert.equal(res.status, 302);
            const location = res.headers.get('Location');
            assert.ok(location.includes('sid='), `Expected sid in Location, got: ${location}`);
            assert.equal(fetchCallCount, 2, 'Should call token + profile endpoints');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('redirects with auth_error when token exchange fails', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (urlArg) => {
            const url = urlString(urlArg);
            if (url.includes('/oauth/token')) {
                return new Response('Unauthorized', { status: 401 });
            }
            return originalFetch(url);
        };

        try {
            const handler = createOAuthHandler(configWithFetchStubs());
            const env = mockEnv();
            const req = new Request('https://auth.pdbfe.dev/auth/callback?code=BAD&state=N', {
                headers: { 'Cookie': 'test_state=N; test_return=https%3A%2F%2Fpdbfe.dev' },
            });

            const res = await handler.handleCallback(req, env);
            const location = res.headers.get('Location');
            assert.ok(location.includes('auth_error'));
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('redirects with auth_error when parseProfile rejects', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (urlArg) => {
            const url = urlString(urlArg);
            if (url.includes('/oauth/token')) {
                return new Response(JSON.stringify({ access_token: 'tok' }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.includes('/oauth/profile')) {
                return new Response(JSON.stringify({ sub: '1', verified_user: false }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response('', { status: 500 });
        };

        try {
            const handler = createOAuthHandler(minimalConfig({
                parseProfile: (profile) => profile.verified_user
                    ? { valid: true, sessionData: {} }
                    : { valid: false, error: 'Not verified' },
            }));
            const env = mockEnv();
            const req = new Request('https://auth.pdbfe.dev/auth/callback?code=C&state=S', {
                headers: { 'Cookie': 'test_state=S; test_return=https%3A%2F%2Fpdbfe.dev' },
            });

            const res = await handler.handleCallback(req, env);
            const location = res.headers.get('Location');
            assert.ok(location.includes('auth_error'));
            assert.ok(location.includes('Not+verified') || location.includes('Not%20verified'));
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

// ── createOAuthHandler — handleLogout ────────────────────────────────────────

describe('createOAuthHandler / handleLogout', () => {
    it('redirects to FRONTEND_ORIGIN', async () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/logout');

        const res = await handler.handleLogout(req, env);
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('Location'), 'https://pdbfe.dev');
    });

    it('deletes the session from KV when sid is present', async () => {
        let deletedKey = null;
        const kv = /** @type {any} */ ({
            get: () => Promise.resolve(null),
            put: () => Promise.resolve(),
            delete: (key) => { deletedKey = key; return Promise.resolve(); },
        });

        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv({ SESSIONS: kv });
        const req = new Request('https://auth.pdbfe.dev/auth/logout', {
            headers: { 'Authorization': 'Bearer deadbeef' },
        });

        await handler.handleLogout(req, env);
        assert.ok(deletedKey, 'KV delete should have been called');
        assert.ok(deletedKey.includes('deadbeef'), `Expected sid in deleted key, got: ${deletedKey}`);
    });
});

// ── createOAuthHandler — handleMe ────────────────────────────────────────────

describe('createOAuthHandler / handleMe', () => {
    it('returns 401 when no session exists', async () => {
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/auth/me');

        const res = await handler.handleMe(req, env);
        assert.equal(res.status, 401);
        const body = await res.json();
        assert.equal(body.authenticated, false);
    });

    it('returns authenticated session data', async () => {
        const session = { id: 42, name: 'Test User' };
        const handler = createOAuthHandler(minimalConfig());
        const env = mockEnv({ SESSIONS: mockKV(session) });
        const req = new Request('https://auth.pdbfe.dev/auth/me', {
            headers: { 'Authorization': 'Bearer some-valid-sid' },
        });

        const res = await handler.handleMe(req, env);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.authenticated, true);
        assert.equal(body.user.id, 42);
    });

    it('includes getCorsHeaders in response', async () => {
        const handler = createOAuthHandler(minimalConfig({
            getCorsHeaders: (_req, _env) => ({
                'Access-Control-Allow-Origin': 'https://pdbfe.dev',
                'Access-Control-Allow-Credentials': 'true',
            }),
        }));
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/auth/me');

        const res = await handler.handleMe(req, env);
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://pdbfe.dev');
    });
});

// ── handleAuth (auth worker) ─────────────────────────────────────────────────

describe('handleAuth', () => {
    it('returns 405 for non-GET methods', async () => {
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/login', { method: 'POST' });
        const res = await handleAuth(req, env);
        assert.equal(res.status, 405);
    });

    it('handles OPTIONS preflight', async () => {
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/login', {
            method: 'OPTIONS',
            headers: { 'Origin': 'https://pdbfe.dev' },
        });
        const res = handleAuth(req, env);
        // Preflight returns 204 or 200
        assert.ok(res.status === 204 || res.status === 200, `Expected 2xx, got ${res.status}`);
    });

    it('routes /auth/login to a 302 redirect', () => {
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/login');
        const res = handleAuth(req, env);
        assert.equal(res.status, 302);
        const location = res.headers.get('Location');
        assert.ok(location.includes('auth.peeringdb.com'), `Expected PDB authorize URL, got: ${location}`);
    });

    it('includes pdbfe_oauth_state cookie on login', () => {
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/login');
        const res = handleAuth(req, env);
        const stateCookie = getCookie(res, 'pdbfe_oauth_state=');
        assert.ok(stateCookie, 'pdbfe_oauth_state cookie should be set');
    });

    it('routes /auth/me to 401 when unauthenticated', async () => {
        const env = mockEnv({ SESSIONS: mockKV(null) });
        const req = new Request('https://auth.pdbfe.dev/auth/me');
        const res = await handleAuth(req, env);
        assert.equal(res.status, 401);
    });

    it('returns 404 for unknown paths', async () => {
        const env = mockEnv();
        const req = new Request('https://auth.pdbfe.dev/auth/unknown');
        const res = await handleAuth(req, env);
        assert.equal(res.status, 404);
    });
});

// ── PeeringDB profile parsing ─────────────────────────────────────────────────

describe('PeeringDB handleAuth / profile parsing', () => {
    it('rejects unverified users via auth_error redirect', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (urlArg) => {
            const url = urlString(urlArg);
            if (url.includes('oauth2/token')) {
                return new Response(JSON.stringify({ access_token: 'tok' }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.includes('profile/v1')) {
                return new Response(JSON.stringify({ id: 1, verified_user: false }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response('', { status: 500 });
        };

        try {
            const env = mockEnv();
            const req = new Request('https://auth.pdbfe.dev/auth/callback?code=C&state=S', {
                headers: { 'Cookie': 'pdbfe_oauth_state=S; pdbfe_oauth_return=https%3A%2F%2Fpdbfe.dev' },
            });

            const res = await handleAuth(req, env);
            const location = res.headers.get('Location');
            assert.ok(location.includes('auth_error'), `Expected auth_error, got: ${location}`);
            assert.ok(
                location.includes('verified') || location.includes('not+verified'),
                `Expected 'verified' in error message, got: ${location}`
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('maps PeeringDB profile fields to session data on success', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (urlArg) => {
            const url = urlString(urlArg);
            if (url.includes('oauth2/token')) {
                return new Response(JSON.stringify({ access_token: 'tok' }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                });
            }
            if (url.includes('profile/v1')) {
                return new Response(JSON.stringify({
                    id: 42,
                    name: 'Alice Operator',
                    given_name: 'Alice',
                    family_name: 'Operator',
                    email: 'alice@example.com',
                    verified_user: true,
                    verified_email: true,
                    networks: [{ id: 1, name: 'AS64496' }],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('', { status: 500 });
        };

        try {
            const kv = mockKV();
            const env = mockEnv({ SESSIONS: kv });
            const req = new Request('https://auth.pdbfe.dev/auth/callback?code=C&state=S', {
                headers: { 'Cookie': 'pdbfe_oauth_state=S; pdbfe_oauth_return=https%3A%2F%2Fpdbfe.dev' },
            });

            const res = await handleAuth(req, env);
            assert.equal(res.status, 302);
            const location = res.headers.get('Location');
            assert.ok(location.includes('sid='), `Expected sid in redirect, got: ${location}`);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
