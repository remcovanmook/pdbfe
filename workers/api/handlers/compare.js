/**
 * @fileoverview Compare handler for entity overlap analysis.
 *
 * Computes the set intersection between two PeeringDB entities — the shared
 * IXPs, facilities, or networks between them — and returns structured JSON
 * with coordinate data for map rendering.
 *
 * This is a PDBFE extension endpoint (not part of upstream PeeringDB).
 * Requires the __pdbfe=1 query parameter.
 *
 * Supported entity pair combinations:
 *   net ↔ net   — shared IXPs and shared facilities
 *   ix  ↔ ix    — shared facilities and shared member networks
 *
 * Route: GET /api/compare?a={tag}:{id}&b={tag}:{id}&__pdbfe=1
 */

import { encodeJSON, serveJSON, jsonError, H_API_AUTH, H_API_ANON } from '../http.js';
import { normaliseCacheKey, DETAIL_TTL } from '../cache.js';
import { withEdgeSWR } from '../swr.js';

/**
 * Set of supported entity pair keys. The pair key is constructed by
 * sorting the two entity tags alphabetically and joining with '+'.
 * @type {Set<string>}
 */
const SUPPORTED_PAIRS = new Set([
    'net+net',
    'ix+ix',
    'fac+fac',
    'ix+net',
    'fac+net',
    'fac+ix'
]);

/**
 * Labels used for entity header lookups, keyed by entity tag.
 * Maps to the primary table name and the columns fetched for
 * the response header.
 * @type {Record<string, {table: string, nameCol: string, extraCols?: string[]}>}
 */
const ENTITY_META = {
    net: { table: 'peeringdb_network', nameCol: 'name', extraCols: ['asn'] },
    ix:  { table: 'peeringdb_ix', nameCol: 'name' },
    fac: { table: 'peeringdb_facility', nameCol: 'name' },
};

/**
 * Parses an entity reference from a query parameter value.
 * Expected format: "{tag}:{id}" e.g. "net:13335" or "ix:26".
 *
 * @param {string} raw - Raw parameter value.
 * @returns {{tag: string, id: number}|null} Parsed reference or null if invalid.
 */
function parseEntityRef(raw) {
    if (!raw) return null;
    const colonIdx = raw.indexOf(':');
    if (colonIdx === -1) return null;
    const tag = raw.slice(0, colonIdx);
    const id = Number.parseInt(raw.slice(colonIdx + 1), 10);
    if (!ENTITY_META[tag] || Number.isNaN(id) || id <= 0) return null;
    return { tag, id };
}

/**
 * Constructs a normalised pair key from two entity tags.
 * Tags are sorted alphabetically so net+ix and ix+net produce the same key.
 *
 * @param {string} tagA - First entity tag.
 * @param {string} tagB - Second entity tag.
 * @returns {string} Normalised pair key.
 */
function pairKey(tagA, tagB) {
    return tagA < tagB ? `${tagA}+${tagB}` : `${tagB}+${tagA}`;
}

/**
 * Fetches the entity header (name, ASN, etc.) for a response envelope.
 *
 * @param {D1Session} db - D1 database session.
 * @param {string} tag - Entity tag.
 * @param {number} id - Entity ID.
 * @returns {Promise<Record<string, any>|null>} Entity header or null if not found.
 */
async function fetchEntityHeader(db, tag, id) {
    const meta = ENTITY_META[tag];
    const cols = ['id', meta.nameCol, ...(meta.extraCols || [])]; // ap-ok: cold path, max 4 cols per entity header
    const colList = cols.map(c => '"' + c + '"').join(', '); // ap-ok: avoids nested template literal (sonar rule)
    const sql = `SELECT ${colList} FROM "${meta.table}" WHERE "id" = ? AND "status" = 'ok'`; // ap-ok: cold path, builds SQL once per header lookup
    const row = await db.prepare(sql).bind(id).first();
    if (!row) return null;
    return { tag, ...row };
}

// ── Overlap query implementations ────────────────────────────────────────────

/**
 * Computes overlap between two networks.
 * Returns shared IXPs (via netixlan), shared facilities (via netfac),
 * and entity-specific IXPs/facilities.
 *
 * @param {D1Session} db - D1 database session.
 * @param {number} idA - Network ID A.
 * @param {number} idB - Network ID B.
 * @returns {Promise<Record<string, any>>} Overlap result sections.
 */
