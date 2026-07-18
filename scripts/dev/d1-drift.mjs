#!/usr/bin/env node
/**
 * @fileoverview Live D1 schema-drift checker.
 *
 * Compares the LIVE production D1 database against what the current code
 * expects, closing the gap the other gates can't see:
 *   - diff_schema.py generates migrations from schema.sql changes,
 *   - CI's Schema Freshness checks migration COVERAGE in git,
 *   - but nothing verifies the migrations were actually APPLIED to prod.
 * A regenerated entity schema whose columns are missing in D1 500s in
 * production while every unit test passes (tests mock D1).
 *
 * Checks (read-only; two SELECTs):
 *   1. Every table/column in extracted/schema.sql exists in live D1.
 *      Missing => DRIFT (the production-500 class) => exit 1.
 *      Extra tables/columns in D1 are reported as info only.
 *   2. Every file in database/migrations/*.sql is recorded in _migrations.
 *      Unapplied => DRIFT => exit 1.
 *
 * Usage:
 *   node scripts/dev/d1-drift.mjs
 *
 * Credentials: sources .env / .env.deploy from repo root (same convention
 * as scripts/deploy.sh) for CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.
 * Values are only passed to the wrangler child process, never printed.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = join(ROOT, 'extracted', 'schema.sql');
const MIGRATIONS_DIR = join(ROOT, 'database', 'migrations');
const DB_NAME = process.env.D1_DRIFT_DB || 'peeringdb';

// ── env loading (deploy.sh convention: .env then .env.deploy) ───────
function loadEnvFile(path, into) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        let trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        // shell-sourced files ('. .env') commonly use `export KEY=value`
        if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trim();
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq);
        // strip optional surrounding quotes
        let val = trimmed.slice(eq + 1);
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!(key in into)) into[key] = val;
    }
}
const childEnv = { ...process.env };
loadEnvFile(join(ROOT, '.env'), childEnv);
loadEnvFile(join(ROOT, '.env.deploy'), childEnv);

// Never search a writable PATH for the binary we execute (Sonar S4036).
const FIXED_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
function resolveBin(name) {
    for (const dir of FIXED_PATH.split(':')) {
        const p = join(dir, name);
        if (existsSync(p)) return p;
    }
    throw new Error(`${name} not found in fixed paths (${FIXED_PATH})`);
}
childEnv.PATH = FIXED_PATH;

// ── expected schema from extracted/schema.sql ───────────────────────
/** @returns {Map<string, Set<string>>} table -> columns */
function parseSchema(sql) {
    const tables = new Map();
    let current = null;
    for (const rawLine of sql.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('CREATE TABLE')) {
            const q1 = line.indexOf('"');
            const q2 = line.indexOf('"', q1 + 1);
            if (q1 !== -1 && q2 !== -1) {
                current = line.slice(q1 + 1, q2);
                tables.set(current, new Set());
            }
            continue;
        }
        if (current === null) continue;
        if (line.startsWith(')')) { current = null; continue; }
        if (line.startsWith('"')) {
            const q2 = line.indexOf('"', 1);
            if (q2 !== -1) tables.get(current).add(line.slice(1, q2));
        }
    }
    return tables;
}
const expected = parseSchema(readFileSync(SCHEMA, 'utf8'));

// ── live D1 queries via wrangler (read-only) ────────────────────────
function d1Query(command) {
    const res = spawnSync(
        resolveBin('npx'),
        ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', '--command', command],
        { cwd: join(ROOT, 'workers'), env: childEnv, encoding: 'utf8', timeout: 120000 },
    );
    if (res.status !== 0) {
        console.error(res.stderr || res.stdout);
        throw new Error(`wrangler d1 execute failed (exit ${res.status})`);
    }
    // Output may carry non-JSON preamble; parse from the first '[' or '{'.
    const text = res.stdout;
    const start = Math.min(...['[', '{'].map(c => {
        const i = text.indexOf(c);
        return i === -1 ? Infinity : i;
    }));
    const parsed = JSON.parse(text.slice(start));
    return (Array.isArray(parsed) ? parsed[0] : parsed).results || [];
}

console.log(`Checking live D1 "${DB_NAME}" against extracted/schema.sql ...`);
const liveRows = d1Query(
    "SELECT m.name AS tbl, p.name AS col FROM sqlite_master AS m " +
    "JOIN pragma_table_info(m.name) AS p " +
    "WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '\\_cf%' ESCAPE '\\' " +
    "ORDER BY 1, 2",
);
/** @type {Map<string, Set<string>>} */
const live = new Map();
for (const row of liveRows) {
    if (!live.has(row.tbl)) live.set(row.tbl, new Set());
    live.get(row.tbl).add(row.col);
}

const appliedRows = d1Query("SELECT name FROM _migrations ORDER BY 1");
const applied = new Set(appliedRows.map(r => r.name));
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

// ── compare ─────────────────────────────────────────────────────────
let drift = 0;
const missingTables = [];
const missingColumns = [];
const extraTables = [];
const extraColumns = [];

for (const [table, cols] of expected) {
    if (!live.has(table)) { missingTables.push(table); continue; }
    for (const col of cols) {
        if (!live.get(table).has(col)) missingColumns.push(`${table}.${col}`);
    }
}
for (const [table, cols] of live) {
    if (!expected.has(table)) { extraTables.push(table); continue; }
    for (const col of cols) {
        if (!expected.get(table).has(col)) extraColumns.push(`${table}.${col}`);
    }
}
const unapplied = migrationFiles.filter(f => !applied.has(f));

console.log(`\nexpected: ${expected.size} tables | live: ${live.size} tables | migrations: ${applied.size} applied / ${migrationFiles.length} in repo`);

if (missingTables.length) {
    drift = 1;
    console.log(`\n✗ TABLES MISSING IN LIVE D1 (production-500 risk):`);
    for (const item of missingTables) console.log(`    ${item}`);
}
if (missingColumns.length) {
    drift = 1;
    console.log(`\n✗ COLUMNS MISSING IN LIVE D1 (production-500 risk):`);
    for (const item of missingColumns) console.log(`    ${item}`);
}
if (unapplied.length) {
    drift = 1;
    console.log(`\n✗ MIGRATIONS IN REPO BUT NOT APPLIED TO LIVE D1:`);
    for (const item of unapplied) console.log(`    ${item}`);
}
if (extraTables.length) console.log(`\nℹ extra tables in D1 (not in schema.sql, harmless): ${extraTables.join(', ')}`);
if (extraColumns.length) console.log(`ℹ extra columns in D1 (not in schema.sql, harmless): ${extraColumns.join(', ')}`);

console.log(drift ? '\nDRIFT DETECTED — deploying code that expects the current schema may 500.' : '\n✓ no drift — live D1 matches extracted/schema.sql and all migrations are applied.');
process.exit(drift);
