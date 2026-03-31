/**
 * @fileoverview SQL query builder that translates PeeringDB filter syntax
 * to parameterised D1 queries. All user input goes through prepared
 * statement bindings — no string concatenation in SQL.
 *
 * Supported filter operators:
 *   eq        → WHERE col = ?
 *   lt        → WHERE col < ?
 *   gt        → WHERE col > ?
 *   lte       → WHERE col <= ?
 *   gte       → WHERE col >= ?
 *   contains  → WHERE col LIKE '%' || ? || '%' COLLATE NOCASE
 *   startswith→ WHERE col LIKE ? || '%' COLLATE NOCASE
 *   in        → WHERE col IN (?, ?, ...)
 */

/**
 * Operator mapping from PeeringDB filter suffix to SQL fragment.
 * Each entry is a function that returns the SQL clause and parameter(s).
 *
 * @type {Record<string, (col: string, value: string) => {clause: string, params: (string|number)[]}>}
 */
const OPS = {
    eq: (col, value) => ({
        clause: `"${col}" = ?`,
        params: [value]
    }),
    lt: (col, value) => ({
        clause: `"${col}" < ?`,
        params: [value]
    }),
    gt: (col, value) => ({
        clause: `"${col}" > ?`,
        params: [value]
    }),
    lte: (col, value) => ({
        clause: `"${col}" <= ?`,
        params: [value]
    }),
    gte: (col, value) => ({
        clause: `"${col}" >= ?`,
        params: [value]
    }),
    contains: (col, value) => ({
        clause: `"${col}" LIKE '%' || ? || '%' COLLATE NOCASE`,
        params: [value]
    }),
    startswith: (col, value) => ({
        clause: `"${col}" LIKE ? || '%' COLLATE NOCASE`,
        params: [value]
    }),
    in: (col, value) => {
        const parts = value.split(",");
        const placeholders = parts.map(() => "?").join(", ");
        return {
            clause: `"${col}" IN (${placeholders})`,
            params: parts
        };
    }
};

/**
 * Coerces a string value to the appropriate D1 bind parameter type
 * based on the entity's declared field type. Prevents type mismatches
 * in prepared statements.
 *
 * @param {string} value - The raw query string value.
 * @param {'string'|'number'|'boolean'|'datetime'} fieldType - The declared field type.
 * @returns {string|number} The coerced value.
 */
function coerceValue(value, fieldType) {
    if (fieldType === "number") {
        const n = Number(value);
        return isNaN(n) ? 0 : n;
    }
    if (fieldType === "boolean") {
        return value === "true" || value === "1" ? 1 : 0;
    }
    return value;
}

/**
 * Builds a parameterised SELECT query from parsed filters, an entity
 * metadata definition, and pagination parameters.
 *
 * Filters are validated against the entity's allowed filter fields.
 * Unknown fields are silently ignored (matching upstream PeeringDB
 * behaviour). The `since` parameter adds an `updated >= datetime(?)` clause.
 *
 * @param {EntityMeta} entity - Entity metadata from the registry.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Pagination and depth.
 * @param {number|null} [singleId=null] - If set, fetches a single row by ID.
 * @returns {BuiltQuery} Parameterised SQL and bind values.
 */
/**
 * Columns that store JSON arrays/objects as TEXT in D1.
 * Must be unwrapped with SQLite's json() function when building
 * json_object() payloads, otherwise the JSON gets double-escaped.
 *
 * @type {Set<string>}
 */
const JSON_STORED_COLS = new Set([
    "social_media", "info_types", "available_voltage_services"
]);

/**
 * Builds the per-column argument list for SQLite's json_object().
 * JSON-stored columns are wrapped in json() to inline them as native
 * JSON arrays without double-escaping. Regular columns are passed as-is.
 *
 * @param {string[]} columns - Column names.
 * @returns {string} Comma-separated json_object argument pairs.
 */
function jsonObjectArgs(columns) {
    const parts = [];
    for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        if (JSON_STORED_COLS.has(c)) {
            parts.push(`'${c}', json("${c}")`);
        } else {
            parts.push(`'${c}', "${c}"`);
        }
    }
    return parts.join(", ");
}

/**
 * Builds a query that returns the complete JSON response envelope
 * as a single string from SQLite, using json_group_array and json_object.
 *
 * This eliminates all V8-side JSON.parse/JSON.stringify overhead:
 * the worker receives a pre-formatted payload string, encodes it to
 * Uint8Array, and serves it directly. Zero V8 object allocations per row.
 *
 * Only used for depth=0 queries. Depth>0 requires row-level expansion
 * in V8 and falls back to buildRowQuery.
 *
 * @param {EntityMeta} entity - Entity metadata from the registry.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Pagination.
 * @param {number|null} [singleId=null] - If set, fetches a single row by ID.
 * @returns {BuiltQuery} Parameterised SQL that returns {payload: string}.
 */
