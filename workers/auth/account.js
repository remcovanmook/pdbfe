/**
 * @fileoverview Account management handlers for the pdbfe-auth worker.
 *
 * Provides CRUD operations for user profiles, preferences, favorites,
 * and API keys:
 *
 *   GET    /account/preferences/options → Available preference keys/values (public)
 *   GET    /account/profile           → Return user profile & preferences
 *   PUT    /account/profile           → Update profile & preferences
 *   GET    /account/keys              → List API keys (prefix + label only)
 *   POST   /account/keys              → Create a new API key
 *   DELETE /account/keys/:id          → Revoke an API key
 *   GET    /account/favorites         → List favorited entities
 *   POST   /account/favorites         → Add a favorite
 *   DELETE /account/favorites/:type/:id → Remove a favorite
 *
 * All endpoints require a valid session (Authorization: Bearer header).
 *
 * Data is stored in the USERDB D1 database:
 *   users           — one row per PeeringDB user (auto-provisioned on first login)
 *   api_keys        — one row per API key, with ACID guarantees on INSERT/DELETE
 *   user_favorites  — one row per favorited entity
 *
 * API keys use the format `pdbfe.<32 hex chars>` for visual distinction
 * from upstream PeeringDB API keys. Keys are SHA-256 hashed before
 * storage so the cleartext key is never persisted.
 */

import { extractSessionId, resolveSession, hashKey } from '../core/auth.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Prefix prepended to generated API keys for identification. */
const KEY_VISUAL_PREFIX = 'pdbfe.';

/** Maximum number of API keys per user. */
// @ts-ignore — used by handleCreateKey

const MAX_KEYS_PER_USER = 5;

/** Maximum number of favorites per user. */
const MAX_FAVORITES_PER_USER = 50;

/** Entity types that can be favorited. */
const VALID_FAVORITE_TYPES = new Set(['net', 'ix', 'fac', 'org', 'carrier', 'campus']);

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
 * Resolves the CORS origin to reflect in the response. Returns the
 * request's Origin if it matches:
 *   1. The production FRONTEND_ORIGIN host (treating www. and apex
 *      as equivalent — e.g. pdbfe.dev and www.pdbfe.dev both match), or
 *   2. Any subdomain of the production host, or
 *   3. Any Cloudflare Pages preview subdomain (*.pages.dev) for the
 *      same project (configured via PAGES_PROJECT or derived from
 *      FRONTEND_ORIGIN).
 * Falls back to the production origin otherwise.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {string} The origin to use in Access-Control-Allow-Origin.
 */
export function resolveAllowedOrigin(request, env) {
    const prodHost = new URL(env.FRONTEND_ORIGIN).host;
    const requestOrigin = request.headers.get('Origin') || '';
    if (!requestOrigin) return env.FRONTEND_ORIGIN;
    try {
        const reqHost = new URL(requestOrigin).host;
        // Exact match (covers identical host including www prefix)
        if (reqHost === prodHost) return requestOrigin;
        // Apex/www equivalence: strip www. from both and compare.
        // Handles FRONTEND_ORIGIN=https://www.pdbfe.dev with request
        // from https://pdbfe.dev, and vice versa.
        if (stripWww(reqHost) === stripWww(prodHost)) return requestOrigin;
        // Subdomain of production host (e.g. staging.pdbfe.dev)
        if (reqHost.endsWith(`.${stripWww(prodHost)}`)) {
            return requestOrigin;
        }
        // Cloudflare Pages preview: <hash|branch>.pdbfe-frontend.pages.dev
        const pagesProject = env.PAGES_PROJECT || 'pdbfe-frontend';
        if (reqHost.endsWith(`.${pagesProject}.pages.dev`)) {
            return requestOrigin;
        }
    } catch { /* malformed */ }
    return env.FRONTEND_ORIGIN;
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
 * data, the resolved CORS origin, or a 401 response if not authenticated.
 *
 * The CORS origin is resolved once here so all downstream handlers use
 * a consistent, validated origin that works for both production and
 * Cloudflare Pages preview deployments.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<{session: SessionData|null, origin: string, error: Response|null}>}
 */
