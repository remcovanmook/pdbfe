/**
 * @fileoverview Background D1 polling for granular L1 cache invalidation
 * and zero-allocation serving of the /status endpoint.
 *
 * Architecture:
 *   Every 15 seconds (gated by a single integer comparison on the hot path),
 *   a background task queries _sync_meta via D1 read-replication. If an
 *   entity's last_modified_at differs from the in-memory snapshot, only that
 *   entity's L1 cache is purged. The L2 per-PoP cache is invalidated
 *   implicitly via version-tagged keys (see pipeline.js).
 *
 *   The /status endpoint is served from a pre-encoded Uint8Array that is
 *   rebuilt during each poll. No JSON.parse or JSON.stringify runs on the
 *   hot path — 1,000 concurrent /status requests serve the same buffer.
 *
 * Exports:
 *   ensureSyncFreshness(db, ctx, now) — O(1) hot-path hook
 *   handleStatus(request, db, ctx)    — pre-encoded /status handler
 *   getEntityVersion(tag)             — returns last_modified_at for L2 key versioning
 */

import { getEntityCache } from './cache.js';
import { ENTITY_TAGS } from './entities.js';
import { encoder, H_API } from './http.js';

/**
 * Per-entity last_modified_at snapshot. Initialised from ENTITY_TAGS
 * with zero — no dynamic keys, no dictionary mode.
 * @type {Map<string, number>}
 */
const _knownModifiedAt = new Map();
for (const tag of ENTITY_TAGS) {
    _knownModifiedAt.set(tag, 0);
}

/** Timestamp of the last background D1 poll. @type {number} */
let _lastCheck = 0;

/** Pre-encoded JSON response for /status. @type {Uint8Array|null} */
let _statusPayload = null;

/** Poll interval in milliseconds (15s). */
const CHECK_INTERVAL_MS = 15_000;

/**
 * Background task: queries _sync_meta via D1 read-replication.
 * Compares each entity's last_modified_at against the in-memory snapshot.
 * If changed, purges that entity's L1 cache. Finally rebuilds the
 * pre-encoded /status payload.
 *
 * Runs inside ctx.waitUntil() — allocations here do not affect the
 * response path.
 *
 * @param {D1Session} db - Session-wrapped D1 database.
 * @returns {Promise<void>}
 */
async function refreshSyncState(db) {
    try {
        const rows = await db.prepare(
            'SELECT entity, last_sync, row_count, updated_at, last_modified_at FROM "_sync_meta" ORDER BY entity'
        ).all();

        if (!rows || !rows.results) return;

        // Build a lookup from the D1 results for fast access.
        // Use a Map to avoid dynamic-key objects (§5).
        /** @type {Map<string, {last_sync: number, row_count: number, updated_at: string, last_modified_at: number}>} */
        const dbState = new Map();
        for (const row of rows.results) {
            dbState.set(
                /** @type {string} */ (row.entity),
                {
                    last_sync: /** @type {number} */ (row.last_sync),
                    row_count: /** @type {number} */ (row.row_count),
                    updated_at: /** @type {string} */ (row.updated_at),
                    last_modified_at: (/** @type {number} */ (row.last_modified_at) || 0) | 0,
                }
            );
        }

        // Granular invalidation: check each known entity against D1 state
        for (const tag of ENTITY_TAGS) {
            const entry = dbState.get(tag);
            if (!entry) continue;

            const known = _knownModifiedAt.get(tag);
            if (known !== undefined && known !== 0 && entry.last_modified_at !== known) {
                console.log(`[sync] ${tag} data changed (${known} → ${entry.last_modified_at}). Purging L1.`);
                const cache = getEntityCache(tag);
                if (cache) cache.purge();
            }
            _knownModifiedAt.set(tag, entry.last_modified_at);
        }

        // Rebuild pre-encoded /status payload using static entity structure.
        // The entity list is fixed at ENTITY_TAGS — no dynamic keys.
        let latestModifiedAt = 0;
        const entityEntries = [];
        for (const tag of ENTITY_TAGS) {
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
        _statusPayload = encoder.encode(json);

    } catch (err) {
        // Background D1 errors must not crash the isolate.
        // The previous _statusPayload and _knownModifiedAt remain valid.
        console.error('[sync] background poll failed:', err);
    }
}

/**
 * Hot-path hook: triggers a background D1 poll if CHECK_INTERVAL_MS
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
export function ensureSyncFreshness(db, ctx, now) {
    if (now - _lastCheck > CHECK_INTERVAL_MS) {
        _lastCheck = now;
        ctx.waitUntil(refreshSyncState(db));
    }
}

/**
 * Hot-path handler for GET /status.
 * Returns the pre-encoded Uint8Array from RAM. If the payload doesn't
 * exist yet (cold boot), blocks on a single D1 query to generate it.
 *
 * @param {Request} request - Inbound HTTP request.
 * @param {D1Session} db - Session-wrapped D1 database.
 * @param {ExecutionContext} ctx - Execution context.
 * @returns {Promise<Response>}
 */
export async function handleStatus(request, db, ctx) {
    if (!_statusPayload) {
        // Cold boot: block on first poll to generate payload.
        // Subsequent requests serve from RAM.
        await refreshSyncState(db);
    } else {
        // Warm: non-blocking background refresh
        ensureSyncFreshness(db, ctx, Date.now());
    }

    return new Response(
        /** @type {BodyInit} */ (/** @type {unknown} */ (_statusPayload)),
        { status: 200, headers: H_API }
    );
}

/**
 * Returns the current last_modified_at timestamp for an entity.
 * Used by pipeline.js to construct versioned L2 cache keys —
 * when the version changes, old L2 entries are orphaned without
 * requiring enumeration or explicit deletion.
 *
 * Zero allocations: returns an existing number from the Map.
 *
 * @param {string} tag - Entity tag (e.g. "net").
 * @returns {number} The last_modified_at epoch, or 0 if not yet polled.
 */
export function getEntityVersion(tag) {
    return _knownModifiedAt.get(tag) || 0;
}
