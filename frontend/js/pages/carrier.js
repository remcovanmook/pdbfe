/**
 * @fileoverview Carrier detail page renderer.
 * Displays carrier info and the facilities table from carrierfac_set.
 */

import { fetchEntity } from '../api.js';
import {
    renderField, renderFieldGroup, renderTableCard,
    renderLoading, renderError,
    linkEntity, escapeHTML,
    attachTableSort, attachTableFilter, attachTablePaging
} from '../render.js';

/**
 * Renders the carrier detail page.
 *
 * @param {Record<string, string>} params - Route params, expects { id: string }.
 */
export async function renderCarrier(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const id = params.id;

    document.title = `Carrier — PeeringDB`;
    app.innerHTML = renderLoading('Loading carrier');

    try {
        const carrier = await fetchEntity('carrier', id, 2);
        if (!carrier) {
            app.innerHTML = renderError(`Carrier ${id} not found`);
            return;
        }

        document.title = `${carrier.name} — PeeringDB`;

        const sidebar = buildSidebar(carrier);
        const tables = buildTables(carrier);

        app.innerHTML = `
            <div class="detail-layout">
                <div class="detail-header">
                    <h1 class="detail-header__title">${escapeHTML(carrier.name)}</h1>
                </div>
                <div class="detail-sidebar">${sidebar}</div>
                <div class="detail-main">${tables}</div>
            </div>
        `;

        attachTableSort(app);
        attachTableFilter(app);
        attachTablePaging(app);
    } catch (err) {
        app.innerHTML = renderError(`Failed to load carrier: ${err.message}`);
    }
}

/**
 * Builds the info sidebar HTML for a carrier.
 *
 * @param {any} carrier - Carrier entity object.
 * @returns {string} HTML string.
 */
function buildSidebar(carrier) {
    const general = renderFieldGroup('General', [
        renderField('Organization', carrier.org_name || carrier.org_id, { linkType: 'org', linkId: carrier.org_id }),
        renderField('Website', carrier.website, { href: carrier.website, external: true }),
        renderField('Also Known As', carrier.aka),
        renderField('Long Name', carrier.name_long),
        renderField('Facilities', carrier.fac_count),
        renderField('Last Updated', carrier.updated),
    ]);

    let notes = '';
    if (carrier.notes) {
        notes = renderFieldGroup('Notes', [
            renderField('Notes', carrier.notes, { markdown: true })
        ]);
    }

    return [general, notes].filter(s => s).join('');
}

/**
 * Builds the facilities table from carrierfac_set.
 *
 * @param {any} carrier - Carrier entity object.
 * @returns {string} HTML string.
 */
function buildTables(carrier) {
    if (!carrier.carrierfac_set || carrier.carrierfac_set.length === 0) {
        return '<div class="empty-state">No facilities listed</div>';
    }

    return renderTableCard({
        title: 'Facilities',
        filterable: true,
        filterPlaceholder: 'Filter facilities...',
        columns: [
            { key: 'name', label: 'Facility' },
        ],
        rows: carrier.carrierfac_set,
        cellRenderer: (row, col) => {
            if (col.key === 'name') {
                return linkEntity('fac', row.fac_id, row.name || `Facility ${row.fac_id}`);
            }
            return escapeHTML(String(row[col.key] ?? '—'));
        }
    });
}
