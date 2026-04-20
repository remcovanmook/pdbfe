/**
 * @fileoverview Network detail page renderer.
 * Displays network info, peering policy, contacts, exchange points table,
 * and interconnection facilities table.
 *
 * Uses DOM-based rendering via Web Components (<pdb-table>) and the
 * createField/createLink builders.
 */

import { fetchEntity } from '../api.js';
import {
    createField, createFieldGroup, createLink, createBool,
    createLoading, createError, createEmptyState,
    createDetailLayout, formatSpeed, setOGTags
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

    document.title = `Network — PDBFE`;
    app.replaceChildren(createLoading(t('Loading network')));

    try {
        const net = await fetchEntity('net', id, 2);

        if (!net) {
            app.replaceChildren(createError(t('Network {id} not found', { id })));
            return;
        }

        document.title = `${net.name} (AS${net.asn}) — PDBFE`;
        setOGTags(
            `${net.name} (AS${net.asn})`,
            `${net.info_type || 'Network'} — ${net.policy_general || 'Peering policy not listed'}`
        );

        const locationData = (net.netfac_set || []).filter((/** @type {any} */ f) => (typeof f.latitude === 'number' && typeof f.longitude === 'number') || (f.address1 && f.city)).map((/** @type {any} */ f) => ({
            lat: f.latitude, 
            lon: f.longitude, 
            address: [f.address1, f.city, f.country].filter(Boolean).join(', '),
            name: f.name || `Facility ${f.fac_id}`
        }));

        app.replaceChildren(createDetailLayout({
            title: net.name,
            subtitle: `AS${net.asn}`,
            logoUrl: net.logo || net.org?.logo || null,
            logoMigrated: Boolean(net.logo ? net.__logo_migrated : net.org?.__logo_migrated),
            entityType: 'net',
            entityId: net.id,
            sidebar: buildSidebar(net),
            main: buildTables(net),
            locations: locationData.length > 0 ? { fac: locationData } : undefined
        }));
    } catch (err) {
        app.replaceChildren(createError(`Failed to load network: ${err.message}`));
    }
}

/**
 * Builds the info sidebar for a network as a DocumentFragment.
 *
 * @param {any} net - Network entity object.
 * @returns {DocumentFragment} Sidebar content fragment.
 */
function buildSidebar(net) {
    const frag = document.createDocumentFragment();

    const general = createFieldGroup('General', [
        createField('Organization', net.org_name || net.org_id, { linkType: 'org', linkId: net.org_id }),
        createField('ASN', net.asn),
        createField('IRR Record', net.irr_as_set),
        createField('Website', net.website, { href: net.website, external: true }),
        createField('Looking Glass', net.looking_glass, { href: net.looking_glass, external: true }),
        createField('Route Server', net.route_server, { href: net.route_server, external: true }),
        createField('Network Type', net.info_type, { translate: true }),
        createField('Traffic Levels', net.info_traffic, { translate: true }),
        createField('Traffic Ratios', net.info_ratio, { translate: true }),
        createField('Scope', net.info_scope, { translate: true }),
        createField('Unicast Prefixes', net.info_prefixes4 || net.info_prefixes6
            ? `${net.info_prefixes4 || 0} IPv4 / ${net.info_prefixes6 || 0} IPv6` : null),
        createField('IPv6', net.info_ipv6 ? t('Yes') : t('No')),
        createField('Multicast', net.info_multicast ? t('Yes') : t('No')),
        createField('Last Updated', net.updated, { date: true }),
    ]);
    if (general) frag.appendChild(general);

    const policy = createFieldGroup('Peering Policy', [
        createField('General Policy', net.policy_general, { translate: true }),
        createField('Policy URL', net.policy_url, { href: net.policy_url, external: true }),
        createField('Ratio Requirement', net.policy_ratio ? t('Yes') : t('No')),
        createField('Contract Requirement', net.policy_contracts ? t('Yes') : t('No')),
        createField('Locations', net.policy_locations, { translate: true }),
    ]);
    if (policy) frag.appendChild(policy);

    // Contacts (poc_set)
    if (net.poc_set && net.poc_set.length > 0) {
        const contactFields = net.poc_set.map(/** @param {any} poc */ (poc) => {
            const field = createField(poc.role || 'Contact', ' ');
            if (!field) return null;

            const valueEl = /** @type {HTMLSpanElement} */ (field.querySelector('.info-field__value'));
            valueEl.textContent = '';

            const parts = [];
            if (poc.name) parts.push(poc.name);

            if (poc.email) {
                const a = document.createElement('a');
                a.href = `mailto:${poc.email}`;
                a.textContent = poc.email;
                parts.push(a);
            }

            if (poc.phone) parts.push(poc.phone);

            for (let i = 0; i < parts.length; i++) {
                if (i > 0) valueEl.appendChild(document.createTextNode(' · '));
                if (typeof parts[i] === 'string') {
                    valueEl.appendChild(document.createTextNode(parts[i]));
                } else {
                    valueEl.appendChild(parts[i]);
                }
            }

            return field;
        });

        const contacts = createFieldGroup('Contacts', contactFields);
        if (contacts) frag.appendChild(contacts);
    }

    return frag;
}

