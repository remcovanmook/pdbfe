/**
 * @fileoverview Unit tests for the shared branding module.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('brandedHeader', () => {
    it('returns HTML with the PDBFE logo', async () => {
        const { brandedHeader } = await import('../../../core/branding.js');
        const html = brandedHeader('Test');
        assert.ok(html.includes('PDBFE') || html.includes('PDB'));
    });

    it('includes the label argument', async () => {
        const { brandedHeader } = await import('../../../core/branding.js');
        const html = brandedHeader('GraphQL');
        assert.ok(html.includes('GraphQL'));
    });

    it('includes navigation links', async () => {
        const { brandedHeader } = await import('../../../core/branding.js');
        const html = brandedHeader('REST API');
        assert.ok(html.includes('graphql.pdbfe.dev'));
        assert.ok(html.includes('rest.pdbfe.dev'));
        assert.ok(html.includes('pdbfe.dev/about'));
    });

    it('includes Inter font import', async () => {
        const { brandedHeader } = await import('../../../core/branding.js');
        const html = brandedHeader('REST API');
        assert.ok(html.includes('fonts.googleapis.com'));
        assert.ok(html.includes('Inter'));
    });

    it('uses the PDBFE colour palette', async () => {
        const { brandedHeader } = await import('../../../core/branding.js');
        const html = brandedHeader('Test');
        // Dark surface background
        assert.ok(html.includes('hsl(220 14% 12%)'));
        // Accent colour
        assert.ok(html.includes('hsl(200 80% 55%)'));
    });
});
