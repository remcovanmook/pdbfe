/**
 * @fileoverview Unit tests for the URL scheme sanitisers (js/url.js).
 * These enforce the allowlist that keeps operator-editable PeeringDB URL
 * fields from smuggling a `javascript:` (or other active) scheme into an
 * href/src.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseURL, sanitiseImageURL } from '../../js/url.js';

describe('sanitiseURL', () => {
    it('allows http/https/mailto', () => {
        assert.equal(sanitiseURL('https://example.com/x'), 'https://example.com/x');
        assert.equal(sanitiseURL('http://example.com'), 'http://example.com');
        assert.equal(sanitiseURL('mailto:a@b.com'), 'mailto:a@b.com');
    });

    it('rejects javascript: and other active schemes → empty string', () => {
        assert.equal(sanitiseURL('javascript:alert(1)'), '');
        assert.equal(sanitiseURL('JaVaScRiPt:alert(1)'), '');
        assert.equal(sanitiseURL('  javascript:alert(1)'), '');
        assert.equal(sanitiseURL('java\tscript:alert(1)'), '');
        assert.equal(sanitiseURL('vbscript:msgbox(1)'), '');
        assert.equal(sanitiseURL('data:text/html,<script>alert(1)</script>'), '');
        assert.equal(sanitiseURL('data:image/svg+xml;base64,PHN2Zz4='), '');
    });

    it('rejects non-strings and empties', () => {
        assert.equal(sanitiseURL(''), '');
        assert.equal(sanitiseURL(null), '');
        assert.equal(sanitiseURL(undefined), '');
        assert.equal(sanitiseURL(12345), '');
    });

    it('trims surrounding whitespace on allowed URLs', () => {
        assert.equal(sanitiseURL('  https://example.com  '), 'https://example.com');
    });
});

describe('sanitiseImageURL', () => {
    it('allows data:image (incl. svg+xml) for <img src> use', () => {
        assert.equal(
            sanitiseImageURL('data:image/png;base64,iVBOR'),
            'data:image/png;base64,iVBOR'
        );
        // svg data URIs are inert in <img> and appear in real PeeringDB notes.
        assert.equal(
            sanitiseImageURL('data:image/svg+xml;base64,PHN2Zz4='),
            'data:image/svg+xml;base64,PHN2Zz4='
        );
    });

    it('still rejects javascript: and non-image data URIs', () => {
        assert.equal(sanitiseImageURL('javascript:alert(1)'), '');
        assert.equal(sanitiseImageURL('data:text/html,<script>1</script>'), '');
    });

    it('strips a trailing dimension suffix', () => {
        assert.equal(
            sanitiseImageURL('https://example.com/a.png =410x300'),
            'https://example.com/a.png'
        );
    });
});
