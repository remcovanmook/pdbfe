/**
 * @fileoverview Request gate for the data workers (api, rest, graphql,
 * search): who is calling, how fast, and whether their credential holds.
 *
 * The data a request gets depends only on whether it is authenticated, never
 * on whose credential it is: an authenticated request may see restricted
 * rows (poc visible=Users), an anonymous one may not.
 *
 *   1. identifyCaller — an upstream PeeringDB key is refused (403) without
 *      any lookup. A pdbfe API key is taken as the caller's identity
 *      unverified. A Bearer session (the frontend's) is resolved now, one
 *      SESSIONS KV read: a session that does not hold leaves the caller
 *      anonymous, as it always has.
 *   2. rateLimited — the Workers rate-limit binding: RL_AUTH keyed by the
 *      key or verified session, RL_ANON by the caller's IP (IPv6 /64).
 *      Counters are shared by every isolate in a Cloudflare location; the
 *      check reads a locally cached count, so it costs no round trip.
 *   3. startVerification — the API-key lookup (USERDB D1), run alongside
 *      the request's own D1 work instead of before it.
 *   4. settle — before the response leaves: a key that does not hold
 *      (unknown, revoked or expired) gets a 401 instead of the data, so
 *      nothing computed for it is returned. A verified caller gets X-Auth-Id
 *      (and the lookup's Server-Timing) on private, authenticated responses.
 *
 * Why sessions are not verified alongside like keys: an invalid session is
 * served anonymously, not refused, so an unverified one must not pick its
 * own rate-limit bucket. A caller inventing keys does get a fresh bucket per
 * key, but every such request ends in a 401.
 *
 * The rate limit is approximate (eventually consistent within a location,
 * separate per location): it stops floods, it is not accounting.
 */

import { extractApiKey, extractSessionId, resolveSession, verifyApiKey } from './auth.js';

/**
 * @typedef {Object} Caller
 * @property {string|null} identity - Rate-limit identity: the (unverified) API key or a verified session id; null when anonymous.
 * @property {string|null} apiKey - The API key still to verify (startVerification), or null.
 * @property {number|null} userId - The session's user; a key's user is known once verified.
 * @property {number|null} ms - Session lookup time (Server-Timing auth), or null.
 * @property {string|null} rejection - Set when the request must be refused (403).
 */

const UPSTREAM_KEY_REJECTION = 'PeeringDB API keys are not valid on this mirror. '
    + 'Create a key at /account after signing in.';

/** @type {Caller} */
const ANONYMOUS = Object.freeze({ identity: null, apiKey: null, userId: null, ms: null, rejection: null });

/**
 * Identifies the caller: an API key (unverified), a verified session, or
 * anonymous. Never touches D1.
 *
 * @param {Request} request - The inbound request.
 * @param {{SESSIONS: KVNamespace}} env - Worker bindings.
 * @returns {Promise<Caller>}
 */
export async function identifyCaller(request, env) {
    const apiKey = extractApiKey(request);
    if (apiKey !== null) {
        if (!apiKey.startsWith('pdbfe.')) return { ...ANONYMOUS, rejection: UPSTREAM_KEY_REJECTION };
        return { ...ANONYMOUS, identity: apiKey, apiKey };
    }
    const sid = extractSessionId(request);
    if (!sid) return ANONYMOUS;
    const t0 = Date.now();
    const session = await resolveSession(env.SESSIONS, sid);
    if (session === null) return ANONYMOUS;
    return { ...ANONYMOUS, identity: sid, userId: session.id, ms: Date.now() - t0 };
}

/**
 * Normalises a client IP address for rate limiting.
 * IPv6 addresses are truncated to their /64 prefix (first 4 groups)
 * because a single subscriber typically receives a /48 to /64 block
 * and can rotate freely within it. Grouping by /64 ensures address
 * rotation within an allocation shares one rate limit bucket.
 *
 * IPv4 addresses are returned unchanged.
 *
 * @internal Exported for unit testing.
 * @param {string} ip - Raw IP address from cf-connecting-ip.
 * @returns {string} Normalised rate limit key (IPv4 as-is, IPv6 /64 prefix).
 */
