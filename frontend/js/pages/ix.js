/**
 * @fileoverview Exchange detail page renderer.
 * Displays IX info, stats bar, LAN prefixes, contacts,
 * peer table (via secondary /api/netixlan query), and local facilities.
 */

import { fetchEntity, fetchIxPeers } from '../api.js';
import {
    renderField, renderFieldGroup, renderTableCard, renderStatsBar,
    renderLoading, renderError, renderBool,
    linkEntity, formatSpeed, escapeHTML, setOGTags,
    attachTableSort, attachTableFilter, attachTablePaging
} from '../render.js';

/**
 * Renders the exchange detail page.
 *
 * @param {Record<string, string>} params - Route params, expects { id: string }.
 */
export async function renderIx(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const id = params.id;

    document.title = `Exchange — PeeringDB`;
    app.innerHTML = renderLoading('Loading exchange');

    try {
        // Parallel fetch: IX entity + peer table
        const [ix, peers] = await Promise.all([
            fetchEntity('ix', id, 2),
            fetchIxPeers(id)
        ]);

        if (!ix) {
            app.innerHTML = renderError(`Exchange ${id} not found`);
            return;
        }

        document.title = `${ix.name} — PeeringDB`;

        // Compute stats from peer table
        const totalPeers = new Set(peers.map(p => p.asn)).size;
        const totalConnections = peers.length;
        const totalSpeed = peers.reduce((sum, p) => sum + (p.speed || 0), 0);
        const openPeers = new Set(peers.filter(p => p.operational).map(p => p.asn)).size;

        setOGTags(
            ix.name,
            `${ix.city || ''}${ix.country ? `, ${ix.country}` : ''} — ${totalPeers.toLocaleString()} Peers, ${formatSpeed(totalSpeed)} Total Speed`
        );

        const statsBar = renderStatsBar([
            { label: 'Peers', value: totalPeers.toLocaleString() },
            { label: 'Connections', value: totalConnections.toLocaleString() },
            { label: 'Open Peers', value: openPeers.toLocaleString() },
            { label: 'Total Speed', value: formatSpeed(totalSpeed) },
        ]);

        const sidebar = buildSidebar(ix);
        const tables = buildTables(ix, peers);

        app.innerHTML = `
            <div class="detail-layout">
                <div class="detail-header">
                    <h1 class="detail-header__title">${escapeHTML(ix.name)}</h1>
                    <span class="detail-header__subtitle">${escapeHTML(ix.city || '')}${ix.country ? `, ${escapeHTML(ix.country)}` : ''}</span>
                </div>
                <div style="grid-column: 1 / -1">${statsBar}</div>
                <div class="detail-sidebar">${sidebar}</div>
                <div class="detail-main">${tables}</div>
            </div>
        `;

        attachTableSort(app);
        attachTableFilter(app);
        attachTablePaging(app);
    } catch (err) {
        app.innerHTML = renderError(`Failed to load exchange: ${err.message}`);
    }
}

/**
 * Builds the sidebar info for an IX.
 *
 * @param {any} ix - Exchange entity object.
 * @returns {string} HTML string.
 */
function buildSidebar(ix) {
    const general = renderFieldGroup('General', [
        renderField('Organization', ix.org_name || ix.org_id, { linkType: 'org', linkId: ix.org_id }),
        renderField('City', ix.city),
        renderField('Country', ix.country),
        renderField('Region', ix.region_continent),
        renderField('Media Type', ix.media),
        renderField('Service Level', ix.service_level),
        renderField('Terms', ix.terms),
        renderField('Website', ix.website, { href: ix.website, external: true }),
        renderField('URL Stats', ix.url_stats, { href: ix.url_stats, external: true }),
        renderField('Tech Email', ix.tech_email),
        renderField('Tech Phone', ix.tech_phone),
        renderField('Policy Email', ix.policy_email),
        renderField('Policy Phone', ix.policy_phone),
        renderField('Notes', ix.notes, { markdown: true }),
        renderField('Last Updated', ix.updated),
    ]);

    let prefixes = '';
    if (ix.ixpfx_set && ix.ixpfx_set.length > 0) {
        const pfxFields = ix.ixpfx_set.map(/** @param {any} pfx */ (pfx) =>
            renderField(pfx.protocol === 'IPv6' ? 'IPv6 Prefix' : 'IPv4 Prefix', pfx.prefix)
        );
        prefixes = renderFieldGroup('LAN Prefixes', pfxFields);
    }

    return [general, prefixes].filter(s => s).join('');
}

/**
 * Builds the peer table and local facilities table.
 *
 * @param {any} ix - Exchange entity object.
 * @param {any[]} peers - netixlan records for this IX.
 * @returns {string} HTML string.
 */
function buildTables(ix, peers) {
    let peerTable = '';
    if (peers.length > 0) {
        peerTable = renderTableCard({
            title: 'Peers',
            filterable: true,
            filterPlaceholder: 'Filter by name or ASN...',
            columns: [
                { key: 'name',       label: 'Network' },
                { key: 'asn',        label: 'ASN', class: 'td-right' },
                { key: 'speed',      label: 'Speed', class: 'td-right' },
                { key: 'ipaddr4',    label: 'IPv4', class: 'td-mono' },
                { key: 'ipaddr6',    label: 'IPv6', class: 'td-mono' },
                { key: 'is_rs_peer', label: 'RS' },
            ],
            rows: peers,
            cellRenderer: (row, col) => {
                switch (col.key) {
                    // Use net_name from the API's JOIN response.
                    // Fall back to AS{asn} if not available.
                    case 'name': {
                        const label = row.net_name || `AS${row.asn}`;
                        return row.net_id
                            ? linkEntity('net', row.net_id, label)
                            : escapeHTML(label);
                    }
                    case 'asn': return String(row.asn || '');
                    case 'speed': return { html: formatSpeed(row.speed), sortValue: row.speed || 0 };
                    case 'ipaddr4': return row.ipaddr4 ? escapeHTML(row.ipaddr4) : '—';
                    case 'ipaddr6': return row.ipaddr6 ? escapeHTML(row.ipaddr6) : '—';
                    case 'is_rs_peer': return renderBool(row.is_rs_peer);
                    default: return escapeHTML(String(row[col.key] ?? ''));
                }
            }
        });
    }

    let facTable = '';
    if (ix.fac_set && ix.fac_set.length > 0) {
        facTable = renderTableCard({
            title: 'Local Facilities',
            columns: [
                { key: 'name',    label: 'Facility' },
                { key: 'city',    label: 'City' },
                { key: 'country', label: 'Country' },
            ],
            rows: ix.fac_set,
            cellRenderer: (row, col) => {
                if (col.key === 'name') return linkEntity('fac', row.id, row.name || `Fac ${row.id}`);
                return escapeHTML(String(row[col.key] ?? '—'));
            }
        });
    }

    return [peerTable, facTable].filter(s => s).join('') || '<div class="empty-state">No peers or facilities</div>';
}