async function overlapNetNet(db, idA, idB) {
    // Shared IXPs: networks present at the same ixlan
    const sharedIxps = await db.prepare(`
        SELECT ix.id AS ix_id, ix.name AS ix_name, ix.country, ix.city,
               a.speed AS speed_a, b.speed AS speed_b,
               a.ipaddr4 AS ipv4_a, b.ipaddr4 AS ipv4_b,
               a.ipaddr6 AS ipv6_a, b.ipaddr6 AS ipv6_b,
               a.is_rs_peer AS rs_a, b.is_rs_peer AS rs_b
        FROM peeringdb_network_ixlan a
        JOIN peeringdb_network_ixlan b ON a.ixlan_id = b.ixlan_id
        JOIN peeringdb_ixlan ixlan ON a.ixlan_id = ixlan.id
        JOIN peeringdb_ix ix ON ixlan.ix_id = ix.id
        WHERE a.net_id = ? AND b.net_id = ?
          AND a.status = 'ok' AND b.status = 'ok'
          AND ix.status = 'ok'
        ORDER BY ix.name COLLATE NOCASE
    `).bind(idA, idB).all();

    // Shared facilities: networks present at the same facility
    const sharedFacs = await db.prepare(`
        SELECT f.id AS fac_id, f.name AS fac_name, f.city, f.country,
               f.latitude, f.longitude
        FROM peeringdb_network_facility a
        JOIN peeringdb_network_facility b ON a.fac_id = b.fac_id
        JOIN peeringdb_facility f ON a.fac_id = f.id
        WHERE a.net_id = ? AND b.net_id = ?
          AND a.status = 'ok' AND b.status = 'ok'
          AND f.status = 'ok'
        ORDER BY f.name COLLATE NOCASE
    `).bind(idA, idB).all();

    // Only-A IXPs (where A is present but B is not)
    const onlyAIxps = await db.prepare(`
        SELECT ix.id AS ix_id, ix.name AS ix_name, ix.country, ix.city
        FROM peeringdb_network_ixlan a
        JOIN peeringdb_ixlan ixlan ON a.ixlan_id = ixlan.id
        JOIN peeringdb_ix ix ON ixlan.ix_id = ix.id
        WHERE a.net_id = ? AND a.status = 'ok' AND ix.status = 'ok'
          AND ix.id NOT IN (
            SELECT ix2.id FROM peeringdb_network_ixlan b
            JOIN peeringdb_ixlan ixlan2 ON b.ixlan_id = ixlan2.id
            JOIN peeringdb_ix ix2 ON ixlan2.ix_id = ix2.id
            WHERE b.net_id = ? AND b.status = 'ok'
          )
        ORDER BY ix.name COLLATE NOCASE
    `).bind(idA, idB).all();

    // Only-B IXPs
    const onlyBIxps = await db.prepare(`
        SELECT ix.id AS ix_id, ix.name AS ix_name, ix.country, ix.city
        FROM peeringdb_network_ixlan a
        JOIN peeringdb_ixlan ixlan ON a.ixlan_id = ixlan.id
        JOIN peeringdb_ix ix ON ixlan.ix_id = ix.id
        WHERE a.net_id = ? AND a.status = 'ok' AND ix.status = 'ok'
          AND ix.id NOT IN (
            SELECT ix2.id FROM peeringdb_network_ixlan b
            JOIN peeringdb_ixlan ixlan2 ON b.ixlan_id = ixlan2.id
            JOIN peeringdb_ix ix2 ON ixlan2.ix_id = ix2.id
            WHERE b.net_id = ? AND b.status = 'ok'
          )
        ORDER BY ix.name COLLATE NOCASE
    `).bind(idB, idA).all();

    // Only-A facilities
    const onlyAFacs = await db.prepare(`
        SELECT f.id AS fac_id, f.name AS fac_name, f.city, f.country,
               f.latitude, f.longitude
        FROM peeringdb_network_facility a
        JOIN peeringdb_facility f ON a.fac_id = f.id
        WHERE a.net_id = ? AND a.status = 'ok' AND f.status = 'ok'
          AND f.id NOT IN (
            SELECT b.fac_id FROM peeringdb_network_facility b
            WHERE b.net_id = ? AND b.status = 'ok'
          )
        ORDER BY f.name COLLATE NOCASE
    `).bind(idA, idB).all();

    // Only-B facilities
    const onlyBFacs = await db.prepare(`
        SELECT f.id AS fac_id, f.name AS fac_name, f.city, f.country,
               f.latitude, f.longitude
        FROM peeringdb_network_facility a
        JOIN peeringdb_facility f ON a.fac_id = f.id
        WHERE a.net_id = ? AND a.status = 'ok' AND f.status = 'ok'
          AND f.id NOT IN (
            SELECT b.fac_id FROM peeringdb_network_facility b
            WHERE b.net_id = ? AND b.status = 'ok'
          )
        ORDER BY f.name COLLATE NOCASE
    `).bind(idB, idA).all();

    return {
        shared_ixps: sharedIxps.results || [],
        shared_facilities: sharedFacs.results || [],
        only_a_ixps: onlyAIxps.results || [],
        only_b_ixps: onlyBIxps.results || [],
        only_a_facilities: onlyAFacs.results || [],
        only_b_facilities: onlyBFacs.results || [],
    };
}

