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
 * The generic OAuth2 flow (CSRF, token exchange, profile fetch, session
 * creation) is handled by {@link createOAuthHandler} from core/oauth.js.
 * This module supplies the PeeringDB-specific configuration: endpoints,
 * scopes, extra request headers, and profile validation.
 *
 * All session state is stored in the SESSIONS KV namespace, shared
 * with pdbfe-api which performs read-only lookups.
 *
 * @see https://docs.peeringdb.com/oauth/
 */

import { resolveAllowedOrigin, accountCorsHeaders, methodNotAllowed, handlePreflight, ensureUser } from '../http.js';
import { createOAuthHandler } from '../../core/oauth.js';
import { encryptToken } from '../tokens.js';

// ── PeeringDB OAuth2 Constants ───────────────────────────────────────────────

const PDB_AUTH_BASE     = 'https://auth.peeringdb.com';
const PDB_AUTHORIZE_URL = `${PDB_AUTH_BASE}/oauth2/authorize/`;
export const PDB_TOKEN_URL   = `${PDB_AUTH_BASE}/oauth2/token/`;
export const PDB_PROFILE_URL = `${PDB_AUTH_BASE}/profile/v1`;

/**
 * OAuth scopes requested from PeeringDB.
 *   profile  — user name fields
 *   email    — email and verified_email
 *   networks — network affiliations with CRUD permission bitmasks
 */
const OAUTH_SCOPES = 'profile email networks';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Maps a PeeringDB profile response to session data.
 * Rejects unverified accounts before a session is written.
 *
 * @param {Record<string, any>} profile - Raw profile JSON from PeeringDB.
 * @returns {import('../../core/oauth.js').OAuthProfileResult}
 */
export function parsePeeringDbProfile(profile) {
    if (!profile.verified_user) {
        return {
            valid: false,
            error: 'PeeringDB account is not verified. Please verify your account and try again.',
        };
    }

    return {
        valid: true,
        /** @type {SessionData} */
        sessionData: {
            id:             profile.id,
            name:           profile.name,
            given_name:     profile.given_name,
            family_name:    profile.family_name,
            email:          profile.email          || '',
            verified_user:  profile.verified_user,
            verified_email: profile.verified_email || false,
            networks:       profile.networks       || [],
            created_at:     new Date().toISOString(),
        },
    };
}

/**
 * Headers for requests to auth.peeringdb.com. PeeringDB's WAF blocks
 * Cloudflare Worker subrequests without an Authorization header, so the
 * token endpoint gets the API key (it reads OAuth credentials from the POST
 * body independently).
 *
 * @param {PdbAuthEnv} env
 * @returns {{token: Record<string, string>, profile: Record<string, string>}}
 */
export function peeringDbHeaders(env) {
    const ua = `pdbfe-auth/1.0 (Cloudflare Worker; +${env.FRONTEND_ORIGIN})`;
    return {
        token: { 'Authorization': `Api-Key ${env.PEERINGDB_API_KEY}`, 'User-Agent': ua },
        profile: { 'User-Agent': ua },
    };
}

/**
 * After a login: make sure the user row exists and keep the refresh token
 * (encrypted) for the daily revalidation (auth/revalidate.js). Without
 * TOKEN_ENCRYPTION_KEY, or when PeeringDB returns no refresh token, nothing
 * is stored and the user is simply not revalidated.
 *
 * @param {PdbAuthEnv} env
 * @param {Record<string, any>} sessionData - Parsed profile (parsePeeringDbProfile).
 * @param {{refresh_token?: string}} tokens - From the token exchange.
 * @returns {Promise<void>}
 */
async function storeLogin(env, sessionData, tokens) {
    await ensureUser(env.USERDB, /** @type {SessionData} */ (sessionData));
    console.log(`[auth] login user ${sessionData.id}: refresh token ${tokens.refresh_token ? 'received' : 'not received'}`);
    if (!tokens.refresh_token || !env.TOKEN_ENCRYPTION_KEY) return;
    const now = new Date().toISOString();
    await env.USERDB.prepare('UPDATE users SET refresh_token = ?, validated_at = ? WHERE id = ?')
        .bind(await encryptToken(env.TOKEN_ENCRYPTION_KEY, tokens.refresh_token), now, sessionData.id).run();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolves the return origin for the OAuth login redirect.
 *
 * Extracts the origin from the Referer header and validates it against
 * the CORS allowlist. Falls back to `env.FRONTEND_ORIGIN` if the header
 * is absent, malformed, or not on the allowlist.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {string} A validated origin URL.
 */
function resolveReturnOrigin(request, env) {
    const referer = request.headers.get('Referer');
    if (referer) {
        try {
            const refOrigin = new URL(referer).origin; // ap-ok: auth worker only
            const probe = new Request(request.url, { headers: { 'Origin': refOrigin } });
            if (resolveAllowedOrigin(probe, env) === refOrigin) {
                return refOrigin;
            }
        } catch { /* malformed Referer — use default */ }
    }
    return env.FRONTEND_ORIGIN;
}

// ── OAuth Handler ─────────────────────────────────────────────────────────────

/**
 * Module-level handler instance. Initialized on the first request when
 * `env` is available, then reused for the lifetime of the isolate.
 *
 * @type {import('../../core/oauth.js').OAuthHandler|null}
 */
let oauthHandler = null;

/**
 * Initializes the OAuth handler on first use, when env bindings are
 * available. Subsequent calls return the cached instance.
 *
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {import('../../core/oauth.js').OAuthHandler}
 */
function getOAuthHandler(env) {
    if (oauthHandler) return oauthHandler;

    const headers = peeringDbHeaders(env);

    oauthHandler = createOAuthHandler({
        authorizeUrl: PDB_AUTHORIZE_URL,
        tokenUrl:     PDB_TOKEN_URL,
        profileUrl:   PDB_PROFILE_URL,
        scopes:       OAUTH_SCOPES,
        cookiePrefix: 'pdbfe_oauth',

        // 30-day sessions: PeeringDB shows its consent screen on every login,
        // so a daily expiry meant a daily re-authorize. Network affiliations
        // are snapshotted at login and refresh on the next one.
        sessionTtl:   30 * 86400,

        tokenHeaders:   headers.token,
        profileHeaders: headers.profile,
        onLogin:        storeLogin,

        getCorsHeaders: (request, env) => accountCorsHeaders(resolveAllowedOrigin(request, env)),

        parseProfile: parsePeeringDbProfile,
    });

    return oauthHandler;
}

// ── Endpoint Handlers ────────────────────────────────────────────────────────

/**
 * Dispatches /auth/* requests to the generic OAuth2 handler.
 *
 * Most endpoints are GET (login/callback/me, and the legacy logout redirect).
 * /auth/exchange and /auth/logout additionally accept POST — the app-initiated,
 * Bearer-authenticated fetches used by the SPA (same shape as /account/*). The
 * OPTIONS preflight is handled centrally.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @param {string} path - The request pathname (e.g. "/auth/login").
 * @returns {Promise<Response>|Response} The HTTP response.
 */
export function handleAuth(request, env, path) {
    if (request.method === 'OPTIONS') return handlePreflight(request, env);

    const postAllowed = path === '/auth/exchange' || path === '/auth/logout';
    const ok = request.method === 'GET' || (request.method === 'POST' && postAllowed);
    if (!ok) {
        return methodNotAllowed(postAllowed ? 'GET, POST, OPTIONS' : 'GET, OPTIONS');
    }

    return getOAuthHandler(env).handleOAuth(request, env, resolveReturnOrigin);
}