/**
 * Builds the data tables (exchange points + facilities) for a network.
 *
 * @param {any} net - Network entity object.
 * @returns {DocumentFragment} Tables fragment.
 */
function buildTables(net) {
    const frag = document.createDocumentFragment();

    if (net.netixlan_set && net.netixlan_set.length > 0) {
        const ixTable = /** @type {any} */ (document.createElement('pdb-table'));
        ixTable.configure({
            tableId: 'ix',
            title: 'Exchange Points',
            filterable: true,
            filterPlaceholder: t('Filter exchanges...'),
            columns: [
                { key: 'name',    label: t('Exchange') },
                { key: 'speed',   label: t('Speed'), class: 'td-right', width: '90px' },
                { key: 'ipaddr4', label: t('IPv4'), class: 'td-mono', width: '140px' },
                { key: 'ipaddr6', label: t('IPv6'), class: 'td-mono', width: '240px' },
                { key: 'is_rs_peer', label: t('RS'), width: '70px' },
            ],
            rows: net.netixlan_set,
            cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
                switch (col.key) {
                    case 'name':
                        return createLink('ix', row.ix_id, row.name || `IX ${row.ix_id}`);
                    case 'speed':
                        return { node: document.createTextNode(formatSpeed(row.speed)), sortValue: row.speed || 0 };
                    case 'ipaddr4':
                        return document.createTextNode(row.ipaddr4 || '—');
                    case 'ipaddr6':
                        return document.createTextNode(row.ipaddr6 || '—');
                    case 'is_rs_peer':
                        return createBool(row.is_rs_peer);
                    default:
                        return document.createTextNode(String(row[col.key] ?? ''));
                }
            }
        });
        frag.appendChild(ixTable);
    }

    if (net.netfac_set && net.netfac_set.length > 0) {
        const facTable = /** @type {any} */ (document.createElement('pdb-table'));
        facTable.configure({
            tableId: 'fac',
            title: 'Facilities',
            filterable: true,
            filterPlaceholder: t('Filter facilities...'),
            columns: [
                { key: 'name',    label: t('Facility') },
                { key: 'city',    label: t('City'), maxWidth: '250px' },
                { key: 'country', label: t('Country'), maxWidth: '100px' },
            ],
            rows: net.netfac_set,
            cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
                if (col.key === 'name') return createLink('fac', row.fac_id, row.name || `Fac ${row.fac_id}`);
                return document.createTextNode(String(row[col.key] ?? '—'));
            }
        });
        frag.appendChild(facTable);
    }

    if (frag.children.length === 0) {
        frag.appendChild(createEmptyState(t('No exchange points or facilities')));
    }

    return frag;
}
