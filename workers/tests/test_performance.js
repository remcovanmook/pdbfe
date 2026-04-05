/**
 * @fileoverview PeeringDB API performance comparison suite.
 * Benchmarks the pdbfe mirror against the canonical PeeringDB API
 * across a range of query patterns: single lookups, filtered lists,
 * pagination, depth expansion, large results, counts, field selection,
 * and as_set.
 *
 * Queries marked mirrorOnly skip the upstream fetch to avoid triggering
 * expensive Django operations (nested serializer recursion, full-table
 * COUNT scans) that cause timeouts or OOM on upstream.
 *
 * Environment variables:
 *   PDBFE_URL          - Mirror URL (default: https://pdbfe-api.remco-vanmook.workers.dev)
 *   PEERINGDB_API_KEY  - API key for authenticated PeeringDB requests
 *
 * Usage:
 *   PEERINGDB_API_KEY=... node --test workers/tests/test_performance.js
 */

import { describe, it } from 'node:test';

// ── Configuration ────────────────────────────────────────────────────────────

const PDBFE = (process.env.PDBFE_URL || 'https://pdbfe-api.remco-vanmook.workers.dev').replace(/\/$/, '');
const PEERINGDB = 'https://www.peeringdb.com';
const PDB_API_KEY = process.env.PEERINGDB_API_KEY || '';

/** Well-known entities unlikely to vanish from PeeringDB. */
const WELL_KNOWN = {
    asn_cloudflare: 13335,
    asn_google: 15169,
    asn_netflix: 2906,
    ix_amsix_id: 26,
    ix_decix_id: 31,
    fac_equinix_am5: 58,
};

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * Delay for rate-limit spacing.
 *
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetches JSON from a URL with timeout and optional API key.
 * Retries once on 429 (rate limit).
 *
 * @param {string} url - Full URL to fetch.
 * @param {{method?: string, timeoutMs?: number}} [opts] - Request options.
 * @returns {Promise<{status: number, body: any, headers: Headers, elapsed: number}>}
 */
