/**
 * @fileoverview Generic OAuth2 Authorization Code flow factory.
 *
 * Implements the Double Submit Cookie CSRF pattern and standard OAuth2
 * authorization code flow. Provider-specific concerns (endpoints, extra
 * request headers, profile parsing) are injected via {@link OAuthHandlerConfig}.
 *
 * @module core/oauth
 */

import { generateSessionId, writeSession, deleteSession, extractSessionId, resolveSession } from './auth.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} OAuthHandlerConfig
 *
 * @property {string} authorizeUrl
 *   Provider's authorization endpoint.
 * @property {string} tokenUrl
 *   Provider's token endpoint (authorization code → access token).
 * @property {string} profileUrl
 *   Provider's profile/userinfo endpoint.
 * @property {string} scopes
 *   Space-separated OAuth2 scopes to request.
 *
 * @property {Record<string, string>} [tokenHeaders]
 *   Extra headers merged into the token POST request (e.g. WAF bypass).
 * @property {Record<string, string>} [profileHeaders]
 *   Extra headers merged into the profile GET request.
 *
 * @property {string} [cookiePrefix='oauth']
 *   Prefix for the CSRF state and return-origin cookies.
 *   Results in `{prefix}_state` and `{prefix}_return` cookie names.
 *
 * @property {number} [stateTtl=300]
 *   CSRF state cookie TTL in seconds.
 * @property {number} [sessionTtl=86400]
 *   KV session TTL in seconds.
 * @property {number} [authCodeTtl=120]
 *   Single-use exchange-code TTL in seconds (the /auth/exchange handoff window).
 *
 * @property {(profile: Record<string, any>) => OAuthProfileResult} parseProfile
 *   Maps the raw provider profile JSON to a session data object.
 *   Return `{ valid: false, error: '...' }` to reject the login.
 *
 * @property {(request: Request, env: any) => Record<string, string>} getCorsHeaders
 *   Returns CORS and other response headers for the /auth/me endpoint.
 */

/**
 * @typedef {Object} OAuthProfileResult
 * @property {boolean} valid - Whether the profile is acceptable.
 * @property {string} [error] - Rejection reason shown to the user.
 * @property {Record<string, any>} [sessionData] - Stored in KV on success.
 */

/**
 * @typedef {Object} OAuthHandler
 * @property {(request: Request, env: any, returnOrigin?: string) => Response} handleLogin
 * @property {(request: Request, env: any) => Promise<Response>} handleCallback
 * @property {(request: Request, env: any, corsHeaders?: Record<string, string>) => Promise<Response>} handleLogout
 * @property {(request: Request, env: any) => Promise<Response>} handleExchange
 * @property {(request: Request, env: any) => Promise<Response>} handleMe
 * @property {(
 *   request: Request,
 *   env: any,
 *   resolveReturnOrigin?: (request: Request, env: any) => string
 * ) => Promise<Response>|Response} handleOAuth
 */

// ── Module-scoped helpers ─────────────────────────────────────────────────────

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
    const re = new RegExp(String.raw`(?:^|;\s*)${name}=([^;]+)`); // ap-ok: auth worker only, not API hot path
    const match = re.exec(header);
    return match ? match[1].trim() : null;
}

/**
 * Builds a 302 redirect response back to the frontend origin.
 * Appends `?code=` (a single-use, browser-bound exchange code) on success or
 * `?auth_error=` on failure.
 *
 * The durable session id is deliberately NOT placed in the URL — it would be
 * captured in access logs and, being a bearer credential adoptable by any
 * browser, would enable session fixation. The frontend swaps the code for the
 * session id via an authenticated POST to /auth/exchange.
 *
 * @param {string} frontendOrigin - The frontend origin URL.
 * @param {string|null} code - Single-use exchange code on success.
 * @param {string|null} error - Error message on failure.
 * @returns {Response}
 */
function redirectToFrontend(frontendOrigin, code, error) {
    let location = frontendOrigin;
    if (code) {
        location += `/?code=${code}`;
    } else if (error) {
        location += `/?auth_error=${encodeURIComponent(error)}`;
    }
    return new Response(null, {
        status: 302,
        headers: { 'Location': location, 'Cache-Control': 'no-store' },
    });
}

/**
 * /auth/logout.
 *
 * Deletes the KV session (when the request carries a resolvable session id).
 * POST returns JSON so the SPA can clear local state itself; GET keeps the
 * legacy 302 redirect to the frontend.
 *
 * @param {Request} request
 * @param {any} env
 * @param {Record<string, string>} [corsHeaders] - CORS headers for the JSON (POST) response.
 * @returns {Promise<Response>}
 */
