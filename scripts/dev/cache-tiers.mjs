#!/usr/bin/env node
/**
 * Cache-tier report from the pdbfe-api Analytics Engine dataset
 * (pdbfe_api_cache, written by recordCacheTier in workers/api/index.js).
 *
 * One data point per entity request that reached the worker — edge hits never
 * do; use Cloudflare's cache analytics for those. Answers "does the per-PoP L2
 * layer earn its lookup cost?" by tier / scope / since-ness.
 *
 * Usage:
 *   . ./.env && node scripts/dev/cache-tiers.mjs            # last 24h
 *   . ./.env && node scripts/dev/cache-tiers.mjs --hours 2
 *   . ./.env && node scripts/dev/cache-tiers.mjs --by-entity
 *
 * Needs CLOUDFLARE_API_TOKEN with Account Analytics read; the account id is
 * taken from CLOUDFLARE_ACCOUNT_ID or wrangler's .wrangler/cache.
 *
 * AE SQL quirks handled here: IF() needs both branches of the same type
 * (use 0.0, not 0 or NULL), there is no GREATEST() (averages are computed
 * client-side from sums and counts), and every selected column must be
 * grouped or aggregated.
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

const { values: opt } = parseArgs({
    options: {
        hours: { type: 'string', default: '24' },
        'by-entity': { type: 'boolean', default: false },
    },
});

const token = process.env.CLOUDFLARE_API_TOKEN;
let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) {
    try {
        account = JSON.parse(readFileSync(new URL('../../.wrangler/cache/wrangler-account.json', import.meta.url), 'utf8')).account.id;
    } catch { /* fall through */ }
}
if (!token || !account) {
    console.error('need CLOUDFLARE_API_TOKEN and an account id (CLOUDFLARE_ACCOUNT_ID or .wrangler/cache) — run `. ./.env` first');
    process.exit(2);
}

const hours = Math.max(1, Math.floor(Number(opt.hours)));
const groupCols = opt['by-entity'] ? 'tier, scope, kind, entity' : 'tier, scope, kind';
const sql = `
SELECT blob1 AS tier, blob2 AS scope, blob4 AS kind${opt['by-entity'] ? ', blob3 AS entity' : ''},
       SUM(_sample_interval) AS n,
       SUM(if(double2 >= 0, double2, 0.0)) AS l2_sum, SUM(if(double2 >= 0, 1.0, 0.0)) AS l2_n,
       SUM(if(double3 >= 0, double3, 0.0)) AS db_sum, SUM(if(double3 >= 0, 1.0, 0.0)) AS db_n
FROM pdbfe_api_cache
WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
GROUP BY ${groupCols}
ORDER BY n DESC
FORMAT JSON`;

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: sql,
});
const text = await res.text();
if (!res.ok || !text.startsWith('{')) {
    // The body is remote input: strip control characters (incl. CR/LF) so it
    // cannot forge or corrupt log lines.
    const safe = text.slice(0, 300).replaceAll(/[\u0000-\u001f\u007f]/g, ' ');
    console.error(`query failed (${res.status}): ${safe}`);
    process.exit(1);
}
const rows = JSON.parse(text).data ?? [];
const avg = (sum, n) => (Number(n) > 0 ? (Number(sum) / Number(n)).toFixed(0) : '-');
const total = rows.reduce((a, r) => a + Number(r.n), 0);

console.log(`pdbfe_api_cache — last ${hours}h — ${total} worker requests\n`);
const cols = ['tier', 'scope', 'kind', ...(opt['by-entity'] ? ['entity'] : []), 'n', 'share', 'avg l2 ms', 'avg db ms'];
const lines = rows.map(r => [r.tier, r.scope, r.kind, ...(opt['by-entity'] ? [r.entity] : []), String(r.n),
    `${((Number(r.n) / total) * 100).toFixed(1)}%`, avg(r.l2_sum, r.l2_n), avg(r.db_sum, r.db_n)]);
const w = cols.map((c, i) => Math.max(c.length, ...lines.map(l => l[i].length)));
console.log(cols.map((c, i) => c.padEnd(w[i])).join('  '));
for (const l of lines) console.log(l.map((c, i) => c.padEnd(w[i])).join('  '));

// L2 verdict line: among requests that consulted L2, how often did it answer?
const l2Hits = rows.filter(r => r.tier === 'L2').reduce((a, r) => a + Number(r.n), 0);
const l2Consulted = l2Hits + rows.filter(r => r.tier === 'MISS' && r.kind !== 'since').reduce((a, r) => a + Number(r.n), 0);
if (l2Consulted > 0) {
    console.log(`\nL2 answered ${l2Hits} of ${l2Consulted} lookups (${((l2Hits / l2Consulted) * 100).toFixed(1)}%)`);
}
