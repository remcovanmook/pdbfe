/**
 * @fileoverview In-memory R2 bucket for tests: get / head / put / delete /
 * list and multipart uploads. complete() enforces R2's multipart rule —
 * every part but the last the same size and at least 5 MiB — so a writer that
 * cuts parts wrongly fails here as it would in production.
 */

const MIN_PART = 5 * 1024 * 1024;

/**
 * @typedef {{ bytes: Uint8Array, uploaded: Date, contentType: string }} MemObject
 */

/**
 * @param {{ now?: () => number }} [opts] - Clock for `uploaded` (default Date.now).
 * @returns {{ bucket: R2Bucket, objects: Map<string, MemObject>, uploads: { key: string, partSizes: number[] }[] }}
 */
export function createMemoryR2({ now = Date.now } = {}) {
    /** @type {Map<string, MemObject>} */
    const objects = new Map();
    /** @type {{ key: string, partSizes: number[] }[]} */
    const uploads = [];

    /** @param {any} v @returns {Uint8Array} */
    const toBytes = (v) => {
        if (typeof v === 'string') return new TextEncoder().encode(v);
        if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
        return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    };
    /** @param {string} key @param {MemObject} o */
    const meta = (key, o) => ({ key, size: o.bytes.byteLength, etag: 'e', httpEtag: '"e"', uploaded: o.uploaded, httpMetadata: { contentType: o.contentType } });

    /** @type {any} */
    const bucket = {
        async head(/** @type {string} */ key) {
            const o = objects.get(key);
            return o ? meta(key, o) : null;
        },
        async get(/** @type {string} */ key) {
            const o = objects.get(key);
            if (!o) return null;
            return {
                ...meta(key, o),
                body: new Blob([o.bytes]).stream(),
                arrayBuffer: async () => o.bytes.slice().buffer,
                text: async () => new TextDecoder().decode(o.bytes),
            };
        },
        async put(/** @type {string} */ key, /** @type {any} */ value, /** @type {any} */ opts) {
            const o = { bytes: toBytes(value), uploaded: new Date(now()), contentType: opts?.httpMetadata?.contentType ?? '' };
            objects.set(key, o);
            return meta(key, o);
        },
        async delete(/** @type {string|string[]} */ keys) {
            for (const k of [keys].flat()) objects.delete(k);
        },
        async list(/** @type {any} */ { prefix = '' } = {}) {
            const out = [];
            for (const [key, o] of objects) if (key.startsWith(prefix)) out.push(meta(key, o));
            return { objects: out, truncated: false, delimitedPrefixes: [] };
        },
        async createMultipartUpload(/** @type {string} */ key, /** @type {any} */ opts) {
            /** @type {Map<number, Uint8Array>} */
            const parts = new Map();
            let aborted = false;
            return {
                key,
                uploadId: `u-${uploads.length}`,
                async uploadPart(/** @type {number} */ n, /** @type {any} */ value) {
                    if (aborted) throw new Error('upload aborted');
                    parts.set(n, toBytes(value));
                    return { partNumber: n, etag: `p${n}` };
                },
                async abort() { aborted = true; },
                async complete(/** @type {{partNumber: number}[]} */ list) {
                    const sizes = list.map((p) => /** @type {Uint8Array} */ (parts.get(p.partNumber)).byteLength);
                    for (let i = 0; i < sizes.length - 1; i++) {
                        if (sizes[i] < MIN_PART || sizes[i] !== sizes[0]) {
                            throw new Error(`R2 multipart: part ${i + 1} is ${sizes[i]} bytes; all but the last must be equal and >= 5 MiB`);
                        }
                    }
                    const total = sizes.reduce((a, b) => a + b, 0);
                    const bytes = new Uint8Array(total);
                    let pos = 0;
                    for (const p of list) {
                        const b = /** @type {Uint8Array} */ (parts.get(p.partNumber));
                        bytes.set(b, pos);
                        pos += b.byteLength;
                    }
                    const o = { bytes, uploaded: new Date(now()), contentType: opts?.httpMetadata?.contentType ?? '' };
                    objects.set(key, o);
                    uploads.push({ key, partSizes: sizes });
                    return meta(key, o);
                },
            };
        },
    };
    return { bucket, objects, uploads };
}