/**
 * Computes overlap between two internet exchanges.
 * Returns shared facilities (via ixfac) and shared member networks
 * (via netixlan).
 *
 * @param {D1Session} db - D1 database session.
 * @param {number} idA - IX ID A.
 * @param {number} idB - IX ID B.
 * @returns {Promise<Record<string, any>>} Overlap result sections.
 */
async function overlapIxIx(db, idA, idB) {
    // Shared facilities
    const sharedFacs = await db.prepare(`
        SELECT f.id AS fac_id, f.name AS fac_name, f.city, f.country,
               f.latitude, f.longitude
        FROM peeringdb_ix_facility a
        JOIN peeringdb_ix_facility b ON a.fac_id = b.fac_id
        JOIN peeringdb_facility f ON a.fac_id = f.id
        WHERE a.ix_id = ? AND b.ix_id = ?
          AND a.status = 'ok' AND b.status = 'ok'
          AND f.status = 'ok'
        ORDER BY f.name COLLATE NOCASE
    `).bind(idA, idB).all();

    // Shared member networks (present on both IXes via netixlan → ixlan → ix)
    const sharedNets = await db.prepare(`
        SELECT DISTINCT n.id AS net_id, n.name AS net_name, n.asn
        FROM peeringdb_network_ixlan a
        JOIN peeringdb_ixlan ixlanA ON a.ixlan_id = ixlanA.id
        JOIN peeringdb_network_ixlan b ON a.net_id = b.net_id
        JOIN peeringdb_ixlan ixlanB ON b.ixlan_id = ixlanB.id
        JOIN peeringdb_network n ON a.net_id = n.id
        WHERE ixlanA.ix_id = ? AND ixlanB.ix_id = ?
          AND a.status = 'ok' AND b.status = 'ok'
          AND n.status = 'ok'
        ORDER BY n.name COLLATE NOCASE
    `).bind(idA, idB).all();

    // Only-A facilities
    const onlyAFacs = await db.prepare(`
        SELECT f.id AS fac_id, f.name AS fac_name, f.city, f.country,
               f.latitude, f.longitude
        FROM peeringdb_ix_facility a
        JOIN peeringdb_facility f ON a.fac_id = f.id
        WHERE a.ix_id = ? AND a.status = 'ok' AND f.status = 'ok'
          AND f.id NOT IN (
            SELECT b.fac_id FROM peeringdb_ix_facility b
            WHERE b.ix_id = ? AND b.status = 'ok'
          )
        ORDER BY f.name COLLATE NOCASE
    `).bind(idA, idB).all();

    // Only-B facilities
    const onlyBFacs = await db.prepare(`
        SELECT f.id AS fac_id, f.name AS fac_name, f.city, f.country,
               f.latitude, f.longitude
        FROM peeringdb_ix_facility a
        JOIN peeringdb_facility f ON a.fac_id = f.id
        WHERE a.ix_id = ? AND a.status = 'ok' AND f.status = 'ok'
          AND f.id NOT IN (
            SELECT b.fac_id FROM peeringdb_ix_facility b
            WHERE b.ix_id = ? AND b.status = 'ok'
          )
        ORDER BY f.name COLLATE NOCASE
    `).bind(idB, idA).all();

    // Only-A networks
    const onlyANets = await db.prepare(`
        SELECT DISTINCT n.id AS net_id, n.name AS net_name, n.asn
        FROM peeringdb_network_ixlan a
        JOIN peeringdb_ixlan ixlan ON a.ixlan_id = ixlan.id
        JOIN peeringdb_network n ON a.net_id = n.id
        WHERE ixlan.ix_id = ? AND a.status = 'ok' AND n.status = 'ok'
          AND n.id NOT IN (
            SELECT DISTINCT b.net_id FROM peeringdb_network_ixlan b
            JOIN peeringdb_ixlan ixlan2 ON b.ixlan_id = ixlan2.id
            WHERE ixlan2.ix_id = ? AND b.status = 'ok'
          )
        ORDER BY n.name COLLATE NOCASE
    `).bind(idA, idB).all();

    // Only-B networks
    const onlyBNets = await db.prepare(`
        SELECT DISTINCT n.id AS net_id, n.name AS net_name, n.asn
        FROM peeringdb_network_ixlan a
        JOIN peeringdb_ixlan ixlan ON a.ixlan_id = ixlan.id
        JOIN peeringdb_network n ON a.net_id = n.id
        WHERE ixlan.ix_id = ? AND a.status = 'ok' AND n.status = 'ok'
          AND n.id NOT IN (
            SELECT DISTINCT b.net_id FROM peeringdb_network_ixlan b
            JOIN peeringdb_ixlan ixlan2 ON b.ixlan_id = ixlan2.id
            WHERE ixlan2.ix_id = ? AND b.status = 'ok'
          )
        ORDER BY n.name COLLATE NOCASE
    `).bind(idB, idA).all();

    return {
        shared_facilities: sharedFacs.results || [],
        shared_networks: sharedNets.results || [],
        only_a_facilities: onlyAFacs.results || [],
        only_b_facilities: onlyBFacs.results || [],
        only_a_networks: onlyANets.results || [],
        only_b_networks: onlyBNets.results || [],
    };
}

