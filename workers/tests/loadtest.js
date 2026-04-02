/**
 * @fileoverview Load test suite for the pdbfe-api production worker.
 *
 * Tests sequential and parallel request performance across multiple
 * query patterns: single entity, filtered lists, depth expansion,
 * JOINs, COUNT, and large result sets. Runs each scenario multiple
 * times to measure cold vs warm cache behaviour.
 *
 * Reports both client-side round-trip latency and server-side isolate
 * processing time from the X-Timer, X-Cache, X-Isolate-ID, and
 * X-Served-By response headers set by the API worker.
 *
 * Usage:
 *   node workers/tests/loadtest.js [--base-url URL] [--concurrency N] [--rounds N]
 *
 * Defaults:
 *   --base-url   https://pdbfe-api.remco-vanmook.workers.dev
 *   --concurrency 10
 *   --rounds      3
 */

const BASE_URL = process.argv.includes('--base-url')
    ? process.argv[process.argv.indexOf('--base-url') + 1]
    : 'https://pdbfe-api.remco-vanmook.workers.dev';

const CONCURRENCY = process.argv.includes('--concurrency')
    ? parseInt(process.argv[process.argv.indexOf('--concurrency') + 1], 10)
    : 10;

const ROUNDS = process.argv.includes('--rounds')
    ? parseInt(process.argv[process.argv.indexOf('--rounds') + 1], 10)
    : 3;

// ── Scenario definitions ─────────────────────────────────────────

/**
 * @typedef {Object} Scenario
 * @property {string} name - Human-readable label.
 * @property {string} path - API path with query string.
 * @property {function(any): string|null} [validate] - Returns error string or null.
 */

/** @type {Scenario[]} */
const SCENARIOS = [
    // ── Single entity lookups ────────────────────────────────────
    {
        name: 'Single net (depth=0)',
        path: '/api/net/694',
        validate: (d) => d.data?.[0]?.asn === 8075 ? null : 'expected Microsoft AS8075'
    },
    {
        name: 'Single ix (depth=0)',
        path: '/api/ix/26',
        validate: (d) => d.data?.[0]?.name?.includes('AMS-IX') ? null : 'expected AMS-IX'
    },
    {
        name: 'Single fac (depth=0)',
        path: '/api/fac/18',
        validate: (d) => d.data?.[0]?.name?.includes('NIKHEF') ? null : 'expected NIKHEF'
    },

    // ── Depth expansion ──────────────────────────────────────────
    {
        name: 'Net depth=1 (child IDs)',
        path: '/api/net/694?depth=1',
        validate: (d) => Array.isArray(d.data?.[0]?.netixlan_set) ? null : 'missing netixlan_set'
    },
    {
        name: 'Net depth=2 (full children)',
        path: '/api/net/694?depth=2',
        validate: (d) => {
            const first = d.data?.[0]?.netixlan_set?.[0];
            return (first && typeof first === 'object' && first.id) ? null : 'depth=2 children not expanded';
        }
    },
    {
        name: 'Fac depth=2 (JOINed children)',
        path: '/api/fac/18?depth=2',
        validate: (d) => {
            const nf = d.data?.[0]?.netfac_set?.[0];
            return nf?.net_name ? null : 'missing net_name in netfac_set';
        }
    },

    // ── Filtered lists ───────────────────────────────────────────
    {
        name: 'Nets by country (NL)',
        path: '/api/net?country=NL&limit=50',
        validate: (d) => d.data?.length > 0 ? null : 'no NL networks returned'
    },
    {
        name: 'Nets by ASN (exact)',
        path: '/api/net?asn=13335',
        validate: (d) => d.data?.[0]?.name?.includes('Cloudflare') ? null : 'expected Cloudflare'
    },
    {
        name: 'Nets name contains "google"',
        path: '/api/net?name__contains=google&limit=20',
        validate: (d) => d.data?.length > 0 ? null : 'no google nets returned'
    },
    {
        name: 'Facilities in Amsterdam',
        path: '/api/fac?city__contains=amsterdam&limit=50',
        validate: (d) => d.data?.length > 5 ? null : 'expected >5 Amsterdam facilities'
    },

    // ── JOIN queries ─────────────────────────────────────────────
    {
        name: 'netixlan with JOIN (AMS-IX peers)',
        path: '/api/netixlan?ix_id=26&limit=50',
        validate: (d) => d.data?.[0]?.net_name ? null : 'missing net_name JOIN field'
    },
    {
        name: 'netfac with JOIN (NIKHEF networks)',
        path: '/api/netfac?fac_id=18&limit=50',
        validate: (d) => d.data?.length > 0 ? null : 'no netfac rows'
    },

    // ── COUNT queries ────────────────────────────────────────────
    {
        name: 'COUNT net (global)',
        path: '/api/net?limit=0',
        validate: (d) => d.meta?.count > 30000 ? null : `count too low: ${d.meta?.count}`
    },
    {
        name: 'COUNT ix (global)',
        path: '/api/ix?limit=0',
        validate: (d) => d.meta?.count > 1000 ? null : `count too low: ${d.meta?.count}`
    },
    {
        name: 'COUNT fac (global)',
        path: '/api/fac?limit=0',
        validate: (d) => d.meta?.count > 5000 ? null : `count too low: ${d.meta?.count}`
    },

    // ── Large result sets ────────────────────────────────────────
    {
        name: 'Large: 250 networks',
        path: '/api/net?limit=250',
        validate: (d) => d.data?.length === 250 ? null : `expected 250 rows, got ${d.data?.length}`
    },
    {
        name: 'Large: netixlan full (AMS-IX)',
        path: '/api/netixlan?ix_id=26',
        validate: (d) => d.data?.length > 800 ? null : `expected >800 rows, got ${d.data?.length}`
    },
    {
        name: 'Large: 250 facilities',
        path: '/api/fac?limit=250',
        validate: (d) => d.data?.length === 250 ? null : `expected 250 rows, got ${d.data?.length}`
    },

    // ── Negative cache (404) ──────────────────────────────────────
    {
        name: 'Non-existent net (404)',
        path: '/api/net/999999',
        validate: (d) => d.error?.includes('not found') ? null : `expected 404 error, got: ${JSON.stringify(d)}`,
        expectStatus: 404
    },
    {
        name: 'Non-existent ix (404)',
        path: '/api/ix/999999',
        validate: (d) => d.error?.includes('not found') ? null : `expected 404 error, got: ${JSON.stringify(d)}`,
        expectStatus: 404
    },
    {
        name: 'Non-existent as_set (404)',
        path: '/api/as_set/999999',
        validate: (d) => d.error?.includes('not found') || d.error?.includes('No network') ? null : `expected 404 error`,
        expectStatus: 404
    },
];