async function handleLogout(request, env, corsHeaders) {
    const sid = extractSessionId(request);
    if (sid) {
        await deleteSession(env.SESSIONS, sid);
    }
    // POST is the app-initiated fetch path: it carries Authorization: Bearer,
    // so the session id above is resolved and the KV session actually deleted.
    // Return JSON so the SPA can then clear local state and navigate itself.
    // GET is the legacy top-level-navigation path (no Bearer → nothing to
    // revoke) kept for backward compatibility; it just redirects home.
    if (request.method === 'POST') {
        return new Response(
            JSON.stringify({ ok: true }) + '\n',
            {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
            }
        );
    }
    return new Response(null, {
        status: 302,
        headers: { 'Location': env.FRONTEND_ORIGIN, 'Cache-Control': 'no-store' },
    });
}

/**
 * POSTs an authorization code to the provider's token endpoint and
 * returns the access token.
 *
 * @param {string} code - The authorization code from the callback URL.
 * @param {string} clientId - OAuth client ID.
 * @param {string} clientSecret - OAuth client secret.
 * @param {string} redirectUri - Registered redirect URI.
 * @param {string} tokenUrl - Provider token endpoint URL.
 * @param {Record<string, string>} extraHeaders - Additional request headers.
 * @returns {Promise<{ok: boolean, access_token?: string, error?: string}>}
 */
async function exchangeCode(code, clientId, clientSecret, redirectUri, tokenUrl, extraHeaders) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
    });

    try {
        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                ...extraHeaders,
            },
            body: body.toString(),
        });

        if (!response.ok) {
            const text = await response.text();
            console.error(`Token exchange failed (${response.status}):`, text);
            return { ok: false, error: `Token endpoint returned ${response.status}: ${text}` };
        }

        const data = /** @type {{access_token: string}} */ (await response.json());
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
 * Fetches the authenticated user's profile from the provider's profile
 * endpoint using a Bearer access token.
 *
 * @param {string} accessToken - The OAuth2 access token.
 * @param {string} profileUrl - Provider profile endpoint URL.
 * @param {Record<string, string>} extraHeaders - Additional request headers.
 * @returns {Promise<Record<string, any>|null>}
 */