export function normaliseIP(ip) {
    // Guard a missing/empty IP so the exported helper can't throw on
    // `.includes` (cf-connecting-ip is absent for internal / service-binding /
    // test requests).
    if (!ip) return 'unknown';
    if (!ip.includes(':')) return ip;

    // Split on :: to handle compressed notation.
    const halves = ip.split('::'); // ap-ok: simple two-part split on known delimiter

    if (halves.length === 1) {
        // Full notation — split and take first 4 groups.
        return ip.split(':').slice(0, 4).join(':'); // ap-ok: simple group extraction
    }

    // Expand :: by inserting zero groups to fill 8 total.
    const head = halves[0] ? halves[0].split(':') : []; // ap-ok: group extraction from head
    const tail = halves[1] ? halves[1].split(':') : []; // ap-ok: group extraction from tail
    const zeros = new Array(8 - head.length - tail.length).fill('0'); // ap-ok: zero-fill for :: expansion
    const full = [...head, ...zeros, ...tail]; // ap-ok: reassemble expanded groups
    return full.slice(0, 4).join(':');
}

/**
 * Checks the per-location rate limit: RL_AUTH keyed by the credential, or
 * RL_ANON keyed by the caller's IP (IPv6 by /64). A worker without the
 * binding (local tests) is not limited.
 *
 * @param {{RL_AUTH?: RateLimit, RL_ANON?: RateLimit}} env - Worker bindings.
 * @param {Request} request - The inbound request.
 * @param {Caller} caller - From identifyCaller.
 * @returns {Promise<boolean>} True when the caller is over its limit.
 */
export async function rateLimited(env, request, caller) {
    const limiter = caller.identity ? env.RL_AUTH : env.RL_ANON;
    if (!limiter) return false;
    const key = caller.identity ?? normaliseIP(request.headers.get('cf-connecting-ip') || '');
    const { success } = await limiter.limit({ key });
    return !success;
}

/**
 * Starts verifying the caller's API key; null when there is none (a session
 * was verified by identifyCaller).
 *
 * @param {{USERDB: D1Database}} env - Worker bindings.
 * @param {Caller} caller - From identifyCaller.
 * @returns {Promise<{valid: boolean, userId: number|null, rejection: string|null, ms: number}>|null}
 *     ms: how long the lookup took (Server-Timing auth).
 */
export function startVerification(env, caller) {
    if (!caller.apiKey) return null;
    const t0 = Date.now();
    return verifyApiKey(env.USERDB, caller.apiKey).then(({ valid, userId, expiresAt }) => ({
        valid,
        userId,
        ms: Date.now() - t0,
        rejection: valid ? null : keyRejection(expiresAt),
    }));
}

/**
 * The 401 message for a key that does not hold.
 *
 * @param {string|null} expiresAt - The key's expiry, when it has one (it lapsed); null for an unknown or revoked key.
 * @returns {string}
 */
function keyRejection(expiresAt) {
    if (expiresAt === null) return 'Invalid API key. Create a key at /account after signing in.';
    return `This API key expired at ${expiresAt}. Rotate or create a key at /account.`;
}

/**
 * Returns what may leave: a 401 when the caller's API key did not hold;
 * otherwise the response, with X-Auth-Id and the lookup's Server-Timing
 * `auth` added when it is a private (authenticated) one. A shared (public)
 * response is returned as it is: it may be stored at the edge for every
 * caller, so it carries nothing about this one.
 *
 * @param {Response} response - The response computed for the caller.
 * @param {Caller} caller - From identifyCaller.
 * @param {ReturnType<typeof startVerification>} verification - From startVerification.
 * @param {(status: number, message: string) => Response} error - The worker's error response builder.
 * @returns {Promise<Response>}
 */
export async function settle(response, caller, verification, error) {
    let { userId, ms } = caller;
    if (verification !== null) {
        const key = await verification;
        if (!key.valid) return error(401, /** @type {string} */ (key.rejection));
        ({ userId, ms } = key);
    }
    if (userId === null || response.headers.get('X-Auth-Status') !== 'authenticated') return response;
    const out = new Response(response.body, response);
    out.headers.set('X-Auth-Id', `u${userId}`);
    const timing = out.headers.get('Server-Timing');
    if (timing && ms !== null) out.headers.set('Server-Timing', `${timing}, auth;dur=${ms}`);
    return out;
}
