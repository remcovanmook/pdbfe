/**
 * @fileoverview API key management handlers for the pdbfe-auth worker.
 *
 * Provides CRUD operations for API keys:
 *   GET    /account/keys            → List API keys (prefix, label, expiry)
 *   POST   /account/keys            → Create a new API key
 *   POST   /account/keys/:id/rotate → Replace a key; the old one gets a grace period
 *   DELETE /account/keys/:id        → Revoke an API key
 *
 * Keys carry an optional expiry (`expires_at`, NULL = never), checked at
 * point of use by verifyApiKey. Rotation issues a new key with the same
 * label and lifetime and lets the old one keep working for ROTATE_GRACE_MS,
 * so deployments can switch over. It is authorized by the session or by
 * the key being rotated itself, so automation can renew without a browser.
 *
 * API keys use the format `pdbfe.<32 hex chars>` for visual distinction
 * from upstream PeeringDB API keys. Keys are SHA-256 hashed before
 * storage so the cleartext key is never persisted.
 */

import { hashKey, extractApiKey } from '../../core/auth.js';
import { jsonResponse, methodNotAllowed, handlePreflight, requireSession, ensureUser, resolveAllowedOrigin } from '../http.js';

/** Prefix prepended to generated API keys for identification. */
const KEY_VISUAL_PREFIX = 'pdbfe.';

/** Maximum number of unexpired API keys per user. */
const MAX_KEYS_PER_USER = 5;

/** Lifetime of a new key when the request doesn't specify one. */
const DEFAULT_EXPIRY_DAYS = 365;

/** Longest lifetime a key can be given, short of never expiring. */
const MAX_EXPIRY_DAYS = 3650;

/** How long a rotated-out key keeps working after its replacement is issued. */
const ROTATE_GRACE_MS = 7 * 86400 * 1000;

const DAY_MS = 86400 * 1000;

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
 * Derives the stable api_keys.key_id from the key's SHA-256 hash.
 *
 * 16 hex chars = 64 bits: collision is astronomically unlikely (the previous
 * 8-char / 32-bit id was birthday-bound at ~2^16 keys, where an INSERT collision
 * would surface as an unhandled 500). Deriving it from the HASH rather than the
 * key's own prefix also means the public key_id leaks no key material.
 *
 * Backward compatible: key_id is a management identifier only (list / delete);
 * verifyApiKey looks keys up by `hash`, so existing 8-char ids keep working and
 * only new keys get the wider hash-derived id.
 *
 * @param {string} keyHash - Hex SHA-256 of the full key.
 * @returns {string} The 16-character key ID.
 */
function keyId(keyHash) {
    return keyHash.slice(0, 16);
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
 * Parses the requested key lifetime from a create request body.
 * Absent → DEFAULT_EXPIRY_DAYS; `null` or 0 → never expires; otherwise
 * a whole number of days from 1 to MAX_EXPIRY_DAYS.
 *
 * @param {unknown} days - The body's `expires_in_days` value.
 * @returns {{ok: true, days: number|null}|{ok: false}} Days, or null for never.
 */
export function parseExpiryDays(days) {
    if (days === undefined) return { ok: true, days: DEFAULT_EXPIRY_DAYS };
    if (days === null || days === 0) return { ok: true, days: null };
    if (Number.isInteger(days) && /** @type {number} */ (days) >= 1 && /** @type {number} */ (days) <= MAX_EXPIRY_DAYS) {
        return { ok: true, days: /** @type {number} */ (days) };
    }
    return { ok: false };
}

/**
 * Dispatches /account/keys requests by HTTP method and sub-path.
 * Handles collection operations (GET, POST) on /account/keys, item
 * deletion (DELETE) on /account/keys/:id and rotation (POST) on
 * /account/keys/:id/rotate.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @param {string} subPath - Path remainder after "/account/keys" (e.g. "", "/:id" or "/:id/rotate").
 * @returns {Promise<Response>}
 */
export async function handleKeys(request, env, subPath) {
    if (request.method === 'OPTIONS') return handlePreflight(request, env);
    // Item routes: /account/keys/:id and /account/keys/:id/rotate
    if (subPath.length > 1) {
        const parts = subPath.slice(1).split('/'); // strip leading "/"
        const itemKeyId = parts[0];
        if (parts.length === 2 && parts[1] === 'rotate' && itemKeyId) {
            if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
            return handleRotateKey(request, env, itemKeyId);
        }
        if (parts.length !== 1 || !itemKeyId) {
            return jsonResponse({ error: 'Invalid key ID' }, 400, resolveAllowedOrigin(request, env));
        }
        if (request.method !== 'DELETE') return methodNotAllowed('DELETE, OPTIONS');
        return handleDeleteKey(request, env, itemKeyId);
    }

    // Collection route: /account/keys
    if (request.method === 'GET')  return handleListKeys(request, env);
    if (request.method === 'POST') return handleCreateKey(request, env);
    return methodNotAllowed('GET, POST, OPTIONS');
}

/**
 * GET /account/keys — Lists the user's API keys.
 * Returns metadata only (key_id, label, prefix, created_at, expires_at) —
 * never the full key. Expired keys are included so the account page can
 * show them as expired until the user removes them.
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
        'SELECT key_id, label, prefix, created_at, expires_at FROM api_keys WHERE user_id = ? ORDER BY created_at'
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
        body = /** @type {{label?: string, expires_in_days?: unknown}} */ (await request.json());
    } catch {
        body = {};
    }

    const label = (typeof body.label === 'string' && body.label.trim().length > 0)
        ? body.label.trim().slice(0, 64)
        : 'Unnamed key';

    const expiry = parseExpiryDays(body.expires_in_days);
    if (!expiry.ok) {
        return jsonResponse(
            { error: `expires_in_days must be null (never) or a whole number from 1 to ${MAX_EXPIRY_DAYS}` },
            400,
            origin
        );
    }

    const user = await ensureUser(env.USERDB, /** @type {SessionData} */ (session));
    const nowMs = Date.now();

    // Check key count — soft limit enforced at the application layer.
    // Expired keys don't count: they no longer grant access.
    const countRow = await env.USERDB.prepare(
        'SELECT COUNT(*) as cnt FROM api_keys WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)'
    ).bind(user.id, new Date(nowMs).toISOString()).first();
    const keyCount = countRow ? /** @type {number} */ (countRow.cnt) : 0;

    if (keyCount >= MAX_KEYS_PER_USER) {
        return jsonResponse(
            { error: `Maximum of ${MAX_KEYS_PER_USER} API keys allowed` },
            400,
            origin
        );
    }

    const expiresAt = expiry.days === null ? null : new Date(nowMs + expiry.days * DAY_MS).toISOString();
    const created = await insertKey(env.USERDB, user.id, label, expiresAt, nowMs);

    // Return the full key exactly once
    return jsonResponse(created, 201, origin);
}