// ── Result type ──────────────────────────────────────────────────

/**
 * Data returned from timedFetch combining client-side measurement
 * with server-side metrics from response headers.
 *
 * @typedef {Object} FetchResult
 * @property {number} status - HTTP status code (0 on network error).
 * @property {number} ms - Client-side round-trip time in ms.
 * @property {number} bytes - Response body byte count.
 * @property {any} data - Parsed JSON body (null on parse failure).
 * @property {string|null} error - Error message if the request failed.
 * @property {ServerMetrics} server - Isolate-side metrics from headers.
 */

/**
 * Server-side metrics extracted from the API worker's response headers.
 *
 * @typedef {Object} ServerMetrics
 * @property {number} isolateMs - Worker isolate processing time (VE value from X-Timer).
 * @property {string} cache - L1 cache status ("HIT" or "MISS").
 * @property {number} cacheHits - Number of times this key has been served from cache.
 * @property {string} isolateId - 8-char hex isolate identifier.
 * @property {string} colo - Cloudflare colo code (e.g. "AMS", "FRA").
 */

// ── Runner ───────────────────────────────────────────────────────

/**
 * Parses server-side metrics from the API worker response headers.
 * Reads X-Timer (format: S{epoch},VS0,VE{ms}), X-Cache, X-Cache-Hits,
 * X-Isolate-ID, and X-Served-By (format: cache-{colo}-pdbfe-api).
 *
 * @param {Headers} headers - Response headers.
 * @returns {ServerMetrics}
 */
