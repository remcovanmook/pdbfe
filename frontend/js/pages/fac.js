/**
 * @fileoverview Facility detail page renderer.
 * Displays facility info, networks present, and exchanges at the facility.
 *
 * Uses DOM-based rendering via Web Components (<pdb-table>) and
 * createField/createLink builders.
 */

import { fetchEntity } from '../api.js';
import {
    createField, createFieldGroup, createLink,
    createLoading, createError, createEmptyState,
    createDetailLayout, setOGTags
} from '../render.js';
import { t } from '../i18n.js';

/**
 * Renders the facility detail page.
 *
 * @param {Record<string, string>} params - Route params, expects { id: string }.
 */
export async function renderFac(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const id = params.id;

    document.title = `Facility — PeeringDB`;
    app.replaceChildren(createLoading('Loading facility'));

    try {
        const fac = await fetchEntity('fac', id, 2);
        if (!fac) {
            app.replaceChildren(createError(`Facility ${id} not found`));
            return;
        }

        const location = (fac.city || '') + (fac.country ? `, ${fac.country}` : '');

        document.title = `${fac.name} — PeeringDB`;
        setOGTags(
            fac.name,
            `Facility — ${location}`
        );

        const subtitle = location;

        app.replaceChildren(createDetailLayout({
            title: fac.name,
            subtitle,
            logoUrl: fac.logo || fac.org?.logo || null,
            entityType: 'fac',
            entityId: fac.id,
            sidebar: buildSidebar(fac),
            main: buildTables(fac),
        }));
    } catch (err) {
        app.replaceChildren(createError(`Failed to load facility: ${err.message}`));
    }
}

/**
 * Builds the info sidebar for a facility as a DocumentFragment.
 *
 * @param {any} fac - Facility entity object.
 * @returns {DocumentFragment} Sidebar content fragment.
 */
function buildSidebar(fac) {
    const frag = document.createDocumentFragment();

    const general = createFieldGroup('General', [
        createField('Organization', fac.org_name || fac.org_id, { linkType: 'org', linkId: fac.org_id }),
        createField('Website', fac.website, { href: fac.website, external: true }),
        createField('CLLI', fac.clli),
        createField('Rencode', fac.rencode),
        createField('NPA-NXX', fac.npanxx),
        createField('Notes', fac.notes, { markdown: true }),
        createField('Last Updated', fac.updated, { date: true }),
    ]);
    if (general) frag.appendChild(general);

    const facMapQuery = fac.latitude && fac.longitude
        ? `${fac.latitude},${fac.longitude}`
        : [fac.address1, fac.city, fac.country].filter(Boolean).join(', ');

    const address = createFieldGroup('Location', [
        createField('Address', fac.address1),
        createField('Address 2', fac.address2),
        createField('City', fac.city, { map: facMapQuery }),
        createField('State', fac.state),
        createField('Postal Code', fac.zipcode),
        createField('Country', fac.country),
        createField('Latitude', fac.latitude),
        createField('Longitude', fac.longitude),
    ]);
    if (address) frag.appendChild(address);

    return frag;
}

/**
 * Builds the data tables (networks + exchanges) for a facility.
 *
 * @param {any} fac - Facility entity object.
 * @returns {DocumentFragment} Tables fragment.
 */
function buildTables(fac) {
    const frag = document.createDocumentFragment();

    if (fac.netfac_set && fac.netfac_set.length > 0) {
        const netTable = /** @type {any} */ (document.createElement('pdb-table'));
        netTable.configure({
            title: 'Networks',
            filterable: true,
            filterPlaceholder: t('Filter networks...'),
            columns: [
                { key: 'network',   label: 'Network' },
                { key: 'local_asn', label: 'ASN', class: 'td-right', width: '100px' },
            ],
            rows: fac.netfac_set,
            cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
                if (col.key === 'network') {
                    const label = row.net_name || `AS${row.local_asn || row.net_id}`;
                    return row.net_id
                        ? createLink('net', row.net_id, label)
                        : document.createTextNode(label);
                }
                if (col.key === 'local_asn') {
                    return document.createTextNode(String(row.net_asn || row.local_asn || '—'));
                }
                return document.createTextNode(String(row[col.key] ?? ''));
            }
        });
        frag.appendChild(netTable);
    }

    if (fac.ixfac_set && fac.ixfac_set.length > 0) {
        const ixTable = /** @type {any} */ (document.createElement('pdb-table'));
        ixTable.configure({
            title: 'Exchanges',
            filterable: true,
            filterPlaceholder: t('Filter exchanges...'),
            columns: [
                { key: 'exchange', label: 'Exchange' },
            ],
            rows: fac.ixfac_set,
            cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
                if (col.key === 'exchange') {
                    const label = row.ix_name || `IX ${row.ix_id}`;
                    return row.ix_id
                        ? createLink('ix', row.ix_id, label)
                        : document.createTextNode(label);
                }
                return document.createTextNode(String(row[col.key] ?? ''));
            }
        });
        frag.appendChild(ixTable);
    }

    if (frag.children.length === 0) {
        frag.appendChild(createEmptyState('No networks or exchanges'));
    }

    return frag;
}
