/**
 * @fileoverview Router for the pdbfe-auth worker.
 *
 * Handles the OAuth2 login flow with PeeringDB (auth.peeringdb.com)
 * and account management for user profiles and API keys:
 *
 *   /auth/login             → Redirect to PeeringDB authorize page
 *   /auth/callback          → Exchange code, create session, redirect to frontend
 *   /auth/logout            → Delete session, redirect to frontend
 *   /auth/me                → Return current session data as JSON
 *
 *   /account/profile   GET  → Return user profile
 *   /account/profile   PUT  → Update user profile
 *   /account/keys      GET  → List API keys
 *   /account/keys      POST → Create API key
 *   /account/keys/:id  DELETE → Revoke API key
 *
 * Session state lives in the SESSIONS KV namespace (shared with pdbfe-api).
 * User profiles and API keys live in the USERDB D1 database.
 */

import {
    handleLogin,
    handleCallback,
    handleLogout,
    handleMe,
    handleAuthPreflight,
} from './oauth.js';

import {
    handleGetProfile,
    handleUpdateProfile,
    handlePreferenceOptions,
    handleListKeys,
    handleCreateKey,
    handleDeleteKey,
    handleListFavorites,
    handleAddFavorite,
    handleRemoveFavorite,
    handleAccountPreflight,
} from './account.js';

/**
 * Routes incoming requests to the appropriate handler.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @param {ExecutionContext} _ctx - Worker execution context (unused).
 * @returns {Promise<Response>} The HTTP response.
 */
async function handleRequest(request, env, _ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
        if (path.startsWith('/account')) {
            return handleAccountPreflight(env);
        }
        return handleAuthPreflight(env);
    }

    // Validate required environment variables early
    if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET) {
        console.error('Missing OAUTH_CLIENT_ID or OAUTH_CLIENT_SECRET secrets');
        return new Response(
            JSON.stringify({ error: 'Auth worker is not configured' }) + '\n',
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // ── Auth routes (GET only) ──────────────────────────────────────────

    if (path.startsWith('/auth/')) {
        if (request.method !== 'GET') {
            return new Response(
                JSON.stringify({ error: 'Method not allowed' }) + '\n',
                { status: 405, headers: { 'Content-Type': 'application/json', 'Allow': 'GET, OPTIONS' } }
            );
        }

        switch (path) {
            case '/auth/login':    return handleLogin(request, env);
            case '/auth/callback': return handleCallback(request, env);
            case '/auth/logout':   return handleLogout(request, env);
            case '/auth/me':       return handleMe(request, env);
        }
    }

    // ── Account routes (mixed methods) ──────────────────────────────────

    // Public: preference options (no auth required)
    if (path === '/account/preferences/options' && request.method === 'GET') {
        return handlePreferenceOptions(request, env);
    }

    if (path === '/account/profile') {
        if (request.method === 'GET')  return handleGetProfile(request, env);
        if (request.method === 'PUT')  return handleUpdateProfile(request, env);
        return methodNotAllowed('GET, PUT, OPTIONS');
    }

    if (path === '/account/keys') {
        if (request.method === 'GET')  return handleListKeys(request, env);
        if (request.method === 'POST') return handleCreateKey(request, env);
        return methodNotAllowed('GET, POST, OPTIONS');
    }

    // DELETE /account/keys/:id
    if (path.startsWith('/account/keys/') && request.method === 'DELETE') {
        const keyId = path.slice('/account/keys/'.length);
        if (!keyId || keyId.includes('/')) {
            return new Response(
                JSON.stringify({ error: 'Invalid key ID' }) + '\n',
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        return handleDeleteKey(request, env, keyId);
    }

    // ── Favorites routes ────────────────────────────────────────────────

    if (path === '/account/favorites') {
        if (request.method === 'GET')  return handleListFavorites(request, env);
        if (request.method === 'POST') return handleAddFavorite(request, env);
        return methodNotAllowed('GET, POST, OPTIONS');
    }

    // DELETE /account/favorites/:type/:id
    if (path.startsWith('/account/favorites/') && request.method === 'DELETE') {
        const rest = path.slice('/account/favorites/'.length);
        const slashIdx = rest.indexOf('/');
        if (slashIdx < 1 || slashIdx === rest.length - 1) {
            return new Response(
                JSON.stringify({ error: 'Invalid favorites path, expected /account/favorites/:type/:id' }) + '\n',
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        const entityType = rest.slice(0, slashIdx);
        const entityId = rest.slice(slashIdx + 1);
        if (entityId.includes('/')) {
            return new Response(
                JSON.stringify({ error: 'Invalid favorites path' }) + '\n',
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }
        return handleRemoveFavorite(request, env, entityType, entityId);
    }

    // ── Default ─────────────────────────────────────────────────────────

    return new Response(
        JSON.stringify({ error: 'Not found' }) + '\n',
        { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
}

/**
 * Returns a 405 Method Not Allowed response with the given Allow header.
 *
 * @param {string} allow - Comma-separated list of allowed methods.
 * @returns {Response}
 */
function methodNotAllowed(allow) {
    return new Response(
        JSON.stringify({ error: 'Method not allowed' }) + '\n',
        { status: 405, headers: { 'Content-Type': 'application/json', 'Allow': allow } }
    );
}

export default {
    /**
     * Cloudflare Workers fetch handler entry point.
     *
     * @param {Request} request - The inbound HTTP request.
     * @param {PdbAuthEnv} env - Auth worker environment bindings.
     * @param {ExecutionContext} ctx - Worker execution context.
     * @returns {Promise<Response>} The HTTP response.
     */
    async fetch(request, env, ctx) {
        try {
            return await handleRequest(request, env, ctx);
        } catch (err) {
            console.error('Auth worker unhandled error:', err);
            return new Response(
                JSON.stringify({ error: 'Internal server error' }) + '\n',
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }
    },
};
