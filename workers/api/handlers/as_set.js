/**
 * @fileoverview AS-set handler for GET /api/as_set/{asn}.
 *
 * Looks up a network by ASN and returns its irr_as_set field.
 */

import { DETAIL_TTL } from '../cache.js';
import { encoder, serveJSON, jsonError, H_API_AUTH, H_API_ANON } from '../http.js';
import { withEdgeSWR } from '../swr.js';

/**
 * Handles the special /api/as_set/{asn} endpoint.
 * Looks up a network by ASN and returns its irr_as_set field.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {D1Session} db - D1 database binding (session-wrapped for read replication).
 * @param {ExecutionContext} ctx - Worker execution context for SWR background tasks.
 * @param {number} asn - The ASN to look up.
 * @param {boolean} authenticated - Whether the caller is authenticated (for X-Auth-Status).
 * @returns {Promise<Response>} JSON response.
 */
export async function handleAsSet(request, db, ctx, asn, authenticated) {
    const cacheKey = `as_set/${asn}`;
    const { buf, tier, hits } = await withEdgeSWR(
        "as_set", cacheKey, ctx, DETAIL_TTL,
        async () => {
            const result = await db.prepare(
                `SELECT json_object('data', json_array(json_object('asn', "asn", 'irr_as_set', "irr_as_set", 'name', "name")), 'meta', json_object()) AS payload FROM "peeringdb_network" WHERE "asn" = ?`
            ).bind(asn).first();

            if (!result || !result.payload) return null;
            return encoder.encode(/** @type {string} */(result.payload));
        }
    );

    if (!buf) return jsonError(404, `No network found for ASN ${asn}`);

    return serveJSON(request, buf, { tier, hits }, authenticated ? H_API_AUTH : H_API_ANON);
}
