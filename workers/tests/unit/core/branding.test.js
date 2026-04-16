/**
 * @fileoverview Unit tests for the shared branding module.
 *
 * Validates that brandedHead() and brandedHeader() produce HTML
 * referencing the frontend assets rather than inlining styles.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('brandedHead', () => {
    it('links to the frontend CSS', async () => {
        const { brandedHead } = await import('../../../core/branding.js');
        const html = brandedHead();
        assert.ok(html.includes('pdbfe.dev/css/index.css'));
    });

    it('links to the Inter font stylesheet', async () => {
        const { brandedHead } = await import('../../../core/branding.js');
        const html = brandedHead();
        assert.ok(html.includes('pdbfe.dev/third_party/inter/inter.css'));
    });

    it('uses <link> tags (not inline styles)', async () => {
        const { brandedHead } = await import('../../../core/branding.js');
        const html = brandedHead();
        assert.ok(html.includes('<link rel="stylesheet"'));
        assert.ok(!html.includes('<style>'));
    });
});

describe('brandedHeader', () => {
    it('includes the PDBFE logo', async () => {
        const { brandedHeader } = await import('../../../core/branding.js');
        const html = brandedHeader('Test');
        assert.ok(html.includes('PDB<span>FE</span>'));
    });

    it('includes the label argument', async () => {
        const { brandedHeader } = await import('../../../core/branding.js');
        const html = brandedHeader('GraphQL');
        assert.ok(html.includes('GraphQL'));
    });

    it('uses the frontend CSS class names', async () => {
        const { brandedHeader } = await import('../../../core/branding.js');
        const html = brandedHeader('REST API');
        assert.ok(html.includes('site-header'));
        assert.ok(html.includes('site-header__inner'));
        assert.ok(html.includes('site-logo'));
    });

    it('includes cross-nav links', async () => {
        const { brandedHeader } = await import('../../../core/branding.js');
        const html = brandedHeader('REST API');
        assert.ok(html.includes('graphql.pdbfe.dev'));
        assert.ok(html.includes('rest.pdbfe.dev'));
        assert.ok(html.includes('/about'));
    });

    it('uses CSS variables (not hardcoded colours)', async () => {
        const { brandedHeader } = await import('../../../core/branding.js');
        const html = brandedHeader('Test');
        assert.ok(html.includes('var(--text-'));
        // Should not inline colour definitions
        assert.ok(!html.includes('hsl(220 14% 12%)'));
    });
});
