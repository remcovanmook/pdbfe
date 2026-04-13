/**
 * @fileoverview Unit tests for core/admin.js.
 *
 * Tests request validation (method filtering, path traversal, scanner probes),
 * admin route dispatching (robots.txt, health, cache status/flush),
 * and wrapHandler error trapping and telemetry headers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, routeAdminPath, wrapHandler } from '../../../core/admin.js';

// ── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Builds a minimal mock Request with the given method and optional path.
 *
 * @param {string} method - HTTP method.
 * @param {Object} [opts] - Optional overrides.
 * @param {Record<string, string>} [opts.headers] - Request headers.
 * @param {Object} [opts.cf] - Cloudflare-specific properties.
 * @returns {Request}
 */
function mockRequest(method, opts = {}) {
    const headers = new Headers(opts.headers || {});
    return /** @type {any} */ ({
        method,
        headers,
        cf: opts.cf || { colo: 'AMS' },
    });
}

// ── validateRequest ──────────────────────────────────────────────────────────

describe('validateRequest', () => {
    it('returns null for allowed methods', () => {
        const req = mockRequest('GET');
        assert.equal(validateRequest(req, 'api/net'), null);
    });

    it('returns 405 for disallowed methods', () => {
        const req = mockRequest('DELETE');
        const resp = validateRequest(req, 'api/net');
        assert.equal(resp.status, 405);
        assert.ok(resp.headers.get('Allow'));
    });

    it('returns 400 for path traversal (..)', () => {
        const req = mockRequest('GET');
        const resp = validateRequest(req, 'api/../etc/passwd');
        assert.equal(resp.status, 400);
    });

    it('returns 404 for .git probe', () => {
        const req = mockRequest('GET');
        const resp = validateRequest(req, '.git/config');
        assert.equal(resp.status, 404);
    });

    it('returns 404 for .env probe', () => {
        const req = mockRequest('GET');
        const resp = validateRequest(req, '.env');
        assert.equal(resp.status, 404);
    });

    it('returns 404 for xmlrpc probe', () => {
        const req = mockRequest('GET');
        const resp = validateRequest(req, 'xmlrpc.php');
        assert.equal(resp.status, 404);
    });

    it('returns 404 for wp-includes probe', () => {
        const req = mockRequest('GET');
        const resp = validateRequest(req, 'foo/wp-includes/something');
        assert.equal(resp.status, 404);
    });

    it('accepts custom allowed methods', () => {
        const req = mockRequest('POST');
        const resp = validateRequest(req, 'api/net', ['POST', 'GET']);
        assert.equal(resp, null);
    });
});

// ── routeAdminPath ───────────────────────────────────────────────────────────

describe('routeAdminPath', () => {
    const mockDb = /** @type {any} */ ({
        prepare: () => ({ first: async () => ({ 1: 1 }) }),
    });

    const mockOpts = {
        db: mockDb,
        serviceName: 'test-service',
        getStats: () => ({ items: 0, bytes: 0, limit: 0 }),
        flush: () => {},
    };

    it('returns robots.txt for robots.txt path', () => {
        const resp = routeAdminPath('robots.txt', {}, mockOpts);
        assert.ok(resp);
        assert.equal(resp.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    });

    it('returns health check for health path', async () => {
        const resp = await routeAdminPath('health', {}, mockOpts);
        assert.ok(resp);
        const body = JSON.parse(await resp.text());
        assert.equal(body.service, 'test-service');
        assert.ok(['OK', 'DEGRADED'].includes(body.status));
    });

    it('returns null for unknown paths', () => {
        const resp = routeAdminPath('unknown', {}, mockOpts);
        assert.equal(resp, null);
    });

    it('returns null for cache_status without valid secret', () => {
        const env = { ADMIN_SECRET: 'correct-secret' };
        const resp = routeAdminPath('_cache_status.wrong-secret', env, mockOpts);
        assert.equal(resp, null);
    });
});

// ── wrapHandler ──────────────────────────────────────────────────────────────

describe('wrapHandler', () => {
    it('adds X-Timer header to response', async () => {
        const handler = async () => new Response('ok');
        const wrapped = wrapHandler(handler, 'test');
        const req = mockRequest('GET');
        const resp = await wrapped.fetch(req, {}, { waitUntil: () => {} });
        const timer = resp.headers.get('X-Timer');
        assert.ok(timer);
        assert.ok(timer.startsWith('S'));
    });

    it('adds X-Served-By header with colo and service name', async () => {
        const handler = async () => new Response('ok');
        const wrapped = wrapHandler(handler, 'pdbfe-api');
        const req = mockRequest('GET');
        const resp = await wrapped.fetch(req, {}, { waitUntil: () => {} });
        const servedBy = resp.headers.get('X-Served-By');
        assert.ok(servedBy.includes('AMS'));
        assert.ok(servedBy.includes('pdbfe-api'));
    });

    it('adds X-Isolate-ID header', async () => {
        const handler = async () => new Response('ok');
        const wrapped = wrapHandler(handler, 'test');
        const req = mockRequest('GET');
        const resp = await wrapped.fetch(req, {}, { waitUntil: () => {} });
        assert.ok(resp.headers.get('X-Isolate-ID'));
    });

    it('returns 500 with error body when handler throws', async () => {
        const handler = async () => { throw new Error('boom'); };
        const wrapped = wrapHandler(handler, 'test');
        const req = mockRequest('GET');
        const resp = await wrapped.fetch(req, {}, { waitUntil: () => {} });
        assert.equal(resp.status, 500);
        const body = JSON.parse(await resp.text());
        assert.equal(body.error, 'Internal Server Error');
    });

    it('sets default X-Auth-Status when handler omits it', async () => {
        const handler = async () => new Response('ok');
        const wrapped = wrapHandler(handler, 'test');
        const req = mockRequest('GET');
        const resp = await wrapped.fetch(req, {}, { waitUntil: () => {} });
        assert.equal(resp.headers.get('X-Auth-Status'), 'unauthenticated');
    });

    it('preserves X-Auth-Status when handler sets it', async () => {
        const handler = async () => new Response('ok', {
            headers: { 'X-Auth-Status': 'authenticated' }
        });
        const wrapped = wrapHandler(handler, 'test');
        const req = mockRequest('GET');
        const resp = await wrapped.fetch(req, {}, { waitUntil: () => {} });
        assert.equal(resp.headers.get('X-Auth-Status'), 'authenticated');
    });
});
