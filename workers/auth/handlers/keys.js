/**
 * @fileoverview API key management handlers for the pdbfe-auth worker.
 *
 * Provides CRUD operations for API keys:
 *   GET    /account/keys       → List API keys (prefix + label only)
 *   POST   /account/keys       → Create a new API key
 *   DELETE /account/keys/:id   → Revoke an API key
 *
 * API keys use the format `pdbfe.<32 hex chars>` for visual distinction
 * from upstream PeeringDB API keys. Keys are SHA-256 hashed before
 * storage so the cleartext key is never persisted.
 */

import { hashKey } from '../../core/auth.js';
import { jsonResponse, methodNotAllowed, handlePreflight, requireSession, ensureUser } from '../http.js';

/** Prefix prepended to generated API keys for identification. */
const KEY_VISUAL_PREFIX = 'pdbfe.';

/** Maximum number of API keys per user. */
const MAX_KEYS_PER_USER = 5;

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

/**
 * Dispatches /account/keys requests by HTTP method and sub-path.
 * Handles collection operations (GET, POST) on /account/keys and
 * item deletion (DELETE) on /account/keys/:id.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @param {string} subPath - Path remainder after "/account/keys" (e.g. "" or "/:id").
 * @returns {Promise<Response>}
 */
export async function handleKeys(request, env, subPath) {
    if (request.method === 'OPTIONS') return handlePreflight(request, env);
    // Item route: /account/keys/:id
    if (subPath.length > 1) {
        const deleteKeyId = subPath.slice(1); // strip leading "/"
        if (deleteKeyId.includes('/')) {
            return jsonResponse({ error: 'Invalid key ID' }, 400, '');
        }
        if (request.method !== 'DELETE') return methodNotAllowed('DELETE, OPTIONS');
        return handleDeleteKey(request, env, deleteKeyId);
    }

    // Collection route: /account/keys
    if (request.method === 'GET')  return handleListKeys(request, env);
    if (request.method === 'POST') return handleCreateKey(request, env);
    return methodNotAllowed('GET, POST, OPTIONS');
}

/**
 * GET /account/keys — Lists the user's API keys.
 * Returns metadata only (key_id, label, prefix, created_at) — never the full key.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
async function handleListKeys(request, env) {
    const { session, origin, error } = await requireSession(request, env);
    if (error) return error;

    await ensureUser(env.USERDB, /** @type {SessionData} */ (session));

    const result = await env.USERDB.prepare(
        'SELECT key_id, label, prefix, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at'
    ).bind(session.id).all();

    return jsonResponse({
        keys: result.results,
        max_keys: MAX_KEYS_PER_USER,
    }, 200, origin);
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
async function handleCreateKey(request, env) {
    const { session, origin, error } = await requireSession(request, env);
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
            origin
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
    }, 201, origin);
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
async function handleDeleteKey(request, env, deleteKeyId) {
    const { session, origin, error } = await requireSession(request, env);
    if (error) return error;

    await ensureUser(env.USERDB, /** @type {SessionData} */ (session));

    // Check the key exists and belongs to this user
    const existing = await env.USERDB.prepare(
        'SELECT key_id FROM api_keys WHERE user_id = ? AND key_id = ?'
    ).bind(session.id, deleteKeyId).first();

    if (!existing) {
        return jsonResponse({ error: 'API key not found' }, 404, origin);
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

    return jsonResponse({ deleted: deleteKeyId }, 200, origin);
}
