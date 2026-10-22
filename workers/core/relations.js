/**
 * @fileoverview Entity relations shared by the API depth expansion
 * (api/depth.js) and the sync worker's change tracking
 * (sync/row_changes.js). Both must agree on what a response contains:
 * the sync side marks a response changed exactly when a row that depth.js
 * would put in it changed.
 */

/**
 * Upstream PeeringDB sets that reach the *other* side of a link table:
 * ix.fac_set lists facilities (via ixfac), ixlan.net_set lists networks (via
 * netixlan). depth=1 → distinct target ids, depth=2 → full target objects.
 * The mirror's own link-row sets (ixfac_set, netixlan_set) stay alongside as
 * extensions; the frontend uses them.
 *
 * @type {Record<string, Array<{field: string, link: string, parentFk: string, targetFk: string, targetTag: string}>>}
 */
export const THROUGH_SETS = {
    ix: [{ field: 'fac_set', link: 'peeringdb_ix_facility', parentFk: 'ix_id', targetFk: 'fac_id', targetTag: 'fac' }],
    ixlan: [{ field: 'net_set', link: 'peeringdb_network_ixlan', parentFk: 'ixlan_id', targetFk: 'net_id', targetTag: 'net' }],
};

/**
 * Whether a field is a parent foreign key that depth expansion turns into an
 * object: named `<target>_id` for a known entity (netixlan.net_side_id /
 * ix_side_id point at fac but are not expanded upstream).
 *
 * @param {Record<string, EntityMeta>} entities
 * @param {FieldDef} f
 * @returns {boolean}
 */
export function isParentFk(entities, f) {
    return !!f.foreignKey && !!entities[f.foreignKey] && f.name === `${f.foreignKey}_id`;
}