async function requireSession(request, env) {
    const origin = resolveAllowedOrigin(request, env);
    const sid = extractSessionId(request);
    if (!sid) {
        return { session: null, origin, error: jsonResponse({ error: 'Authentication required' }, 401, origin) };
    }

    const session = await resolveSession(env.SESSIONS, sid);
    if (!session) {
        return { session: null, origin, error: jsonResponse({ error: 'Invalid or expired session' }, 401, origin) };
    }

    return { session, origin, error: null };
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
 * Uses INSERT OR IGNORE to survive concurrent SPA requests that
 * may both attempt to provision the same user simultaneously.
 * The second INSERT silently drops, and the re-fetch returns
 * the canonical DB state regardless of which request won.
 *
 * @param {D1Database} db - USERDB D1 binding.
 * @param {SessionData} session - Current session data.
 * @returns {Promise<UserRecord>}
 */
async function ensureUser(db, session) {
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
 * GET /account/preferences/options — Returns available preference keys
 * and their valid values from the preference_options table.
 *
 * Public endpoint (no auth required) so the UI can populate selectors
 * before login. Response is grouped by pref_key:
 *   { "language": ["en", "de", ...], "theme": ["auto", "dark", "light"] }
 *
 * CORS: reflects the request Origin when it matches the production
 * FRONTEND_ORIGIN or any Cloudflare Pages preview subdomain of the
 * same project. This avoids CORS failures on branch previews.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handlePreferenceOptions(request, env) {
    const { results } = await env.USERDB.prepare(
        'SELECT pref_key, pref_value FROM preference_options ORDER BY pref_key, pref_value'
    ).all();

    /** @type {Record<string, string[]>} */
    const grouped = {};
    for (const row of results) {
        const key = /** @type {string} */ (row.pref_key);
        const val = /** @type {string} */ (row.pref_value);
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(val);
    }

    return new Response(JSON.stringify(grouped) + '\n', {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            ...corsHeaders(resolveAllowedOrigin(request, env)),
        },
    });
}

/**
 * GET /account/profile — Returns the user's profile.
 * Auto-provisions a user record if this is the first access.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handleGetProfile(request, env) {
    const { session, origin, error } = await requireSession(request, env);
    if (error) return error;

    const user = await ensureUser(env.USERDB, /** @type {SessionData} */ (session));

    /** @type {UserPreferences} */
    let preferences = {};
    try { preferences = JSON.parse(user.preferences || '{}'); } catch { /* use default */ }

    return jsonResponse({
        id: user.id,
        name: user.name,
        email: user.email,
        preferences,
        networks: session.networks,
        created_at: user.created_at,
        updated_at: user.updated_at,
    }, 200, origin);
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
    const { session, origin, error } = await requireSession(request, env);
    if (error) return error;

    let body;
    try {
        body = /** @type {{name?: string, preferences?: UserPreferences}} */ (await request.json());
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400, origin);
    }

    const user = await ensureUser(env.USERDB, /** @type {SessionData} */ (session));
    const now = new Date().toISOString();

    // Build SET clauses for fields that are being updated
    const sets = /** @type {string[]} */ ([]);
    const binds = /** @type {(string|number)[]} */ ([]);

    // Name update
    if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
            return jsonResponse({ error: 'name must be non-empty' }, 400, origin);
        }
        sets.push('name = ?');
        binds.push(body.name.trim());
    }

    // Preferences update (merge with existing)
    /** @type {UserPreferences} */
    let mergedPrefs;
    try { mergedPrefs = JSON.parse(user.preferences || '{}'); } catch { mergedPrefs = {}; }

    if (body.preferences !== undefined) {
        if (typeof body.preferences !== 'object' || body.preferences === null) {
            return jsonResponse({ error: 'preferences must be an object' }, 400, origin);
        }

        // Validate each preference key/value against the preference_options table.
        // This avoids hardcoded enum checks — adding a new preference is a DB INSERT.
        for (const [key, value] of Object.entries(body.preferences)) {
            if (typeof value !== 'string') {
                return jsonResponse({ error: `Preference '${key}' must be a string` }, 400, origin);
            }
            const valid = await env.USERDB.prepare(
                'SELECT 1 FROM preference_options WHERE pref_key = ? AND pref_value = ?'
            ).bind(key, value).first();
            if (!valid) {
                return jsonResponse({ error: `Invalid preference: ${key}=${value}` }, 400, origin);
            }
            mergedPrefs[key] = value;
        }

        sets.push('preferences = ?');
        binds.push(JSON.stringify(mergedPrefs));
    }

    if (sets.length === 0) {
        return jsonResponse({ error: 'No fields to update' }, 400, origin);
    }

    sets.push('updated_at = ?');
    binds.push(now, user.id);

    await env.USERDB.prepare(
        `UPDATE users SET ${sets.join(', ')} WHERE id = ?`
    ).bind(...binds).run();

    return jsonResponse({
        id: user.id,
        name: body.name === undefined ? user.name : body.name.trim(),
        email: user.email,
        preferences: mergedPrefs,
        updated_at: now,
    }, 200, origin);
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
export async function handleCreateKey(request, env) {
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
export async function handleDeleteKey(request, env, deleteKeyId) {
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

// ── Favorites Handlers ───────────────────────────────────────────────────────

/**
 * GET /account/favorites — Lists the user's favorited entities.
 * Returns an array of { entity_type, entity_id, label, created_at }.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handleListFavorites(request, env) {
    const { session, origin, error } = await requireSession(request, env);
    if (error) return error;

    await ensureUser(env.USERDB, /** @type {SessionData} */ (session));

    const result = await env.USERDB.prepare(
        'SELECT entity_type, entity_id, label, created_at FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC'
    ).bind(session.id).all();

    return jsonResponse({
        favorites: result.results,
        max_favorites: MAX_FAVORITES_PER_USER,
    }, 200, origin);
}

