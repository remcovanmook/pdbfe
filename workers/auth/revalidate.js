/**
 * @fileoverview Daily revalidation of pdbfe users against PeeringDB.
 *
 * PeeringDB exports no user list and no account status, but each user's
 * OAuth refresh token (stored encrypted at login, handlers/oauth.js) still
 * works for as long as they hold a PeeringDB account that has not revoked
 * pdbfe. Once a day, per user with a stored token: refresh it (keeping the
 * rotated token at once) and re-read the profile.
 *
 *   - Valid (verified user): record validated_at and rewrite their sessions
 *     with the current profile, so network affiliations follow PeeringDB
 *     instead of the login-time snapshot (sessions live 30 days).
 *   - Invalid — the refresh is refused (`invalid_grant`: account closed or
 *     consent withdrawn), the fresh token cannot read the profile, or the
 *     user is no longer verified (closing an account clears its groups):
 *     delete their sessions, expire their API keys (api_keys.expires_at;
 *     the rows stay listed as expired) and drop the token.
 *   - Anything else (network error, 5xx, 429, invalid_client, a token that
 *     will not decrypt): skip and retry tomorrow. A hiccup on either side
 *     must never revoke anyone.
 *
 * Least recently validated first, at most MAX_USERS_PER_RUN per run, paced
 * USER_GAP_MS apart (two auth.peeringdb.com requests per user).
 */

import { decryptToken, encryptToken } from './tokens.js';
import { PDB_TOKEN_URL, PDB_PROFILE_URL, parsePeeringDbProfile, peeringDbHeaders } from './handlers/oauth.js';

/** Daily revalidation cron: 04:23 UTC. Must match wrangler-auth.toml. */
export const REVALIDATE_CRON = '23 4 * * *';

export const MAX_USERS_PER_RUN = 300;
const USER_GAP_MS = 1500;
const SESSION_PREFIX = 'session:';

/**
 * @typedef {{ checked: number, valid: number, invalidated: number[], skipped: number, errors: string[] }} RevalidationReport
 */

/**
 * Runs one revalidation pass.
 *
 * @param {PdbAuthEnv} env
 * @param {{ pauseMs?: number, fetchImpl?: typeof fetch }} [opts] - Test hooks.
 * @returns {Promise<RevalidationReport>}
 */
export async function runRevalidation(env, opts = {}) {
    /** @type {RevalidationReport} */
    const report = { checked: 0, valid: 0, invalidated: [], skipped: 0, errors: [] };
    if (!env.TOKEN_ENCRYPTION_KEY) {
        console.log('[revalidate] TOKEN_ENCRYPTION_KEY not set; nothing to do');
        return report;
    }
    const pauseMs = opts.pauseMs ?? USER_GAP_MS;
    const fetchImpl = opts.fetchImpl ?? fetch;

    const users = (await env.USERDB.prepare(
        'SELECT id, refresh_token FROM users WHERE refresh_token IS NOT NULL ORDER BY validated_at IS NOT NULL, validated_at LIMIT ?'
    ).bind(MAX_USERS_PER_RUN).all()).results || [];
    if (users.length === 0) return report;

    const sessions = await sessionsByUser(env.SESSIONS);

    for (const [i, u] of users.entries()) {
        // Sequential on purpose: upstream requests are paced.
        if (i > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs)); // NOSONAR
        const userId = /** @type {number} */ (u.id);
        report.checked++;
        try {
            const outcome = await checkUser(env, fetchImpl, userId, /** @type {string} */ (u.refresh_token));
            if (outcome.verdict === 'valid') {
                await refreshSessions(env.SESSIONS, sessions.get(userId) || [], /** @type {Record<string, any>} */ (outcome.sessionData));
                report.valid++;
            } else if (outcome.verdict === 'invalid') {
                await invalidateUser(env, userId, sessions.get(userId) || []);
                report.invalidated.push(userId);
                console.error(`[revalidate] user ${userId} invalidated: ${outcome.reason}`);
            } else {
                report.skipped++;
                report.errors.push(`user ${userId}: ${outcome.reason}`);
            }
        } catch (err) {
            report.skipped++;
            report.errors.push(`user ${userId}: ${/** @type {Error} */ (err).message}`);
        }
    }

    console.log(`[revalidate] checked ${report.checked}: ${report.valid} valid, ${report.invalidated.length} invalidated, ${report.skipped} skipped`);
    for (const e of report.errors) console.error(`[revalidate] skipped ${e}`);
    return report;
}

/**
 * Refreshes one user's token and reads their profile.
 *
 * @param {PdbAuthEnv} env
 * @param {typeof fetch} fetchImpl
 * @param {number} userId
 * @param {string} storedToken - Encrypted refresh token.
 * @returns {Promise<{verdict: 'valid'|'invalid'|'skip', reason?: string, sessionData?: Record<string, any>}>}
 */
