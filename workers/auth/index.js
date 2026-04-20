/**
 * @fileoverview Router for the pdbfe-auth worker.
 *
 * Dispatches requests to handler modules. Each handler owns its own
 * HTTP method validation and sub-path parsing — the router is
 * responsible only for top-level path prefix matching.
 *
 *   /auth/*                          → handleAuth
 *   /account/preferences/options     → handlePreferences
 *   /account/profile                 → handleProfile
 *   /account/keys[/*]                → handleKeys
 *   /account/favorites[/*]           → handleFavorites
 *
 * Session state lives in the SESSIONS KV namespace (shared with pdbfe-api).
 * User profiles and API keys live in the USERDB D1 database.
 */

import {
    handleAuth,
    handlePreferences,
    handleProfile,
    handleKeys,
    handleFavorites,
} from './handlers/index.js';

import { wrapHandler } from '../core/admin.js';

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

    // Validate required environment variables early
    if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET) {
        console.error('Missing OAUTH_CLIENT_ID or OAUTH_CLIENT_SECRET secrets');
        return new Response(
            JSON.stringify({ error: 'Auth worker is not configured' }) + '\n',
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // ── Auth routes ─────────────────────────────────────────────────────

    if (path.startsWith('/auth/')) return handleAuth(request, env, path);

    // ── Account routes ──────────────────────────────────────────────────

    if (path === '/account/preferences/options') return handlePreferences(request, env);
    if (path === '/account/profile')             return handleProfile(request, env);

    if (path === '/account/keys' || path.startsWith('/account/keys/'))
        return handleKeys(request, env, path.slice('/account/keys'.length));

    if (path === '/account/favorites' || path.startsWith('/account/favorites/'))
        return handleFavorites(request, env, path.slice('/account/favorites'.length));

    // ── Default ─────────────────────────────────────────────────────────

    return new Response(
        JSON.stringify({ error: 'Not found' }) + '\n',
        { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
}

export default wrapHandler(handleRequest, 'pdbfe-auth');
