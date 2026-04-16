/**
 * @fileoverview Tests for the static API landing pages in frontend/api/.
 *
 * Validates that the HTML files reference the frontend CSS,
 * use the correct class names, and contain the expected content.
 */

import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../');
const graphqlHtml = readFileSync(resolve(REPO_ROOT, 'frontend/api/graphql.html'), 'utf-8');
const restHtml = readFileSync(resolve(REPO_ROOT, 'frontend/api/rest.html'), 'utf-8');

describe('frontend/api/graphql.html', () => {
    it('links to the frontend CSS', () => {
        assert.ok(graphqlHtml.includes('/css/index.css'));
    });

    it('links to the Inter font', () => {
        assert.ok(graphqlHtml.includes('/third_party/inter/inter.css'));
    });

    it('uses the site-header class', () => {
        assert.ok(graphqlHtml.includes('site-header'));
        assert.ok(graphqlHtml.includes('site-logo'));
    });

    it('includes the PDBFE logo', () => {
        assert.ok(graphqlHtml.includes('PDB<span>FE</span>'));
    });

    it('includes the GraphQL label', () => {
        assert.ok(graphqlHtml.includes('GraphQL'));
    });

    it('loads GraphiQL from CDN', () => {
        assert.ok(graphqlHtml.includes('graphiql'));
        assert.ok(graphqlHtml.includes('cdn.jsdelivr.net'));
    });

    it('has cross-nav links', () => {
        assert.ok(graphqlHtml.includes('graphql.pdbfe.dev'));
        assert.ok(graphqlHtml.includes('rest.pdbfe.dev'));
        assert.ok(graphqlHtml.includes('/about'));
    });
});

describe('frontend/api/rest.html', () => {
    it('links to the frontend CSS', () => {
        assert.ok(restHtml.includes('/css/index.css'));
    });

    it('links to the Inter font', () => {
        assert.ok(restHtml.includes('/third_party/inter/inter.css'));
    });

    it('uses the site-header class', () => {
        assert.ok(restHtml.includes('site-header'));
        assert.ok(restHtml.includes('site-logo'));
    });

    it('includes the PDBFE logo', () => {
        assert.ok(restHtml.includes('PDB<span>FE</span>'));
    });

    it('includes the REST API label', () => {
        assert.ok(restHtml.includes('REST API'));
    });

    it('loads Scalar from CDN', () => {
        assert.ok(restHtml.includes('@scalar/api-reference'));
        assert.ok(restHtml.includes('cdn.jsdelivr.net'));
    });

    it('points at /openapi.json', () => {
        assert.ok(restHtml.includes('/openapi.json'));
    });
});
