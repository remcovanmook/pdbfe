/**
 * @fileoverview Shared HTTP utilities for the pdbfe-auth worker.
 *
 * Centralises CORS origin resolution, response construction, and
 * session-gated request handling. Used by both OAuth and account
 * handler modules.
 */

import { extractSessionId, extractBearerToken, resolveSession } from '../core/auth.js';

// ── CORS ─────────────────────────────────────────────────────────────────────

/**
 * Strips a leading "www." from a hostname, returning the bare apex.
 * Used to normalise www vs apex comparisons in CORS origin matching.
 *
 * @param {string} host - Hostname to strip.
 * @returns {string} The hostname without a leading "www.".
 */
function stripWww(host) {
    return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * The frontend origins the auth worker serves: FRONTEND_ORIGIN first, then
 * any FRONTEND_ALIASES (comma-separated origins, e.g. another domain the
 * same frontend is published on). Malformed entries are skipped.
 *
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {string[]} Hostnames, FRONTEND_ORIGIN's first.
 */
function frontendHosts(env) {
    const hosts = [new URL(env.FRONTEND_ORIGIN).host];
    for (const alias of (env.FRONTEND_ALIASES || '').split(',')) {
        const trimmed = alias.trim();
        if (!trimmed) continue;
        try {
            hosts.push(new URL(trimmed).host);
        } catch { /* malformed alias — skip */ }
    }
    return hosts;
}

/**
 * Whether a request host belongs to a frontend host: the same host, its
 * www/apex twin (pdbfe.dev and www.pdbfe.dev), or a subdomain of it
 * (staging.pdbfe.dev).
 *
 * @param {string} reqHost
 * @param {string} frontendHost
 * @returns {boolean}
 */
function matchesFrontendHost(reqHost, frontendHost) {
    if (reqHost === frontendHost) return true;
    const apex = stripWww(frontendHost);
    return stripWww(reqHost) === apex || reqHost.endsWith(`.${apex}`);
}

/**
 * Resolves the CORS origin to reflect in the response. Returns the
 * request's Origin if its host belongs to FRONTEND_ORIGIN or one of
 * FRONTEND_ALIASES (same host, www/apex twin, or a subdomain — see
 * matchesFrontendHost), or is a Cloudflare Pages preview subdomain
 * (*.pages.dev) of the same project (PAGES_PROJECT, default
 * pdbfe-frontend). Falls back to FRONTEND_ORIGIN otherwise.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {string} The origin to use in Access-Control-Allow-Origin.
 */
export function resolveAllowedOrigin(request, env) {
    const requestOrigin = request.headers.get('Origin') || '';
    if (!requestOrigin) return env.FRONTEND_ORIGIN;
    try {
        const reqHost = new URL(requestOrigin).host;
        if (frontendHosts(env).some((h) => matchesFrontendHost(reqHost, h))) return requestOrigin;
        // Cloudflare Pages preview: <hash|branch>.pdbfe-frontend.pages.dev
        const pagesProject = env.PAGES_PROJECT || 'pdbfe-frontend';
        if (reqHost.endsWith(`.${pagesProject}.pages.dev`)) {
            return requestOrigin;
        }
    } catch { /* malformed */ }
    return env.FRONTEND_ORIGIN;
}


/**
 * Builds CORS headers for account endpoints (full CRUD methods).
 *
 * @param {string} origin - Allowed origin.
 * @returns {Record<string, string>}
 */
export function accountCorsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
    };
}

/**
 * Returns a 204 CORS preflight response for account endpoints.
 * Resolves the allowed origin from the request, matching the pattern
 * used by core/http.js handlePreflight but with origin-specific headers.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Response} 204 with account CORS headers.
 */
export function handlePreflight(request, env) {
    return new Response(null, {
        status: 204,
        headers: accountCorsHeaders(resolveAllowedOrigin(request, env)),
    });
}

// ── Response helpers ─────────────────────────────────────────────────────────

/**
 * Returns a JSON response with account CORS headers and no-store caching.
 *
 * @param {any} body - Response body (will be JSON.stringify'd).
 * @param {number} status - HTTP status code.
 * @param {string} origin - Allowed CORS origin.
 * @param {string} [timing] - Optional Server-Timing value.
 * @returns {Response}
 */
