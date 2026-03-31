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
export function buildQuery(entity, filters, opts, singleId = null) {
    const { limit, skip, since } = opts;
    const cols = entity.columns.map(c => `"${c}"`).join(", ");
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

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

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

    const sql = `SELECT ${cols} FROM "${entity.table}"${where} ORDER BY "id" ASC${pagination}`;
    return { sql, params };
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
