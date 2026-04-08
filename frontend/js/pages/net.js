/**
 * @fileoverview Network detail page renderer.
 * Displays network info, peering policy, contacts, exchange points table,
 * and interconnection facilities table.
 */

import { fetchEntity } from '../api.js';
import {
    renderField, renderFieldGroup, renderTableCard,
    renderLoading, renderError, renderBool,
    linkEntity, formatSpeed, escapeHTML, setOGTags,
    attachTableSort, attachTableFilter, attachTablePaging
} from '../render.js';
import { t } from '../i18n.js';

/**
 * Renders the network detail page.
 *
 * @param {Record<string, string>} params - Route params, expects { id: string }.
 */
export async function renderNet(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const id = params.id;

    document.title = `Network — PeeringDB`;
    app.innerHTML = renderLoading('Loading network');

    try {
        const net = await fetchEntity('net', id, 2);
        if (!net) {
            app.innerHTML = renderError(`Network ${id} not found`);
            return;
        }

        document.title = `${net.name} (AS${net.asn}) — PeeringDB`;
        setOGTags(
            `${net.name} (AS${net.asn})`,
            `${net.info_type || 'Network'} — ${net.policy_general || 'Peering policy not listed'}`
        );

        const sidebar = buildSidebar(net);
        const tables = buildTables(net);

        app.innerHTML = `
            <div class="detail-layout">
                <div class="detail-header">
                    <h1 class="detail-header__title">${escapeHTML(net.name)}</h1>
                    <span class="detail-header__subtitle">AS${net.asn}</span>
                </div>
                <div class="detail-sidebar">${sidebar}</div>
                <div class="detail-main">${tables}</div>
            </div>
        `;

        attachTableSort(app);
        attachTableFilter(app);
        attachTablePaging(app);
    } catch (err) {
        app.innerHTML = renderError(`Failed to load network: ${err.message}`);
    }
}

/**
 * Builds the info sidebar HTML for a network.
 *
 * @param {any} net - Network entity object.
 * @returns {string} HTML string.
 */
function buildSidebar(net) {
    const general = renderFieldGroup('General', [
        renderField('Organization', net.org_name || net.org_id, { linkType: 'org', linkId: net.org_id }),
        renderField('ASN', net.asn),
        renderField('IRR Record', net.irr_as_set),
        renderField('Website', net.website, { href: net.website, external: true }),
        renderField('Looking Glass', net.looking_glass, { href: net.looking_glass, external: true }),
        renderField('Route Server', net.route_server, { href: net.route_server, external: true }),
        renderField('Network Type', net.info_type, { translate: true }),
        renderField('Traffic Levels', net.info_traffic, { translate: true }),
        renderField('Traffic Ratios', net.info_ratio, { translate: true }),
        renderField('Scope', net.info_scope, { translate: true }),
        renderField('Unicast Prefixes', net.info_prefixes4 || net.info_prefixes6
            ? `${net.info_prefixes4 || 0} IPv4 / ${net.info_prefixes6 || 0} IPv6` : null),
        renderField('IPv6', net.info_ipv6 ? t('Yes') : t('No')),
        renderField('Multicast', net.info_multicast ? t('Yes') : t('No')),
        renderField('Last Updated', net.updated),
    ]);

    const policy = renderFieldGroup('Peering Policy', [
        renderField('General Policy', net.policy_general, { translate: true }),
        renderField('Policy URL', net.policy_url, { href: net.policy_url, external: true }),
        renderField('Ratio Requirement', net.policy_ratio ? t('Yes') : t('No')),
        renderField('Contract Requirement', net.policy_contracts ? t('Yes') : t('No')),
        renderField('Locations', net.policy_locations, { translate: true }),
    ]);

    let contacts = '';
    if (net.poc_set && net.poc_set.length > 0) {
        const fields = net.poc_set.map(/** @param {any} poc */ (poc) => {
            const parts = [escapeHTML(poc.role || 'Contact')];
            if (poc.name) parts.push(escapeHTML(poc.name));
            if (poc.email) parts.push(`<a href="mailto:${escapeHTML(poc.email)}">${escapeHTML(poc.email)}</a>`);
            if (poc.phone) parts.push(escapeHTML(poc.phone));
            return `<div class="info-field">
                <span class="info-field__label">${/* safe — built from escapeHTML() */ parts[0]}</span>
                <span class="info-field__value">${/* safe — built from escapeHTML() */ parts.slice(1).join(' · ')}</span>
            </div>`;
        });
        contacts = renderFieldGroup('Contacts', fields);
    }

    return [general, policy, contacts].filter(s => s).join('');
}

/**
 * Builds the data tables (exchange points + facilities) for a network.
 *
 * @param {any} net - Network entity object.
 * @returns {string} HTML string.
 */
function buildTables(net) {
    let ixTable = '';
    if (net.netixlan_set && net.netixlan_set.length > 0) {
        ixTable = renderTableCard({
            title: 'Exchange Points',
            filterable: true,
            filterPlaceholder: t('Filter exchanges...'),
            columns: [
                { key: 'name',    label: 'Exchange' },
                { key: 'speed',   label: 'Speed', class: 'td-right' },
                { key: 'ipaddr4', label: 'IPv4', class: 'td-mono' },
                { key: 'ipaddr6', label: 'IPv6', class: 'td-mono' },
                { key: 'is_rs_peer', label: 'RS' },
            ],
            rows: net.netixlan_set,
            cellRenderer: (row, col) => {
                switch (col.key) {
                    case 'name': return linkEntity('ix', row.ix_id, row.name || `IX ${row.ix_id}`);
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
    if (net.netfac_set && net.netfac_set.length > 0) {
        facTable = renderTableCard({
            title: 'Facilities',
            filterable: true,
            filterPlaceholder: t('Filter facilities...'),
            columns: [
                { key: 'name',    label: 'Facility' },
                { key: 'city',    label: 'City' },
                { key: 'country', label: 'Country' },
            ],
            rows: net.netfac_set,
            cellRenderer: (row, col) => {
                if (col.key === 'name') return linkEntity('fac', row.fac_id, row.name || `Fac ${row.fac_id}`);
                return escapeHTML(String(row[col.key] ?? '—'));
            }
        });
    }

    return [ixTable, facTable].filter(s => s).join('') || `<div class="empty-state">${escapeHTML(t('No exchange points or facilities'))}</div>`;
}