async function checkUser(env, fetchImpl, userId, storedToken) {
    let refreshToken;
    try {
        refreshToken = await decryptToken(/** @type {string} */ (env.TOKEN_ENCRYPTION_KEY), storedToken);
    } catch (err) {
        return { verdict: 'skip', reason: `stored token does not decrypt (${/** @type {Error} */ (err).message})` };
    }
    const headers = peeringDbHeaders(env);

    const tokenRes = await fetchImpl(PDB_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers.token },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: env.OAUTH_CLIENT_ID,
            client_secret: env.OAUTH_CLIENT_SECRET,
        }).toString(),
    });
    if (!tokenRes.ok) {
        const body = /** @type {{error?: string}} */ (await tokenRes.json().catch(() => ({})));
        // Only invalid_grant speaks about the user; invalid_client etc. are ours.
        if (tokenRes.status === 400 && body.error === 'invalid_grant') return { verdict: 'invalid', reason: 'refresh refused (invalid_grant)' };
        return { verdict: 'skip', reason: `token endpoint ${tokenRes.status}${body.error ? ` ${body.error}` : ''}` };
    }
    const tokens = /** @type {{access_token?: string, refresh_token?: string}} */ (await tokenRes.json());
    if (!tokens.access_token) return { verdict: 'skip', reason: 'no access_token in refresh response' };

    // Refresh tokens rotate: keep the new one before anything else can fail.
    if (tokens.refresh_token) {
        await env.USERDB.prepare('UPDATE users SET refresh_token = ? WHERE id = ?')
            .bind(await encryptToken(/** @type {string} */ (env.TOKEN_ENCRYPTION_KEY), tokens.refresh_token), userId).run();
    }

    const profileRes = await fetchImpl(PDB_PROFILE_URL, { headers: { Authorization: `Bearer ${tokens.access_token}`, ...headers.profile } });
    if (profileRes.status === 401 || profileRes.status === 403) return { verdict: 'invalid', reason: `profile refused (${profileRes.status})` };
    if (!profileRes.ok) return { verdict: 'skip', reason: `profile endpoint ${profileRes.status}` };
    const profile = /** @type {Record<string, any>} */ (await profileRes.json());
    if (profile.id !== userId) return { verdict: 'skip', reason: `profile is user ${profile.id}, expected ${userId}` };

    const parsed = parsePeeringDbProfile(profile);
    if (!parsed.valid) return { verdict: 'invalid', reason: 'no longer a verified PeeringDB user' };

    await env.USERDB.prepare('UPDATE users SET validated_at = ? WHERE id = ?').bind(new Date().toISOString(), userId).run();
    return { verdict: 'valid', sessionData: parsed.sessionData };
}

/**
 * Lists every session key with its expiry, grouped by user. Sessions
 * written since the uid metadata was added carry it; older ones are read
 * once to find their user.
 *
 * @param {KVNamespace} kv
 * @returns {Promise<Map<number, Array<{name: string, expiration?: number}>>>}
 */
async function sessionsByUser(kv) {
    /** @type {Map<number, Array<{name: string, expiration?: number}>>} */
    const out = new Map();
    let cursor;
    do {
        // Sequential on purpose: KV list pages chain on the cursor.
        const page = await kv.list({ prefix: SESSION_PREFIX, cursor }); // NOSONAR
        for (const k of page.keys) {
            let uid = /** @type {{uid?: number}|null} */ (k.metadata)?.uid;
            if (uid === undefined) {
                const data = /** @type {{id?: number}|null} */ (await kv.get(k.name, { type: 'json' })); // NOSONAR
                uid = data?.id;
            }
            if (typeof uid !== 'number') continue;
            if (!out.has(uid)) out.set(uid, []);
            /** @type {Array<{name: string, expiration?: number}>} */ (out.get(uid)).push({ name: k.name, expiration: k.expiration });
        }
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
}

/**
 * Rewrites a valid user's sessions with their current profile, keeping
 * each session's own expiry and original created_at.
 *
 * @param {KVNamespace} kv
 * @param {Array<{name: string, expiration?: number}>} keys
 * @param {Record<string, any>} sessionData
 * @returns {Promise<void>}
 */
async function refreshSessions(kv, keys, sessionData) {
    for (const k of keys) {
        const old = /** @type {Record<string, any>|null} */ (await kv.get(k.name, { type: 'json' })); // NOSONAR
        if (!old) continue;
        /** @type {KVNamespacePutOptions} */
        const putOpts = { metadata: { uid: sessionData.id } };
        if (k.expiration) putOpts.expiration = k.expiration;
        await kv.put(k.name, JSON.stringify({ ...sessionData, created_at: old.created_at ?? sessionData.created_at }), putOpts); // NOSONAR
    }
}

/**
 * Ends an invalid user's access: sessions deleted, API keys expired now
 * (unless already expired), stored token dropped.
 *
 * @param {PdbAuthEnv} env
 * @param {number} userId
 * @param {Array<{name: string}>} keys - The user's session keys.
 * @returns {Promise<void>}
 */
async function invalidateUser(env, userId, keys) {
    for (const k of keys) await env.SESSIONS.delete(k.name); // NOSONAR
    const now = new Date().toISOString();
    await env.USERDB.batch([
        env.USERDB.prepare('UPDATE api_keys SET expires_at = ? WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)').bind(now, userId, now),
        env.USERDB.prepare('UPDATE users SET refresh_token = NULL, updated_at = ? WHERE id = ?').bind(now, userId),
    ]);
}