export function jsonResponse(body, status, origin, timing) {
    /** @type {Record<string, string>} */
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...accountCorsHeaders(origin),
    };
    if (timing) {
        // Phase durations (kv = session lookup, db = USERDB queries); the
        // Timing-Allow-Origin lets the browser's Timing tab show them for
        // this cross-origin request.
        headers['Server-Timing'] = timing;
        if (origin) headers['Timing-Allow-Origin'] = origin;
    }
    return new Response(JSON.stringify(body) + '\n', { status, headers });
}

/**
 * Returns a 405 Method Not Allowed response with the given Allow header.
 *
 * @param {string} allow - Comma-separated list of allowed methods.
 * @returns {Response}
 */
export function methodNotAllowed(allow) {
    return new Response(
        JSON.stringify({ error: 'Method not allowed' }) + '\n',
        { status: 405, headers: { 'Content-Type': 'application/json', 'Allow': allow } }
    );
}

// ── Session resolution ───────────────────────────────────────────────────────

/**
 * Resolves the current session from the request. Returns the session
 * data, the resolved CORS origin, or a 401 response if not authenticated.
 *
 * The CORS origin is resolved once here so all downstream handlers use
 * a consistent, validated origin that works for both production and
 * Cloudflare Pages preview deployments.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<{session: SessionData|null, origin: string, error: Response|null, kvMs?: number}>} kvMs: session lookup time (Server-Timing).
 */
export async function requireSession(request, env) {
    const origin = resolveAllowedOrigin(request, env);
    // State-changing requests must authenticate via Authorization: Bearer, never
    // the pdbfe_sid cookie — the browser never auto-attaches a Bearer header, so
    // a cross-site form POST cannot authenticate (CSRF defence). Reads accept
    // either. (The frontend uses Bearer/localStorage for everything, so this is
    // transparent; it closes the latent cookie-CSRF vector.)
    const method = request.method;
    const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const sid = mutating ? extractBearerToken(request) : extractSessionId(request);
    if (!sid) {
        return { session: null, origin, error: jsonResponse({ error: 'Authentication required' }, 401, origin) };
    }

    const tKv = Date.now();
    const session = await resolveSession(env.SESSIONS, sid);
    const kvMs = Date.now() - tKv;
    if (!session) {
        return { session: null, origin, error: jsonResponse({ error: 'Invalid or expired session' }, 401, origin, `kv;dur=${kvMs}`) };
    }

    return { session, origin, error: null, kvMs };
}

// ── User record helpers ──────────────────────────────────────────────────────

/**
 * Reads a user record from the USERDB D1 database. Returns null if not found.
 *
 * @param {D1Database} db - USERDB D1 binding.
 * @param {number} userId - PeeringDB user ID.
 * @returns {Promise<UserRecord|null>}
 */
export async function getUser(db, userId) {
    return /** @type {UserRecord|null} */ (
        await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()
    );
}

/**
 * Provisions a new user record from session data if one doesn't
 * already exist. Returns the existing or newly created record.
 *
 * Uses INSERT OR IGNORE to survive concurrent SPA requests that
 * may both attempt to provision the same user simultaneously.
 * The second INSERT silently drops, and the re-fetch returns
 * the canonical DB state regardless of which request won.
 *
 * @param {D1Database} db - USERDB D1 binding.
 * @param {SessionData} session - Current session data.
 * @returns {Promise<UserRecord>}
 */
export async function ensureUser(db, session) {
    let existing = await getUser(db, session.id);
    if (existing) return existing;

    const now = new Date().toISOString();
    await db.prepare(
        'INSERT OR IGNORE INTO users (id, name, email, preferences, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(session.id, session.name, session.email, '{}', now, now).run();

    // Re-fetch to guarantee we return the canonical DB state
    // regardless of which concurrent request won the INSERT race.
    existing = await getUser(db, session.id);

    return existing || /** @type {UserRecord} */ ({
        id: session.id,
        name: session.name,
        email: session.email,
        preferences: '{}',
        created_at: now,
        updated_at: now,
    });
}
