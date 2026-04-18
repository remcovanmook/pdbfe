/**
 * @fileoverview Static analysis tests that scan source files for
 * anti-pattern violations documented in ANTI_PATTERNS.md.
 *
 * Each test reads source files, splits into lines, and checks for
 * banned patterns. Lines containing the suppression comment "ap-ok"
 * are excluded — use this for intentional exceptions with a brief
 * justification, e.g.:
 *
 *   const parts = str.split(':'); // ap-ok: cold-boot, runs once
 *
 * Coverage:
 *   §1  — new URL() constructor
 *   §2  — regex execution (.test, .match, .exec, .replace with regex, new RegExp)
 *   §3  — array allocations (.map, .filter, spread, .split, Array().fill)
 *   §4  — JSON.parse / JSON.stringify in handler code
 *   §6  — async on files that must be synchronous
 *   §7  — pending map manipulation outside pipeline.js
 *   §8  — mutating cached Uint8Array buffers
 *   §9  — D1 .prepare() in files that must not touch D1
 *   §10 — await putL2() blocking response
 *   §12 — raw cachedQuery() / cache.get() in handler code
 *
 * Not statically detectable (require code review):
 *   §5  — dynamic object keys (ambiguous without type info)
 *   §11 — holding LRU results across get() calls (requires data flow analysis)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKERS_ROOT = join(__dirname, '..', '..');

// ── File Sets ────────────────────────────────────────────────────────
// Different rules apply to different file scopes. Files are grouped
// by their role in the request lifecycle.

/**
 * Hot-path source directories scanned for universal rules (§1-§3, §10).
 * Excludes api/entities.js (cold-boot module-level setup).
 */
const HOT_PATH_DIRS = ['api', 'core', 'graphql', 'rest'];
const COLD_BOOT_FILES = new Set(['entities.js']);

/**
 * Files that must NEVER contain async functions or arrow functions.
 * These are purely synchronous modules — adding async introduces
 * unnecessary microtask overhead (§6).
 */
const SYNC_ONLY_FILES = [
    'core/cache.js',
    'core/http.js',
    'api/http.js',
    'graphql/handlers/static.js',
    'rest/handlers/static.js',
    'rest/scalar.js',
];

/**
 * Files that must NEVER call db.prepare() or touch D1 directly (§9).
 * D1 access goes through cachedQuery() in pipeline.js.
 */
const NO_D1_FILES = [
    'core/cache.js',
    'core/http.js',
    'core/utils.js',
    'api/cache.js',
    'graphql/cache.js',
    'graphql/handlers/static.js',
    'rest/cache.js',
    'rest/handlers/static.js',
    'rest/scalar.js',
];

/**
 * Files that must NEVER manipulate the pending map directly (§7).
 * Only pipeline.js owns coalescing via cache.pending.
 */
const NO_PENDING_FILES = [
    'api/handlers/list.js',
    'api/handlers/detail.js',
    'api/handlers/as_set.js',
    'api/handlers/shared.js',
    'core/http.js',
    'api/http.js',
    'api/cache.js',
    'core/cache.js',
    'graphql/cache.js',
    'graphql/handlers/static.js',
    'graphql/handlers/query.js',
    'rest/cache.js',
    'rest/handlers/static.js',
    'rest/handlers/detail.js',
    'rest/handlers/list.js',
    'rest/scalar.js',
];

/**
 * Handler files where cachedQuery() and cache.get() should not
 * appear directly — use withEdgeSWR() instead (§12).
 */
const HANDLER_FILES = [
    'api/handlers/list.js',
    'api/handlers/detail.js',
    'api/handlers/as_set.js',
    'graphql/handlers/query.js',
    'rest/handlers/detail.js',
    'rest/handlers/list.js',
];

/**
 * Handler files where JSON.parse() and JSON.stringify() should not
 * appear on the hot path (§4). Allowed in core/http.js (encodeJSON,
 * jsonError) and admin/auth/oauth paths.
 */
const NO_JSON_ROUNDTRIP_FILES = [
    'api/handlers/list.js',
    'api/handlers/detail.js',
    'api/handlers/as_set.js',
    'graphql/handlers/query.js',
    'rest/handlers/detail.js',
    'rest/handlers/list.js',
];

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Recursively collects all .js files from the given directory,
 * excluding files in the COLD_BOOT_FILES set.
 *
 * @param {string} dir - Absolute path to scan.
 * @returns {string[]} Array of absolute file paths.
 */
function collectSourceFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            files.push(...collectSourceFiles(full));
        } else if (entry.endsWith('.js') && !COLD_BOOT_FILES.has(entry)) {
            files.push(full);
        }
    }
    return files;
}

/**
 * Scans source lines for a regex pattern, skipping lines that contain
 * the "ap-ok" suppression marker or are inside block comments.
 *
 * @param {string[]} lines - Source file split into lines.
 * @param {RegExp} pattern - Pattern to test against each line.
 * @returns {{line: number, text: string}[]} Array of violations.
 */
function scanLines(lines, pattern) {
    const violations = [];
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Track block comment state.
        if (trimmed.startsWith('/*') || trimmed.startsWith('/**')) {
            inBlockComment = true;
        }
        if (inBlockComment) {
            if (trimmed.includes('*/')) inBlockComment = false;
            continue;
        }

        // Skip single-line comments and suppressed lines.
        if (trimmed.startsWith('//')) continue;
        if (line.includes('ap-ok')) continue;

        if (pattern.test(line)) {
            violations.push({ line: i + 1, text: trimmed });
        }
    }

    return violations;
}

/**
 * Formats a list of violations into a readable assertion message.
 *
 * @param {string} file - Relative file path.
 * @param {{line: number, text: string}[]} violations - Found violations.
 * @returns {string} Formatted message.
 */
function formatViolations(file, violations) {
    const details = violations
        .map(v => `  L${v.line}: ${v.text}`)
        .join('\n');
    return `${file}:\n${details}\n  Suppress with an inline // ap-ok comment if intentional.`;
}

/**
 * Reads and caches a file's lines by its relative path under WORKERS_ROOT.
 *
 * @param {string} relPath - Path relative to WORKERS_ROOT.
 * @returns {{rel: string, lines: string[]}} File metadata.
 */
function readFile(relPath) {
    const abs = join(WORKERS_ROOT, relPath);
    const content = readFileSync(abs, 'utf-8');
    return { rel: relPath, lines: content.split('\n') };
}

// Collect all hot-path source files once for universal rule scanning.
const allHotPathFiles = [];
for (const dir of HOT_PATH_DIRS) {
    allHotPathFiles.push(...collectSourceFiles(join(WORKERS_ROOT, dir)));
}

/** @type {Map<string, {rel: string, lines: string[]}>} */
const fileCache = new Map();
for (const abs of allHotPathFiles) {
    const rel = relative(WORKERS_ROOT, abs);
    const content = readFileSync(abs, 'utf-8');
    fileCache.set(abs, { rel, lines: content.split('\n') });
}

// ═════════════════════════════════════════════════════════════════════
// §1 — URL Parsing
// new URL() allocates a large object graph that triggers GC pressure.
// ═════════════════════════════════════════════════════════════════════

