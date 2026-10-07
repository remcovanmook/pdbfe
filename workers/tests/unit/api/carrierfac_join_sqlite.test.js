/**
 * @fileoverview fac depth=2 carrierfac_set carries `carrier_name` (join on
 * peeringdb_carrier, from entity-overrides.json), like netfac_set's
 * net_name and ixfac_set's ix_name — the facility page lists carriers by
 * name without a second request.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteD1, registerAssetLoader, envFor, mockCtx } from '../../lib/sqlite_d1.js';

registerAssetLoader();
const { default: apiWorker } = await import('../../../api/index.js');

const TS = '2026-01-01T00:00:00Z';
/** @type {any} */
let env;

before(() => {
    const { sqlite, db } = createSqliteD1();
    sqlite.exec(`INSERT INTO "peeringdb_organization" (id, name, social_media, status, created, updated) VALUES (1, 'Org', '[]', 'ok', '${TS}', '${TS}')`);
    sqlite.exec(`INSERT INTO "peeringdb_facility" (id, org_id, name, social_media, available_voltage_services, status, created, updated) VALUES (1, 1, 'Fac One', '[]', '[]', 'ok', '${TS}', '${TS}')`);
    const carrier = sqlite.prepare(`INSERT INTO "peeringdb_carrier" (id, org_id, name, social_media, status, created, updated) VALUES (?, 1, ?, '[]', 'ok', '${TS}', '${TS}')`);
    carrier.run(4, 'Carrier Four');
    carrier.run(30, 'Carrier Thirty');
    const cf = sqlite.prepare(`INSERT INTO "peeringdb_ix_carrier_facility" (id, carrier_id, fac_id, status, created, updated) VALUES (?, ?, 1, 'ok', '${TS}', '${TS}')`);
    cf.run(8, 4);
    cf.run(189, 30);
    env = envFor(db);
});

describe('carrierfac carrier_name join', () => {
    it('fac depth=2 carrierfac_set includes carrier_name', async () => {
        const res = await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/fac/1?depth=2'), env, mockCtx);
        assert.equal(res.status, 200);
        const fac = (await res.json()).data[0];
        assert.deepEqual(
            fac.carrierfac_set.map((/** @type {any} */ c) => [c.carrier_id, c.carrier_name]),
            [[4, 'Carrier Four'], [30, 'Carrier Thirty']],
        );
    });

    it('carrierfac depth=0 keeps upstream columns only', async () => {
        const res = await apiWorker.fetch(new Request('https://api.pdbfe.dev/api/carrierfac?fac_id=1'), env, mockCtx);
        const rows = (await res.json()).data;
        assert.equal(rows.length, 2);
        assert.equal('carrier_name' in rows[0], false);
    });
});
