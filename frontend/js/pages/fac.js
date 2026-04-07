/**
 * @fileoverview Facility detail page renderer.
 * Displays facility info, networks present, and exchanges at the facility.
 */

import { fetchEntity } from '../api.js';
import {
    renderField, renderFieldGroup, renderTableCard,
    renderLoading, renderError,
    linkEntity, escapeHTML, setOGTags,
    attachTableSort, attachTableFilter, attachTablePaging
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
    app.innerHTML = renderLoading('Loading facility');

    try {
        const fac = await fetchEntity('fac', id, 2);
        if (!fac) {
            app.innerHTML = renderError(`Facility ${id} not found`);
            return;
        }

        document.title = `${fac.name} — PeeringDB`;
        setOGTags(
            fac.name,
            `Facility — ${fac.city || ''}${fac.country ? `, ${fac.country}` : ''}`
        );

        const sidebar = buildSidebar(fac);
        const tables = buildTables(fac);

        app.innerHTML = `
            <div class="detail-layout">
                <div class="detail-header">
                    <h1 class="detail-header__title">${escapeHTML(fac.name)}</h1>
                    <span class="detail-header__subtitle">${escapeHTML(fac.city || '')}${fac.country ? `, ${escapeHTML(fac.country)}` : ''}</span>
                </div>
                <div class="detail-sidebar">${sidebar}</div>
                <div class="detail-main">${tables}</div>
            </div>
        `;

        attachTableSort(app);
        attachTableFilter(app);
        attachTablePaging(app);
    } catch (err) {
        app.innerHTML = renderError(`Failed to load facility: ${err.message}`);
    }
}

/**
 * Builds the info sidebar for a facility.
 *
 * @param {any} fac - Facility entity object.
 * @returns {string} HTML string.
 */
function buildSidebar(fac) {
    const general = renderFieldGroup('General', [
        renderField('Organization', fac.org_name || fac.org_id, { linkType: 'org', linkId: fac.org_id }),
        renderField('Website', fac.website, { href: fac.website, external: true }),
        renderField('CLLI', fac.clli),
        renderField('Rencode', fac.rencode),
        renderField('NPA-NXX', fac.npanxx),
        renderField('Notes', fac.notes, { markdown: true }),
        renderField('Last Updated', fac.updated),
    ]);

    const address = renderFieldGroup('Location', [
        renderField('Address', fac.address1),
        renderField('Address 2', fac.address2),
        renderField('City', fac.city),
        renderField('State', fac.state),
        renderField('Postal Code', fac.zipcode),
        renderField('Country', fac.country),
        renderField('Latitude', fac.latitude),
        renderField('Longitude', fac.longitude),
    ]);

    return [general, address].filter(s => s).join('');
}

/**
 * Builds the data tables (networks + exchanges) for a facility.
 *
 * @param {any} fac - Facility entity object.
 * @returns {string} HTML string.
 */
function buildTables(fac) {
    let netTable = '';
    if (fac.netfac_set && fac.netfac_set.length > 0) {
        netTable = renderTableCard({
            title: 'Networks',
            filterable: true,
            filterPlaceholder: t('Filter networks...'),
            columns: [
                { key: 'network',   label: 'Network' },
                { key: 'local_asn', label: 'ASN', class: 'td-right' },
            ],
            rows: fac.netfac_set,
            cellRenderer: (row, col) => {
                // Use net_name from the API's JOIN response.
                // Fall back to AS{local_asn} if not available.
                if (col.key === 'network') {
                    const label = row.net_name || `AS${row.local_asn || row.net_id}`;
                    return row.net_id
                        ? linkEntity('net', row.net_id, label)
                        : escapeHTML(label);
                }
                if (col.key === 'local_asn') return String(row.net_asn || row.local_asn || '—');
                return escapeHTML(String(row[col.key] ?? ''));
            }
        });
    }

    let ixTable = '';
    if (fac.ixfac_set && fac.ixfac_set.length > 0) {
        ixTable = renderTableCard({
            title: 'Exchanges',
            columns: [
                { key: 'exchange', label: 'Exchange' },
            ],
            rows: fac.ixfac_set,
            cellRenderer: (row, col) => {
                // Use ix_name from the API's JOIN response.
                // Fall back to IX ID if not available.
                if (col.key === 'exchange') {
                    const label = row.ix_name || `IX ${row.ix_id}`;
                    return row.ix_id
                        ? linkEntity('ix', row.ix_id, label)
                        : escapeHTML(label);
                }
                return escapeHTML(String(row[col.key] ?? ''));
            }
        });
    }

    return [netTable, ixTable].filter(s => s).join('') || `<div class="empty-state">${escapeHTML(t('No networks or exchanges'))}</div>`;
}