async function fetchJSON(url, opts = {}) {
    const { method = 'GET', timeoutMs = 30000 } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    /** @type {Record<string, string>} */
    const headers = { 'Accept': 'application/json' };
    if (PDB_API_KEY && url.startsWith(PEERINGDB)) {
        headers['Authorization'] = `Api-Key ${PDB_API_KEY}`;
    }

    try {
        const start = Date.now();
        const res = await fetch(url, { method, signal: controller.signal, headers });
        let body;
        try {
            body = await res.json();
        } catch {
            body = { _error: `Non-JSON response (status ${res.status})` };
        }
        const elapsed = Date.now() - start;

        if (res.status === 429 && url.startsWith(PEERINGDB)) {
            clearTimeout(timer);
            const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
            await delay((retryAfter + 1) * 1000);
            const start2 = Date.now();
            const res2 = await fetch(url, { method, signal: controller.signal, headers });
            const body2 = await res2.json();
            return { status: res2.status, body: body2, headers: res2.headers, elapsed: Date.now() - start2 };
        }
        return { status: res.status, body, headers: res.headers, elapsed };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Fetches from the mirror only.
 *
 * @param {string} path - API path starting with /.
 * @param {{method?: string}} [opts] - Request options.
 * @returns {Promise<{status: number, body: any, headers: Headers, elapsed: number}>}
 */
async function fetchMirror(path, opts) {
    return fetchJSON(`${PDBFE}${path}`, opts);
}

// ==========================================================================
// PERFORMANCE COMPARISON
// ==========================================================================

/**
 * Performance benchmark queries. Each entry defines a label, API path,
 * whether to warm the mirror cache before measuring, and whether to
 * skip the upstream fetch (for queries known to be expensive on Django).
 * @type {{label: string, path: string, warm?: boolean, mirrorOnly?: boolean}[]}
 */
const PERF_QUERIES = [
    // ── Single-record lookups ────────────────────────────────────────────
    { label: 'net by ASN (CF)',        path: `/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=0`, warm: true },
    { label: 'net by ASN (Netflix)',   path: `/api/net?asn=${WELL_KNOWN.asn_netflix}&depth=0`, warm: true },
    { label: 'net detail by ID',       path: '/api/net/1?depth=0', warm: true },
    { label: 'ix detail by ID',        path: `/api/ix/${WELL_KNOWN.ix_amsix_id}?depth=0`, warm: true },
    { label: 'fac detail by ID',       path: `/api/fac/${WELL_KNOWN.fac_equinix_am5}?depth=0`, warm: true },

    // ── Filtered lists ───────────────────────────────────────────────────
    { label: 'netixlan by ix_id',      path: `/api/netixlan?ix_id=${WELL_KNOWN.ix_amsix_id}&depth=0` },
    { label: 'netfac by local_asn',    path: `/api/netfac?local_asn=${WELL_KNOWN.asn_google}&depth=0` },
    { label: 'ix Europe (limit=20)',   path: '/api/ix?region_continent=Europe&limit=20&depth=0' },
    { label: 'net NL (cross-entity)',  path: '/api/net?country=NL&limit=10&depth=0' },
    { label: 'netixlan __in filter',   path: '/api/netixlan?net_id__in=694,1100&depth=0' },

    // ── Pagination ───────────────────────────────────────────────────────
    { label: 'net limit=5 skip=0',     path: '/api/net?limit=5&skip=0&depth=0' },
    { label: 'net limit=5 skip=100',   path: '/api/net?limit=5&skip=100&depth=0' },

    // ── Depth expansion (mirror-only: triggers Django nested serializer) ─
    { label: 'net depth=1 (CF)',       path: `/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=1`, mirrorOnly: true },
    { label: 'net depth=2 (CF)',       path: `/api/net?asn=${WELL_KNOWN.asn_cloudflare}&depth=2`, mirrorOnly: true },

    // ── Large results ────────────────────────────────────────────────────
    { label: 'net limit=50',           path: '/api/net?limit=50&depth=0' },
    { label: 'netixlan limit=50',      path: '/api/netixlan?limit=50&depth=0' },
    { label: 'fac limit=50',           path: '/api/fac?limit=50&depth=0' },

    // ── Count (mirror-only: upstream COUNT(*) causes full InnoDB scan) ───
    { label: 'net count (limit=0)',    path: '/api/net?limit=0&depth=0', mirrorOnly: true },

    // ── Fields filter ────────────────────────────────────────────────────
    { label: 'net fields=id,asn,name', path: '/api/net?limit=10&fields=id,asn,name&depth=0' },

    // ── as_set ───────────────────────────────────────────────────────────
    { label: 'as_set lookup',          path: `/api/as_set/${WELL_KNOWN.asn_cloudflare}` },
];

describe('Performance: mirror vs upstream', { concurrency: 1 }, () => {
    /** @type {{label: string, mirror: number, upstream: number, ratio: number}[]} */
    const results = [];

    for (const q of PERF_QUERIES) {
        it(`${q.label}`, async (t) => {
            // Optional cache warm for mirror
            if (q.warm) {
                await fetchMirror(q.path);
            }

            const mirror = await fetchMirror(q.path);

            // Skip upstream for queries known to cause timeouts or OOM
            // on Django (depth>0 serializer recursion, COUNT full scans)
            if (q.mirrorOnly) {
                t.diagnostic(`mirror=${mirror.elapsed}ms  (upstream skipped: expensive query)`);
                return;
            }

            await delay(300);

            /** @type {{status: number, body: any, headers: Headers, elapsed: number}} */
            let upstream;
            try {
                upstream = await fetchJSON(`${PEERINGDB}${q.path}`);
            } catch {
                t.diagnostic(`${q.label}: upstream fetch failed, skipping comparison`);
                return;
            }

            if (upstream.body?._error) {
                t.diagnostic(`${q.label}: upstream returned non-JSON, skipping comparison`);
                return;
            }

            const ratio = mirror.elapsed / Math.max(upstream.elapsed, 1);
            results.push({
                label: q.label,
                mirror: mirror.elapsed,
                upstream: upstream.elapsed,
                ratio,
            });

            t.diagnostic(
                `mirror=${mirror.elapsed}ms  upstream=${upstream.elapsed}ms  ratio=${ratio.toFixed(2)}x`
            );
        });
    }

    // Print summary table after all queries complete
    it('── summary ──', async (t) => {
        if (results.length === 0) {
            t.diagnostic('No results collected');
            return;
        }

        const pad = (/** @type {string} */ s, /** @type {number} */ n) => s.padEnd(n);
        const rpad = (/** @type {string} */ s, /** @type {number} */ n) => s.padStart(n);

        const header = `${pad('Query', 30)} ${rpad('Mirror', 8)} ${rpad('Upstream', 10)} ${rpad('Ratio', 8)} ${rpad('Winner', 8)}`;
        const sep = '─'.repeat(header.length);

        t.diagnostic('');
        t.diagnostic(sep);
        t.diagnostic(header);
        t.diagnostic(sep);

        let mirrorWins = 0;
        let upstreamWins = 0;
        let totalMirror = 0;
        let totalUpstream = 0;

        for (const r of results) {
            const winner = r.ratio < 1.0 ? 'mirror' : r.ratio > 1.0 ? 'upstream' : 'tie';
            if (r.ratio < 1.0) mirrorWins++;
            if (r.ratio > 1.0) upstreamWins++;
            totalMirror += r.mirror;
            totalUpstream += r.upstream;

            t.diagnostic(
                `${pad(r.label, 30)} ${rpad(r.mirror + 'ms', 8)} ${rpad(r.upstream + 'ms', 10)} ${rpad(r.ratio.toFixed(2) + 'x', 8)} ${rpad(winner, 8)}`
            );
        }

        t.diagnostic(sep);
        const totalRatio = totalMirror / Math.max(totalUpstream, 1);
        t.diagnostic(
            `${pad('TOTAL', 30)} ${rpad(totalMirror + 'ms', 8)} ${rpad(totalUpstream + 'ms', 10)} ${rpad(totalRatio.toFixed(2) + 'x', 8)} ${rpad(totalRatio < 1 ? 'mirror' : 'upstream', 8)}`
        );
        t.diagnostic(`Mirror wins: ${mirrorWins}/${results.length}  Upstream wins: ${upstreamWins}/${results.length}`);
        t.diagnostic('');
    });
});
