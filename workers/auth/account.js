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
 * Data is stored in the USERDB D1 database:
 *   users     — one row per PeeringDB user (auto-provisioned on first login)
 *   api_keys  — one row per API key, with ACID guarantees on INSERT/DELETE
 *
 * API keys use the format `pdbfe.<32 hex chars>` for visual distinction
 * from upstream PeeringDB API keys. Keys are SHA-256 hashed before
 * storage so the cleartext key is never persisted.
 */

import { extractSessionId, resolveSession, generateSessionId, hashKey } from '../core/auth.js';

// ── Constants ────────────────────────────────────────────────────────────────

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

// ── User record helpers (D1) ─────────────────────────────────────────────────

/**
 * Reads a user record from the USERDB D1 database. Returns null if not found.
 *
 * @param {D1Database} db - USERDB D1 binding.
 * @param {number} userId - PeeringDB user ID.
 * @returns {Promise<UserRecord|null>}
 */
async function getUser(db, userId) {
    return /** @type {UserRecord|null} */ (
        await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()
    );
}

/**
 * Provisions a new user record from session data if one doesn't
 * already exist. Returns the existing or newly created record.
 *
 * @param {D1Database} db - USERDB D1 binding.
 * @param {SessionData} session - Current session data.
 * @returns {Promise<UserRecord>}
 */
async function ensureUser(db, session) {
    const existing = await getUser(db, session.id);
    if (existing) return existing;

    const now = new Date().toISOString();
    await db.prepare(
        'INSERT INTO users (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(session.id, session.name, session.email, now, now).run();

    return /** @type {UserRecord} */ ({
        id: session.id,
        name: session.name,
        email: session.email,
        created_at: now,
        updated_at: now,
    });
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
 * api_keys table.
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

    const user = await ensureUser(env.USERDB, /** @type {SessionData} */ (session));

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

    const user = await ensureUser(env.USERDB, /** @type {SessionData} */ (session));
    const now = new Date().toISOString();
    const trimmedName = body.name.trim();

    await env.USERDB.prepare(
        'UPDATE users SET name = ?, updated_at = ? WHERE id = ?'
    ).bind(trimmedName, now, user.id).run();

    return jsonResponse({
        id: user.id,
        name: trimmedName,
        email: user.email,
        updated_at: now,
    }, 200, env.FRONTEND_ORIGIN);
}

/**
 * GET /account/keys — Lists the user's API keys.
 * Returns metadata only (key_id, label, prefix, created_at) — never the full key.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handleListKeys(request, env) {
    const { session, error } = await requireSession(request, env);
    if (error) return error;

    await ensureUser(env.USERDB, /** @type {SessionData} */ (session));

    const result = await env.USERDB.prepare(
        'SELECT key_id, label, prefix, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at'
    ).bind(session.id).all();

    return jsonResponse({
        keys: result.results,
        max_keys: MAX_KEYS_PER_USER,
    }, 200, env.FRONTEND_ORIGIN);
}

/**
 * POST /account/keys — Creates a new API key.
 * The full key is returned exactly once in the response. It is never
 * stored — only its SHA-256 hash is persisted in D1.
 *
 * Uses db.batch() to atomically:
 *   1. INSERT the key row into api_keys
 *   2. UPDATE the user's updated_at timestamp
 *
 * The UNIQUE constraint on api_keys.hash prevents duplicate keys at
 * the database level. The key count check + insert is not strictly
 * atomic, but the worst case is exceeding MAX_KEYS_PER_USER by one
 * on a race — acceptable for a soft limit.
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

    const user = await ensureUser(env.USERDB, /** @type {SessionData} */ (session));

    // Check key count — soft limit enforced at the application layer.
    const countRow = await env.USERDB.prepare(
        'SELECT COUNT(*) as cnt FROM api_keys WHERE user_id = ?'
    ).bind(user.id).first();
    const keyCount = countRow ? /** @type {number} */ (countRow.cnt) : 0;

    if (keyCount >= MAX_KEYS_PER_USER) {
        return jsonResponse(
            { error: `Maximum of ${MAX_KEYS_PER_USER} API keys allowed` },
            400,
            env.FRONTEND_ORIGIN
        );
    }

    const fullKey = generateApiKey();
    const keyHash = await hashKey(fullKey);
    const now = new Date().toISOString();
    const id = keyId(fullKey);
    const prefix = keyPrefix(fullKey);

    // Atomic batch: insert key + update user timestamp.
    // UNIQUE constraint on hash prevents duplicate keys.
    await env.USERDB.batch([
        env.USERDB.prepare(
            'INSERT INTO api_keys (key_id, user_id, label, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, user.id, label, prefix, keyHash, now),
        env.USERDB.prepare(
            'UPDATE users SET updated_at = ? WHERE id = ?'
        ).bind(now, user.id),
    ]);

    // Return the full key exactly once
    return jsonResponse({
        key: fullKey,
        key_id: id,
        label,
        prefix,
        created_at: now,
    }, 201, env.FRONTEND_ORIGIN);
}

/**
 * DELETE /account/keys/:id — Revokes an API key by its 8-char ID.
 * Deletes the key row from api_keys and updates the user's timestamp.
 * Uses db.batch() to ensure both operations succeed or fail together.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @param {string} deleteKeyId - The 8-char key ID to revoke.
 * @returns {Promise<Response>}
 */
export async function handleDeleteKey(request, env, deleteKeyId) {
    const { session, error } = await requireSession(request, env);
    if (error) return error;

    await ensureUser(env.USERDB, /** @type {SessionData} */ (session));

    // Check the key exists and belongs to this user
    const existing = await env.USERDB.prepare(
        'SELECT key_id FROM api_keys WHERE user_id = ? AND key_id = ?'
    ).bind(session.id, deleteKeyId).first();

    if (!existing) {
        return jsonResponse({ error: 'API key not found' }, 404, env.FRONTEND_ORIGIN);
    }

    const now = new Date().toISOString();

    // Atomic batch: delete key + update user timestamp
    await env.USERDB.batch([
        env.USERDB.prepare(
            'DELETE FROM api_keys WHERE user_id = ? AND key_id = ?'
        ).bind(session.id, deleteKeyId),
        env.USERDB.prepare(
            'UPDATE users SET updated_at = ? WHERE id = ?'
        ).bind(now, session.id),
    ]);

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