describe('§1 — no new URL() on hot path', () => {
    const pattern = /new\s+URL\s*\(/;

    for (const [, { rel, lines }] of fileCache) {
        it(`${rel}`, () => {
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ═════════════════════════════════════════════════════════════════════
// §2 — Regular Expressions on the Hot Path
// Regex is unpredictable and opens the door to ReDoS.
// ═════════════════════════════════════════════════════════════════════

describe('§2 — no regex execution on hot path', () => {
    const pattern = /(?:\/[^/\n]+\/[gimsuy]*\.(?:test|match|exec)\s*\(|new\s+RegExp\s*\(|\.match\s*\(\s*\/|\.replace\s*\(\s*\/)/;

    for (const [, { rel, lines }] of fileCache) {
        it(`${rel}`, () => {
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ═════════════════════════════════════════════════════════════════════
// §3 — Functional Array Methods / Spread / Split
// Creates intermediate arrays that become GC garbage per request.
// ═════════════════════════════════════════════════════════════════════

describe('§3 — no .map()/.filter()/spread/split/Array().fill() on hot path', () => {
    const pattern = /(?:\.map\s*\(|\.filter\s*\(|\[\s*\.\.\.|\.split\s*\(|(?<!\w)Array\s*\()/;

    for (const [, { rel, lines }] of fileCache) {
        it(`${rel}`, () => {
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ═════════════════════════════════════════════════════════════════════
// §4 — JSON Round-Tripping in Handler Code
// depth=0 uses D1's json_group_array. JSON.parse/stringify should not
// appear in handler code except the depth>0 cold path.
// ═════════════════════════════════════════════════════════════════════

describe('§4 — no JSON.parse/stringify in handler code', () => {
    const pattern = /JSON\.(parse|stringify)\s*\(/;

    for (const relPath of NO_JSON_ROUNDTRIP_FILES) {
        it(`${relPath}`, () => {
            const { rel, lines } = readFile(relPath);
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ═════════════════════════════════════════════════════════════════════
// §6 — Unnecessary async on Synchronous Modules
// Cache lookups, HTTP helpers, and rate limiting are synchronous.
// Adding async adds microtask queue overhead for no reason.
// ═════════════════════════════════════════════════════════════════════

describe('§6 — no async functions in sync-only modules', () => {
    const pattern = /(?:async\s+function\b|async\s*\(|async\s*\w+\s*=>|async\s*\w+\s*\()/;

    for (const relPath of SYNC_ONLY_FILES) {
        it(`${relPath}`, () => {
            const { rel, lines } = readFile(relPath);
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ═════════════════════════════════════════════════════════════════════
// §7 — Bypassing the Pending Map
// Only pipeline.js may manipulate cache.pending. Direct pending.set()
// or pending.delete() elsewhere bypasses coalescing.
// ═════════════════════════════════════════════════════════════════════

describe('§7 — no pending map manipulation outside pipeline.js', () => {
    const pattern = /pending\.(set|delete)\s*\(/;

    for (const relPath of NO_PENDING_FILES) {
        it(`${relPath}`, () => {
            const { rel, lines } = readFile(relPath);
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ═════════════════════════════════════════════════════════════════════
// §8 — Mutating Cached Buffers
// The Uint8Array in the LRU cache is shared across all responses.
// Writing to it (entry.buf[i] = x) corrupts all concurrent readers.
// ═════════════════════════════════════════════════════════════════════

describe('§8 — no mutation of cached buffer entries', () => {
    const pattern = /\.buf\s*\[.*\]\s*=/;

    for (const [, { rel, lines }] of fileCache) {
        it(`${rel}`, () => {
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ═════════════════════════════════════════════════════════════════════
// §9 — D1 .prepare() Outside Allowed Files
// Handler D1 queries go through cachedQuery() (via withEdgeSWR).
// Infrastructure modules must never call .prepare() directly.
// ═════════════════════════════════════════════════════════════════════

describe('§9 — no .prepare() in infrastructure modules', () => {
    const pattern = /\.prepare\s*\(/;

    for (const relPath of NO_D1_FILES) {
        it(`${relPath}`, () => {
            const { rel, lines } = readFile(relPath);
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ═════════════════════════════════════════════════════════════════════
// §10 — Awaiting L2 Cache Writes
// putL2() is fire-and-forget. Awaiting it blocks the response.
// ═════════════════════════════════════════════════════════════════════

describe('§10 — no await on putL2() calls', () => {
    const pattern = /await\s+putL2\s*\(/;

    for (const [, { rel, lines }] of fileCache) {
        it(`${rel}`, () => {
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ═════════════════════════════════════════════════════════════════════
// §12 — Raw cachedQuery() / cache.get() in Handler Code
// Handlers should use withEdgeSWR() which encapsulates cache reads,
// SWR, and cachedQuery. Direct calls bypass SWR and risk §11 bugs.
// ═════════════════════════════════════════════════════════════════════

describe('§12 — no raw cachedQuery() in handler code', () => {
    const pattern = /cachedQuery\s*\(\s*\{/;

    for (const relPath of HANDLER_FILES) {
        it(`${relPath}`, () => {
            const { rel, lines } = readFile(relPath);
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

describe('§12 — no raw cache.get() in handler code', () => {
    const pattern = /cache\.get\s*\(/;

    for (const relPath of HANDLER_FILES) {
        it(`${relPath}`, () => {
            const { rel, lines } = readFile(relPath);
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});
