/**
 * @fileoverview Exchange detail page renderer.
 * Displays IX info, stats bar, LAN prefixes, contacts,
 * peer table (via secondary /api/netixlan query), and local facilities.
 *
 * Uses DOM-based rendering via Web Components (<pdb-table>,
 * <pdb-field-group>) and the createField/createLink builders.
 */

import { fetchEntity, fetchIxPeers, fetchList } from '../api.js';
import {
    createField, createFieldGroup, createLink, createBool,
    createLoading, createError, createEmptyState,
    createStatsBar, createDetailLayout,
    formatSpeed, setOGTags
} from '../render.js';
import { t } from '../i18n.js';

/**
 * Renders the exchange detail page.
 *
 * @param {Record<string, string>} params - Route params, expects { id: string }.
 */
export async function renderIx(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const id = params.id;

    document.title = `Exchange — PeeringDB`;
    app.replaceChildren(createLoading('Loading exchange'));

    try {
        const ix = await fetchEntity('ix', id, 2);

        if (!ix) {
            app.replaceChildren(createError(`Exchange ${id} not found`));
            return;
        }

        // Fetch peers and LAN prefixes in parallel.
        // ixpfx is a child of ixlan (not ix), so depth=2 on ix doesn't
        // include them — we need a separate query using the ixlan_id.
        const ixlanId = ix.ixlan_set?.[0]?.id;
        const [peers, prefixes] = await Promise.all([
            fetchIxPeers(id),
            ixlanId ? fetchList('ixpfx', { ixlan_id: ixlanId }) : Promise.resolve([]),
        ]);

        // Attach prefixes so the sidebar renderer picks them up
        ix.ixpfx_set = prefixes;

        document.title = `${ix.name} — PeeringDB`;

        // Compute stats from peer table
        const totalPeers = new Set(peers.map(p => p.asn)).size;
        const totalConnections = peers.length;
        const totalSpeed = peers.reduce((sum, p) => sum + (p.speed || 0), 0);
        const openPeers = new Set(peers.filter(p => p.operational).map(p => p.asn)).size;
        const ipv6Count = peers.filter(p => p.ipaddr6).length;
        const ipv6Pct = totalConnections > 0
            ? `${Math.round((ipv6Count / totalConnections) * 100)}%`
            : '—';

        const location = (ix.city || '') + (ix.country ? `, ${ix.country}` : '');

        setOGTags(
            ix.name,
            `${location} — ${totalPeers.toLocaleString()} Peers, ${formatSpeed(totalSpeed)} Total Speed`
        );

        const statsBar = createStatsBar([
            { label: 'Peers', value: totalPeers.toLocaleString() },
            { label: 'Connections', value: totalConnections.toLocaleString() },
            { label: 'Open Peers', value: openPeers.toLocaleString() },
            { label: 'Total Speed', value: formatSpeed(totalSpeed) },
            { label: 'IPv6', value: ipv6Pct },
        ]);

        const subtitle = location;

        app.replaceChildren(createDetailLayout({
            title: ix.name,
            subtitle,
            logoUrl: ix.logo || ix.org?.logo || null,
            logoMigrated: Boolean(ix.logo ? ix.__logo_migrated : ix.org?.__logo_migrated),
            entityType: 'ix',
            entityId: ix.id,
            statsBar,
            sidebar: buildSidebar(ix),
            main: buildTables(ix, peers),
        }));
    } catch (err) {
        app.replaceChildren(createError(`Failed to load exchange: ${err.message}`));
    }
}

/**
 * Builds the sidebar info for an IX as a DocumentFragment.
 *
 * @param {any} ix - Exchange entity object.
 * @returns {DocumentFragment} Sidebar content fragment.
 */
function buildSidebar(ix) {
    const frag = document.createDocumentFragment();

    const general = createFieldGroup('General', [
        createField('Organization', ix.org_name || ix.org_id, { linkType: 'org', linkId: ix.org_id }),
        createField('City', ix.city, { map: [ix.city, ix.country].filter(Boolean).join(', ') }),
        createField('Country', ix.country),
        createField('Region', ix.region_continent, { translate: true }),
        createField('Media Type', ix.media, { translate: true }),
        createField('Service Level', ix.service_level, { translate: true }),
        createField('Terms', ix.terms, { translate: true }),
        createField('Website', ix.website, { href: ix.website, external: true }),
        createField('URL Stats', ix.url_stats, { href: ix.url_stats, external: true }),
        createField('Tech Email', ix.tech_email, { email: true }),
        createField('Tech Phone', ix.tech_phone),
        createField('Policy Email', ix.policy_email, { email: true }),
        createField('Policy Phone', ix.policy_phone),
        createField('Notes', ix.notes, { markdown: true }),
        createField('Last Updated', ix.updated, { date: true }),
    ]);
    if (general) frag.appendChild(general);

    // LAN parameters from ixlan_set — 1:1 relationship with IX.
    // Surfaces MTU, route server ASN, 802.1Q support, and the
    // IX-F Member Export URL when publicly visible.
    const lan = ix.ixlan_set?.[0];
    if (lan) {
        /** @type {Array<HTMLElement|null>} */
        const lanFields = [
            createField('MTU', lan.mtu),
        ];

        // 802.1Q support — uses createBool for the yes/no badge
        const dot1qField = createField('802.1Q', lan.dot1q_support != null ? ' ' : null);
        if (dot1qField) {
            const valueEl = dot1qField.querySelector('.info-field__value');
            if (valueEl) {
                valueEl.textContent = '';
                valueEl.appendChild(createBool(lan.dot1q_support));
            }
        }
        lanFields.push(dot1qField);

        if (lan.rs_asn) {
            lanFields.push(createField('Route Server ASN', lan.rs_asn));
        }

        // Only show the IX-F URL when visibility is Public
        if (lan.ixf_ixp_member_list_url_visible === 'Public' && lan.ixf_ixp_member_list_url) {
            lanFields.push(createField('IX-F Member Export', lan.ixf_ixp_member_list_url, {
                href: lan.ixf_ixp_member_list_url, external: true
            }));
        }

        const lanGroup = createFieldGroup('LAN', lanFields);
        if (lanGroup) frag.appendChild(lanGroup);
    }

    // LAN Prefixes
    if (ix.ixpfx_set && ix.ixpfx_set.length > 0) {
        const pfxFields = ix.ixpfx_set.map(/** @param {any} pfx */ (pfx) =>
            createField(pfx.protocol === 'IPv6' ? 'IPv6 Prefix' : 'IPv4 Prefix', pfx.prefix)
        );
        const pfxGroup = createFieldGroup('LAN Prefixes', pfxFields);
        if (pfxGroup) frag.appendChild(pfxGroup);
    }

    return frag;
}

