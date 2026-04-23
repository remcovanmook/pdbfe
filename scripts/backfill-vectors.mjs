#!/usr/bin/env node
/**
 * @fileoverview One-shot vector backfill script.
 *
 * Iterates all rows in each searchable entity table, generates BGE-large
 * embeddings via the Workers AI REST API, upserts them into Vectorize, and
 * marks each batch with __vector_embedded = 1 in D1.
 *
 * Run this AFTER deploying the sync worker with AI + VECTORIZE bindings.
 * The sync worker handles new/changed rows from that point; this script
 * fills in the historical data.
 *
 * Safe to re-run: rows already at __vector_embedded = 1 are skipped.
 *
 * Required environment variables:
 *   CLOUDFLARE_ACCOUNT_ID  — Cloudflare account ID
 *   CLOUDFLARE_API_TOKEN   — API token with D1:Edit, AI:Run, Vectorize:Edit
 *   D1_DATABASE_ID         — D1 database ID for the peeringdb database
 *   VECTORIZE_INDEX_NAME   — Vectorize index name (default: pdbfe-vectors)
 *
 * Usage:
 *   node scripts/backfill-vectors.mjs
 */

import { env } from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parses a KEY=VALUE env file into process.env.
 * Strips leading `export `, skips comments and blank lines.
 * Existing env vars take precedence (explicit env wins over file).
 *
 * @param {string} path - Absolute path to the env file.
 */
function loadEnvFile(path) {
    let content;
    try { content = readFileSync(path, 'utf8'); } catch { return; }
    for (const line of content.split('\n')) {
        const stripped = line.replace(/^\s*export\s+/, '').trim();
        if (!stripped || stripped.startsWith('#')) continue;
        const eq = stripped.indexOf('=');
        if (eq === -1) continue;
        const key = stripped.slice(0, eq).trim();
        const val = stripped.slice(eq + 1).trim();
        if (!(key in env)) env[key] = val;
    }
}

// Load local env files when running outside CI.
// .env carries runtime secrets; .env.deploy carries infra IDs.
loadEnvFile(`${REPO_ROOT}/.env`);
loadEnvFile(`${REPO_ROOT}/.env.deploy`);

const ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = env.CLOUDFLARE_API_TOKEN;
const D1_DB_ID = env.D1_DATABASE_ID;
const VECTORIZE_NAME = env.VECTORIZE_INDEX_NAME ?? 'pdbfe-vectors';

const missing = [
    !ACCOUNT_ID && 'CLOUDFLARE_ACCOUNT_ID',
    !API_TOKEN  && 'CLOUDFLARE_API_TOKEN',
    !D1_DB_ID   && 'D1_DATABASE_ID',
].filter(Boolean);

if (missing.length > 0) {
    console.error(`Missing required env: ${missing.join(', ')}`);
    process.exit(1);
}

const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

/** @type {Record<string, string>} */
const AUTH_HEADERS = {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
};

/**
 * Entity tags and their D1 table names.
 * Matches VECTOR_ENTITY_TAGS in workers/sync/entities.js.
 * @type {Array<{tag: string, table: string}>}
 */
const ENTITIES = [
    { tag: 'org', table: 'peeringdb_organization' },
    { tag: 'net', table: 'peeringdb_network' },
    { tag: 'ix', table: 'peeringdb_ix' },
    { tag: 'fac', table: 'peeringdb_facility' },
    { tag: 'carrier', table: 'peeringdb_carrier' },
    { tag: 'campus', table: 'peeringdb_campus' },
];

/** Rows fetched from D1 per page. */
const PAGE_SIZE = 500;
/** Texts sent to Workers AI per embed call. */
const EMBED_BATCH = 50;

/**
 * Executes a SQL statement against D1 via the REST API.
 *
 * @param {string} sql - SQL query to execute.
 * @param {Array<string|number|null>} [params] - Bound parameters.
 * @returns {Promise<any[]>} Array of result rows.
 */
async function d1Query(sql, params = []) {
    const resp = await fetch(
        `${CF_BASE}/d1/database/${D1_DB_ID}/query`,
        {
            method: 'POST',
            headers: AUTH_HEADERS,
            body: JSON.stringify({ sql, params }),
        }
    );
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`D1 query failed (${resp.status}): ${text}`);
    }
    const json = await resp.json();
    if (!json.success) {
        throw new Error(`D1 error: ${JSON.stringify(json.errors)}`);
    }
    // D1 REST returns an array of result sets (one per statement).
    return json.result?.[0]?.results ?? [];
}

/**
 * Calls Workers AI to generate BGE-large-en-v1.5 embeddings.
 *
 * @param {string[]} texts - Texts to embed.
 * @returns {Promise<number[][]>} Array of embedding vectors.
 */