// ── Cross-entity overlap query implementations ───────────────────────────────

/**
 * Computes overlap between an IXP and a Network (keys always sorted: ix+net).
 * Focuses on shared facilities and verifies direct IXP membership.
 *
 * @param {D1Session} db - D1 database session.
 * @param {number} ixId - IX ID A.
 * @param {number} netId - Network ID B.
 * @returns {Promise<Record<string, any>>} Overlap result sections.
 */
async function overlapIxNet(db, ixId, netId) {
    // Shared Facilities: IX is there AND Net is there
    const sharedFacs = await db.prepare(`
        SELECT f.id AS fac_id, f.name AS fac_name, f.city, f.country,
               f.latitude, f.longitude
        FROM peeringdb_ix_facility a
        JOIN peeringdb_network_facility b ON a.fac_id = b.fac_id
        JOIN peeringdb_facility f ON a.fac_id = f.id
        WHERE a.ix_id = ? AND b.net_id = ?
          AND a.status = 'ok' AND b.status = 'ok'
          AND f.status = 'ok'
        ORDER BY f.name COLLATE NOCASE
    `).bind(ixId, netId).all();

    // Only-A (IX) facilities
    const onlyAIxFacs = await db.prepare(`
        SELECT f.id AS fac_id, f.name AS fac_name, f.city, f.country, f.latitude, f.longitude
        FROM peeringdb_ix_facility a
        JOIN peeringdb_facility f ON a.fac_id = f.id
        WHERE a.ix_id = ? AND a.status = 'ok' AND f.status = 'ok'
          AND f.id NOT IN (
            SELECT b.fac_id FROM peeringdb_network_facility b
            WHERE b.net_id = ? AND b.status = 'ok'
          )
        ORDER BY f.name COLLATE NOCASE
    `).bind(ixId, netId).all();

    // Only-B (Net) facilities
    const onlyBNetFacs = await db.prepare(`
        SELECT f.id AS fac_id, f.name AS fac_name, f.city, f.country, f.latitude, f.longitude
        FROM peeringdb_network_facility b
        JOIN peeringdb_facility f ON b.fac_id = f.id
        WHERE b.net_id = ? AND b.status = 'ok' AND f.status = 'ok'
          AND f.id NOT IN (
            SELECT a.fac_id FROM peeringdb_ix_facility a
            WHERE a.ix_id = ? AND a.status = 'ok'
          )
        ORDER BY f.name COLLATE NOCASE
    `).bind(netId, ixId).all();

    // Membership: Is the network peering at the IX?
    const membership = await db.prepare(`
        SELECT ixlan.id as ixlan_id, ixlan.ix_id, a.speed, a.ipaddr4, a.ipaddr6, a.is_rs_peer
        FROM peeringdb_network_ixlan a
        JOIN peeringdb_ixlan ixlan ON a.ixlan_id = ixlan.id
        WHERE a.net_id = ? AND ixlan.ix_id = ?
          AND a.status = 'ok' AND ixlan.status = 'ok'
    `).bind(netId, ixId).all();

    return {
        shared_facilities: sharedFacs.results || [],
        only_a_facilities: onlyAIxFacs.results || [],
        only_b_facilities: onlyBNetFacs.results || [],
        membership: membership.results || []
    };
}

