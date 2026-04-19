/**
 * @fileoverview Profile management handlers for the pdbfe-auth worker.
 *
 * Provides GET/PUT for user profiles and GET for preference options:
 *   GET /account/preferences/options → Available preference keys/values (public)
 *   GET /account/profile             → Return user profile & preferences
 *   PUT /account/profile             → Update profile & preferences
 */

import { resolveAllowedOrigin, accountCorsHeaders, jsonResponse, methodNotAllowed, handlePreflight, requireSession, ensureUser } from '../http.js';

/**
 * GET /account/preferences/options — Returns available preference keys
 * and their valid values from the preference_options table.
 *
 * Public endpoint (no auth required) so the UI can populate selectors
 * before login. Response is grouped by pref_key:
 *   { "language": ["en", "de", ...], "theme": ["auto", "dark", "light"] }
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handlePreferences(request, env) {
    if (request.method === 'OPTIONS') return handlePreflight(request, env);
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
            ...accountCorsHeaders(resolveAllowedOrigin(request, env)),
        },
    });
}

/**
 * Dispatches /account/profile requests by HTTP method.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
export async function handleProfile(request, env) {
    if (request.method === 'OPTIONS') return handlePreflight(request, env);
    if (request.method === 'GET')  return handleGetProfile(request, env);
    if (request.method === 'PUT')  return handleUpdateProfile(request, env);
    return methodNotAllowed('GET, PUT, OPTIONS');
}

/**
 * GET /account/profile — Returns the user's profile.
 * Auto-provisions a user record if this is the first access.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
async function handleGetProfile(request, env) {
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
 * PUT /account/profile — Updates the user's display name and preferences.
 * Only the `name` field is editable; email comes from PeeringDB.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {PdbAuthEnv} env - Auth worker environment bindings.
 * @returns {Promise<Response>}
 */
async function handleUpdateProfile(request, env) {
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
