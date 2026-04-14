/**
 * @fileoverview ASN redirect handler.
 * Looks up a network by its Autonomous System Number and redirects
 * to the network detail page. Supports both bare ASN numbers and
 * AS-prefixed input (e.g. "AS13335" or "13335").
 */

import { fetchByAsn } from '../api.js';
import { createLoading, createError } from '../render.js';
import { navigate } from '../router.js';

/**
 * Handles the /asn/:asn route. Strips an optional "AS" prefix,
 * looks up the network by ASN, and redirects to /net/{id}.
 * Replaces the current history entry so Back skips this intermediary page.
 *
 * @param {Record<string, string>} params - Route params, expects { asn: string }.
 */
export async function renderAsn(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));

    // Strip optional AS/as prefix
    const raw = (params.asn || '').replace(/^as/i, '');
    const asn = Number.parseInt(raw, 10);

    if (Number.isNaN(asn) || asn <= 0) {
        app.replaceChildren(createError(`Invalid ASN: ${params.asn}`));
        document.title = 'Invalid ASN — PeeringDB';
        return;
    }

    document.title = `AS${asn} — PeeringDB`;
    app.replaceChildren(createLoading(`Looking up AS${asn}`));

    try {
        const net = await fetchByAsn(asn);
        if (net) {
            // Replace history entry so Back doesn't return to this redirect page
            window.history.replaceState(null, '', `/net/${net.id}`);
            navigate(`/net/${net.id}`);
        } else {
            app.replaceChildren(createError(`No network found for AS${asn}`));
        }
    } catch (err) {
        app.replaceChildren(createError(`Failed to look up AS${asn}: ${err.message}`));
    }
}