export function buildJsonQuery(entity, filters, opts, singleId = null) {
    const { clauses, params, pagination } = buildWherePagination(entity, filters, opts, singleId);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const jsonCols = jsonObjectArgs(entity.columns);

    const sql =
        `SELECT json_object('data',json_group_array(json_object(${jsonCols})),'meta',json_object()) AS payload` +
        ` FROM (SELECT * FROM "${entity.table}"${where} ORDER BY "id" ASC${pagination})`;

    return { sql, params };
}

/**
 * Builds a traditional SELECT query returning individual rows.
 * Used when depth>0 (rows need V8-side expansion with relationship sets)
 * and by the sync worker for row-level processing.
 *
 * @param {EntityMeta} entity - Entity metadata from the registry.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Pagination and depth.
 * @param {number|null} [singleId=null] - If set, fetches a single row by ID.
 * @returns {BuiltQuery} Parameterised SQL and bind values.
 */
export function buildRowQuery(entity, filters, opts, singleId = null) {
    const { clauses, params, pagination } = buildWherePagination(entity, filters, opts, singleId);
    const cols = entity.columns.map(c => `"${c}"`).join(", ");
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

    const sql = `SELECT ${cols} FROM "${entity.table}"${where} ORDER BY "id" ASC${pagination}`;
    return { sql, params };
}

/**
 * Backwards-compatible alias. Delegates to buildRowQuery.
 * Retained for existing callsites (depth expansion, sync worker, tests).
 *
 * @param {EntityMeta} entity - Entity metadata from the registry.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Pagination and depth.
 * @param {number|null} [singleId=null] - If set, fetches a single row by ID.
 * @returns {BuiltQuery} Parameterised SQL and bind values.
 */
export function buildQuery(entity, filters, opts, singleId = null) {
    return buildRowQuery(entity, filters, opts, singleId);
}

/**
 * Common WHERE/LIMIT/OFFSET construction shared by both query builders.
 * Validates filters against the entity's allowed fields, applies the since
 * parameter, and builds pagination clauses.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Pagination.
 * @param {number|null} singleId - Single-row ID or null.
 * @returns {{ clauses: string[], params: (string|number)[], pagination: string }}
 */
function buildWherePagination(entity, filters, opts, singleId) {
    const { limit, skip, since } = opts;
    /** @type {string[]} */
    const clauses = [];
    /** @type {(string|number)[]} */
    const params = [];

    // Single-row fetch by ID
    if (singleId !== null) {
        clauses.push('"id" = ?');
        params.push(singleId);
    }

    // Since filter (unix epoch seconds → ISO datetime comparison)
    if (since > 0) {
        clauses.push('"updated" >= datetime(?, \'unixepoch\')');
        params.push(since);
    }

    // Apply user-provided filters, validating against the entity's allowed fields
    for (const f of filters) {
        const fieldType = entity.filters[f.field];
        if (!fieldType) continue; // Unknown field — ignore silently

        const opFn = OPS[f.op];
        if (!opFn) continue; // Unknown operator — ignore silently

        // For 'in' operator, coerce each comma-separated value
        if (f.op === "in") {
            const result = opFn(f.field, f.value);
            result.params = result.params.map(v => coerceValue(/** @type {string} */(v), fieldType));
            clauses.push(result.clause);
            params.push(...result.params);
        } else {
            const coerced = coerceValue(f.value, fieldType);
            const result = opFn(f.field, /** @type {string} */(coerced));
            result.params = [coerced];
            clauses.push(result.clause);
            params.push(...result.params);
        }
    }

    // Pagination: cap at 250 when depth > 0 (matching upstream behaviour)
    let effectiveLimit = limit || 0;
    if (opts.depth > 0 && (effectiveLimit === 0 || effectiveLimit > 250)) {
        effectiveLimit = 250;
    }

    let pagination = "";
    if (effectiveLimit > 0) {
        pagination += ` LIMIT ?`;
        params.push(effectiveLimit);
        if (skip > 0) {
            pagination += ` OFFSET ?`;
            params.push(skip);
        }
    } else if (skip > 0) {
        // Skip without limit requires a large limit in SQLite
        pagination += ` LIMIT -1 OFFSET ?`;
        params.push(skip);
    }

    return { clauses, params, pagination };
}

/**
 * Builds the cache key prefix for the next page of a paginated
 * query. Returns null if there is no next page to pre-fetch
 * (no limit set, or single-row fetch).
 *
 * @param {ParsedFilter[]} filters - The current query filters.
 * @param {{depth: number, limit: number, skip: number, since: number}} opts - Current pagination.
 * @param {number} resultCount - Number of rows returned by the current query.
 * @returns {{limit: number, skip: number}|null} Next-page pagination, or null.
 */
export function nextPageParams(filters, opts, resultCount) {
    const effectiveLimit = opts.limit || (opts.depth > 0 ? 250 : 0);
    if (effectiveLimit === 0) return null;
    if (resultCount < effectiveLimit) return null; // Last page
    return { limit: effectiveLimit, skip: (opts.skip || 0) + effectiveLimit };
}
