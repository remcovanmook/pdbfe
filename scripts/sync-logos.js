/**
 * @fileoverview One-time logo backfill script.
 *
 * Fetches all entity logos from upstream S3 and stores them in the
 * pdbfe-logos R2 bucket. Sets __logo_migrated = 1 for each row
 * after successful upload.
 *
 * Run as a temporary worker with D1 + R2 bindings:
 *   npx wrangler deploy scripts/sync-logos.js --name pdbfe-logo-backfill \
 *     --config workers/wrangler-sync.toml --no-bundle
 *   curl -X POST https://pdbfe-logo-backfill.<subdomain>.workers.dev/run
 *   npx wrangler delete --name pdbfe-logo-backfill
 *
 * Or via wrangler dev for local testing.
 */

import { ENTITIES } from '../workers/sync/entities.js';
import { syncLogos } from '../workers/sync/index.js';

/** Entity tags that have a logo field. */
const LOGO_ENTITIES = new Set(['org', 'net', 'ix', 'fac', 'carrier', 'campus']);

export default {
    /**
     * HTTP handler for the backfill trigger.
     * POST /run — runs logo sync across all entity types with no
     * per-cron-run limit (processes all unmigrated logos).
     *
     * @param {Request} request - The inbound HTTP request.
     * @param {PdbSyncEnv} env - Environment bindings (PDB + LOGOS).
     * @returns {Promise<Response>}
     */
    async fetch(request, env) {
        if (request.method !== 'POST') {
            return new Response('POST /run to start backfill', { status: 405 });
        }

        const results = {};
        let totalFetched = 0;
        let totalErrors = 0;

        for (const [tag, meta] of Object.entries(ENTITIES)) {
            if (!LOGO_ENTITIES.has(tag)) continue;

            // Run in a loop until no more unmigrated logos for this entity
            let entityFetched = 0;
            let entityErrors = 0;
            let batch = 0;

            while (true) {
                batch++;
                const lr = await syncLogos(env.PDB, env.LOGOS, tag, meta.table);
                entityFetched += lr.fetched;
                entityErrors += lr.errors;

                // syncLogos processes up to 20 per call; stop when none left
                if (lr.fetched === 0 && lr.errors === 0) break;

                // Safety: bail after 50 batches (1000 logos) per entity
                if (batch >= 50) {
                    console.warn(`[backfill] ${tag}: hit batch limit (${batch}), continuing next run`);
                    break;
                }
            }

            results[tag] = { fetched: entityFetched, errors: entityErrors, batches: batch };
            totalFetched += entityFetched;
            totalErrors += entityErrors;
        }

        const body = JSON.stringify({
            summary: { totalFetched, totalErrors },
            entities: results,
        }, null, 2);

        return new Response(body + '\n', {
            headers: { 'Content-Type': 'application/json' },
        });
    }
};
