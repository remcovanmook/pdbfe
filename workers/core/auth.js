/**
 * @fileoverview Authentication utilities for the PeeringDB API worker.
 *
 * Provides two authentication paths:
 *
 * 1. API-Key: PeeringDB convention `Authorization: Api-Key <key>`.
 *    Currently a stub — verifyApiKey() always returns false.
 *    Reserved for future direct API-key validation.
 *
 * 2. Session-based: OAuth sessions stored in the SESSIONS KV namespace.
 *    The pdbfe-auth worker writes sessions on successful OAuth login.
 *    The pdbfe-api worker reads sessions to determine auth status.
 *    Sessions are identified by a random hex token sent as:
 *      - `Authorization: Bearer <sid>` header, or
 *      - `pdbfe_sid` cookie
 *
 * The KV key format is `session:<sid>` and values are JSON SessionData objects.
 */

/** @type {string} KV key prefix for session entries. */
const SESSION_PREFIX = 'session:';

/**
 * Extracts an API key from the request's Authorization header.
 * Supports the PeeringDB header format: `Api-Key <key>`.
 *
 * Returns the key string if present and correctly formatted,
 * or null if the header is missing, empty, or uses an
 * unrecognised scheme.
 *
 * @param {Request} request - The inbound HTTP request.
 * @returns {string|null} The extracted API key, or null.
 */
export function extractApiKey(request) {
    const header = request.headers.get('Authorization');
    if (!header) return null;

    // PeeringDB uses "Api-Key <key>" (case-insensitive prefix)
    const prefix = 'api-key ';
    if (!header.toLowerCase().startsWith(prefix)) return null;

    const key = header.slice(prefix.length).trim();
    return key.length > 0 ? key : null;
}

/**
 * Validates an API key. Stub — always returns false.
 *
 * Reserved for future direct API-key validation against an upstream
 * endpoint or a separate keys KV namespace. Not used for OAuth sessions.
 *
 * @param {string} _apiKey - The API key to validate (unused).
 * @returns {boolean} Whether the key is valid. Always false for now.
 */
export function verifyApiKey(_apiKey) {
    return false;
}

/**
 * Extracts a session ID from the request. Checks two sources in order:
 *
 * 1. `Authorization: Bearer <sid>` header (preferred for API clients)
 * 2. `pdbfe_sid` cookie (for browser-based sessions)
 *
 * Returns the raw session ID string or null if not present.
 * Does not validate the session — use resolveSession() for that.
 *
 * @param {Request} request - The inbound HTTP request.
 * @returns {string|null} The extracted session ID, or null.
 */
export function extractSessionId(request) {
    // Check Bearer token first
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
        const bearerPrefix = 'bearer ';
        if (authHeader.toLowerCase().startsWith(bearerPrefix)) {
            const sid = authHeader.slice(bearerPrefix.length).trim();
            if (sid.length > 0) return sid;
        }
    }

    // Fall back to cookie
    const cookie = request.headers.get('Cookie');
    if (cookie) {
        const match = cookie.match(/(?:^|;\s*)pdbfe_sid=([^;]+)/);
        if (match && match[1]) return match[1].trim();
    }

    return null;
}

/**
 * Resolves a session ID to a SessionData object by reading from
 * the SESSIONS KV namespace. Returns null if the session does not
 * exist or if the stored value is not valid JSON.
 *
 * KV TTL handles expiration — if the key has expired, KV.get()
 * returns null automatically.
 *
 * @param {KVNamespace} kv - The SESSIONS KV namespace binding.
 * @param {string} sid - The session ID to look up.
 * @returns {Promise<SessionData|null>} The session data, or null if invalid/expired.
 */
export async function resolveSession(kv, sid) {
    if (!sid) return null;

    const key = SESSION_PREFIX + sid;
    const value = await kv.get(key, { type: 'json' });
    if (!value) return null;

    return /** @type {SessionData} */ (value);
}

/**
 * Generates a cryptographically random session ID as a 32-byte
 * hex string (64 characters). Used by the auth worker when
 * creating new sessions after a successful OAuth callback.
 *
 * @returns {string} A 64-character lowercase hex string.
 */
export function generateSessionId() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Writes a session to the SESSIONS KV namespace. Used by the auth
 * worker after a successful OAuth callback to persist user data.
 *
 * @param {KVNamespace} kv - The SESSIONS KV namespace binding.
 * @param {string} sid - The session ID (from generateSessionId).
 * @param {SessionData} data - The user profile data to store.
 * @param {number} [ttlSeconds=86400] - Time-to-live in seconds (default 24 hours).
 * @returns {Promise<void>}
 */
export async function writeSession(kv, sid, data, ttlSeconds = 86400) {
    const key = SESSION_PREFIX + sid;
    await kv.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds });
}

/**
 * Deletes a session from the SESSIONS KV namespace. Used by the
 * auth worker on logout.
 *
 * @param {KVNamespace} kv - The SESSIONS KV namespace binding.
 * @param {string} sid - The session ID to delete.
 * @returns {Promise<void>}
 */
export async function deleteSession(kv, sid) {
    if (!sid) return;
    const key = SESSION_PREFIX + sid;
    await kv.delete(key);
}