function parseServerMetrics(headers) {
    // X-Timer: S1775046123456,VS0,VE12
    const timer = headers.get('X-Timer') || '';
    const veMatch = timer.match(/VE(\d+)/);
    const isolateMs = veMatch ? parseInt(veMatch[1], 10) : -1;

    const cache = headers.get('X-Cache') || '–';
    const cacheHits = parseInt(headers.get('X-Cache-Hits') || '0', 10);
    const isolateId = headers.get('X-Isolate-ID') || '–';

    // X-Served-By: cache-AMS-pdbfe-api
    const servedBy = headers.get('X-Served-By') || '';
    const coloMatch = servedBy.match(/cache-([A-Z]+)/);
    const colo = coloMatch ? coloMatch[1] : '–';

    return { isolateMs, cache, cacheHits, isolateId, colo };
}

/**
 * Executes a single HTTP request and returns timing + status info
 * along with server-side metrics from the response headers.
 *
 * @param {string} url - Full URL to fetch.
 * @returns {Promise<FetchResult>}
 */
async function timedFetch(url) {
    const t0 = performance.now();
    try {
        const res = await fetch(url);
        const text = await res.text();
        const ms = performance.now() - t0;
        let data = null;
        try { data = JSON.parse(text); } catch { /* non-JSON */ }
        const server = parseServerMetrics(res.headers);
        return { status: res.status, ms, bytes: text.length, data, error: null, server };
    } catch (err) {
        const ms = performance.now() - t0;
        const server = { isolateMs: -1, cache: '–', cacheHits: 0, isolateId: '–', colo: '–' };
        return { status: 0, ms, bytes: 0, data: null, error: err.message, server };
    }
}

/**
 * Runs a batch of URLs in parallel with bounded concurrency.
 *
 * @param {string[]} urls - URLs to fetch.
 * @param {number} concurrency - Max parallel requests.
 * @returns {Promise<FetchResult[]>}
 */
async function parallelFetch(urls, concurrency) {
    /** @type {FetchResult[]} */
    const results = [];
    const queue = [...urls];
    const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
        while (queue.length > 0) {
            const url = queue.shift();
            results.push(await timedFetch(url));
        }
    });
    await Promise.all(workers);
    return results;
}

/**
 * Formats a duration in milliseconds for display.
 *
 * @param {number} ms - Duration in milliseconds.
 * @returns {string} Formatted string like "123ms" or "1.2s".
 */