/**
 * POST /account/favorites — Adds an entity to the user's favorites.
 * Expects JSON body: { entity_type, entity_id, label }.
 * Uses INSERT OR IGNORE for idempotency — re-favoriting a duplicate
 * is silently accepted without error.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handleAddFavorite(request, env) {
    const { session, origin, error } = await requireSession(request, env);
    if (error) return error;

    let body;
    try {
        body = /** @type {{entity_type?: string, entity_id?: number, label?: string}} */ (await request.json());
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400, origin);
    }

    // Validate entity_type
    if (!body.entity_type || !VALID_FAVORITE_TYPES.has(body.entity_type)) {
        return jsonResponse(
            { error: `entity_type must be one of: ${[...VALID_FAVORITE_TYPES].join(', ')}` },
            400, origin
        );
    }

    // Validate entity_id
    if (typeof body.entity_id !== 'number' || !Number.isInteger(body.entity_id) || body.entity_id <= 0) {
        return jsonResponse({ error: 'entity_id must be a positive integer' }, 400, origin);
    }

    const label = (typeof body.label === 'string' && body.label.trim().length > 0)
        ? body.label.trim().slice(0, 200)
        : '';

    await ensureUser(env.USERDB, /** @type {SessionData} */ (session));

    // Check favorites count (soft limit)
    const countRow = await env.USERDB.prepare(
        'SELECT COUNT(*) as cnt FROM user_favorites WHERE user_id = ?'
    ).bind(session.id).first();
    const favCount = countRow ? /** @type {number} */ (countRow.cnt) : 0;

    if (favCount >= MAX_FAVORITES_PER_USER) {
        return jsonResponse(
            { error: `Maximum of ${MAX_FAVORITES_PER_USER} favorites allowed` },
            400, origin
        );
    }

    const now = new Date().toISOString();

    await env.USERDB.prepare(
        'INSERT OR IGNORE INTO user_favorites (user_id, entity_type, entity_id, label, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(session.id, body.entity_type, body.entity_id, label, now).run();

    return jsonResponse({
        entity_type: body.entity_type,
        entity_id: body.entity_id,
        label,
        created_at: now,
    }, 201, origin);
}

