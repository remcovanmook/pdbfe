/**
 * @fileoverview API-worker binding of the generic sync-state tracker.
 *
 * Injects the API worker's dependencies into core/sync_state.js:
 *   - ENTITY_TAGS         — the tracked entity list
 *   - onEntityChange      — per-entity L1 purge via getEntityCache()
 *   - statusHeaders (H_API) — the API worker serves the sync /status endpoint
 *
 * Re-exports the resulting closures with the same names the rest of the
 * API worker already imports, so no call sites change.
 *
 * Exports:
 *   ensureSyncFreshness(db, ctx, now) — O(1) hot-path hook
 *   handleStatus(request, db, ctx)    — pre-encoded /status handler
 *   getEntityVersion(tag)             — returns last_modified_at for L2 key versioning
 */

import { createSyncState } from '../core/sync_state.js';
import { getEntityCache } from './cache.js';
import { ENTITY_TAGS } from './entities.js';
import { H_API } from './http.js';

const _sync = createSyncState({
    entityTags: ENTITY_TAGS,
    onEntityChange: (tag) => {
        const cache = getEntityCache(tag);
        if (cache) cache.purge();
    },
    statusHeaders: H_API,
});

export const ensureSyncFreshness = _sync.ensureSyncFreshness;
export const handleStatus = _sync.handleStatus;
export const getEntityVersion = _sync.getEntityVersion;
