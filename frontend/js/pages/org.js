/**
 * @fileoverview Organization detail page renderer.
 * Displays org info and tables of owned networks, facilities, and exchanges.
 */

import { fetchEntity } from '../api.js';
import {
    renderField, renderFieldGroup, renderTableCard,
    renderLoading, renderError,
    linkEntity, escapeHTML,
    attachTableSort, attachTableFilter
} from '../render.js';

/**
 * Renders the organization detail page.
 *
 * @param {Record<string, string>} params - Route params, expects { id: string }.
 */
export async function renderOrg(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const id = params.id;

    document.title = `Organization — PeeringDB`;
    app.innerHTML = renderLoading('Loading organization');

    try {
        const org = await fetchEntity('org', id, 2);
        if (!org) {
            app.innerHTML = renderError(`Organization ${id} not found`);
            return;
        }

        document.title = `${org.name} — PeeringDB`;

        const sidebar = buildSidebar(org);
        const tables = buildTables(org);

        app.innerHTML = `
            <div class="detail-layout">
                <div class="detail-header">
                    <h1 class="detail-header__title">${escapeHTML(org.name)}</h1>
                </div>
                <div class="detail-sidebar">${sidebar}</div>
                <div class="detail-main">${tables}</div>
            </div>
        `;

        attachTableSort(app);
        attachTableFilter(app);
    } catch (err) {
        app.innerHTML = renderError(`Failed to load organization: ${err.message}`);
    }
}

/**
 * Builds the info sidebar for an organization.
 *
 * @param {any} org - Organization entity object.
 * @returns {string} HTML string.
 */
function buildSidebar(org) {
    const general = renderFieldGroup('General', [
        renderField('Also Known As', org.aka),
        renderField('Long Name', org.name_long),
        renderField('Website', org.website, { href: org.website, external: true }),
        renderField('Notes', org.notes),
        renderField('Last Updated', org.updated),
    ]);

    const address = renderFieldGroup('Address', [
        renderField('Address', org.address1),
        renderField('Address 2', org.address2),
        renderField('City', org.city),
        renderField('State', org.state),
        renderField('Postal Code', org.zipcode),
        renderField('Country', org.country),
    ]);

    return [general, address].filter(s => s).join('');
}

/**
 * Builds tables for an organization's network, facility, and exchange assets.
 *
 * @param {any} org - Organization entity object.
 * @returns {string} HTML string.
 */
function buildTables(org) {
    let netTable = '';
    if (org.net_set && org.net_set.length > 0) {
        netTable = renderTableCard({
            title: 'Networks',
            filterable: true,
            filterPlaceholder: 'Filter networks...',
            columns: [
                { key: 'name', label: 'Network' },
                { key: 'asn',  label: 'ASN', class: 'td-right' },
            ],
            rows: org.net_set,
            cellRenderer: (row, col) => {
                if (col.key === 'name') return linkEntity('net', row.id, row.name || `Net ${row.id}`);
                if (col.key === 'asn') return String(row.asn || '—');
                return escapeHTML(String(row[col.key] ?? ''));
            }
        });
    }

    let facTable = '';
    if (org.fac_set && org.fac_set.length > 0) {
        facTable = renderTableCard({
            title: 'Facilities',
            columns: [
                { key: 'name',    label: 'Facility' },
                { key: 'city',    label: 'City' },
                { key: 'country', label: 'Country' },
            ],
            rows: org.fac_set,
            cellRenderer: (row, col) => {
                if (col.key === 'name') return linkEntity('fac', row.id, row.name || `Fac ${row.id}`);
                return escapeHTML(String(row[col.key] ?? '—'));
            }
        });
    }

    let ixTable = '';
    if (org.ix_set && org.ix_set.length > 0) {
        ixTable = renderTableCard({
            title: 'Exchanges',
            columns: [
                { key: 'name',    label: 'Exchange' },
                { key: 'city',    label: 'City' },
                { key: 'country', label: 'Country' },
            ],
            rows: org.ix_set,
            cellRenderer: (row, col) => {
                if (col.key === 'name') return linkEntity('ix', row.id, row.name || `IX ${row.id}`);
                return escapeHTML(String(row[col.key] ?? '—'));
            }
        });
    }

    return [netTable, facTable, ixTable].filter(s => s).join('') || '<div class="empty-state">No networks, facilities, or exchanges</div>';
}
