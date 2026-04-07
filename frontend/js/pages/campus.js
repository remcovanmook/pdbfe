/**
 * @fileoverview Campus detail page renderer.
 * Displays campus info and its associated facilities from fac_set.
 */

import { fetchEntity } from '../api.js';
import {
    renderField, renderFieldGroup, renderTableCard,
    renderLoading, renderError,
    linkEntity, escapeHTML,
    attachTableSort, attachTableFilter, attachTablePaging
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
    app.innerHTML = renderLoading('Loading campus');

    try {
        const campus = await fetchEntity('campus', id, 2);
        if (!campus) {
            app.innerHTML = renderError(`Campus ${id} not found`);
            return;
        }

        document.title = `${campus.name} — PeeringDB`;

        const sidebar = buildSidebar(campus);
        const tables = buildTables(campus);

        app.innerHTML = `
            <div class="detail-layout">
                <div class="detail-header">
                    <h1 class="detail-header__title">${escapeHTML(campus.name)}</h1>
                </div>
                <div class="detail-sidebar">${sidebar}</div>
                <div class="detail-main">${tables}</div>
            </div>
        `;

        attachTableSort(app);
        attachTableFilter(app);
        attachTablePaging(app);
    } catch (err) {
        app.innerHTML = renderError(`Failed to load campus: ${err.message}`);
    }
}

/**
 * Builds the info sidebar HTML for a campus.
 *
 * @param {any} campus - Campus entity object.
 * @returns {string} HTML string.
 */
function buildSidebar(campus) {
    return renderFieldGroup('General', [
        renderField('Organization', campus.org_name || campus.org_id, { linkType: 'org', linkId: campus.org_id }),
        renderField('Website', campus.website, { href: campus.website, external: true }),
        renderField('Also Known As', campus.aka),
        renderField('Long Name', campus.name_long),
        renderField('City', campus.city),
        renderField('State/Province', campus.state),
        renderField('Country', campus.country),
        renderField('Postal Code', campus.zipcode),
        renderField('Last Updated', campus.updated),
    ]);
}

/**
 * Builds the facilities table from fac_set.
 *
 * @param {any} campus - Campus entity object.
 * @returns {string} HTML string.
 */
function buildTables(campus) {
    if (!campus.fac_set || campus.fac_set.length === 0) {
        return `<div class="empty-state">${escapeHTML(t('No facilities listed'))}</div>`;
    }

    return renderTableCard({
        title: 'Facilities',
        filterable: true,
        filterPlaceholder: t('Filter facilities...'),
        columns: [
            { key: 'name', label: 'Facility' },
            { key: 'city', label: 'City' },
            { key: 'country', label: 'Country' },
        ],
        rows: campus.fac_set,
        cellRenderer: (row, col) => {
            if (col.key === 'name') {
                return linkEntity('fac', row.id, row.name || `Facility ${row.id}`);
            }
            return escapeHTML(String(row[col.key] ?? '—'));
        }
    });
}
