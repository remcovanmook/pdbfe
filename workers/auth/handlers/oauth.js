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

import { resolveAllowedOrigin, accountCorsHeaders, methodNotAllowed, handlePreflight } from '../http.js';
import { createOAuthHandler } from '../../core/oauth.js';

// ── PeeringDB OAuth2 Constants ───────────────────────────────────────────────

const PDB_AUTH_BASE     = 'https://auth.peeringdb.com';
const PDB_AUTHORIZE_URL = `${PDB_AUTH_BASE}/oauth2/authorize/`;
const PDB_TOKEN_URL     = `${PDB_AUTH_BASE}/oauth2/token/`;
const PDB_PROFILE_URL   = `${PDB_AUTH_BASE}/profile/v1`;

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
function parsePeeringDbProfile(profile) {
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

    /** @type {string} Shared User-Agent for all upstream requests. */
    const UA = `pdbfe-auth/1.0 (Cloudflare Worker; +${env.FRONTEND_ORIGIN})`;

    oauthHandler = createOAuthHandler({
        authorizeUrl: PDB_AUTHORIZE_URL,
        tokenUrl:     PDB_TOKEN_URL,
        profileUrl:   PDB_PROFILE_URL,
        scopes:       OAUTH_SCOPES,
        cookiePrefix: 'pdbfe_oauth',

        // PeeringDB's WAF blocks Cloudflare Worker subrequests without an
        // Authorization header. Inject the API key to satisfy it; the token
        // endpoint reads OAuth credentials from the POST body independently.
        tokenHeaders: {
            'Authorization': `Api-Key ${env.PEERINGDB_API_KEY}`,
            'User-Agent': UA,
        },

        profileHeaders: {
            'User-Agent': UA,
        },

        getCorsHeaders: (request, env) => accountCorsHeaders(resolveAllowedOrigin(request, env)),

        parseProfile: parsePeeringDbProfile,
    });

    return oauthHandler;
}

// ── Endpoint Handlers ────────────────────────────────────────────────────────

/**
 * Dispatches /auth/* requests to the generic OAuth2 handler.
 * Enforces GET-only and handles OPTIONS preflight.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>|Response} The HTTP response.
 */
export function handleAuth(request, env) {
    if (request.method === 'OPTIONS') return handlePreflight(request, env);
    if (request.method !== 'GET') return methodNotAllowed('GET, OPTIONS');

    return getOAuthHandler(env).handleOAuth(request, env, resolveReturnOrigin);
}
