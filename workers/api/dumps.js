/**
 * @fileoverview Full-table JSON dumps in R2 (bucket pdbfe-dumps).
 *
 * A default full-table list — depth=0, no filters, fields, sort, skip or
 * limit — is the same bytes for every caller until the table changes. For the
 * large public tables, the async worker writes those bytes to R2 once per
 * change and the API and REST workers serve the object's body as the
 * response: no D1 query, no decoding or encoding, Content-Length from the
 * object. Upstream PeeringDB serves its unfiltered lists from a cache too.
 *
 * Lifecycle:
 *   1. The sync advances _sync_meta.last_modified_at for a changed table and
 *      then publishes a `dump` task (sync/rows.js publishDump).
 *   2. The async worker builds `dumps/<tag>/<last_modified_at>.json` from the
 *      same page queries the API uses (api/json_list.js writeJsonList),
 *      uploads it, and only then sets _sync_meta.dump_key — conditional on
 *      last_modified_at being unchanged, so a dump never claims a newer
 *      version than it holds. Objects of that table older than DUMP_KEEP_MS,
 *      other than the current one, are deleted.
 *   3. The API serves the dump only while dump_key is the key of the current
 *      last_modified_at (both from the 15 s _sync_meta poll, no D1 call);
 *      until the new dump is up it streams from D1 as before.
 *
 * Shared by the sync, async, api and rest workers.
 */

/**
 * Tables with a dump: the large public ones (json_list.js PAGE_ROWS) whose
 * full list is the same for every caller. poc is excluded: its authenticated
 * and anonymous lists differ.
 * @type {ReadonlySet<string>}
 */
export const DUMP_TAGS = new Set(['net', 'netixlan', 'org', 'netfac', 'fac']);

/** How long a superseded dump is kept, for requests still reading it. */
export const DUMP_KEEP_MS = 60 * 60 * 1000;

/**
 * The R2 key of a table's dump at a data version.
 * @param {string} tag - Entity tag.
 * @param {number} version - The table's _sync_meta.last_modified_at.
 * @returns {string}
 */
export function dumpKey(tag, version) {
    return `dumps/${tag}/${version}.json`;
}

/** R2 key prefix of a table's dumps. @param {string} tag @returns {string} */
export function dumpPrefix(tag) {
    return `dumps/${tag}/`;
}

/**
 * Whether a list request is the default full-table list a dump holds:
 * depth=0, no filters, no since, no fields, no sort, no skip, and no limit
 * (or limit=0, which upstream also treats as no limit), on a dumped table.
 *
 * @param {string} tag - Entity tag.
 * @param {ParsedFilter[]} filters - Parsed filters.
 * @param {QueryOpts} opts - Query options.
 * @returns {boolean}
 */
export function isDumpRequest(tag, filters, opts) {
    return DUMP_TAGS.has(tag) && opts.depth === 0 && filters.length === 0
        && opts.since <= 0 && opts.limit <= 0 && opts.skip <= 0
        && !opts.sort && (!opts.fields || opts.fields.length === 0) && !opts.pdbfe;
}

/**
 * The table's current dump, if there is one: dump_key must be the key of the
 * table's current last_modified_at (both from the same _sync_meta poll), and
 * the object must exist. Otherwise null, and the caller streams from D1.
 *
 * @param {R2Bucket|undefined} bucket - pdbfe-dumps (absent in dev/tests: no dumps).
 * @param {string} tag - Entity tag.
 * @param {string} key - _sync_meta.dump_key.
 * @param {number} version - _sync_meta.last_modified_at.
 * @returns {Promise<R2ObjectBody|null>}
 */
export async function currentDump(bucket, tag, key, version) {
    if (!bucket || version <= 0 || key !== dumpKey(tag, version)) return null;
    return bucket.get(key);
}

