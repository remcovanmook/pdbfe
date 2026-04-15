/**
 * @fileoverview Carrier detail page renderer.
 * Displays carrier info and the facilities table from carrierfac_set.
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
 * Renders the carrier detail page.
 *
 * @param {Record<string, string>} params - Route params, expects { id: string }.
 */
export async function renderCarrier(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const id = params.id;

    document.title = `Carrier — PeeringDB`;
    app.replaceChildren(createLoading('Loading carrier'));

    try {
        const carrier = await fetchEntity('carrier', id, 2);
        if (!carrier) {
            app.replaceChildren(createError(`Carrier ${id} not found`));
            return;
        }

        document.title = `${carrier.name} — PeeringDB`;

        app.replaceChildren(createDetailLayout({
            title: carrier.name,
            logoUrl: carrier.logo || carrier.org?.logo || null,
            logoMigrated: Boolean(carrier.logo ? carrier.__logo_migrated : carrier.org?.__logo_migrated),
            entityType: 'carrier',
            entityId: carrier.id,
            sidebar: buildSidebar(carrier),
            main: buildTables(carrier),
        }));
    } catch (err) {
        app.replaceChildren(createError(`Failed to load carrier: ${err.message}`));
    }
}

/**
 * Builds the info sidebar for a carrier as a DocumentFragment.
 *
 * @param {any} carrier - Carrier entity object.
 * @returns {DocumentFragment} Sidebar content fragment.
 */
function buildSidebar(carrier) {
    const frag = document.createDocumentFragment();

    const general = createFieldGroup('General', [
        createField('Organization', carrier.org_name || carrier.org_id, { linkType: 'org', linkId: carrier.org_id }),
        createField('Website', carrier.website, { href: carrier.website, external: true }),
        createField('Also Known As', carrier.aka),
        createField('Long Name', carrier.name_long),
        createField('Facilities', carrier.fac_count),
        createField('Last Updated', carrier.updated, { date: true }),
    ]);
    if (general) frag.appendChild(general);

    if (carrier.notes) {
        const notes = createFieldGroup('Notes', [
            createField('Notes', carrier.notes, { markdown: true })
        ]);
        if (notes) frag.appendChild(notes);
    }

    return frag;
}

/**
 * Builds the facilities table from carrierfac_set.
 *
 * @param {any} carrier - Carrier entity object.
 * @returns {HTMLElement} Table element or empty-state.
 */
function buildTables(carrier) {
    if (!carrier.carrierfac_set || carrier.carrierfac_set.length === 0) {
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
        ],
        rows: carrier.carrierfac_set,
        cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
            if (col.key === 'name') {
                return createLink('fac', row.fac_id, row.name || `Facility ${row.fac_id}`);
            }
            return document.createTextNode(String(row[col.key] ?? '—'));
        }
    });
    return table;
}
