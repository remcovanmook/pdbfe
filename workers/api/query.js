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

import { getColumns, getJsonColumns, getBoolColumns, getNullableColumns, getFilterType, resolveCrossEntityFilter } from './entities.js';

/**
 * Suffix operators that can appear after `__` in PeeringDB query parameters.
 * Derived from OPS keys, excluding `eq` which is the implicit default
 * (no suffix). Used by parseQueryFilters() to recognise operator suffixes.
 * @type {Set<string>}
 */
export const FILTER_OPS = new Set(['lt', 'gt', 'lte', 'gte', 'contains', 'startswith', 'in']);

/**
 * Operator mapping from PeeringDB filter suffix to SQL fragment.
 * Each entry is a function that returns the SQL clause and parameter(s).
 *
 * @type {Record<string, (col: string, value: string) => {clause: string, params: (string|number)[]}>}
 */
const OPS = {
    eq: (col, value) => ({
        clause: `"${col}" = ? COLLATE NOCASE`,
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
        const parts = value.split(","); // ap-ok: SQL IN clause construction
        const placeholders = parts.map(() => "?").join(", "); // ap-ok: SQL placeholders
        return {
            clause: `"${col}" IN (${placeholders})`,
            params: parts
        };
    }
};

/**
 * SQL clause generators for aliased column references.
 * Unlike OPS, these accept a pre-quoted SQL column expression
 * (e.g. t."ix_id") and a placeholder string.
 *
 * @type {Record<string, (col: string, ph: string) => string>}
 */
const OPS_SQL = {
    eq: (col, ph) => `${col} = ${ph} COLLATE NOCASE`,
    lt: (col, ph) => `${col} < ${ph}`,
    gt: (col, ph) => `${col} > ${ph}`,
    lte: (col, ph) => `${col} <= ${ph}`,
    gte: (col, ph) => `${col} >= ${ph}`,
    contains: (col, ph) => `${col} LIKE '%' || ${ph} || '%' COLLATE NOCASE`,
    startswith: (col, ph) => `${col} LIKE ${ph} || '%' COLLATE NOCASE`,
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
        return Number.isNaN(n) ? 0 : n;
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
 * Builds the per-column argument list for SQLite's json_object().
 * JSON-stored columns are wrapped in json() to inline them as native
 * JSON arrays without double-escaping. Boolean columns use json()
 * around a CASE expression to emit true/false instead of 0/1.
 * Nullable columns are wrapped in NULLIF(col, '') so that empty
 * strings stored in D1 are emitted as JSON null, matching upstream.
 * Regular columns are passed as-is.
 *
 * @param {string[]} columns - Column names.
 * @param {Set<string>} jsonCols - Column names that store JSON TEXT.
 * @param {Set<string>} boolCols - Column names with boolean type.
 * @param {Set<string>} nullableCols - Column names that are nullable.
 * @param {string} [prefix] - Optional table alias prefix (e.g. "t").
 * @returns {string} Comma-separated json_object argument pairs.
 */
function jsonObjectArgs(columns, jsonCols, boolCols, nullableCols, prefix) {
    const pfx = prefix ? `${prefix}.` : '';
    const parts = [];
    for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        if (jsonCols.has(c)) {
            parts.push(`'${c}', json(${pfx}"${c}")`);
        } else if (boolCols.has(c)) {
            parts.push(`'${c}', json(CASE WHEN ${pfx}"${c}" THEN 'true' ELSE 'false' END)`);
        } else if (nullableCols.has(c)) {
            parts.push(`'${c}', NULLIF(${pfx}"${c}", '')`);
        } else {
            parts.push(`'${c}', ${pfx}"${c}"`);
        }
    }
    return parts.join(", ");
}

/**
 * Builds LEFT JOIN clauses and SELECT column additions from
 * joinColumns metadata. Used by both buildJsonQuery and buildRowQuery.
 *
 * Returns:
 *   - joinSql: LEFT JOIN clauses
 *   - selectCols: aliased SELECT columns (e.g. j0."name" AS "net_name")
 *   - jsonArgs: json_object args with table-qualified refs (for flat queries)
 *   - outerJsonArgs: json_object args with unqualified alias refs (for subquery wrappers)
 *
 * @param {JoinColumnDef[]} joinDefs - JOIN definitions from entity metadata.
 * @returns {{ joinSql: string, selectCols: string[], jsonArgs: string[], outerJsonArgs: string[] }}
 */
function buildJoinFragments(joinDefs) {
    const joinParts = [];
    const selectCols = [];
    const jsonArgs = [];
    const outerJsonArgs = [];
    for (let i = 0; i < joinDefs.length; i++) {
        const j = joinDefs[i];
        const alias = `j${i}`;
        joinParts.push(
            ` LEFT JOIN "${j.table}" AS ${alias} ON t."${j.localFk}" = ${alias}."id"`
        );
        for (const [srcCol, aliasName] of Object.entries(j.columns)) {
            selectCols.push(`${alias}."${srcCol}" AS "${aliasName}"`);
            jsonArgs.push(`'${aliasName}', ${alias}."${srcCol}"`);
            outerJsonArgs.push(`'${aliasName}', "${aliasName}"`);
        }
    }
    return {
        joinSql: joinParts.join(''),
        selectCols,
        jsonArgs,
        outerJsonArgs
    };
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
 * When the entity has joinColumns, the query uses table aliasing and
 * LEFT JOINs to resolve cross-entity names (e.g. network name on netixlan).
 *
 * @param {EntityMeta} entity - Entity metadata from the registry.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Pagination.
 * @param {number|null} [singleId=null] - If set, fetches a single row by ID.
 * @returns {BuiltQuery} Parameterised SQL that returns {payload: string}.
 */
export function buildJsonQuery(entity, filters, opts, singleId = null) {
    const columns = opts.fields && opts.fields.length > 0 ? opts.fields : getColumns(entity);
    const jsonCols = getJsonColumns(entity);
    const boolCols = getBoolColumns(entity);
    const nullableCols = getNullableColumns(entity);
    const hasJoins = entity.joinColumns && entity.joinColumns.length > 0;
    const tableAlias = hasJoins ? 't' : '';
    const { clauses, params, pagination, orderBy } = buildWherePagination(
        entity, filters, opts, singleId, tableAlias
    );
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

    if (hasJoins) {
        const hasExplicitFields = opts.fields && opts.fields.length > 0;
        const { joinSql, selectCols, outerJsonArgs } = buildJoinFragments(
            /** @type {JoinColumnDef[]} */ (entity.joinColumns)
        );
        const baseCols = columns.map((/** @type {string} */ c) => `t."${c}"`).join(', '); // ap-ok: SQL construction
        const allSelectCols = hasExplicitFields
            ? baseCols
            : baseCols + ', ' + selectCols.join(', ');

        const baseJsonArgs = jsonObjectArgs(columns, jsonCols, boolCols, nullableCols);
        const allJsonArgs = hasExplicitFields
            ? baseJsonArgs
            : baseJsonArgs + ', ' + outerJsonArgs.join(', ');

        const sql =
            `SELECT json_object('data',json_group_array(json_object(${allJsonArgs})),'meta',json_object()) AS payload` +
            ` FROM (SELECT ${allSelectCols}` +
            ` FROM "${entity.table}" AS t${joinSql}${where}` +
            ` ORDER BY ${orderBy}${pagination})`;

        return { sql, params };
    }

    const jsonArgs = jsonObjectArgs(columns, jsonCols, boolCols, nullableCols);
    const sql =
        `SELECT json_object('data',json_group_array(json_object(${jsonArgs})),'meta',json_object()) AS payload` +
        ` FROM (SELECT * FROM "${entity.table}"${where} ORDER BY ${orderBy}${pagination})`;

    return { sql, params };
}

/**
 * Builds a traditional SELECT query returning individual rows.
 * Used when depth>0 (rows need V8-side expansion with relationship sets)
 * and by the sync worker for row-level processing.
 *
 * When the entity has joinColumns, the query uses table aliasing and
 * LEFT JOINs to include cross-entity columns in the result set.
 *
 * @param {EntityMeta} entity - Entity metadata from the registry.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Pagination and depth.
 * @param {number|null} [singleId=null] - If set, fetches a single row by ID.
 * @returns {BuiltQuery} Parameterised SQL and bind values.
 */
export function buildRowQuery(entity, filters, opts, singleId = null) {
    const columns = opts.fields && opts.fields.length > 0 ? opts.fields : getColumns(entity);
    const hasJoins = entity.joinColumns && entity.joinColumns.length > 0;
    const tableAlias = hasJoins ? 't' : '';
    const { clauses, params, pagination, orderBy } = buildWherePagination(
        entity, filters, opts, singleId, tableAlias
    );
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

    if (hasJoins) {
        const hasExplicitFields = opts.fields && opts.fields.length > 0;
        const { joinSql, selectCols } = buildJoinFragments(
            /** @type {JoinColumnDef[]} */ (entity.joinColumns)
        );
        const baseCols = columns.map((/** @type {string} */ c) => `t."${c}"`).join(", "); // ap-ok: SQL construction
        const allCols = hasExplicitFields
            ? baseCols
            : baseCols + ', ' + selectCols.join(', ');

        const sql = `SELECT ${allCols} FROM "${entity.table}" AS t${joinSql}${where} ORDER BY ${orderBy}${pagination}`;
        return { sql, params };
    }

    const cols = columns.map((/** @type {string} */ c) => `"${c}"`).join(", "); // ap-ok: SQL construction
    const sql = `SELECT ${cols} FROM "${entity.table}"${where} ORDER BY ${orderBy}${pagination}`;
    return { sql, params };
}


/**
 * Common WHERE/LIMIT/OFFSET construction shared by all query builders.
 * Validates filters against the entity's allowed fields, applies the since
 * parameter, and builds pagination clauses.
 *
 * When tableAlias is provided (e.g. "t"), all column references in WHERE
 * clauses are prefixed with the alias to avoid ambiguity in JOIN queries.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Pagination.
 * @param {number|null} singleId - Single-row ID or null.
 * @param {string} [tableAlias] - Optional table alias for column qualification.
 * @returns {{ clauses: string[], params: (string|number)[], pagination: string, orderBy: string }}
 */
function buildWherePagination(entity, filters, opts, singleId, tableAlias) {
    const { limit, skip, since, sort } = opts;
    const pfx = tableAlias ? `${tableAlias}.` : '';
    /** @type {string[]} */
    const clauses = [];
    /** @type {(string|number)[]} */
    const params = [];

    // Single-row fetch by ID
    if (singleId !== null) {
        clauses.push(`${pfx}"id" = ?`);
        params.push(singleId);
    }

    // Since filter (unix epoch seconds → ISO datetime comparison)
    if (since > 0) {
        clauses.push(`${pfx}"updated" >= datetime(?, 'unixepoch')`);
        params.push(since);
    }

    // Default to status=ok if no explicit status filter is present
    // (matches upstream PeeringDB behaviour — deleted records excluded by default)
    const hasStatusFilter = filters.some(f => f.field === 'status');
    if (!hasStatusFilter && getFilterType(entity, 'status')) {
        clauses.push(`${pfx}"status" = ?`);
        params.push('ok');
    }

    // Apply user-provided filters, validating against the entity's field definitions
    for (const f of filters) {

        // Cross-entity filter: generate a subquery against the related table.
        // e.g. fac__state=NSW on ixfac → ixfac.fac_id IN (SELECT id FROM fac WHERE state = ?)
        if (f.entity) {
            const ref = resolveCrossEntityFilter(entity, f.entity, f.field);
            if (typeof ref === 'string') continue; // Validation should have caught this

            const opFn = OPS[f.op];
            if (!opFn) continue;

            // Build the inner WHERE clause using the standard OPS functions
            // (they operate on unaliased column names, which is what we want)
            if (f.op === 'in') {
                const parts = f.value.split(','); // ap-ok: SQL IN clause
                const placeholders = parts.map(() => '?').join(', '); // ap-ok: SQL placeholders
                clauses.push(`${pfx}"${ref.fkField}" IN (SELECT "id" FROM "${ref.targetTable}" WHERE "${f.field}" IN (${placeholders}))`);
                params.push(...parts.map(v => coerceValue(/** @type {string} */(v), /** @type {'string'|'number'|'boolean'|'datetime'} */(ref.fieldType)))); // ap-ok: SQL bind params
            } else {
                const inner = opFn(f.field, f.value);
                clauses.push(`${pfx}"${ref.fkField}" IN (SELECT "id" FROM "${ref.targetTable}" WHERE ${inner.clause})`);
                params.push(coerceValue(f.value, /** @type {'string'|'number'|'boolean'|'datetime'} */(ref.fieldType)));
            }
            continue;
        }

        const fieldType = getFilterType(entity, f.field);
        if (!fieldType) continue; // Unknown or non-queryable field — ignore silently

        const opFn = OPS[f.op];
        if (!opFn) continue; // Unknown operator — ignore silently

        // Qualify the column with the table alias for JOIN queries.
        const sqlCol = pfx ? `${pfx}"${f.field}"` : f.field;

        // For 'in' operator, coerce each comma-separated value
        if (f.op === "in") {
            if (pfx) {
                const parts = f.value.split(","); // ap-ok: SQL IN clause
                const placeholders = parts.map(() => "?").join(", "); // ap-ok: SQL placeholders
                clauses.push(`${sqlCol} IN (${placeholders})`);
                params.push(...parts.map(v => coerceValue(/** @type {string} */(v), fieldType))); // ap-ok: SQL bind params
            } else {
                const result = opFn(f.field, f.value);
                result.params = result.params.map(v => coerceValue(/** @type {string} */(v), fieldType)); // ap-ok: SQL bind params
                clauses.push(result.clause);
                params.push(...result.params);
            }
        } else {
            const coerced = coerceValue(f.value, fieldType);
            if (pfx) {
                const opSql = OPS_SQL[f.op];
                if (opSql) {
                    clauses.push(opSql(sqlCol, '?'));
                    params.push(coerced);
                }
            } else {
                const result = opFn(f.field, /** @type {string} */(coerced));
                result.params = [coerced];
                clauses.push(result.clause);
                params.push(...result.params);
            }
        }
    }

    // Pagination: limit <= 0 means no user-specified limit (the router
    // rejects negative limits with 400, so we only see -1 sentinel or 0).
    // depth>0 caps at 250 (matching upstream PeeringDB). depth=0 has no
    // artificial cap — upstream allows full table reads.
    let effectiveLimit = limit > 0 ? limit : 0;
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
        // Skip without limit requires LIMIT -1 in SQLite (unbounded).
        // This is safe because negative limits are rejected at the router.
        pagination += ` LIMIT -1 OFFSET ?`;
        params.push(skip);
    }

    // Sort: parse Django-style sort parameter (e.g. "-updated" → DESC).
    // Only columns that exist on the entity are allowed (prevents injection).
    let orderBy = `${pfx}"id" ASC`;
    if (sort) {
        const desc = sort.startsWith('-');
        const col = desc ? sort.slice(1) : sort;
        const allCols = getColumns(entity);
        if (allCols.includes(col)) {
            orderBy = `${pfx}"${col}" ${desc ? 'DESC' : 'ASC'}`;
        }
    }

    return { clauses, params, pagination, orderBy };
}

/**
 * Builds a COUNT query for the given entity and filters.
 * Returns the total number of matching rows without fetching data.
 * Used when limit=0 is requested to provide entity counts.
 *
 * @param {EntityMeta} entity - Entity metadata.
 * @param {ParsedFilter[]} filters - Parsed query filters.
 * @param {{depth: number, limit: number, skip: number, since: number, sort: string, fields?: string[]}} opts - Only since is used.
 * @returns {BuiltQuery} Parameterised SQL returning { cnt: number }.
 */
export function buildCountQuery(entity, filters, opts) {
    // Count queries never use JOINs or pagination — just filter clauses.
    // The pagination builder may append LIMIT/OFFSET params that a COUNT
    // query doesn't use. Extract only the WHERE-related params.
    const { clauses, params } = buildWherePagination(entity, filters, opts, null);

    const whereParamCount = clauses.reduce(
        (/** @type {number} */ n, /** @type {string} */ c) => n + (c.match(/\?/g) || []).length, 0 // ap-ok: param counting at query build time
    );
    const whereParams = params.slice(0, whereParamCount);

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT COUNT(*) AS cnt FROM "${entity.table}"${where}`;
    return { sql, params: whereParams };
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
    const effectiveLimit = opts.limit > 0 ? opts.limit : (opts.depth > 0 ? 250 : 0);
    if (effectiveLimit === 0) return null;
    if (resultCount < effectiveLimit) return null; // Last page
    return { limit: effectiveLimit, skip: (opts.skip || 0) + effectiveLimit };
}
