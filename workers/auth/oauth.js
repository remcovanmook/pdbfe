/**
 * @fileoverview PeeringDB OAuth2 Authorization Code flow handlers.
 *
 * This module implements the four auth endpoints served by pdbfe-auth:
 *
 *   /auth/login    → Redirect user to PeeringDB's authorize URL
 *   /auth/callback → Exchange code for token, fetch profile, create session
 *   /auth/logout   → Delete session from KV, redirect to frontend
 *   /auth/me       → Return current session data as JSON
 *
 * All session state is stored in the SESSIONS KV namespace, shared
 * with pdbfe-api which performs read-only lookups.
 *
 * PeeringDB OAuth2 endpoints (auth.peeringdb.com):
 *   Authorize:  /oauth2/authorize/
 *   Token:      /oauth2/token/
 *   Profile:    /profile/v1
 *
 * @see https://docs.peeringdb.com/oauth/
 */

import {
    extractSessionId,
    resolveSession,
    generateSessionId,
    writeSession,
    deleteSession
} from '../core/auth.js';

// ── PeeringDB OAuth2 Constants ───────────────────────────────────────────────

const PDB_AUTH_BASE = 'https://auth.peeringdb.com';
const PDB_AUTHORIZE_URL = `${PDB_AUTH_BASE}/oauth2/authorize/`;
const PDB_TOKEN_URL = `${PDB_AUTH_BASE}/oauth2/token/`;
const PDB_PROFILE_URL = `${PDB_AUTH_BASE}/profile/v1`;

/**
 * OAuth scopes requested from PeeringDB.
 *   profile  — user name fields
 *   email    — email and verified_email
 *   networks — network affiliations with CRUD permission bitmasks
 */
const OAUTH_SCOPES = 'profile email networks';

/** CSRF state cookie TTL in seconds (5 minutes). */
const STATE_TTL = 300;

/** Session TTL in seconds (24 hours). */
const SESSION_TTL = 86400;

// ── CORS helpers ─────────────────────────────────────────────────────────────

/**
 * Builds CORS headers that allow the frontend origin to make
 * credentialed requests to the auth worker.
 *
 * @param {string} frontendOrigin - The allowed frontend origin.
 * @returns {Record<string, string>} CORS headers.
 */
function corsHeaders(frontendOrigin) {
    return {
        'Access-Control-Allow-Origin': frontendOrigin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
    };
}

// ── Endpoint Handlers ────────────────────────────────────────────────────────

/**
 * Handles GET /auth/login.
 *
 * Generates a CSRF state nonce, binds it to the browser via an HttpOnly
 * cookie (Double Submit Cookie pattern), and redirects the user to
 * PeeringDB's OAuth2 authorization endpoint.
 *
 * No server-side storage is needed for the state — the cookie is the
 * sole CSRF binding. The callback handler verifies the cookie matches
 * the URL state parameter returned by PeeringDB.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Response} 302 redirect to PeeringDB authorize URL.
 */
export function handleLogin(request, env) {
    const state = generateSessionId();

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: env.OAUTH_CLIENT_ID,
        redirect_uri: env.OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPES,
        state,
    });

    // Bind the state nonce to this browser via a cookie. The callback
    // handler will verify the cookie matches the URL state parameter,
    // preventing login CSRF attacks where an attacker sends their own
    // authorization URL to a victim.
    return new Response(null, {
        status: 302,
        headers: {
            'Location': `${PDB_AUTHORIZE_URL}?${params.toString()}`,
            'Cache-Control': 'no-store',
            'Set-Cookie': `pdbfe_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=${STATE_TTL}; Path=/`,
        },
    });
}

/**
 * Handles GET /auth/callback.
 *
 * This is the OAuth2 redirect URI. PeeringDB sends back a `code`
 * and `state` parameter. The handler:
 *   1. Validates the state nonce via cookie (CSRF protection)
 *   2. Exchanges the authorization code for an access token
 *   3. Fetches the user profile using the access token
 *   4. Creates a session in KV
 *   5. Redirects to the frontend with the session ID as a query parameter
 *
 * @param {Request} request - The inbound HTTP request (with ?code=...&state=...).
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>} 302 redirect to the frontend, or error response.
 */