/**
 * Computes overlap between a Facility and a Network (fac+net).
 * Returns shared IXPs (IXPs the Network peers at which reside in the Facility).
 *
 * @param {D1Session} db - D1 database session.
 * @param {number} facId - Facility ID A.
 * @param {number} netId - Network ID B.
 * @returns {Promise<Record<string, any>>} Overlap result sections.
 */
async function overlapFacNet(db, facId, netId) {
    const sharedIxps = await db.prepare(`
        SELECT ix.id AS ix_id, ix.name AS ix_name, ix.country, ix.city,
               n.speed AS speed_b, n.ipaddr4 AS ipv4_b, n.ipaddr6 AS ipv6_b, n.is_rs_peer AS rs_b
        FROM peeringdb_ix_facility ixfac
        JOIN peeringdb_ix ix ON ixfac.ix_id = ix.id
        JOIN peeringdb_ixlan ixlan ON ixlan.ix_id = ix.id
        JOIN peeringdb_network_ixlan n ON n.ixlan_id = ixlan.id
        WHERE ixfac.fac_id = ? AND n.net_id = ?
          AND ixfac.status = 'ok' AND ix.status = 'ok' AND ixlan.status = 'ok' AND n.status = 'ok'
        ORDER BY ix.name COLLATE NOCASE
    `).bind(facId, netId).all();

    const onlyAFacIxps = await db.prepare(`
        SELECT ix.id AS ix_id, ix.name AS ix_name, ix.country, ix.city
        FROM peeringdb_ix_facility a
        JOIN peeringdb_ix ix ON a.ix_id = ix.id
        WHERE a.fac_id = ? AND a.status = 'ok' AND ix.status = 'ok'
          AND ix.id NOT IN (
            SELECT ixlan2.ix_id FROM peeringdb_network_ixlan b
            JOIN peeringdb_ixlan ixlan2 ON b.ixlan_id = ixlan2.id
            WHERE b.net_id = ? AND b.status = 'ok'
          )
        ORDER BY ix.name COLLATE NOCASE
    `).bind(facId, netId).all();

    const onlyBNetIxps = await db.prepare(`
        SELECT ix.id AS ix_id, ix.name AS ix_name, ix.country, ix.city,
               b.speed AS speed_b, b.ipaddr4 AS ipv4_b, b.ipaddr6 AS ipv6_b, b.is_rs_peer AS rs_b
        FROM peeringdb_network_ixlan b
        JOIN peeringdb_ixlan ixlan ON b.ixlan_id = ixlan.id
        JOIN peeringdb_ix ix ON ixlan.ix_id = ix.id
        WHERE b.net_id = ? AND b.status = 'ok' AND ix.status = 'ok' AND ixlan.status = 'ok'
          AND ix.id NOT IN (
            SELECT a.ix_id FROM peeringdb_ix_facility a
            WHERE a.fac_id = ? AND a.status = 'ok'
          )
        ORDER BY ix.name COLLATE NOCASE
    `).bind(netId, facId).all();

    return {
        shared_ixps: sharedIxps.results || [],
        only_a_ixps: onlyAFacIxps.results || [],
        only_b_ixps: onlyBNetIxps.results || []
    };
}

