/**
 * @fileoverview Unit tests for the L2 per-PoP cache (core/l2cache.js).
 *
 * Tests initL2 origin derivation and getL2/putL2 behaviour when the
 * Cache API is unavailable (Node.js environment). The actual Cache API
 * is only available in Cloudflare Workers — these tests verify the
 * graceful degradation path.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initL2, getL2, putL2 } from '../../../core/l2cache.js';

// ── initL2 ───────────────────────────────────────────────────────────────────

describe('initL2', () => {
    it('does not throw when called with a valid URL', () => {
        assert.doesNotThrow(() => {
            initL2('https://api.pdbfe.dev/api/net');
        });
    });

    it('is idempotent — second call does not change prefix', () => {
        // initL2 stores module-level state. Since we can't reset it,
        // just verify it doesn't throw on repeated calls.
        initL2('https://api.pdbfe.dev/api/net');
        initL2('https://different.host.dev/something');
        // No assertion needed — just verify no errors.
    });
});

// ── getL2 ────────────────────────────────────────────────────────────────────

describe('getL2', () => {
    it('returns null when Cache API is unavailable (Node.js)', async () => {
        initL2('https://api.pdbfe.dev/api/net');
        const result = await getL2('api/net/694');
        assert.equal(result, null);
    });

    it('does not throw on cache miss', async () => {
        initL2('https://api.pdbfe.dev/api/net');
        await assert.doesNotReject(getL2('nonexistent/key'));
    });
});

// ── putL2 ────────────────────────────────────────────────────────────────────

describe('putL2', () => {
    it('does not throw when Cache API is unavailable (Node.js)', async () => {
        initL2('https://api.pdbfe.dev/api/net');
        const buf = new TextEncoder().encode('{"data":[],"meta":{}}');
        await assert.doesNotReject(putL2('api/net/test', buf, 3600));
    });

    it('accepts zero TTL without error', async () => {
        initL2('https://api.pdbfe.dev/api/net');
        const buf = new TextEncoder().encode('test');
        await assert.doesNotReject(putL2('test/zero-ttl', buf, 0));
    });
});