function fmtMs(ms) {
    if (ms < 0) return '–';
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Formats byte count for display.
 *
 * @param {number} bytes - Byte count.
 * @returns {string} Formatted string like "12.3 KB".
 */
function fmtBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Computes percentile from a sorted array.
 *
 * @param {number[]} sorted - Sorted numeric array.
 * @param {number} p - Percentile (0-1).
 * @returns {number}
 */
function percentile(sorted, p) {
    return sorted[Math.floor(sorted.length * p)] ?? 0;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
    console.log(`\n${'═'.repeat(78)}`);
    console.log(`  pdbfe-api load test`);
    console.log(`  Target:      ${BASE_URL}`);
    console.log(`  Concurrency: ${CONCURRENCY}`);
    console.log(`  Rounds:      ${ROUNDS}`);
    console.log(`${'═'.repeat(78)}\n`);

    // ── Probe: health + isolate info ─────────────────────────────
    console.log('── Probe: health check ──\n');
    const healthResult = await timedFetch(`${BASE_URL}/health`);
    if (healthResult.data) {
        const h = healthResult.data;
        console.log(`  Status:      ${h.status}`);
        console.log(`  D1:          ${h.d1}`);
        console.log(`  Isolate:     ${h.isolate?.id} (up ${h.isolate?.uptimeFormatted})`);
        console.log(`  Colo:        ${healthResult.server.colo}`);
        const c = h.cache || {};
        const totalEntries = Object.values(c).reduce((/** @type {number} */ sum, /** @type {any} */ e) => sum + (e?.entries ?? 0), 0);
        const totalBytes = Object.values(c).reduce((/** @type {number} */ sum, /** @type {any} */ e) => sum + (e?.sizeBytes ?? 0), 0);
        console.log(`  Cache:       ${totalEntries} entries, ${fmtBytes(totalBytes)}`);
    } else {
        console.log(`  Health check failed: HTTP ${healthResult.status}`);
    }

    // ── Phase 1: Sequential scenarios ────────────────────────────
    console.log('\n── Phase 1: Sequential requests (cold → warm cache) ──\n');

    const COL = {
        name: 38, round: 6, status: 5, rtt: 8, ve: 8, cache: 5, size: 10, valid: 6
    };

    console.log(
        'Scenario'.padEnd(COL.name) +
        'Rnd'.padEnd(COL.round) +
        'HTTP'.padEnd(COL.status) +
        'RTT'.padEnd(COL.rtt) +
        'VE'.padEnd(COL.ve) +
        'Cache'.padEnd(COL.cache) +
        'Size'.padEnd(COL.size) +
        'Valid'
    );
    console.log('─'.repeat(90));

    /**
     * Per-scenario timing data for the summary table.
     * @type {Map<string, {rtts: number[], ves: number[], caches: string[]}>}
     */
    const timings = new Map();

    /** @type {Set<string>} */
    const isolatesSeen = new Set();

    for (const scenario of SCENARIOS) {
        const url = `${BASE_URL}${scenario.path}`;
        timings.set(scenario.name, { rtts: [], ves: [], caches: [] });

        for (let round = 1; round <= ROUNDS; round++) {
            const r = await timedFetch(url);
            const t = timings.get(scenario.name);
            t.rtts.push(r.ms);
            t.ves.push(r.server.isolateMs);
            t.caches.push(r.server.cache);
            if (r.server.isolateId !== '–') isolatesSeen.add(r.server.isolateId);

            let valid = '–';
            if (scenario.validate && r.data) {
                const err = scenario.validate(r.data);
                valid = err ? `✘ ${err}` : '✔';
            }
            // Also validate expected HTTP status (defaults to 200)
            const expectedStatus = scenario.expectStatus || 200;
            if (r.status !== expectedStatus) {
                valid = `\u2718 HTTP ${r.status} (expected ${expectedStatus})`;
            }

            console.log(
                scenario.name.padEnd(COL.name) +
                `R${round}`.padEnd(COL.round) +
                String(r.status).padEnd(COL.status) +
                fmtMs(r.ms).padEnd(COL.rtt) +
                fmtMs(r.server.isolateMs).padEnd(COL.ve) +
                r.server.cache.padEnd(COL.cache) +
                fmtBytes(r.bytes).padEnd(COL.size) +
                valid
            );
        }
    }

    // ── Phase 1 summary ──────────────────────────────────────────
    console.log(`\n── Phase 1 Summary ──\n`);
    console.log(`  Isolates observed: ${isolatesSeen.size} (${[...isolatesSeen].join(', ')})\n`);
    console.log(
        'Scenario'.padEnd(38) +
        'RTT R1'.padEnd(9) +
        'RTT avg'.padEnd(9) +
        'VE R1'.padEnd(9) +
        'VE avg'.padEnd(9) +
        'Overhead'.padEnd(10) +
        'Cache'
    );
    console.log('─'.repeat(93));

    for (const [name, t] of timings) {
        const rttAvg = t.rtts.reduce((a, b) => a + b, 0) / t.rtts.length;
        const veAvg = t.ves.filter(v => v >= 0).reduce((a, b) => a + b, 0) / t.ves.filter(v => v >= 0).length || 0;
        const overhead = rttAvg - veAvg;
        const cachePattern = t.caches.join('→').replace(/MISS/g, 'M').replace(/HIT/g, 'H');

        console.log(
            name.padEnd(38) +
            fmtMs(t.rtts[0]).padEnd(9) +
            fmtMs(rttAvg).padEnd(9) +
            fmtMs(t.ves[0]).padEnd(9) +
            fmtMs(veAvg).padEnd(9) +
            fmtMs(overhead).padEnd(10) +
            cachePattern
        );
    }

    // ── Phase 2: Parallel burst ──────────────────────────────────
    console.log(`\n── Phase 2: Parallel burst (${CONCURRENCY} concurrent) ──\n`);

    const burstScenarios = [
        {
            name: 'Mixed entity lookups',
            urls: [
                '/api/net/694', '/api/ix/26', '/api/fac/18', '/api/org/2634',
                '/api/net/20', '/api/ix/1', '/api/fac/1', '/api/org/14',
                '/api/net/1', '/api/ix/2', '/api/fac/2', '/api/org/17',
                '/api/net/2', '/api/ix/3', '/api/fac/4', '/api/org/18',
                '/api/net/4775', '/api/ix/42', '/api/fac/5', '/api/org/100',
            ]
        },
        {
            name: 'Parallel depth=2 expansions',
            urls: [
                '/api/net/694?depth=2', '/api/net/20?depth=2',
                '/api/ix/26?depth=2', '/api/ix/1?depth=2',
                '/api/fac/18?depth=2', '/api/fac/1?depth=2',
                '/api/net/4775?depth=2', '/api/net/1?depth=2',
                '/api/ix/42?depth=2', '/api/fac/4?depth=2',
            ]
        },
        {
            name: 'Parallel filtered lists',
            urls: [
                '/api/net?country=NL&limit=100', '/api/net?country=US&limit=100',
                '/api/net?country=DE&limit=100', '/api/net?country=GB&limit=100',
                '/api/fac?country=NL&limit=100', '/api/fac?country=US&limit=100',
                '/api/ix?country=US&limit=100', '/api/ix?country=DE&limit=100',
                '/api/net?name__contains=cloud&limit=50',
                '/api/net?name__contains=telecom&limit=50',
            ]
        },
        {
            name: 'Parallel large results',
            urls: [
                '/api/net?limit=250', '/api/fac?limit=250',
                '/api/ix?limit=250', '/api/netixlan?ix_id=26',
                '/api/net?limit=250&skip=250', '/api/fac?limit=250&skip=250',
                '/api/netfac?fac_id=18', '/api/net?country=US&limit=250',
                '/api/netixlan?ix_id=171', '/api/netixlan?ix_id=359',
            ]
        },
        {
            name: 'Parallel COUNTs',
            urls: [
                '/api/net?limit=0', '/api/ix?limit=0',
                '/api/fac?limit=0', '/api/org?limit=0',
                '/api/netixlan?limit=0', '/api/netfac?limit=0',
                '/api/ixfac?limit=0', '/api/ixlan?limit=0',
                '/api/poc?limit=0', '/api/net?limit=0',
            ]
        }
    ];

    // Add negative-cache burst for 404 testing
    burstScenarios.push({
        name: 'Parallel 404s (negative cache)',
        urls: [
            '/api/net/900001', '/api/net/900002', '/api/net/900003',
            '/api/ix/900001', '/api/ix/900002',
            '/api/fac/900001', '/api/fac/900002',
            '/api/as_set/900001', '/api/as_set/900002', '/api/as_set/900003',
        ],
        expect404: true
    });

    console.log(
        'Burst'.padEnd(33) +
        'Reqs'.padEnd(6) +
        'Wall'.padEnd(9) +
        'RTT⌀'.padEnd(8) +
        'VE⌀'.padEnd(8) +
        'VE P50'.padEnd(8) +
        'VE P95'.padEnd(8) +
        'VE max'.padEnd(8) +
        'OH⌀'.padEnd(8) +
        'Hits'.padEnd(6) +
        'Errs'
    );
    console.log('─'.repeat(105));

    for (const burst of burstScenarios) {
        const urls = burst.urls.map(p => `${BASE_URL}${p}`);
        const t0 = performance.now();
        const results = await parallelFetch(urls, CONCURRENCY);
        const wallMs = performance.now() - t0;

        const rtts = results.map(r => r.ms).sort((a, b) => a - b);
        const ves = results.map(r => r.server.isolateMs).filter(v => v >= 0).sort((a, b) => a - b);

        const rttAvg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
        const veAvg = ves.length > 0 ? ves.reduce((a, b) => a + b, 0) / ves.length : -1;
        const veP50 = ves.length > 0 ? percentile(ves, 0.50) : -1;
        const veP95 = ves.length > 0 ? percentile(ves, 0.95) : -1;
        const veMax = ves.length > 0 ? ves[ves.length - 1] : -1;
        const overhead = veAvg >= 0 ? rttAvg - veAvg : -1;
        const hits = results.filter(r => r.server.cache === 'HIT').length;
        const expectedStatus = burst.expect404 ? 404 : 200;
        const errors = results.filter(r => r.status !== expectedStatus).length;

        console.log(
            burst.name.padEnd(33) +
            String(urls.length).padEnd(6) +
            fmtMs(wallMs).padEnd(9) +
            fmtMs(rttAvg).padEnd(8) +
            fmtMs(veAvg).padEnd(8) +
            fmtMs(veP50).padEnd(8) +
            fmtMs(veP95).padEnd(8) +
            fmtMs(veMax).padEnd(8) +
            fmtMs(overhead).padEnd(8) +
            String(hits).padEnd(6) +
            String(errors)
        );

        // Log detail for each failed request
        for (let i = 0; i < results.length; i++) {
            if (results[i].status !== expectedStatus) {
                const path = burst.urls[i] || urls[i];
                const errBody = results[i].data?.error || results[i].error || '(no body)';
                console.log(`  ✘ ${path}  → HTTP ${results[i].status}  ${errBody}`);
            }
        }
    }

    // ── Phase 3: Sustained throughput ────────────────────────────
    console.log(`\n── Phase 3: Sustained throughput (30s, ${CONCURRENCY} concurrent) ──\n`);

    const sustainedUrl = `${BASE_URL}/api/net?limit=50`;
    const duration = 30_000;
    const start = performance.now();
    let completed = 0;
    let errors = 0;
    let totalRtt = 0;
    let totalVe = 0;
    let veCount = 0;
    let cacheHits = 0;

    /** @type {number[]} */
    const rttAll = [];
    /** @type {number[]} */
    const veAll = [];
    /** @type {Set<string>} */
    const sustainedIsolates = new Set();

    const sustainedWorkers = Array.from({ length: CONCURRENCY }, async () => {
        while (performance.now() - start < duration) {
            const r = await timedFetch(sustainedUrl);
            completed++;
            totalRtt += r.ms;
            rttAll.push(r.ms);
            if (r.server.isolateMs >= 0) {
                totalVe += r.server.isolateMs;
                veAll.push(r.server.isolateMs);
                veCount++;
            }
            if (r.server.cache === 'HIT') cacheHits++;
            if (r.server.isolateId !== '–') sustainedIsolates.add(r.server.isolateId);
            if (r.status !== 200) errors++;
        }
    });

    await Promise.all(sustainedWorkers);
    const elapsed = performance.now() - start;

    rttAll.sort((a, b) => a - b);
    veAll.sort((a, b) => a - b);

    console.log(`  Duration:      ${fmtMs(elapsed)}`);
    console.log(`  Requests:      ${completed}`);
    console.log(`  Throughput:    ${(completed / (elapsed / 1000)).toFixed(1)} req/s`);
    console.log(`  Errors:        ${errors}`);
    console.log(`  Isolates:      ${sustainedIsolates.size} (${[...sustainedIsolates].join(', ')})`);
    console.log(`  Cache HIT:     ${cacheHits}/${completed} (${(cacheHits / completed * 100).toFixed(1)}%)`);
    console.log('');
    console.log('                 RTT (client)    VE (isolate)');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  Avg:           ${fmtMs(totalRtt / completed).padEnd(16)}${fmtMs(veCount > 0 ? totalVe / veCount : -1)}`);
    console.log(`  P50:           ${fmtMs(percentile(rttAll, 0.50)).padEnd(16)}${fmtMs(veAll.length > 0 ? percentile(veAll, 0.50) : -1)}`);
    console.log(`  P95:           ${fmtMs(percentile(rttAll, 0.95)).padEnd(16)}${fmtMs(veAll.length > 0 ? percentile(veAll, 0.95) : -1)}`);
    console.log(`  P99:           ${fmtMs(percentile(rttAll, 0.99)).padEnd(16)}${fmtMs(veAll.length > 0 ? percentile(veAll, 0.99) : -1)}`);
    console.log(`  Max:           ${fmtMs(rttAll[rttAll.length - 1]).padEnd(16)}${fmtMs(veAll.length > 0 ? veAll[veAll.length - 1] : -1)}`);
    console.log(`  Overhead avg:  ${fmtMs(veCount > 0 ? (totalRtt / completed) - (totalVe / veCount) : -1)}`);

    console.log(`\n${'═'.repeat(78)}`);
    console.log(`  Load test complete`);
    console.log(`${'═'.repeat(78)}\n`);
}

main().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Load test failed:', err);
    process.exit(1);
});
