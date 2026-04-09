/**
 * @fileoverview Static analysis tests that scan hot-path source files for
 * anti-pattern violations documented in ANTI_PATTERNS.md.
 *
 * Each test reads the source files, splits into lines, and checks for
 * banned patterns. Lines containing the suppression comment "ap-ok"
 * are excluded — use this for intentional exceptions with a brief
 * justification, e.g.:
 *
 *   const parts = str.split(':'); // ap-ok: cold-boot, runs once
 *
 * This runs as part of the unit test suite and CI pipeline, catching
 * regressions before they reach production.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKERS_ROOT = join(__dirname, '..', '..');

/**
 * Hot-path source files — these run on every request and must not use
 * patterns that allocate unnecessary garbage or introduce latency.
 *
 * Excluded: api/entities.js (cold-boot module-level setup, runs once
 * per isolate lifetime), test files, markdown, and config.
 */
const HOT_PATH_DIRS = ['api', 'core'];
const COLD_BOOT_FILES = new Set(['entities.js']);

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
 * the "ap-ok" suppression marker or are inside JSDoc/block comments.
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

// Collect all hot-path source files once.
const sourceFiles = [];
for (const dir of HOT_PATH_DIRS) {
    sourceFiles.push(...collectSourceFiles(join(WORKERS_ROOT, dir)));
}

/** @type {Map<string, {rel: string, lines: string[]}>} */
const fileCache = new Map();
for (const abs of sourceFiles) {
    const rel = relative(WORKERS_ROOT, abs);
    const content = readFileSync(abs, 'utf-8');
    fileCache.set(abs, { rel, lines: content.split('\n') });
}

// ── §1: URL Parsing ─────────────────────────────────────────────────

describe('§1 — no new URL() on hot path', () => {
    const pattern = /new\s+URL\s*\(/;

    for (const [abs, { rel, lines }] of fileCache) {
        it(`${rel}`, () => {
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ── §2: Regular Expressions ─────────────────────────────────────────

describe('§2 — no regex execution on hot path', () => {
    // Matches .test(, .match(, .exec(, .replace(/ on regex literals,
    // and new RegExp( constructor calls.
    const pattern = /(?:\/[^/\n]+\/[gimsuy]*\.(?:test|match|exec)\s*\(|new\s+RegExp\s*\(|\.match\s*\(\s*\/|\.replace\s*\(\s*\/)/;

    for (const [abs, { rel, lines }] of fileCache) {
        it(`${rel}`, () => {
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ── §3: Array allocations on hot path ───────────────────────────────

describe('§3 — no .map()/.filter()/spread/split/Array().fill() on hot path', () => {
    // Each sub-pattern catches a distinct array-allocation source:
    //   .map(     — creates intermediate array from callback
    //   .filter(  — creates filtered copy
    //   [...      — spread into new array
    //   .split(   — splits string into array
    //   Array(    — explicit array constructor (often with .fill)
    const pattern = /(?:\.map\s*\(|\.filter\s*\(|\[\s*\.\.\.|\.split\s*\(|(?<!\w)Array\s*\()/;

    for (const [abs, { rel, lines }] of fileCache) {
        it(`${rel}`, () => {
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});

// ── §10: Awaiting L2 cache writes ───────────────────────────────────

describe('§10 — no await on putL2() calls', () => {
    const pattern = /await\s+putL2\s*\(/;

    for (const [abs, { rel, lines }] of fileCache) {
        it(`${rel}`, () => {
            const v = scanLines(lines, pattern);
            assert.equal(v.length, 0, formatViolations(rel, v));
        });
    }
});