async function embed(texts) {
    const resp = await fetch(
        `${CF_BASE}/ai/run/@cf/baai/bge-large-en-v1.5`,
        {
            method: 'POST',
            headers: AUTH_HEADERS,
            body: JSON.stringify({ text: texts }),
        }
    );
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`AI embed failed (${resp.status}): ${text}`);
    }
    const json = await resp.json();
    return json.result?.data ?? [];
}

/**
 * Upserts vectors into the Vectorize index.
 *
 * @param {Array<{id: string, values: number[], metadata: object}>} vectors
 * @returns {Promise<void>}
 */
async function vectorizeUpsert(vectors) {
    // Vectorize REST API expects NDJSON body.
    const ndjson = vectors
        .map(v => JSON.stringify(v))
        .join('\n');

    const resp = await fetch(
        `${CF_BASE}/vectorize/v2/indexes/${VECTORIZE_NAME}/upsert`,
        {
            method: 'POST',
            headers: {
                ...AUTH_HEADERS,
                'Content-Type': 'application/x-ndjson',
            },
            body: ndjson,
        }
    );
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Vectorize upsert failed (${resp.status}): ${text}`);
    }
}

/**
 * Marks a batch of row IDs as embedded in D1.
 *
 * @param {string} table - D1 table name.
 * @param {number[]} ids - Row IDs to mark.
 * @returns {Promise<void>}
 */
async function markEmbedded(table, ids) {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    await d1Query(
        `UPDATE "${table}" SET "__vector_embedded" = 1 WHERE id IN (${placeholders})`,
        ids
    );
}

/**
 * Backfills all unembedded rows for a single entity.
 *
 * @param {string} tag - Entity tag (e.g. 'net').
 * @param {string} table - D1 table name.
 * @returns {Promise<{embedded: number, errors: number}>}
 */
async function backfillEntity(tag, table) {
    let embedded = 0;
    let errors = 0;
    let consecutiveErrorPages = 0;

    console.log(`[backfill] ${tag}: starting`);

    while (true) {
        // Always fetch from offset 0 — rows are marked embedded as they're
        // processed, so the WHERE filter acts as the cursor. Using OFFSET
        // with a shrinking set causes every other page to be skipped.
        const rows = await d1Query(
            `SELECT id, name FROM "${table}" WHERE "__vector_embedded" = 0 LIMIT ?`,
            [PAGE_SIZE]
        );

        if (rows.length === 0) break;

        let pageEmbedded = 0;

        // Process in EMBED_BATCH chunks.
        for (let i = 0; i < rows.length; i += EMBED_BATCH) {
            const batch = rows.slice(i, i + EMBED_BATCH);
            const texts = batch.map(r => String(r.name || ''));
            const ids = batch.map(r => r.id);

            try {
                const embeddings = await embed(texts);

                if (embeddings.length !== batch.length) {
                    throw new Error(`AI returned ${embeddings.length} embeddings for ${batch.length} texts`);
                }

                /** @type {Array<{id: string, values: number[], metadata: object}>} */
                const vectors = batch.map((r, j) => ({
                    id: `${tag}:${r.id}`,
                    values: embeddings[j],
                    metadata: { entity: tag, id: r.id },
                }));

                await vectorizeUpsert(vectors);
                await markEmbedded(table, ids);

                embedded += batch.length;
                pageEmbedded += batch.length;
                process.stdout.write(`\r[backfill] ${tag}: ${embedded} embedded`);
            } catch (err) {
                console.error(`\n[backfill] ${tag} batch error: ${err.message}`);
                errors += batch.length;
            }
        }

        // Guard against infinite loops when rows persistently fail to embed
        // (they stay at __vector_embedded=0 and reappear each iteration).
        if (pageEmbedded === 0) {
            consecutiveErrorPages++;
            if (consecutiveErrorPages >= 3) {
                console.error(`\n[backfill] ${tag}: 3 consecutive pages with 0 successes, stopping`);
                break;
            }
        } else {
            consecutiveErrorPages = 0;
        }
    }

    console.log(`\n[backfill] ${tag}: done — ${embedded} embedded, ${errors} errors`);
    return { embedded, errors };
}

// Main
let totalEmbedded = 0;
let totalErrors = 0;

for (const { tag, table } of ENTITIES) {
    const { embedded, errors } = await backfillEntity(tag, table);
    totalEmbedded += embedded;
    totalErrors += errors;
}

console.log(`\n[backfill] complete — ${totalEmbedded} total embedded, ${totalErrors} total errors`);
if (totalErrors > 0) process.exit(1);
