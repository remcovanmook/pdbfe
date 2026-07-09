/**
 * @fileoverview Generic background D1 polling for granular L1 cache
 * invalidation and (optionally) zero-allocation serving of a /status
 * endpoint. Worker-agnostic: all worker-specific behaviour is injected.
 *
 * Architecture:
 *   Every `checkIntervalMs` (gated by a single integer comparison on the
 *   hot path), a background task queries _sync_meta via D1 read-replication.
 *   If an entity's last_modified_at differs from the in-memory snapshot,
 *   `onEntityChange(tag)` is invoked so the caller can purge the right L1
 *   scope (per-entity cache in the API worker; the single shared LRU in the
 *   REST worker). The L2 per-PoP cache is invalidated implicitly via
 *   version-tagged keys (see pipeline/) using getEntityVersion().
 *
 * This module has no dependency on the api/ layer — callers inject the
 * entity tag list, the on-change hook, and (optionally) the /status header
 * set. See api/sync_state.js and rest/cache.js for the two wrappers.
 *
 * Factory returns:
 *   ensureSyncFreshness(db, ctx, now) — O(1) hot-path hook
 *   handleStatus(request, db, ctx)    — pre-encoded /status handler (needs statusHeaders)
 *   getEntityVersion(tag)             — returns last_modified_at for L2 key versioning
 *   refresh(db)                       — force a synchronous poll (cold boot / tests)
 */

import { encoder } from './http.js';

/**
 * Creates an isolated sync-state tracker. Instantiate once per worker
 * module; the returned closures share a private last_modified_at snapshot.
 *
 * @param {Object} opts
 * @param {Iterable<string>} opts.entityTags - Entity tags to track.
 * @param {(tag: string) => void} opts.onEntityChange - Called for each entity
 *        whose last_modified_at changed. Perform the L1 purge here.
 * @param {Record<string, string>} [opts.statusHeaders] - Header set for the
 *        pre-encoded /status payload. Omit to disable status payload building
 *        (a worker that does not serve the sync /status endpoint).
 * @param {number} [opts.checkIntervalMs] - Poll interval (default 15s).
 * @returns {{
 *   refresh: (db: D1Session) => Promise<void>,
 *   ensureSyncFreshness: (db: D1Session, ctx: ExecutionContext, now: number) => void,
 *   handleStatus: (request: Request, db: D1Session, ctx: ExecutionContext) => Promise<Response>,
 *   getEntityVersion: (tag: string) => number,
 * }}
 */
