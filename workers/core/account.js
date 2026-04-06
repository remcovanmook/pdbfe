/**
 * @fileoverview Account management handlers for the pdbfe-auth worker.
 *
 * Provides CRUD operations for user profiles and API keys:
 *
 *   GET    /account/profile     → Return user profile
 *   PUT    /account/profile     → Update user profile
 *   GET    /account/keys        → List API keys (prefix + label only)
 *   POST   /account/keys        → Create a new API key
 *   DELETE /account/keys/:id    → Revoke an API key
 *
 * All endpoints require a valid session (Authorization: Bearer header).
 *
 * Data is stored in the USERS KV namespace:
 *   user:<pdb_user_id>   → UserRecord (profile + key metadata)
 *   apikey:<full_key>    → ApiKeyEntry (reverse index for API worker lookups)
 *
 * API keys use the format `pdbfe.<32 hex chars>` for visual distinction
 * from upstream PeeringDB API keys.
 */

import { extractSessionId, resolveSession, generateSessionId } from './auth.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** KV key prefix for user records. */
const USER_PREFIX = 'user:';

/** KV key prefix for API key reverse-index entries. */
const APIKEY_PREFIX = 'apikey:';

/** Prefix prepended to generated API keys for identification. */
const KEY_VISUAL_PREFIX = 'pdbfe.';

/** Maximum number of API keys per user. */
const MAX_KEYS_PER_USER = 5;

// ── CORS ─────────────────────────────────────────────────────────────────────

/**
 * Builds CORS headers for account endpoints.
 *
 * @param {string} origin - Allowed origin.
 * @returns {Record<string, string>}
 */
function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
    };
}

/**
 * Returns a JSON response with CORS headers.
 *
 * @param {any} body - Response body (will be JSON.stringify'd).
 * @param {number} status - HTTP status code.
 * @param {string} origin - Allowed CORS origin.
 * @returns {Response}
 */
function jsonResponse(body, status, origin) {
    return new Response(
        JSON.stringify(body) + '\n',
        {
            status,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                ...corsHeaders(origin),
            },
        }
    );
}

// ── Session resolution ───────────────────────────────────────────────────────

/**
 * Resolves the current session from the request. Returns the session
 * data or a 401 response if not authenticated.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<{session: SessionData|null, error: Response|null}>}
 */
async function requireSession(request, env) {
    const sid = extractSessionId(request);
    if (!sid) {
        return { session: null, error: jsonResponse({ error: 'Authentication required' }, 401, env.FRONTEND_ORIGIN) };
    }

    const session = await resolveSession(env.SESSIONS, sid);
    if (!session) {
        return { session: null, error: jsonResponse({ error: 'Invalid or expired session' }, 401, env.FRONTEND_ORIGIN) };
    }

    return { session, error: null };
}

// ── User record helpers ──────────────────────────────────────────────────────

/**
 * Reads a user record from USERS KV. Returns null if not found.
 *
 * @param {KVNamespace} kv - USERS KV namespace.
 * @param {number} userId - PeeringDB user ID.
 * @returns {Promise<UserRecord|null>}
 */
async function getUser(kv, userId) {
    return /** @type {UserRecord|null} */ (
        await kv.get(USER_PREFIX + userId, { type: 'json' })
    );
}

/**
 * Writes a user record to USERS KV. No TTL — user records persist
 * until explicitly deleted.
 *
 * @param {KVNamespace} kv - USERS KV namespace.
 * @param {UserRecord} user - The user record to write.
 * @returns {Promise<void>}
 */
async function putUser(kv, user) {
    await kv.put(USER_PREFIX + user.id, JSON.stringify(user));
}

/**
 * Provisions a new user record from session data if one doesn't
 * already exist. Returns the existing or newly created record.
 *
 * @param {KVNamespace} kv - USERS KV namespace.
 * @param {SessionData} session - Current session data.
 * @returns {Promise<UserRecord>}
 */
async function ensureUser(kv, session) {
    const existing = await getUser(kv, session.id);
    if (existing) return existing;

    const now = new Date().toISOString();
    /** @type {UserRecord} */
    const user = {
        id: session.id,
        name: session.name,
        email: session.email,
        api_keys: [],
        created_at: now,
        updated_at: now,
    };

    await putUser(kv, user);
    return user;
}

// ── API key helpers ──────────────────────────────────────────────────────────

/**
 * Generates a new API key. Format: `pdbfe.<32 hex chars>`.
 * The 16 random bytes provide 128 bits of entropy.
 *
 * @returns {string} The full API key string.
 */
export function generateApiKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return KEY_VISUAL_PREFIX + hex;
}

/**
 * Extracts the key ID from a full API key. The ID is the first 8 hex
 * characters after the prefix, used as the stable identifier in the
 * user record's api_keys array.
 *
 * @param {string} fullKey - The full API key (e.g. "pdbfe.a1b2c3d4e5f6...").
 * @returns {string} The 8-character key ID.
 */
function keyId(fullKey) {
    return fullKey.slice(KEY_VISUAL_PREFIX.length, KEY_VISUAL_PREFIX.length + 8);
}

/**
 * Extracts the display prefix from a full API key. The prefix is the
 * first 4 hex characters after the `pdbfe.` visual prefix.
 *
 * @param {string} fullKey - The full API key.
 * @returns {string} The 4-character display prefix.
 */
function keyPrefix(fullKey) {
    return fullKey.slice(KEY_VISUAL_PREFIX.length, KEY_VISUAL_PREFIX.length + 4);
}

// ── Endpoint Handlers ────────────────────────────────────────────────────────