export async function handleCallback(request, env) {
    const url = new URL(request.url); // ap-ok: auth worker only, not API hot path
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    // Cookie clearing header — expires the oauth_state cookie regardless
    // of whether the callback succeeds or fails.
    const clearCookie = 'pdbfe_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

    // PeeringDB may redirect with an error parameter on user denial
    if (error) {
        const desc = url.searchParams.get('error_description') || error;
        const resp = redirectToFrontend(env.FRONTEND_ORIGIN, null, desc);
        resp.headers.append('Set-Cookie', clearCookie);
        return resp;
    }

    if (!code || !state) {
        const resp = redirectToFrontend(env.FRONTEND_ORIGIN, null, 'Missing code or state parameter');
        resp.headers.append('Set-Cookie', clearCookie);
        return resp;
    }

    // Validate CSRF state nonce: verify the cookie set during /auth/login
    // matches the state parameter returned by PeeringDB. This proves the
    // login flow was initiated by this browser (Double Submit Cookie).
    const cookieState = extractCookie(request, 'pdbfe_oauth_state');
    if (!cookieState || cookieState !== state) {
        const resp = redirectToFrontend(env.FRONTEND_ORIGIN, null, 'State mismatch (possible CSRF)');
        resp.headers.append('Set-Cookie', clearCookie);
        return resp;
    }

    // Exchange authorization code for access token
    const tokenResult = await exchangeCode(code, env);
    if (!tokenResult.ok) {
        const resp = redirectToFrontend(env.FRONTEND_ORIGIN, null, tokenResult.error || 'Token exchange failed');
        resp.headers.append('Set-Cookie', clearCookie);
        return resp;
    }

    // Fetch user profile from PeeringDB
    const profile = await fetchProfile(tokenResult.access_token);
    if (!profile) {
        const resp = redirectToFrontend(env.FRONTEND_ORIGIN, null, 'Failed to fetch user profile');
        resp.headers.append('Set-Cookie', clearCookie);
        return resp;
    }

    // Require verified user — unverified accounts cannot log in
    if (!profile.verified_user) {
        const resp = redirectToFrontend(
            env.FRONTEND_ORIGIN,
            null,
            'PeeringDB account is not verified. Please verify your account and try again.'
        );
        resp.headers.append('Set-Cookie', clearCookie);
        return resp;
    }

    // Create session
    const sid = generateSessionId();
    /** @type {SessionData} */
    const sessionData = {
        id: profile.id,
        name: profile.name,
        given_name: profile.given_name,
        family_name: profile.family_name,
        email: profile.email || '',
        verified_user: profile.verified_user,
        verified_email: profile.verified_email || false,
        networks: profile.networks || [],
        created_at: new Date().toISOString(),
    };

    await writeSession(env.SESSIONS, sid, sessionData, SESSION_TTL);

    const resp = redirectToFrontend(env.FRONTEND_ORIGIN, sid, null);
    resp.headers.append('Set-Cookie', clearCookie);
    return resp;
}

/**
 * Handles GET /auth/logout.
 *
 * Deletes the session from KV and redirects to the frontend.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>} 302 redirect to the frontend.
 */
export async function handleLogout(request, env) {
    const sid = extractSessionId(request);
    if (sid) {
        await deleteSession(env.SESSIONS, sid);
    }

    return new Response(null, {
        status: 302,
        headers: {
            'Location': env.FRONTEND_ORIGIN,
            'Cache-Control': 'no-store',
        },
    });
}

/**
 * Handles GET /auth/me.
 *
 * Returns the current session data as JSON, or a 401 if no valid
 * session exists. Used by the frontend to check login status.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>} JSON response with session data or 401.
 */
export async function handleMe(request, env) {
    const headers = corsHeaders(env.FRONTEND_ORIGIN);

    const sid = extractSessionId(request);
    if (!sid) {
        return new Response(
            JSON.stringify({ authenticated: false }) + '\n',
            { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } }
        );
    }

    const session = await resolveSession(env.SESSIONS, sid);
    if (!session) {
        return new Response(
            JSON.stringify({ authenticated: false }) + '\n',
            { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } }
        );
    }

    return new Response(
        JSON.stringify({ authenticated: true, user: session }) + '\n',
        { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } }
    );
}

