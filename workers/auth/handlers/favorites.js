/**
 * @fileoverview Favorites management handlers for the pdbfe-auth worker.
 *
 * Provides CRUD operations for user favorites:
 *   GET    /account/favorites              → List favorited entities
 *   POST   /account/favorites              → Add a favorite
 *   PUT    /account/favorites              → Replace entire list (reorder)
 *   DELETE /account/favorites/:type/:id    → Remove a favorite
 */

import { jsonResponse, methodNotAllowed, handlePreflight, requireSession, ensureUser } from '../http.js';

/** Maximum number of favorites per user. */
const MAX_FAVORITES_PER_USER = 50;

/** Entity types that can be favorited. */
const VALID_FAVORITE_TYPES = new Set(['net', 'ix', 'fac', 'org', 'carrier', 'campus']);

/**
 * Dispatches /account/favorites requests by HTTP method and sub-path.
 * Handles collection operations (GET, POST, PUT) on /account/favorites
 * and item deletion (DELETE) on /account/favorites/:type/:id.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @param {string} subPath - Path remainder after "/account/favorites" (e.g. "" or "/:type/:id").
 * @returns {Promise<Response>}
 */
export async function handleFavorites(request, env, subPath) {
    if (request.method === 'OPTIONS') return handlePreflight(request, env);
    // Item route: /account/favorites/:type/:id
    if (subPath.length > 1) {
        const rest = subPath.slice(1); // strip leading "/"
        const slashIdx = rest.indexOf('/');
        if (slashIdx < 1 || slashIdx === rest.length - 1 || rest.slice(slashIdx + 1).includes('/')) {
            return jsonResponse({ error: 'Expected /account/favorites/:type/:id' }, 400, '');
        }
        if (request.method !== 'DELETE') return methodNotAllowed('DELETE, OPTIONS');
        return handleRemoveFavorite(request, env, rest.slice(0, slashIdx), rest.slice(slashIdx + 1));
    }

    // Collection route: /account/favorites
    if (request.method === 'GET')  return handleListFavorites(request, env);
    if (request.method === 'POST') return handleAddFavorite(request, env);
    if (request.method === 'PUT')  return handleReplaceFavorites(request, env);
    return methodNotAllowed('GET, POST, PUT, OPTIONS');
}

/**
 * GET /account/favorites — Lists the user's favorited entities.
 * Returns an array of { entity_type, entity_id, label, created_at }.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
async function handleListFavorites(request, env) {
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
async function handleAddFavorite(request, env) {
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
async function handleReplaceFavorites(request, env) {
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
async function handleRemoveFavorite(request, env, entityType, entityId) {
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
