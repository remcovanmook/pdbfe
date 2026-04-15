/**
 * @fileoverview Campus detail page renderer.
 * Displays campus info and its associated facilities from fac_set.
 *
 * Uses DOM-based rendering via Web Components (<pdb-table>) and
 * createField/createLink builders.
 */

import { fetchEntity } from '../api.js';
import {
    createField, createFieldGroup, createLink,
    createLoading, createError, createEmptyState, createDetailLayout
} from '../render.js';
import { t } from '../i18n.js';

/**
 * Renders the campus detail page.
 *
 * @param {Record<string, string>} params - Route params, expects { id: string }.
 */
export async function renderCampus(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const id = params.id;

    document.title = `Campus — PeeringDB`;
    app.replaceChildren(createLoading('Loading campus'));

    try {
        const campus = await fetchEntity('campus', id, 2);
        if (!campus) {
            app.replaceChildren(createError(`Campus ${id} not found`));
            return;
        }

        document.title = `${campus.name} — PeeringDB`;

        app.replaceChildren(createDetailLayout({
            title: campus.name,
            logoUrl: campus.logo || campus.org?.logo || null,
            entityType: 'campus',
            entityId: campus.id,
            sidebar: buildSidebar(campus),
            main: buildTables(campus),
        }));
    } catch (err) {
        app.replaceChildren(createError(`Failed to load campus: ${err.message}`));
    }
}

/**
 * Builds the info sidebar for a campus as a DocumentFragment.
 *
 * @param {any} campus - Campus entity object.
 * @returns {DocumentFragment} Sidebar content fragment.
 */
function buildSidebar(campus) {
    const group = createFieldGroup('General', [
        createField('Organization', campus.org_name || campus.org_id, { linkType: 'org', linkId: campus.org_id }),
        createField('Website', campus.website, { href: campus.website, external: true }),
        createField('Also Known As', campus.aka),
        createField('Long Name', campus.name_long),
        createField('City', campus.city, { map: [campus.city, campus.country].filter(Boolean).join(', ') }),
        createField('State/Province', campus.state),
        createField('Country', campus.country),
        createField('Postal Code', campus.zipcode),
        createField('Last Updated', campus.updated, { date: true }),
    ]);

    const frag = document.createDocumentFragment();
    if (group) frag.appendChild(group);
    return frag;
}

/**
 * Builds the facilities table from fac_set.
 *
 * @param {any} campus - Campus entity object.
 * @returns {HTMLElement} Table element or empty-state.
 */
function buildTables(campus) {
    if (!campus.fac_set || campus.fac_set.length === 0) {
        return createEmptyState('No facilities listed');
    }

    const table = /** @type {any} */ (document.createElement('pdb-table'));
    table.configure({
        tableId: 'fac',
        title: 'Facilities',
        filterable: true,
        filterPlaceholder: t('Filter facilities...'),
        columns: [
            { key: 'name', label: 'Facility' },
            { key: 'city', label: 'City', maxWidth: '250px' },
            { key: 'country', label: 'Country', maxWidth: '100px' },
        ],
        rows: campus.fac_set,
        cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
            if (col.key === 'name') {
                return createLink('fac', row.id, row.name || `Facility ${row.id}`);
            }
            return document.createTextNode(String(row[col.key] ?? '—'));
        }
    });
    return table;
}
