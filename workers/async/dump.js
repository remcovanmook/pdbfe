/**
 * @fileoverview `dump` task: rebuilds a table's full-table list dump in R2
 * (lifecycle in api/dumps.js).
 *
 * Reads the table's current last_modified_at, writes the default list —
 * the same bytes the API serves (api/json_list.js writeJsonList) — to
 * `dumps/<tag>/<last_modified_at>.json` as a multipart upload, then sets
 * _sync_meta.dump_key only if last_modified_at is still that version. The
 * table is never held in memory: pages are re-cut into fixed PART_BYTES
 * parts as they arrive. Finally deletes the table's dumps older than
 * DUMP_KEEP_MS other than the current one.
 */

import { ENTITIES } from '../api/entities.js';
import { writeJsonList } from '../api/json_list.js';
import { DUMP_TAGS, DUMP_KEEP_MS, dumpKey, dumpPrefix } from '../api/dumps.js';

/**
 * Multipart part size. R2 requires every part but the last to be the same
 * size and at least 5 MiB.
 */
const PART_BYTES = 8 * 1024 * 1024;

/** The default full-table list: what a dump holds (api/dumps.js isDumpRequest). @type {QueryOpts} */
const DUMP_OPTS = Object.freeze({
    depth: 0, limit: 0, skip: 0, since: 0, sort: '', fields: [], pdbfe: false, authenticated: false,
});

/**
 * Rebuilds `tag`'s dump if it is not current.
 *
 * @param {D1Database} db - PeeringDB mirror.
 * @param {R2Bucket} bucket - pdbfe-dumps.
 * @param {string} tag - Entity tag.
 * @param {number} [now] - Current time in ms (injectable for tests).
 * @returns {Promise<'skipped'|'current'|'written'|'superseded'>} skipped: not a
 *          dumped table; current: dump_key already matches; written: uploaded
 *          and keyed; superseded: uploaded, but the table changed meanwhile, so
 *          not keyed (the next task writes the newer one).
 */
export async function handleDump(db, bucket, tag, now = Date.now()) {
    if (!DUMP_TAGS.has(tag)) return 'skipped';
    const meta = await db.prepare('SELECT last_modified_at, dump_key FROM "_sync_meta" WHERE entity = ?').bind(tag).first();
    if (!meta) return 'skipped';
    const version = Number(meta.last_modified_at);
    const key = dumpKey(tag, version);
    if (meta.dump_key === key) return 'current';

    const upload = await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    /** @type {R2UploadedPart[]} */
    const parts = [];
    let part = new Uint8Array(PART_BYTES);
    let fill = 0;
    try {
        await writeJsonList(db, ENTITIES[tag], DUMP_OPTS, async (chunk) => {
            let pos = 0;
            while (pos < chunk.byteLength) {
                const n = Math.min(PART_BYTES - fill, chunk.byteLength - pos);
                part.set(chunk.subarray(pos, pos + n), fill);
                fill += n;
                pos += n;
                if (fill === PART_BYTES) {
                    parts.push(await upload.uploadPart(parts.length + 1, part)); // NOSONAR: parts are sequential by design
                    part = new Uint8Array(PART_BYTES);
                    fill = 0;
                }
            }
        });
        parts.push(await upload.uploadPart(parts.length + 1, part.subarray(0, fill)));
        await upload.complete(parts);
    } catch (err) {
        await upload.abort().catch(() => {});
        throw err;
    }

    const res = await db.prepare('UPDATE "_sync_meta" SET dump_key = ? WHERE entity = ? AND last_modified_at = ?')
        .bind(key, tag, version).run();
    const keyed = Number(res?.meta?.changes ?? 0) > 0;
    await deleteOldDumps(bucket, tag, keyed ? key : String(/** @type {string} */ (meta.dump_key)), now);
    return keyed ? 'written' : 'superseded';
}

/**
 * Deletes `tag`'s dumps uploaded more than DUMP_KEEP_MS ago, except `keep`
 * (the one _sync_meta points at). Requests reading a superseded dump have
 * that long to finish.
 *
 * @param {R2Bucket} bucket
 * @param {string} tag
 * @param {string} keep - Key never deleted.
 * @param {number} now - Current time in ms.
 * @returns {Promise<string[]>} Keys deleted.
 */
export async function deleteOldDumps(bucket, tag, keep, now) {
    /** @type {string[]} */
    const old = [];
    let cursor;
    do {
        const page = await bucket.list({ prefix: dumpPrefix(tag), cursor }); // NOSONAR: listing pages are sequential
        for (const o of page.objects) {
            if (o.key !== keep && now - o.uploaded.getTime() > DUMP_KEEP_MS) old.push(o.key);
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (old.length > 0) await bucket.delete(old);
    return old;
}