/**
 * Builds the peer table and local facilities table as a DocumentFragment.
 *
 * @param {any} ix - Exchange entity object.
 * @param {any[]} peers - netixlan records for this IX.
 * @returns {DocumentFragment} Tables fragment.
 */
function buildTables(ix, peers) {
    const frag = document.createDocumentFragment();

    // Build facility lookup: fac_id → {name, fac_id} for resolving
    // netixlan.ix_side_id (which is a fac_id) to facility name.
    /** @type {Map<number, {name: string, fac_id: number}>} */
    const ixfacMap = new Map();
    for (const f of ix.ixfac_set || []) {
        ixfacMap.set(f.fac_id, { name: f.name || `Facility ${f.fac_id}`, fac_id: f.fac_id });
    }
    if (peers.length > 0) {
        // Only show Facility column when ix_side_id data exists
        const hasFacData = peers.some(p => p.ix_side_id);

        /** @type {TableColumn[]} */
        const columns = [
            { key: 'name',       label: 'Network' },
            { key: 'asn',        label: 'ASN', class: 'td-right', width: '80px' },
            { key: 'speed',      label: 'Speed', class: 'td-right', width: '90px' },
        ];
        if (hasFacData) {
            columns.push({ key: 'facility', label: 'Facility' });
        }
        columns.push(
            { key: 'ip',         label: 'IP Address', class: 'td-mono' },
            { key: 'is_rs_peer', label: 'RS', width: '70px' },
        );

        const peerTable = /** @type {HTMLElement & {configure: Function}} */ (
            document.createElement('pdb-table')
        );
        peerTable.configure({
            tableId: 'peers',
            title: 'Connections',
            filterable: true,
            filterPlaceholder: t('Filter by name or ASN...'),
            columns,
            rows: peers,
            cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
                switch (col.key) {
                    case 'name': {
                        const label = row.net_name || `AS${row.asn}`;
                        return row.net_id
                            ? createLink('net', row.net_id, label)
                            : document.createTextNode(label);
                    }
                    case 'asn':
                        return document.createTextNode(String(row.asn || ''));
                    case 'speed':
                        return {
                            node: document.createTextNode(formatSpeed(row.speed)),
                            sortValue: row.speed || 0
                        };
                    case 'ip': {
                        const wrap = document.createElement('span');
                        wrap.className = 'ip-stack';
                        if (row.ipaddr4) {
                            const v4 = document.createElement('span');
                            v4.textContent = row.ipaddr4;
                            wrap.appendChild(v4);
                        }
                        if (row.ipaddr6) {
                            const v6 = document.createElement('span');
                            v6.textContent = row.ipaddr6;
                            wrap.appendChild(v6);
                        }
                        if (!row.ipaddr4 && !row.ipaddr6) {
                            wrap.textContent = '—';
                        }
                        return wrap;
                    }
                    case 'facility': {
                        const fac = ixfacMap.get(row.ix_side_id);
                        if (!fac) return document.createTextNode('—');
                        return createLink('fac', fac.fac_id, fac.name);
                    }
                    case 'is_rs_peer':
                        return createBool(row.is_rs_peer);
                    default:
                        return document.createTextNode(String(row[col.key] ?? ''));
                }
            }
        });
        frag.appendChild(peerTable);
    }

    if (ix.ixfac_set && ix.ixfac_set.length > 0) {
        const facTable = /** @type {HTMLElement & {configure: Function}} */ (
            document.createElement('pdb-table')
        );
        facTable.configure({
            tableId: 'fac',
            title: 'Local Facilities',
            filterable: true,
            filterPlaceholder: t('Filter facilities...'),
            columns: [
                { key: 'name',    label: 'Facility' },
                { key: 'city',    label: 'City', maxWidth: '250px' },
                { key: 'country', label: 'Country', maxWidth: '100px' },
            ],
            rows: ix.ixfac_set,
            cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
                if (col.key === 'name') {
                    return createLink('fac', row.fac_id, row.name || `Fac ${row.fac_id}`);
                }
                return document.createTextNode(String(row[col.key] ?? '—'));
            }
        });
        frag.appendChild(facTable);
    }

    if (frag.children.length === 0) {
        frag.appendChild(createEmptyState('No peers or facilities'));
    }

    return frag;
}