/**
 * Computes overlap between a Facility and an IX (fac+ix).
 * Returns shared Networks (Networks in the facility that peer at the IX).
 *
 * @param {D1Session} db - D1 database session.
 * @param {number} facId - Facility ID A.
 * @param {number} ixId - IX ID B.
 * @returns {Promise<Record<string, any>>} Overlap result sections.
 */
async function overlapFacIx(db, facId, ixId) {
    const sharedNets = await db.prepare(`
        SELECT DISTINCT n.id AS net_id, n.name AS net_name, n.asn
        FROM peeringdb_network_facility a
        JOIN peeringdb_network n ON a.net_id = n.id
        JOIN peeringdb_network_ixlan b ON b.net_id = n.id
        JOIN peeringdb_ixlan ixlan ON b.ixlan_id = ixlan.id
        WHERE a.fac_id = ? AND ixlan.ix_id = ?
          AND a.status = 'ok' AND n.status = 'ok' AND b.status = 'ok' AND ixlan.status = 'ok'
        ORDER BY n.name COLLATE NOCASE
    `).bind(facId, ixId).all();

    const onlyAFacNets = await db.prepare(`
        SELECT DISTINCT n.id AS net_id, n.name AS net_name, n.asn
        FROM peeringdb_network_facility a
        JOIN peeringdb_network n ON a.net_id = n.id
        WHERE a.fac_id = ? AND a.status = 'ok' AND n.status = 'ok'
          AND n.id NOT IN (
            SELECT b.net_id FROM peeringdb_network_ixlan b
            JOIN peeringdb_ixlan ixlan ON b.ixlan_id = ixlan.id
            WHERE ixlan.ix_id = ? AND b.status = 'ok'
          )
        ORDER BY n.name COLLATE NOCASE
    `).bind(facId, ixId).all();

    const onlyBIxNets = await db.prepare(`
        SELECT DISTINCT n.id AS net_id, n.name AS net_name, n.asn
        FROM peeringdb_network_ixlan b
        JOIN peeringdb_ixlan ixlan ON b.ixlan_id = ixlan.id
        JOIN peeringdb_network n ON b.net_id = n.id
        WHERE ixlan.ix_id = ? AND b.status = 'ok' AND ixlan.status = 'ok' AND n.status = 'ok'
          AND n.id NOT IN (
            SELECT a.net_id FROM peeringdb_network_facility a
            WHERE a.fac_id = ? AND a.status = 'ok'
          )
        ORDER BY n.name COLLATE NOCASE
    `).bind(ixId, facId).all();

    return {
        shared_networks: sharedNets.results || [],
        only_a_networks: onlyAFacNets.results || [],
        only_b_networks: onlyBIxNets.results || []
    };
}

/**
 * Computes overlap between two facilities (fac+fac).
 *
 * @param {D1Session} db - D1 database session.
 * @param {number} idA - Facility ID A.
 * @param {number} idB - Facility ID B.
 * @returns {Promise<Record<string, any>>} Overlap result sections.
 */
