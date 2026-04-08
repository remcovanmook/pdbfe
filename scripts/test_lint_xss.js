/**
 * @fileoverview Unit tests for the XSS template literal scanner (scripts/lint_xss.js).
 *
 * Tests the detection heuristics by scanning synthetic JS snippets and
 * verifying that the scanner correctly flags unescaped interpolations
 * and passes safe ones. Uses the scanner as a subprocess to test the
 * actual exit codes.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCANNER = path.resolve(__dirname, 'lint_xss.js');

/**
 * Temporary directory for synthetic test files.
 * Placed inside frontend/js/ so the scanner picks them up.
 * @type {string}
 */
const TEST_DIR = path.resolve(__dirname, '../frontend/js/__xss_test_tmp__');

/**
 * Runs the XSS scanner and returns the exit code + output.
 *
 * @returns {{exitCode: number, output: string}}
 */
function runScanner() {
    try {
        const output = execSync(`node ${SCANNER}`, {
            encoding: 'utf-8',
            cwd: path.resolve(__dirname, '..'),
            stdio: ['pipe', 'pipe', 'pipe']
        });
        return { exitCode: 0, output };
    } catch (/** @type {any} */ err) {
        return { exitCode: err.status, output: err.stderr || err.stdout || '' };
    }
}

/**
 * Writes a JS file into the temp test directory.
 *
 * @param {string} filename - File name (e.g. "test.js").
 * @param {string} content - File contents.
 */
function writeTestFile(filename, content) {
    fs.writeFileSync(path.join(TEST_DIR, filename), content, 'utf-8');
}

describe('XSS Scanner', () => {

    beforeEach(() => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    });

    // ── Should pass ──────────────────────────────────────────────────────

    it('should pass when interpolation uses escapeHTML()', () => {
        writeTestFile('safe_escape.js', `
            const html = \`<div>\${escapeHTML(name)}</div>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    it('should pass when interpolation uses t()', () => {
        writeTestFile('safe_t.js', `
            const html = \`<span>\${t('Hello')}</span>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    it('should pass when interpolation uses a render* function', () => {
        writeTestFile('safe_render.js', `
            const html = \`<div>\${renderField('Name', value)}</div>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    it('should pass when interpolation uses linkEntity()', () => {
        writeTestFile('safe_link.js', `
            const html = \`<td>\${linkEntity('net', row.id, row.name)}</td>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    it('should pass with /* safe */ comment', () => {
        writeTestFile('safe_comment.js', `
            const html = \`<div>\${/* safe */ preBuiltHtml}</div>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    it('should pass with /* safe — reason */ comment', () => {
        writeTestFile('safe_comment_reason.js', `
            const html = \`<div>\${/* safe — from escapeHTML */ variable}</div>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    it('should pass for numeric property access (.id, .length)', () => {
        writeTestFile('safe_numeric.js', `
            const html = \`<span>\${items.length}</span>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    it('should pass for known HTML fragment variable names', () => {
        writeTestFile('safe_fragment.js', `
            const html = \`<div>\${sidebar}</div><div>\${tables}</div>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    it('should pass for variables ending in HTML', () => {
        writeTestFile('safe_html_var.js', `
            const html = \`<tbody>\${bodyHTML}</tbody>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    it('should ignore non-HTML template literals', () => {
        writeTestFile('non_html.js', `
            const sql = \`SELECT * FROM users WHERE id = \${userId}\`;
            console.log(\`User count: \${count}\`);
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    it('should pass for Number() and String() coercion', () => {
        writeTestFile('safe_coercion.js', `
            const html = \`<span>\${Number(val)}</span>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 0);
    });

    // ── Should fail ──────────────────────────────────────────────────────

    it('should flag unescaped variable in HTML context', () => {
        writeTestFile('unsafe_var.js', `
            const html = \`<div>\${userName}</div>\`;
        `);
        const { exitCode, output } = runScanner();
        assert.equal(exitCode, 1);
        assert.ok(output.includes('userName'), `output should mention 'userName': ${output}`);
    });

    it('should flag unescaped property access in HTML context', () => {
        writeTestFile('unsafe_prop.js', `
            const html = \`<td>\${item.name}</td>\`;
        `);
        const { exitCode, output } = runScanner();
        assert.equal(exitCode, 1);
        assert.ok(output.includes('item.name'));
    });

    it('should flag method call that is not in safe list', () => {
        writeTestFile('unsafe_method.js', `
            const html = \`<span>\${foo.bar()}</span>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 1);
    });

    it('should flag err.message without escapeHTML', () => {
        writeTestFile('unsafe_err.js', `
            const html = \`<div class="error">\${err.message}</div>\`;
        `);
        const { exitCode } = runScanner();
        assert.equal(exitCode, 1);
    });
});
