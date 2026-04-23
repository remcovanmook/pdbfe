/**
 * @fileoverview Keyword search handler for the search worker.
 *
 * Executes a D1 LIKE query across the primary display fields of a single
 * entity type and returns results in the search envelope format.
 *
 * This is the fallback path when semantic search is disabled or when the
 * caller explicitly requests mode=keyword. Results are ordered by name
 * and carry score=1.0 (uniform relevance — no ranking).
 *
 * Anti-pattern compliance:
 *   §3  — no .map()/.filter(); rows accumulated with a for loop.
 *   §4  — single encoder.encode(JSON.stringify(...)) at exit; no per-row JSON.
 *   §9  — this function is called inside a withSearchSWR queryFn closure;
 *          it does not manage the cache lifecycle itself.
 */

import { encoder } from '../http.js';
import { ENTITIES, SEARCH_FIELDS, getPrimaryField, getExtraFields } from '../entities.js';

/**
 * Executes a keyword search against D1 for a single entity type.
 *
 * Builds a WHERE clause with LIKE predicates across the entity's primary
 * display fields (up to MAX_LIKE_FIELDS). Parameters are bound via D1's
 * prepared statement API to prevent injection. The query string is wrapped
 * in `%` wildcards so it matches anywhere within the field value.
 *
 * Returns the result as a serialised Uint8Array ready to cache and serve.
 * Returns null if D1 returns no rows (triggers negative caching upstream).
 *
 * @param {D1Database} db - D1 database session (withSession already applied).
 * @param {string} entityTag - Entity type to search (e.g. "net").
 * @param {string} q - Search query string.
 * @param {number} limit - Maximum number of results to return.
 * @param {number} skip - Pagination offset.
 * @returns {Promise<Uint8Array|null>} Serialised search envelope, or null if empty.
 */
export async function handleKeyword(db, entityTag, q, limit, skip) {
    const fields = SEARCH_FIELDS[entityTag];
    const table = ENTITIES[entityTag].table;
    const primaryField = getPrimaryField(entityTag);

    // Build WHERE clause: OR across each searchable field using LIKE.
    // §2: string concatenation, no regex. Field count already capped by entities.js.
    const fieldCount = fields.length;
    let where = '';
    for (let i = 0; i < fieldCount; i++) {
        if (i > 0) where += ' OR ';
        where += fields[i] + ' LIKE ?';
    }

    // §3: build bind array in one shot instead of multiple push calls.
    const pattern = '%' + q + '%';
    /** @type {(string|number)[]} */
    const binds = /** @type {(string|number)[]} */ (new Array(fieldCount).fill(pattern));
    binds.push(limit, skip);

    const extraFields = getExtraFields(entityTag);
    const extraSelect = extraFields.length > 0 ? ', ' + extraFields.join(', ') : '';

    const sql =
        `SELECT id, ${primaryField} AS name${extraSelect}, status FROM ${table}` +
        ` WHERE (${where}) AND status != 'deleted'` +
        ` ORDER BY name ASC LIMIT ? OFFSET ?`;

    const result = await db.prepare(sql).bind(...binds).all();

    if (!result.success || result.results.length === 0) return null;

    // §3: for loop instead of .map() to accumulate result rows.
    const rows = result.results;
    /** @type {{id: number, name: string, entity_type: string, score: number, [key: string]: any}[]} */
    const data = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        /** @type {{id: number, name: string, entity_type: string, score: number, [key: string]: any}} */
        const row = {
            id: /** @type {number} */ (r.id),
            name: /** @type {string} */ (r.name) || '',
            entity_type: entityTag,
            score: 1,
        };
        // Copy extra display fields (asn, city, country, etc.) if present.
        for (let j = 0; j < extraFields.length; j++) {
            const col = extraFields[j];
            if (r[col] != null) row[col] = r[col];
        }
        data.push(row);
    }

    // §4: single serialisation at exit.
    return encoder.encode(JSON.stringify({
        data,
        meta: { count: data.length, mode: 'keyword' },
    }));
}