async function overlapFacFac(db, idA, idB) {
    const sharedNets = await db.prepare(`
        SELECT DISTINCT n.id AS net_id, n.name AS net_name, n.asn
        FROM peeringdb_network_facility a
        JOIN peeringdb_network_facility b ON a.net_id = b.net_id
        JOIN peeringdb_network n ON a.net_id = n.id
        WHERE a.fac_id = ? AND b.fac_id = ?
          AND a.status = 'ok' AND b.status = 'ok' AND n.status = 'ok'
        ORDER BY n.name COLLATE NOCASE
    `).bind(idA, idB).all();

    const sharedIxps = await db.prepare(`
        SELECT ix.id AS ix_id, ix.name AS ix_name, ix.country, ix.city
        FROM peeringdb_ix_facility a
        JOIN peeringdb_ix_facility b ON a.ix_id = b.ix_id
        JOIN peeringdb_ix ix ON a.ix_id = ix.id
        WHERE a.fac_id = ? AND b.fac_id = ?
          AND a.status = 'ok' AND b.status = 'ok' AND ix.status = 'ok'
        ORDER BY ix.name COLLATE NOCASE
    `).bind(idA, idB).all();

    const onlyANets = await db.prepare(`
        SELECT DISTINCT n.id AS net_id, n.name AS net_name, n.asn
        FROM peeringdb_network_facility a
        JOIN peeringdb_network n ON a.net_id = n.id
        WHERE a.fac_id = ? AND a.status = 'ok' AND n.status = 'ok'
          AND n.id NOT IN (SELECT net_id FROM peeringdb_network_facility WHERE fac_id = ? AND status='ok')
        ORDER BY n.name COLLATE NOCASE
    `).bind(idA, idB).all();

    const onlyBNets = await db.prepare(`
        SELECT DISTINCT n.id AS net_id, n.name AS net_name, n.asn
        FROM peeringdb_network_facility a
        JOIN peeringdb_network n ON a.net_id = n.id
        WHERE a.fac_id = ? AND a.status = 'ok' AND n.status = 'ok'
          AND n.id NOT IN (SELECT net_id FROM peeringdb_network_facility WHERE fac_id = ? AND status='ok')
        ORDER BY n.name COLLATE NOCASE
    `).bind(idB, idA).all();

    const onlyAIxps = await db.prepare(`
        SELECT ix.id AS ix_id, ix.name AS ix_name, ix.country, ix.city
        FROM peeringdb_ix_facility a
        JOIN peeringdb_ix ix ON a.ix_id = ix.id
        WHERE a.fac_id = ? AND a.status = 'ok' AND ix.status = 'ok'
          AND ix.id NOT IN (SELECT ix_id FROM peeringdb_ix_facility WHERE fac_id = ? AND status='ok')
        ORDER BY ix.name COLLATE NOCASE
    `).bind(idA, idB).all();

    const onlyBIxps = await db.prepare(`
        SELECT ix.id AS ix_id, ix.name AS ix_name, ix.country, ix.city
        FROM peeringdb_ix_facility a
        JOIN peeringdb_ix ix ON a.ix_id = ix.id
        WHERE a.fac_id = ? AND a.status = 'ok' AND ix.status = 'ok'
          AND ix.id NOT IN (SELECT ix_id FROM peeringdb_ix_facility WHERE fac_id = ? AND status='ok')
        ORDER BY ix.name COLLATE NOCASE
    `).bind(idB, idA).all();

    return {
        shared_networks: sharedNets.results || [],
        shared_ixps: sharedIxps.results || [],
        only_a_networks: onlyANets.results || [],
        only_b_networks: onlyBNets.results || [],
        only_a_ixps: onlyAIxps.results || [],
        only_b_ixps: onlyBIxps.results || []
    };
}

/**
 * Dispatcher mapping pair keys to their overlap implementations.
 * @type {Record<string, (db: D1Session, idA: number, idB: number) => Promise<Record<string, any>>>}
 */
const OVERLAP_FNS = {
    'net+net': overlapNetNet,
    'ix+ix': overlapIxIx,
    'fac+fac': overlapFacFac,
    'ix+net': overlapIxNet,
    'fac+net': overlapFacNet,
    'fac+ix': overlapFacIx,
};

// ── Public handler ───────────────────────────────────────────────────────────

/**
 * Executes the full compare query for caching via withEdgeSWR.
 * The heavy query + header lookups happen inside this closure so
 * the result can be cached as a pre-encoded Uint8Array.
 *
 * @param {D1Session} db - D1 database session.
 * @param {{tag: string, id: number}} refA - Parsed entity A reference.
 * @param {{tag: string, id: number}} refB - Parsed entity B reference.
 * @param {string} pk - Normalised pair key.
 * @returns {Promise<Uint8Array|null>} Encoded JSON payload, or null if an entity is missing.
 */