/**
 * PUT /account/favorites — Replaces the entire favorites list with an
 * ordered array. Used to persist reorder operations from the UI.
 *
 * Expects JSON body: { favorites: [{entity_type, entity_id, label}, ...] }
 *
 * Implements an atomic DELETE-all + batch INSERT. Order is encoded via
 * sequential created_at timestamps (one second apart) so the existing
 * ORDER BY created_at query returns them in the submitted order.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handleReplaceFavorites(request, env) {
    const { session, origin, error } = await requireSession(request, env);
    if (error) return error;

    let body;
    try {
        body = /** @type {{favorites?: Array<{entity_type: string, entity_id: number, label?: string}>}} */ (await request.json());
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400, origin);
    }

    if (!Array.isArray(body.favorites)) {
        return jsonResponse({ error: 'favorites must be an array' }, 400, origin);
    }

    if (body.favorites.length > MAX_FAVORITES_PER_USER) {
        return jsonResponse(
            { error: `Maximum of ${MAX_FAVORITES_PER_USER} favorites allowed` },
            400, origin
        );
    }

    // Validate each entry
    for (const fav of body.favorites) {
        if (!fav.entity_type || !VALID_FAVORITE_TYPES.has(fav.entity_type)) {
            return jsonResponse(
                { error: `entity_type must be one of: ${[...VALID_FAVORITE_TYPES].join(', ')}` },
                400, origin
            );
        }
        if (typeof fav.entity_id !== 'number' || !Number.isInteger(fav.entity_id) || fav.entity_id <= 0) {
            return jsonResponse({ error: 'entity_id must be a positive integer' }, 400, origin);
        }
    }

    await ensureUser(env.USERDB, /** @type {SessionData} */ (session));

    // Build batch: delete all existing, then insert in order.
    // Sequential created_at values encode the sort order without
    // needing a sort_order column.
    const baseTime = Date.now();
    const stmts = [
        env.USERDB.prepare('DELETE FROM user_favorites WHERE user_id = ?').bind(session.id),
    ];
    for (let i = 0; i < body.favorites.length; i++) {
        const fav = body.favorites[i];
        const label = (typeof fav.label === 'string' && fav.label.trim().length > 0)
            ? fav.label.trim().slice(0, 200)
            : '';
        const ts = new Date(baseTime + i).toISOString();
        stmts.push(
            env.USERDB.prepare(
                'INSERT INTO user_favorites (user_id, entity_type, entity_id, label, created_at) VALUES (?, ?, ?, ?, ?)'
            ).bind(session.id, fav.entity_type, fav.entity_id, label, ts)
        );
    }
    await env.USERDB.batch(stmts);

    return jsonResponse({ replaced: body.favorites.length }, 200, origin);
}

/**
 * DELETE /account/favorites/:type/:id — Removes an entity from favorites.
 * Returns 200 even if the favorite didn't exist (idempotent delete).
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @param {string} entityType - Entity type tag.
 * @param {string} entityId - Entity ID (string from URL path, parsed as int).
 * @returns {Promise<Response>}
 */
export async function handleRemoveFavorite(request, env, entityType, entityId) {
    const { session, origin, error } = await requireSession(request, env);
    if (error) return error;

    if (!VALID_FAVORITE_TYPES.has(entityType)) {
        return jsonResponse({ error: 'Invalid entity type' }, 400, origin);
    }

    const id = Number.parseInt(entityId, 10);
    if (Number.isNaN(id) || id <= 0) {
        return jsonResponse({ error: 'Invalid entity ID' }, 400, origin);
    }

    await env.USERDB.prepare(
        'DELETE FROM user_favorites WHERE user_id = ? AND entity_type = ? AND entity_id = ?'
    ).bind(session.id, entityType, id).run();

    return jsonResponse({ deleted: { entity_type: entityType, entity_id: id } }, 200, origin);
}

/**
 * OPTIONS preflight for /account/* endpoints.
 * Reflects the request origin for Pages preview subdomain support.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Response}
 */
export function handleAccountPreflight(request, env) {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(resolveAllowedOrigin(request, env)),
    });
}