/**
 * Handles OPTIONS preflight for /auth/* endpoints.
 *
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Response} 204 with CORS headers.
 */
export function handleAuthPreflight(env) {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(env.FRONTEND_ORIGIN),
    });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Extracts a named cookie value from the request's Cookie header.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {string} name - Cookie name to extract.
 * @returns {string|null} The cookie value, or null if not found.
 */
function extractCookie(request, name) {
    const header = request.headers.get('Cookie');
    if (!header) return null;
    const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`); // ap-ok: auth worker only, not API hot path
    const match = header.match(re);
    return match ? match[1].trim() : null;
}

/**
 * Exchanges an OAuth2 authorization code for an access token by
 * POSTing to PeeringDB's token endpoint.
 *
 * @param {string} code - The authorization code from the callback.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<{ok: boolean, access_token?: string, error?: string}>}
 */
async function exchangeCode(code, env) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.OAUTH_REDIRECT_URI,
        client_id: env.OAUTH_CLIENT_ID,
        client_secret: env.OAUTH_CLIENT_SECRET,
    });

    // PeeringDB's WAF blocks Cloudflare Worker subrequests that lack an
    // Authorization header. We use a PeeringDB API key in the header to
    // satisfy the WAF, while the token endpoint reads OAuth client
    // credentials from the POST body.

    try {
        const response = await fetch(PDB_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Api-Key ${env.PEERINGDB_API_KEY}`,
                'User-Agent': 'pdbfe-auth/1.0 (Cloudflare Worker; +https://pdbfe-frontend.pages.dev)',
            },
            body: body.toString(),
        });

        if (!response.ok) {
            const text = await response.text();
            console.error(`Token exchange failed (${response.status}):`, text);
            return { ok: false, error: `Token endpoint returned ${response.status}: ${text}` };
        }

        const data = /** @type {{access_token: string, token_type: string}} */ (await response.json());
        if (!data.access_token) {
            return { ok: false, error: 'No access_token in token response' };
        }

        return { ok: true, access_token: data.access_token };
    } catch (err) {
        console.error('Token exchange error:', err);
        return { ok: false, error: 'Token exchange network error' };
    }
}

/**
 * Fetches the authenticated user's profile from PeeringDB's
 * profile endpoint using a Bearer access token.
 *
 * @param {string} accessToken - The OAuth2 access token.
 * @returns {Promise<Record<string, any>|null>} The profile object, or null on failure.
 */
async function fetchProfile(accessToken) {
    try {
        const response = await fetch(PDB_PROFILE_URL, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': 'pdbfe-auth/1.0 (Cloudflare Worker; +https://pdbfe-frontend.pages.dev)',
            },
        });

        if (!response.ok) {
            console.error(`Profile fetch failed (${response.status})`);
            return null;
        }

        return /** @type {Record<string, any>} */ (await response.json());
    } catch (err) {
        console.error('Profile fetch error:', err);
        return null;
    }
}

/**
 * Builds a redirect response back to the frontend origin.
 * On success, appends the session ID as a query parameter (?sid=...).
 * On error, appends the error message as a query parameter (?auth_error=...).
 *
 * Query parameters survive Cloudflare Access redirect chains, while
 * URL fragments (#) are stripped by Access during its auth flow.
 *
 * @param {string} frontendOrigin - The frontend origin URL.
 * @param {string|null} sid - The session ID on success, or null.
 * @param {string|null} error - Error message on failure, or null.
 * @returns {Response} 302 redirect response.
 */
function redirectToFrontend(frontendOrigin, sid, error) {
    let location = frontendOrigin;
    if (sid) {
        location += `/?sid=${sid}`;
    } else if (error) {
        location += `/?auth_error=${encodeURIComponent(error)}`;
    }

    return new Response(null, {
        status: 302,
        headers: {
            'Location': location,
            'Cache-Control': 'no-store',
        },
    });
}