async function fetchProfile(accessToken, profileUrl, extraHeaders) {
    try {
        const response = await fetch(profileUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                ...extraHeaders,
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

/** @type {string} KV key prefix for single-use OAuth exchange codes. */
const AUTHCODE_PREFIX = 'authcode:';

/**
 * Computes the base64url-encoded SHA-256 of a string. Used for the PKCE-style
 * challenge: the frontend sends `challenge = sha256Base64Url(verifier)` at
 * login; /auth/exchange recomputes it from the presented verifier and compares.
 *
 * @param {string} input - The value to hash (the PKCE verifier).
 * @returns {Promise<string>} base64url digest, no padding.
 */
async function sha256Base64Url(input) {
    const data = new TextEncoder().encode(input);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    // 32 bytes → binary string → base64url (no padding). Spread is safe at this
    // fixed small size.
    const bin = String.fromCodePoint(...digest);
    return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates an OAuth2 handler object for the Authorization Code flow.
 *
 * The returned handler functions accept `(request, env)` and are suitable
 * for direct use as Cloudflare Worker route handlers.
 *
 * @param {OAuthHandlerConfig} config - Provider-specific configuration.
 * @returns {OAuthHandler}
 */
export function createOAuthHandler(config) {
    const stateTtl      = config.stateTtl      ?? 300;
    const sessionTtl    = config.sessionTtl    ?? 86400;
    const tokenHeaders   = config.tokenHeaders   ?? {};
    const profileHeaders = config.profileHeaders ?? {};
    const prefix         = config.cookiePrefix   ?? 'oauth';
    const stateCookie    = `${prefix}_state`;
    const returnCookie   = `${prefix}_return`;
    const challengeCookie = `${prefix}_chal`;
    const authCodeTtl    = config.authCodeTtl    ?? 120;

    /**
     * GET /auth/login.
     *
     * Generates a CSRF state nonce, binds it to the browser via an HttpOnly
     * cookie (Double Submit Cookie pattern), and redirects the user to the
     * provider's authorization endpoint.
     *
     * The caller is responsible for resolving and validating `returnOrigin`
     * against its CORS allowlist before passing it here.
     *
     * @param {Request} request
     * @param {any} env
     * @param {string} [returnOrigin] - Validated return origin. Defaults to env.FRONTEND_ORIGIN.
     * @returns {Response}
     */
    function handleLogin(request, env, returnOrigin = env.FRONTEND_ORIGIN) {
        const state = generateSessionId();

        const params = new URLSearchParams({
            response_type: 'code',
            client_id: env.OAUTH_CLIENT_ID,
            redirect_uri: env.OAUTH_REDIRECT_URI,
            scope: config.scopes,
            state,
        });

        const headers = new Headers({
            'Location': `${config.authorizeUrl}?${params.toString()}`,
            'Cache-Control': 'no-store',
        });
        headers.append('Set-Cookie', `${stateCookie}=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=${stateTtl}; Path=/`);
        headers.append('Set-Cookie', `${returnCookie}=${encodeURIComponent(returnOrigin)}; HttpOnly; Secure; SameSite=Lax; Max-Age=${stateTtl}; Path=/`);

        // PKCE-style binding: the frontend sends a challenge (sha256 of a
        // browser-held verifier). Persist it in an HttpOnly cookie so the
        // callback can bind the one-time exchange code to it. base64url is
        // cookie-safe (no chars needing escaping).
        const challenge = new URL(request.url).searchParams.get('challenge'); // ap-ok: auth worker only
        if (challenge) {
            headers.append('Set-Cookie', `${challengeCookie}=${challenge}; HttpOnly; Secure; SameSite=Lax; Max-Age=${stateTtl}; Path=/`);
        }

        return new Response(null, { status: 302, headers });
    }

    /**
     * GET /auth/callback.
     *
     * Validates CSRF nonce, exchanges code for access token, fetches the
     * provider profile, runs `parseProfile`, writes a KV session, and
     * redirects to the frontend with the session ID.
     *
     * @param {Request} request
     * @param {any} env
     * @returns {Promise<Response>}
     */
    async function handleCallback(request, env) {
        const url   = new URL(request.url); // ap-ok: auth worker only
        const code  = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        const clearCookies = [
            `${stateCookie}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
            `${returnCookie}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
            `${challengeCookie}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        ];

        /**
         * Appends cookie-clearing headers to any response before returning it.
         * @param {Response} resp
         * @returns {Response}
         */
        const clearAndReturn = (resp) => {
            for (const c of clearCookies) resp.headers.append('Set-Cookie', c);
            return resp;
        };

        let returnOrigin = env.FRONTEND_ORIGIN;
        const rawReturn = extractCookie(request, returnCookie);
        if (rawReturn) {
            // The return origin cookie was set by handleLogin and validated
            // against the CORS allowlist at that point, so we trust it here.
            returnOrigin = decodeURIComponent(rawReturn);
        }

        if (error) {
            return clearAndReturn(redirectToFrontend(returnOrigin, null, url.searchParams.get('error_description') || error));
        }
        if (!code || !state) {
            return clearAndReturn(redirectToFrontend(returnOrigin, null, 'Missing code or state parameter'));
        }

        const cookieState = extractCookie(request, stateCookie);
        if (!cookieState || cookieState !== state) {
            return clearAndReturn(redirectToFrontend(returnOrigin, null, 'State mismatch (possible CSRF)'));
        }

        const tokenResult = await exchangeCode(
            code,
            env.OAUTH_CLIENT_ID,
            env.OAUTH_CLIENT_SECRET,
            env.OAUTH_REDIRECT_URI,
            config.tokenUrl,
            tokenHeaders
        );
        if (!tokenResult.ok) {
            return clearAndReturn(redirectToFrontend(returnOrigin, null, tokenResult.error || 'Token exchange failed'));
        }

        const profile = await fetchProfile(tokenResult.access_token, config.profileUrl, profileHeaders);
        if (!profile) {
            return clearAndReturn(redirectToFrontend(returnOrigin, null, 'Failed to fetch user profile'));
        }

        const parsed = config.parseProfile(profile);
        if (!parsed.valid) {
            return clearAndReturn(redirectToFrontend(returnOrigin, null, parsed.error || 'Profile rejected'));
        }

        const sid = generateSessionId();
        await writeSession(env.SESSIONS, sid, /** @type {SessionData} */ (parsed.sessionData), sessionTtl);

        // Hand the session back via a single-use, browser-bound exchange code
        // rather than putting the durable sid in the redirect URL. The code is
        // bound to the PKCE challenge captured at login; only the browser that
        // holds the matching verifier can redeem it at /auth/exchange. An
        // injected `?code=` (or one scraped from logs) is useless without it.
        const challenge = extractCookie(request, challengeCookie) || '';
        const handoffCode = generateSessionId();
        await env.SESSIONS.put(
            `${AUTHCODE_PREFIX}${handoffCode}`,
            JSON.stringify({ sid, challenge }),
            { expirationTtl: authCodeTtl }
        );

        return clearAndReturn(redirectToFrontend(returnOrigin, handoffCode, null));
    }


    /**
     * GET /auth/me.
     *
     * Returns the current session data as JSON, or a 401 if no valid
     * session exists.
     *
     * @param {Request} request
     * @param {any} env
     * @returns {Promise<Response>}
     */
    async function handleMe(request, env) {
        const headers = {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...config.getCorsHeaders(request, env),
        };

        const sid = extractSessionId(request);
        if (!sid) {
            return new Response(
                JSON.stringify({ authenticated: false }) + '\n',
                { status: 401, headers }
            );
        }

        const session = await resolveSession(env.SESSIONS, sid);
        if (!session) {
            return new Response(
                JSON.stringify({ authenticated: false }) + '\n',
                { status: 401, headers }
            );
        }

        return new Response(
            JSON.stringify({ authenticated: true, user: session }) + '\n',
            { status: 200, headers }
        );
    }

    /**
     * POST /auth/exchange.
     *
     * Swaps a single-use exchange code (delivered to the frontend via the
     * callback redirect) for the durable session id — but only if the caller
     * presents the PKCE verifier whose sha256 matches the challenge the code
     * was bound to at login. This makes an injected/scraped code useless to
     * anyone but the browser that initiated the login (session-fixation
     * defence), and keeps the session id out of URLs/logs.
     *
     * @param {Request} request
     * @param {any} env
     * @returns {Promise<Response>}
     */
    async function handleExchange(request, env) {
        const headers = {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...config.getCorsHeaders(request, env),
        };
        /** @param {number} status @param {object} respBody @returns {Response} */
        const json = (status, respBody) =>
            new Response(JSON.stringify(respBody) + '\n', { status, headers });

        let body;
        try {
            body = /** @type {{code?: string, verifier?: string}} */ (await request.json());
        } catch {
            body = {};
        }
        const code = typeof body.code === 'string' ? body.code : '';
        const verifier = typeof body.verifier === 'string' ? body.verifier : '';
        if (!code || !verifier) {
            return json(400, { error: 'Missing code or verifier' });
        }

        const key = `${AUTHCODE_PREFIX}${code}`;
        const stored = /** @type {{sid: string, challenge: string}|null} */ (
            await env.SESSIONS.get(key, { type: 'json' })
        );
        if (!stored) {
            return json(400, { error: 'Invalid or expired code' });
        }

        // Empty challenge means the login did not present one — reject rather
        // than fall back to an unbound (fixation-prone) exchange.
        const expected = await sha256Base64Url(verifier);
        if (!stored.challenge || expected !== stored.challenge) {
            return json(400, { error: 'Verifier mismatch' });
        }

        // Single-use: consume the code only once the verifier checks out.
        await env.SESSIONS.delete(key);
        return json(200, { sid: stored.sid });
    }

    /**
     * Top-level OAuth2 request dispatcher.
     *
     * Routes /auth/login, /auth/callback, /auth/logout, and /auth/me by
     * pathname. The optional `resolveReturnOrigin` callback allows the caller
     * to supply a validated return origin for the login redirect (e.g. from
     * the Referer header). Defaults to `env.FRONTEND_ORIGIN`.
     *
     * @param {Request} request
     * @param {any} env
     * @param {(request: Request, env: any) => string} [resolveReturnOrigin]
     * @returns {Promise<Response>|Response}
     */
    function handleOAuth(request, env, resolveReturnOrigin) {
        const path = new URL(request.url).pathname; // ap-ok: auth worker only, not API hot path
        const returnOrigin = resolveReturnOrigin
            ? resolveReturnOrigin(request, env)
            : env.FRONTEND_ORIGIN;

        switch (path) {
            case '/auth/login':    return handleLogin(request, env, returnOrigin);
            case '/auth/callback': return handleCallback(request, env);
            case '/auth/logout':   return handleLogout(request, env, config.getCorsHeaders(request, env));
            case '/auth/exchange': return handleExchange(request, env);
            case '/auth/me':       return handleMe(request, env);
            default:
                return new Response(
                    JSON.stringify({ error: 'Not found' }) + '\n',
                    { status: 404, headers: { 'Content-Type': 'application/json' } }
                );
        }
    }

    return { handleLogin, handleCallback, handleLogout, handleExchange, handleMe, handleOAuth };
}