async function executeCompareQuery(db, refA, refB, pk) {
    // Fetch entity headers in parallel
    const [headerA, headerB] = await Promise.all([
        fetchEntityHeader(db, refA.tag, refA.id),
        fetchEntityHeader(db, refB.tag, refB.id),
    ]);

    if (!headerA || !headerB) return null;

    // Run the overlap query. For asymmetric pairs (e.g. net+ix in future),
    // the dispatcher normalises the order so the first arg matches the
    // first tag in the pair key.
    const overlapFn = OVERLAP_FNS[pk];
    let overlap;
    if (refA.tag <= refB.tag) {
        overlap = await overlapFn(db, refA.id, refB.id);
    } else {
        // Swap so the "smaller" tag is always first
        overlap = await overlapFn(db, refB.id, refA.id);
        // Swap only_a / only_b labels
        /** @type {Record<string, any>} */
        const swapped = {};
        for (const [key, val] of Object.entries(overlap)) {
            if (key.startsWith('only_a_')) {
                swapped[key.replace('only_a_', 'only_b_')] = val;
            } else if (key.startsWith('only_b_')) {
                swapped[key.replace('only_b_', 'only_a_')] = val;
            } else {
                swapped[key] = val;
            }
        }
        overlap = swapped;
    }

    return encodeJSON({ a: headerA, b: headerB, ...overlap });
}

/**
 * Handles compare requests: GET /api/compare?a={tag}:{id}&b={tag}:{id}&__pdbfe=1
 *
 * Validates the __pdbfe=1 flag, parses both entity references, checks the
 * pair is supported, then delegates to withEdgeSWR for cached query execution.
 * Uses the "compare" cache tier and serveJSON for response building, following
 * the same pattern as handleAsSet and handleDetail.
 *
 * @param {Request} request - The inbound HTTP request.
 * @param {D1Session} db - D1 database session (with read replication).
 * @param {ExecutionContext} ctx - Worker execution context for SWR background tasks.
 * @param {string} queryString - Raw query string (without leading '?').
 * @param {boolean} authenticated - Whether the caller is authenticated.
 * @param {Record<string, string>} hNocache - Pre-cooked no-cache header set.
 * @returns {Promise<Response>} JSON response with overlap data.
 */
export async function handleCompare(request, db, ctx, queryString, authenticated, hNocache) {
    // Parse query parameters manually (no URLSearchParams allocation)
    const params = new Map();
    if (queryString) {
        for (const part of queryString.split('&')) { // ap-ok: bounded by URL length, once per request
            const eqIdx = part.indexOf('=');
            if (eqIdx === -1) continue;
            params.set(
                decodeURIComponent(part.slice(0, eqIdx)),
                decodeURIComponent(part.slice(eqIdx + 1))
            );
        }
    }

    // Require __pdbfe=1 — this is a PDBFE extension
    if (params.get('__pdbfe') !== '1') {
        return jsonError(400,
            'The compare endpoint is a PDBFE extension. Add __pdbfe=1 to your query.',
            hNocache
        );
    }

    const refA = parseEntityRef(params.get('a') || '');
    const refB = parseEntityRef(params.get('b') || '');

    if (!refA || !refB) {
        return jsonError(400,
            'Both a and b parameters required in format {tag}:{id}, e.g. a=net:13335&b=net:15169',
            hNocache
        );
    }

    const pk = pairKey(refA.tag, refB.tag);
    if (!SUPPORTED_PAIRS.has(pk)) {
        return jsonError(400,
            `Unsupported entity pair: ${refA.tag} + ${refB.tag}. ` +
            `Supported: ${[...SUPPORTED_PAIRS].map(p => p.replaceAll('+', ' ↔ ')).join(', ')}`, // ap-ok: error path only, set has ≤5 entries
            hNocache
        );
    }

    const cacheKey = normaliseCacheKey('api/compare', queryString);
    const { buf, tier, hits } = await withEdgeSWR(
        'compare', cacheKey, ctx, DETAIL_TTL,
        () => executeCompareQuery(db, refA, refB, pk)
    );

    if (!buf) {
        // One or both entities not found
        return jsonError(404, 'One or both entities not found', hNocache);
    }

    return serveJSON(request, buf, { tier, hits }, authenticated ? H_API_AUTH : H_API_ANON);
}