/**
 * Generates a key and inserts its row, updating the user's timestamp in
 * the same atomic batch. The UNIQUE constraint on hash prevents duplicates.
 *
 * @param {D1Database} db - USERDB D1 binding.
 * @param {number} userId - Owning user ID.
 * @param {string} label - Key label.
 * @param {string|null} expiresAt - ISO expiry, or null for never.
 * @param {number} nowMs - Current time in ms since epoch.
 * @param {D1PreparedStatement[]} [extra] - Further statements to run in the same batch.
 * @returns {Promise<{key: string, key_id: string, label: string, prefix: string, created_at: string, expires_at: string|null}>}
 *   The new key's metadata, including the full key (returned to the user once).
 */
async function insertKey(db, userId, label, expiresAt, nowMs, extra = []) {
    const fullKey = generateApiKey();
    const keyHash = await hashKey(fullKey);
    const now = new Date(nowMs).toISOString();
    const id = keyId(keyHash);
    const prefix = keyPrefix(fullKey);

    await db.batch([
        db.prepare(
            'INSERT INTO api_keys (key_id, user_id, label, prefix, hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, userId, label, prefix, keyHash, now, expiresAt),
        db.prepare(
            'UPDATE users SET updated_at = ? WHERE id = ?'
        ).bind(now, userId),
        ...extra,
    ]);

    return { key: fullKey, key_id: id, label, prefix, created_at: now, expires_at: expiresAt };
}

/**
 * POST /account/keys/:id/rotate — Replaces an API key.
 *
 * Issues a new key with the same label and lifetime (never-expiring stays
 * never-expiring) and moves the old key's expiry to at most ROTATE_GRACE_MS
 * from now. Both happen in one batch. The new full key is returned once,
 * alongside the old key's new expiry.
 *
 * Authorized by either:
 *   - `Authorization: Bearer <sid>` for a session owning the key, or
 *   - `Authorization: Api-Key <key>` where the key IS the one being
 *     rotated (and has not expired), so automation can renew itself.
 * Neither header is sent by browsers on their own, so this is CSRF-safe.
 *
 * Rotation is not blocked by MAX_KEYS_PER_USER: the old key drops out of
 * the count once its grace period ends.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @param {string} rotateKeyId - The key ID to rotate.
 * @returns {Promise<Response>}
 */
async function handleRotateKey(request, env, rotateKeyId) {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const apiKey = extractApiKey(request);

    /** @type {Record<string, any>|null} */
    let existing;
    let origin;
    if (apiKey === null) {
        const auth = await requireSession(request, env);
        if (auth.error) return auth.error;
        origin = auth.origin;
        await ensureUser(env.USERDB, /** @type {SessionData} */ (auth.session));
        existing = await env.USERDB.prepare(
            'SELECT user_id, key_id, label, created_at, expires_at FROM api_keys WHERE user_id = ? AND key_id = ?'
        ).bind(auth.session.id, rotateKeyId).first();
    } else {
        origin = resolveAllowedOrigin(request, env);
        existing = await env.USERDB.prepare(
            'SELECT user_id, key_id, label, created_at, expires_at FROM api_keys WHERE hash = ? AND key_id = ?'
        ).bind(await hashKey(apiKey), rotateKeyId).first();
        if (!existing) {
            return jsonResponse({ error: 'The API key does not match the key being rotated' }, 403, origin);
        }
    }

    if (!existing) {
        return jsonResponse({ error: 'API key not found' }, 404, origin);
    }
    if (existing.expires_at !== null && existing.expires_at <= nowIso) {
        return jsonResponse({ error: 'API key has expired; create a new one instead' }, 400, origin);
    }

    // Same lifetime as the key being replaced; never-expiring stays so.
    const newExpiresAt = existing.expires_at === null
        ? null
        : new Date(nowMs + (Date.parse(existing.expires_at) - Date.parse(existing.created_at))).toISOString();

    // Old key: grace period, but never later than it would have expired anyway.
    const graceIso = new Date(nowMs + ROTATE_GRACE_MS).toISOString();
    const oldExpiresAt = existing.expires_at !== null && existing.expires_at < graceIso ? existing.expires_at : graceIso;

    const created = await insertKey(env.USERDB, existing.user_id, existing.label, newExpiresAt, nowMs, [
        env.USERDB.prepare(
            'UPDATE api_keys SET expires_at = ? WHERE user_id = ? AND key_id = ?'
        ).bind(oldExpiresAt, existing.user_id, existing.key_id),
    ]);

    return jsonResponse({
        ...created,
        rotated: { key_id: existing.key_id, expires_at: oldExpiresAt },
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
