/**
 * @fileoverview Per-row field visibility (upstream PeeringDB "*_visible" fields).
 *
 * Some columns carry their own visibility setting on the same row:
 * ixlan.ixf_ixp_member_list_url is gated by ixf_ixp_member_list_url_visible
 * (Public / Users / Private). Upstream omits the value unless the caller may
 * see it: anonymous → Public only, authenticated → Public or Users. Private
 * is never served (org members only — the mirror has no org membership).
 *
 * Enforced in SQL by every query builder (api/query.js, api/depth.js), so
 * no handler, depth path, REST relation or GraphQL resolver can emit the
 * raw value: the column is selected as
 *   CASE WHEN "<vis>" IN (<allowed>) THEN "<col>" END
 * and filters/sorts on it only ever see rows the caller may see.
 *
 * Tables listed here are also treated as auth-sensitive by auth_scope.js
 * (their responses differ by auth state, so they are never shared).
 */

/** table → (column → visibility column) */
const GATED = new Map([
    ['peeringdb_ixlan', new Map([['ixf_ixp_member_list_url', 'ixf_ixp_member_list_url_visible']])],
]);

/** Visibility values each auth state may see, as fixed SQL literals. */
const ALLOWED_ANON = "'Public'";
const ALLOWED_AUTH = "'Public', 'Users'";

/** Tables with at least one gated column. */
export const GATED_TABLES = new Set(GATED.keys());

/**
 * The visibility column gating `column` on `table`, if any.
 * @param {string} table
 * @param {string} column
 * @returns {string|undefined}
 */
export function gateFor(table, column) {
    return GATED.get(table)?.get(column);
}

/**
 * SQL list of visibility values the caller may see.
 * @param {boolean|undefined} authenticated
 * @returns {string}
 */
export function allowedVisibility(authenticated) {
    return authenticated === true ? ALLOWED_AUTH : ALLOWED_ANON;
}

/**
 * Column expression for SELECT lists: the plain column, or the gated CASE
 * aliased back to the column name.
 *
 * @param {string} table - Table the column belongs to.
 * @param {string} column - Column name.
 * @param {string} pfx - Table alias prefix including the dot (e.g. "t.") or ''.
 * @param {boolean|undefined} authenticated - Caller auth state.
 * @returns {string}
 */
export function selectColumn(table, column, pfx, authenticated) {
    const vis = gateFor(table, column);
    if (!vis) return `${pfx}"${column}"`;
    return `CASE WHEN ${pfx}"${vis}" IN (${allowedVisibility(authenticated)}) THEN ${pfx}"${column}" END AS "${column}"`;
}

/**
 * Extra WHERE clause that restricts a filter or sort on a gated column to
 * rows whose value the caller may see, or null for ungated columns.
 *
 * @param {string} table
 * @param {string} column
 * @param {string} pfx - Alias prefix including the dot, or ''.
 * @param {boolean|undefined} authenticated
 * @returns {string|null}
 */
export function visibilityClause(table, column, pfx, authenticated) {
    const vis = gateFor(table, column);
    return vis ? `${pfx}"${vis}" IN (${allowedVisibility(authenticated)})` : null;
}
