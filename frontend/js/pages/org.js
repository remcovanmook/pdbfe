/**
 * @fileoverview Organization detail page renderer.
 * Displays org info and tables of owned networks, facilities, and exchanges.
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
 * Renders the organization detail page.
 *
 * @param {Record<string, string>} params - Route params, expects { id: string }.
 */
export async function renderOrg(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const id = params.id;

    document.title = `Organization — PeeringDB`;
    app.replaceChildren(createLoading('Loading organization'));

    try {
        const org = await fetchEntity('org', id, 2);
        if (!org) {
            app.replaceChildren(createError(`Organization ${id} not found`));
            return;
        }

        document.title = `${org.name} — PeeringDB`;
        setOGTags(org.name, `Organization — PeeringDB`);

        app.replaceChildren(createDetailLayout({
            title: org.name,
            sidebar: buildSidebar(org),
            main: buildTables(org),
        }));
    } catch (err) {
        app.replaceChildren(createError(`Failed to load organization: ${err.message}`));
    }
}

/**
 * Builds the info sidebar for an organization as a DocumentFragment.
 *
 * @param {any} org - Organization entity object.
 * @returns {DocumentFragment} Sidebar content fragment.
 */
function buildSidebar(org) {
    const frag = document.createDocumentFragment();

    const general = createFieldGroup('General', [
        createField('Also Known As', org.aka),
        createField('Long Name', org.name_long),
        createField('Website', org.website, { href: org.website, external: true }),
        createField('Notes', org.notes, { markdown: true }),
        createField('Last Updated', org.updated),
    ]);
    if (general) frag.appendChild(general);

    const address = createFieldGroup('Address', [
        createField('Address', org.address1),
        createField('Address 2', org.address2),
        createField('City', org.city),
        createField('State', org.state),
        createField('Postal Code', org.zipcode),
        createField('Country', org.country),
    ]);
    if (address) frag.appendChild(address);

    return frag;
}

/**
 * Builds tables for an organization's network, facility, and exchange assets.
 *
 * @param {any} org - Organization entity object.
 * @returns {DocumentFragment} Tables fragment.
 */
function buildTables(org) {
    const frag = document.createDocumentFragment();

    if (org.net_set && org.net_set.length > 0) {
        const netTable = /** @type {any} */ (document.createElement('pdb-table'));
        netTable.configure({
            title: 'Networks',
            filterable: true,
            filterPlaceholder: t('Filter networks...'),
            columns: [
                { key: 'name', label: 'Network' },
                { key: 'asn',  label: 'ASN', class: 'td-right' },
            ],
            rows: org.net_set,
            cellRenderer: (row, col) => {
                if (col.key === 'name') return createLink('net', row.id, row.name || `Net ${row.id}`);
                if (col.key === 'asn') return document.createTextNode(String(row.asn || '—'));
                return document.createTextNode(String(row[col.key] ?? ''));
            }
        });
        frag.appendChild(netTable);
    }

    if (org.fac_set && org.fac_set.length > 0) {
        const facTable = /** @type {any} */ (document.createElement('pdb-table'));
        facTable.configure({
            title: 'Facilities',
            columns: [
                { key: 'name',    label: 'Facility' },
                { key: 'city',    label: 'City' },
                { key: 'country', label: 'Country' },
            ],
            rows: org.fac_set,
            cellRenderer: (row, col) => {
                if (col.key === 'name') return createLink('fac', row.id, row.name || `Fac ${row.id}`);
                return document.createTextNode(String(row[col.key] ?? '—'));
            }
        });
        frag.appendChild(facTable);
    }

    if (org.ix_set && org.ix_set.length > 0) {
        const ixTable = /** @type {any} */ (document.createElement('pdb-table'));
        ixTable.configure({
            title: 'Exchanges',
            columns: [
                { key: 'name',    label: 'Exchange' },
                { key: 'city',    label: 'City' },
                { key: 'country', label: 'Country' },
            ],
            rows: org.ix_set,
            cellRenderer: (row, col) => {
                if (col.key === 'name') return createLink('ix', row.id, row.name || `IX ${row.id}`);
                return document.createTextNode(String(row[col.key] ?? '—'));
            }
        });
        frag.appendChild(ixTable);
    }

    if (frag.children.length === 0) {
        frag.appendChild(createEmptyState('No networks, facilities, or exchanges'));
    }

    return frag;
}