/**
 * GET /account/profile — Returns the user's profile.
 * Auto-provisions a user record if this is the first access.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handleGetProfile(request, env) {
    const { session, error } = await requireSession(request, env);
    if (error) return error;

    const user = await ensureUser(env.USERS, /** @type {SessionData} */ (session));

    return jsonResponse({
        id: user.id,
        name: user.name,
        email: user.email,
        networks: session.networks,
        created_at: user.created_at,
        updated_at: user.updated_at,
    }, 200, env.FRONTEND_ORIGIN);
}

/**
 * PUT /account/profile — Updates the user's display name.
 * Only the `name` field is editable; email comes from PeeringDB.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handleUpdateProfile(request, env) {
    const { session, error } = await requireSession(request, env);
    if (error) return error;

    let body;
    try {
        body = /** @type {{name?: string}} */ (await request.json());
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400, env.FRONTEND_ORIGIN);
    }

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return jsonResponse({ error: 'name is required and must be non-empty' }, 400, env.FRONTEND_ORIGIN);
    }

    const user = await ensureUser(env.USERS, /** @type {SessionData} */ (session));
    user.name = body.name.trim();
    user.updated_at = new Date().toISOString();

    await putUser(env.USERS, user);

    return jsonResponse({
        id: user.id,
        name: user.name,
        email: user.email,
        updated_at: user.updated_at,
    }, 200, env.FRONTEND_ORIGIN);
}

/**
 * GET /account/keys — Lists the user's API keys.
 * Returns metadata only (id, label, prefix, created_at) — never the full key.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handleListKeys(request, env) {
    const { session, error } = await requireSession(request, env);
    if (error) return error;

    const user = await ensureUser(env.USERS, /** @type {SessionData} */ (session));

    return jsonResponse({
        keys: user.api_keys,
        max_keys: MAX_KEYS_PER_USER,
    }, 200, env.FRONTEND_ORIGIN);
}

/**
 * POST /account/keys — Creates a new API key.
 * The full key is returned exactly once in the response. It is never
 * stored in the user record — only the 4-char prefix is kept for display.
 *
 * Two KV writes happen atomically (sequentially):
 *   1. `apikey:<full_key>` — reverse index for pdbfe-api lookups
 *   2. `user:<id>` — updated user record with new key metadata
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handleCreateKey(request, env) {
    const { session, error } = await requireSession(request, env);
    if (error) return error;

    let body;
    try {
        body = /** @type {{label?: string}} */ (await request.json());
    } catch {
        body = {};
    }

    const label = (typeof body.label === 'string' && body.label.trim().length > 0)
        ? body.label.trim().slice(0, 64)
        : 'Unnamed key';

    const user = await ensureUser(env.USERS, /** @type {SessionData} */ (session));

    if (user.api_keys.length >= MAX_KEYS_PER_USER) {
        return jsonResponse(
            { error: `Maximum of ${MAX_KEYS_PER_USER} API keys allowed` },
            400,
            env.FRONTEND_ORIGIN
        );
    }

    const fullKey = generateApiKey();
    const now = new Date().toISOString();

    // Write reverse-index entry (for pdbfe-api lookups)
    /** @type {ApiKeyEntry} */
    const entry = {
        user_id: session.id,
        label,
        created_at: now,
    };
    await env.USERS.put(APIKEY_PREFIX + fullKey, JSON.stringify(entry));

    // Update user record with key metadata
    /** @type {ApiKeyMeta} */
    const meta = {
        id: keyId(fullKey),
        label,
        prefix: keyPrefix(fullKey),
        created_at: now,
    };
    user.api_keys.push(meta);
    user.updated_at = now;
    await putUser(env.USERS, user);

    // Return the full key exactly once
    return jsonResponse({
        key: fullKey,
        id: meta.id,
        label: meta.label,
        prefix: meta.prefix,
        created_at: now,
    }, 201, env.FRONTEND_ORIGIN);
}

/**
 * DELETE /account/keys/:id — Revokes an API key by its 8-char ID.
 * Deletes both the reverse-index entry and removes the key from
 * the user record.
 *
 * Since we don't store the full key in the user record, we need to
 * reconstruct the reverse-index key. We iterate over KV to find the
 * matching entry by user_id and key ID prefix match.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @param {string} deleteKeyId - The 8-char key ID to revoke.
 * @returns {Promise<Response>}
 */
export async function handleDeleteKey(request, env, deleteKeyId) {
    const { session, error } = await requireSession(request, env);
    if (error) return error;

    const user = await ensureUser(env.USERS, /** @type {SessionData} */ (session));

    const keyIndex = user.api_keys.findIndex(k => k.id === deleteKeyId);
    if (keyIndex === -1) {
        return jsonResponse({ error: 'API key not found' }, 404, env.FRONTEND_ORIGIN);
    }

    // Find and delete the reverse-index entry by listing keys with the prefix
    // The full key starts with "pdbfe." followed by hex where first 8 chars match the ID
    const listResult = await env.USERS.list({ prefix: APIKEY_PREFIX + KEY_VISUAL_PREFIX + deleteKeyId });
    for (const key of listResult.keys) {
        // Verify the entry belongs to this user before deleting
        const entry = /** @type {ApiKeyEntry|null} */ (
            await env.USERS.get(key.name, { type: 'json' })
        );
        if (entry && entry.user_id === session.id) {
            await env.USERS.delete(key.name);
        }
    }

    // Remove from user record
    user.api_keys.splice(keyIndex, 1);
    user.updated_at = new Date().toISOString();
    await putUser(env.USERS, user);

    return jsonResponse({ deleted: deleteKeyId }, 200, env.FRONTEND_ORIGIN);
}

/**
 * OPTIONS preflight for /account/* endpoints.
 *
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Response}
 */
export function handleAccountPreflight(env) {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(env.FRONTEND_ORIGIN),
    });
}