export function createSyncState({ entityTags, onEntityChange, statusHeaders, checkIntervalMs = 15_000 }) {
    /**
     * Per-entity last_modified_at snapshot. Initialised from entityTags
     * with zero — no dynamic keys, no dictionary mode.
     * @type {Map<string, number>}
     */
    const knownModifiedAt = new Map();
    for (const tag of entityTags) {
        knownModifiedAt.set(tag, 0);
    }

    /** Timestamp of the last background D1 poll. @type {number} */
    let lastCheck = 0;

    /** Pre-encoded JSON response for /status. @type {Uint8Array|null} */
    let statusPayload = null;

    /**
     * Background task: queries _sync_meta via D1 read-replication.
     * Compares each entity's last_modified_at against the in-memory snapshot
     * and calls onEntityChange for the ones that moved. Rebuilds the
     * pre-encoded /status payload when statusHeaders is configured.
     *
     * Runs inside ctx.waitUntil() — allocations here do not affect the
     * response path.
     *
     * @param {D1Session} db - Session-wrapped D1 database.
     * @returns {Promise<void>}
     */
    async function refresh(db) {
        try {
            const rows = await db.prepare(
                'SELECT entity, last_sync, row_count, updated_at, last_modified_at FROM "_sync_meta" ORDER BY entity'
            ).all();

            if (!rows || !rows.results) return;

            // Build a lookup from the D1 results for fast access.
            // Use a Map to avoid dynamic-key objects.
            /** @type {Map<string, {last_sync: number, row_count: number, updated_at: string, last_modified_at: number}>} */
            const dbState = new Map();
            for (const row of rows.results) {
                dbState.set(
                    /** @type {string} */ (row.entity),
                    {
                        last_sync: /** @type {number} */ (row.last_sync),
                        row_count: /** @type {number} */ (row.row_count),
                        updated_at: /** @type {string} */ (row.updated_at),
                        last_modified_at: Math.trunc(/** @type {number} */ (row.last_modified_at) || 0),
                    }
                );
            }

            // Granular invalidation: check each known entity against D1 state.
            for (const tag of entityTags) {
                const entry = dbState.get(tag);
                if (!entry) continue;

                const known = knownModifiedAt.get(tag);
                if (known !== undefined && known !== 0 && entry.last_modified_at !== known) {
                    console.log(`[sync] ${tag} data changed (${known} → ${entry.last_modified_at}). Purging L1.`);
                    onEntityChange(tag);
                }
                knownModifiedAt.set(tag, entry.last_modified_at);
            }

            // Rebuild pre-encoded /status payload only when the worker serves it.
            if (statusHeaders) {
                let latestModifiedAt = 0;
                const entityEntries = [];
                for (const tag of entityTags) {
                    const entry = dbState.get(tag);
                    const last_sync = entry ? entry.last_sync : 0;
                    const row_count = entry ? entry.row_count : 0;
                    const updated_at = entry ? entry.updated_at : '';
                    const last_modified_at = entry ? entry.last_modified_at : 0;

                    entityEntries.push(`"${tag}":{"last_sync":${last_sync},"row_count":${row_count},"updated_at":"${updated_at}","last_modified_at":${last_modified_at}}`);

                    if (last_modified_at > latestModifiedAt) {
                        latestModifiedAt = last_modified_at;
                    }
                }

                const json = `{"sync":{"last_modified_at":${latestModifiedAt},"entities":{${entityEntries.join(',')}}}}\n`;
                statusPayload = encoder.encode(json);
            }

        } catch (err) {
            // Background D1 errors must not crash the isolate.
            // The previous statusPayload and knownModifiedAt remain valid.
            console.error('[sync] background poll failed:', err);
        }
    }

    /**
     * Hot-path hook: triggers a background D1 poll if checkIntervalMs
     * has elapsed since the last one. O(1) — single integer comparison,
     * zero allocations.
     *
     * Call this on entity routes only (not admin/health/status) so the
     * poll is gated to requests where staleness has an impact.
     *
     * @param {D1Session} db - Session-wrapped D1 database.
     * @param {ExecutionContext} ctx - Execution context for background tasks.
     * @param {number} now - Current timestamp (reuse caller's Date.now()).
     */
    function ensureSyncFreshness(db, ctx, now) {
        if (now - lastCheck > checkIntervalMs) {
            lastCheck = now;
            ctx.waitUntil(refresh(db));
        }
    }

    /**
     * Hot-path handler for GET /status. Requires statusHeaders.
     * Returns the pre-encoded Uint8Array from RAM. If the payload doesn't
     * exist yet (cold boot), blocks on a single D1 query to generate it.
     *
     * @param {Request} request - Inbound HTTP request.
     * @param {D1Session} db - Session-wrapped D1 database.
     * @param {ExecutionContext} ctx - Execution context.
     * @returns {Promise<Response>}
     */
    async function handleStatus(request, db, ctx) {
        if (!statusHeaders) {
            throw new Error('handleStatus called without statusHeaders configured');
        }
        if (!statusPayload) {
            // Cold boot: block on first poll to generate payload.
            await refresh(db);
        } else {
            // Warm: non-blocking background refresh.
            ensureSyncFreshness(db, ctx, Date.now());
        }

        return new Response(
            /** @type {BodyInit} */ (/** @type {unknown} */ (statusPayload)),
            { status: 200, headers: statusHeaders }
        );
    }

    /**
     * Returns the current last_modified_at timestamp for an entity.
     * Used by pipeline/ to construct versioned L2 cache keys — when the
     * version changes, old L2 entries are orphaned without enumeration
     * or explicit deletion. Zero allocations.
     *
     * @param {string} tag - Entity tag (e.g. "net").
     * @returns {number} The last_modified_at epoch, or 0 if not yet polled.
     */
    function getEntityVersion(tag) {
        return knownModifiedAt.get(tag) || 0;
    }

    return { refresh, ensureSyncFreshness, handleStatus, getEntityVersion };
}
