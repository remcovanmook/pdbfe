/**
 * @fileoverview Router for the pdbfe-auth worker.
 *
 * Handles the OAuth2 login flow with PeeringDB (auth.peeringdb.com):
 *   /auth/login    → Redirect to PeeringDB authorize page
 *   /auth/callback → Exchange code, create session, redirect to frontend
 *   /auth/logout   → Delete session, redirect to frontend
 *   /auth/me       → Return current session data as JSON
 *
 * All session state lives in the SESSIONS KV namespace, shared with
 * pdbfe-api which performs read-only lookups for authentication.
 *
 * This worker does not serve API data — it only manages authentication.
 */

import {
    handleLogin,
    handleCallback,
    handleLogout,
    handleMe,
    handleAuthPreflight,
} from '../core/oauth.js';

/**
 * Routes incoming requests to the appropriate auth handler.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @param {ExecutionContext} _ctx - Worker execution context (unused).
 * @returns {Promise<Response>} The HTTP response.
 */
async function handleRequest(request, env, _ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight for all /auth/* paths
    if (request.method === 'OPTIONS') {
        return handleAuthPreflight(env);
    }

    // Only GET is supported for auth endpoints
    if (request.method !== 'GET') {
        return new Response(
            JSON.stringify({ error: 'Method not allowed' }) + '\n',
            {
                status: 405,
                headers: {
                    'Content-Type': 'application/json',
                    'Allow': 'GET, OPTIONS',
                },
            }
        );
    }

    // Validate required environment variables early
    if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET) {
        console.error('Missing OAUTH_CLIENT_ID or OAUTH_CLIENT_SECRET secrets');
        return new Response(
            JSON.stringify({ error: 'Auth worker is not configured' }) + '\n',
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    switch (path) {
        case '/auth/login':
            return handleLogin(request, env);

        case '/auth/callback':
            return handleCallback(request, env);

        case '/auth/logout':
            return handleLogout(request, env);

        case '/auth/me':
            return handleMe(request, env);

        default:
            return new Response(
                JSON.stringify({ error: 'Not found' }) + '\n',
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
    }
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
