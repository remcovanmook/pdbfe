/**
 * @fileoverview Tests for scripts/version_frontend.js.
 *
 * Usage:
 *   node --test scripts/test_version_frontend.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionModuleSpecifiers, versionIndexHtml, buildVersionedFrontend, assetHash, IMMUTABLE_HEADERS } from './version_frontend.js';

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend');

describe('versionModuleSpecifiers', () => {
    it('versions relative import, re-export and side-effect specifiers', () => {
        const src = [
            "import { a } from './a.js';",
            'import {\n    b,\n    c,\n} from "../b.js";',
            "export { d } from './d.js';",
            "import './components/e.js';",
        ].join('\n');
        const out = versionModuleSpecifiers(src, '1.2.3');
        assert.match(out, /from '\.\/a\.js\?v=1\.2\.3'/);
        assert.match(out, /from "\.\.\/b\.js\?v=1\.2\.3"/);
        assert.match(out, /from '\.\/d\.js\?v=1\.2\.3'/);
        assert.match(out, /import '\.\/components\/e\.js\?v=1\.2\.3'/);
    });

    it('leaves JSDoc type imports and non-relative specifiers alone', () => {
        const src = "/** @param {import('./api.js').T} x */\nimport x from 'https://cdn.example/x.js';";
        assert.equal(versionModuleSpecifiers(src, '1'), src);
    });
});

describe('versionIndexHtml', () => {
    it('versions /js and /css URLs and replaces an existing ?v=', () => {
        const html = '<link rel="modulepreload" href="/js/boot.js">\n<script type="module" src="/js/boot.js"></script>\n<link rel="stylesheet" href="/css/index.css?v=7">';
        const out = versionIndexHtml(html, '9');
        assert.equal(out, '<link rel="modulepreload" href="/js/boot.js?v=9">\n<script type="module" src="/js/boot.js?v=9"></script>\n<link rel="stylesheet" href="/css/index.css?v=9">');
    });

    it('leaves /third_party URLs alone', () => {
        const html = '<script defer src="/third_party/leaflet/leaflet.js"></script>';
        assert.equal(versionIndexHtml(html, '9'), html);
    });
});

describe('buildVersionedFrontend (real frontend/)', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pdbfe-dist-'));
    const token = buildVersionedFrontend(FRONTEND_DIR, out, '0.0.0');

    it('uses <version>-<content hash> as the token', () => {
        assert.equal(token, `0.0.0-${assetHash(FRONTEND_DIR)}`);
    });

    it('leaves no relative import without the token', () => {
        const files = fs.readdirSync(path.join(out, 'js'), { withFileTypes: true, recursive: true })
            .filter((e) => e.isFile() && e.name.endsWith('.js'));
        for (const e of files) {
            const src = fs.readFileSync(path.join(e.parentPath, e.name), 'utf8');
            for (const m of src.matchAll(/\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g)) {
                assert.ok(m[1].endsWith(`?v=${token}`), `${e.name}: ${m[1]}`);
            }
        }
    });

    it('versions every /js and /css URL in index.html', () => {
        const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
        for (const m of html.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"]+)"/g)) {
            assert.ok(m[1].endsWith(`?v=${token}`), m[1]);
        }
    });

    it('adds the immutable rule to the build only, not to frontend/', () => {
        assert.ok(fs.readFileSync(path.join(out, '_headers'), 'utf8').endsWith(IMMUTABLE_HEADERS));
        assert.ok(!fs.readFileSync(path.join(FRONTEND_DIR, '_headers.example'), 'utf8').includes('max-age=31536000'));
    });

    it('does not copy node_modules', () => {
        assert.equal(fs.existsSync(path.join(out, 'node_modules')), false);
    });
});
