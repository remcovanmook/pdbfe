/**
 * @fileoverview Compare page renderer.
 *
 * Displays an entity overlap analysis between two PeeringDB entities.
 * The user selects two entities via search-style inputs, and the page
 * shows shared and exclusive resources in tabulated sections.
 *
 * URL: /compare?a={tag}:{id}&b={tag}:{id}
 * If query params are missing, shows the selection form.
 */

import { fetchCompare, searchWithAsn, SEARCH_ENTITIES } from '../api.js';
import { createLoading, createError, createLink, createEntityBadge, formatSpeed } from '../render.js';
import { t } from '../i18n.js';

/**
 * Entity type labels for the selector dropdowns.
 * @type {Record<string, string>}
 */
const TYPE_LABELS = { net: 'Network', ix: 'Exchange', fac: 'Facility' };

/**
 * Renders the compare page into the app container.
 * If a and b query params are present, fetches and displays overlap.
 * Otherwise shows the entity selection form.
 *
 * @param {Record<string, string>} params - Route params including query params.
 */
export async function renderCompare(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    document.title = `${t('Compare')} — PDBFE`;

    if (params.a && params.b) {
        await renderResults(app, params.a, params.b);
    } else {
        renderSelector(app, params.a || '', params.b || '');
    }
}

// ── Selection form ──────────────────────────────────────────────────────

/**
 * Renders the entity selection form with two search inputs and a
 * compare button. Each input has typeahead search functionality.
 *
 * @param {HTMLElement} app - App container element.
 * @param {string} initialA - Pre-filled value for entity A.
 * @param {string} initialB - Pre-filled value for entity B.
 */
function renderSelector(app, initialA, initialB) {
    const wrap = document.createElement('div');
    wrap.className = 'compare-page';

    const heading = document.createElement('h1');
    heading.textContent = t('Compare Entities');
    wrap.appendChild(heading);

    const desc = document.createElement('p');
    desc.className = 'compare-page__desc';
    desc.textContent = t('Select two entities to see their shared and exclusive resources.');
    wrap.appendChild(desc);

    const form = document.createElement('form');
    form.className = 'compare-form';
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const a = /** @type {HTMLInputElement} */ (form.querySelector('#compare-a-ref')).value;
        const b = /** @type {HTMLInputElement} */ (form.querySelector('#compare-b-ref')).value;
        if (a && b) {
            globalThis.__router.navigate(`/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
        }
    });

    form.appendChild(createEntityInput('A', 'compare-a', initialA));
    form.appendChild(createEntityInput('B', 'compare-b', initialB));

    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'compare-form__submit';
    btn.textContent = t('Compare');
    form.appendChild(btn);

    wrap.appendChild(form);

    // Supported pairs hint
    const hint = document.createElement('p');
    hint.className = 'compare-page__hint';
    hint.textContent = t('Supported: Network ↔ Network, Exchange ↔ Exchange');
    wrap.appendChild(hint);

    app.replaceChildren(wrap);
}

/**
 * Creates an entity input group with a type selector, search input,
 * and hidden ref field. The search input has basic typeahead.
 *
 * @param {string} label - Display label (e.g. "A", "B").
 * @param {string} prefix - ID prefix for the input elements.
 * @param {string} initialRef - Pre-filled entity reference.
 * @returns {HTMLDivElement} The input group element.
 */
function createEntityInput(label, prefix, initialRef) {
    const group = document.createElement('div');
    group.className = 'compare-form__group';

    const lbl = document.createElement('label');
    lbl.className = 'compare-form__label';
    lbl.textContent = `${t('Entity')} ${label}`;
    group.appendChild(lbl);

    const row = document.createElement('div');
    row.className = 'compare-form__row';

    // Type selector
    const typeSelect = document.createElement('select');
    typeSelect.id = `${prefix}-type`;
    typeSelect.className = 'compare-form__type';
    for (const [tag, name] of Object.entries(TYPE_LABELS)) {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = t(name);
        typeSelect.appendChild(opt);
    }
    row.appendChild(typeSelect);

    // Search input with typeahead
    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'compare-form__search-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = `${prefix}-search`;
    input.className = 'compare-form__search';
    input.placeholder = t('Search by name or ASN...');
    input.autocomplete = 'off';
    searchWrapper.appendChild(input);

    // Dropdown for results
    const dropdown = document.createElement('div');
    dropdown.className = 'compare-form__dropdown';
    dropdown.hidden = true;
    searchWrapper.appendChild(dropdown);

    row.appendChild(searchWrapper);
    group.appendChild(row);

    // Hidden field to store the selected entity ref
    const refInput = document.createElement('input');
    refInput.type = 'hidden';
    refInput.id = `${prefix}-ref`;
    if (initialRef) {
        refInput.value = initialRef;
        // Pre-fill the visible input with the ref for display
        input.value = initialRef;
    }
    group.appendChild(refInput);

    // Selected entity display
    const selectedDisplay = document.createElement('div');
    selectedDisplay.className = 'compare-form__selected';
    selectedDisplay.id = `${prefix}-selected`;
    group.appendChild(selectedDisplay);

    // Wire up typeahead
    let debounceTimer = 0;
    let abortCtrl = /** @type {AbortController|null} */ (null);

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        const q = input.value.trim();
        if (q.length < 2) {
            dropdown.hidden = true;
            return;
        }
        debounceTimer = globalThis.setTimeout(async () => {
            if (abortCtrl) abortCtrl.abort();
            abortCtrl = new AbortController();
            try {
                const results = await searchWithAsn(q, abortCtrl.signal);
                renderDropdown(dropdown, results, typeSelect.value, (tag, id, name) => {
                    refInput.value = `${tag}:${id}`;
                    input.value = name;
                    dropdown.hidden = true;
                    selectedDisplay.textContent = `${tag}:${id} — ${name}`;
                    // Auto-set type selector to match
                    if (TYPE_LABELS[tag]) typeSelect.value = tag;
                });
            } catch { /* aborted or error */ }
        }, 250);
    });

    // Close dropdown on blur (with delay for click)
    input.addEventListener('blur', () => {
        globalThis.setTimeout(() => { dropdown.hidden = true; }, 200);
    });

    return group;
}

/**
 * Renders typeahead search results into a dropdown.
 *
 * @param {HTMLElement} dropdown - Dropdown container.
 * @param {Record<string, any[]>} results - Search results grouped by type.
 * @param {string} preferredType - Currently selected entity type.
 * @param {(tag: string, id: number, name: string) => void} onSelect - Selection callback.
 */
function renderDropdown(dropdown, results, preferredType, onSelect) {
    dropdown.replaceChildren();

    // Show preferred type first, then others
    const types = [preferredType, ...Object.keys(TYPE_LABELS).filter(t => t !== preferredType)];

    let hasResults = false;
    for (const tag of types) {
        const items = results[tag];
        if (!items || items.length === 0) continue;
        hasResults = true;

        for (const item of items.slice(0, 5)) {
            const row = document.createElement('div');
            row.className = 'compare-form__dropdown-item';
            row.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Prevent blur
                onSelect(tag, item.id, item.name);
            });

            const badge = createEntityBadge(tag);
            row.appendChild(badge);

            const name = document.createElement('span');
            name.className = 'compare-form__dropdown-name';
            name.textContent = item.name;
            row.appendChild(name);

            if (tag === 'net' && item.asn) {
                const asn = document.createElement('span');
                asn.className = 'compare-form__dropdown-asn';
                asn.textContent = `AS${item.asn}`;
                row.appendChild(asn);
            }

            dropdown.appendChild(row);
        }
    }

    dropdown.hidden = !hasResults;
}

// ── Results display ─────────────────────────────────────────────────────

/**
 * Fetches and renders the overlap analysis results.
 *
 * @param {HTMLElement} app - App container element.
 * @param {string} refA - Entity A reference (e.g. "net:13335").
 * @param {string} refB - Entity B reference (e.g. "net:15169").
 */
async function renderResults(app, refA, refB) {
    app.replaceChildren(createLoading(t('Comparing entities...')));

    try {
        const data = await fetchCompare(refA, refB);
        const wrap = document.createElement('div');
        wrap.className = 'compare-page';

        // Header with both entities
        const header = document.createElement('div');
        header.className = 'compare-header';

        header.appendChild(createEntityHeader(data.a));
        const vs = document.createElement('span');
        vs.className = 'compare-header__vs';
        vs.textContent = 'vs';
        header.appendChild(vs);
        header.appendChild(createEntityHeader(data.b));

        wrap.appendChild(header);

        // Back link
        const back = document.createElement('a');
        back.href = '/compare';
        back.dataset.link = '';
        back.className = 'compare-page__back';
        back.textContent = `← ${t('New comparison')}`;
        wrap.appendChild(back);

        // Render sections based on the pair type
        const pairType = `${data.a.tag}+${data.b.tag}`;

        if (pairType === 'net+net') {
            renderNetNetResults(wrap, data);
        } else if (pairType === 'ix+ix') {
            renderIxIxResults(wrap, data);
        }

        app.replaceChildren(wrap);
    } catch (err) {
        app.replaceChildren(createError(err.message));
    }
}

/**
 * Creates an entity header card for the results view.
 *
 * @param {Record<string, any>} entity - Entity header from the API.
 * @returns {HTMLDivElement} The header card element.
 */
function createEntityHeader(entity) {
    const card = document.createElement('div');
    card.className = 'compare-entity-card';

    const badge = createEntityBadge(entity.tag, { header: true });
    card.appendChild(badge);

    const nameLink = createLink(entity.tag, entity.id, entity.name);
    nameLink.className = 'compare-entity-card__name';
    card.appendChild(nameLink);

    if (entity.asn) {
        const asn = document.createElement('span');
        asn.className = 'compare-entity-card__asn';
        asn.textContent = `AS${entity.asn}`;
        card.appendChild(asn);
    }

    return card;
}

/**
 * Renders net↔net comparison results: shared IXPs, shared facilities,
 * and exclusive sections.
 *
 * @param {HTMLElement} wrap - Page wrapper element.
 * @param {Record<string, any>} data - API response data.
 */
function renderNetNetResults(wrap, data) {
    // Summary stats
    const stats = document.createElement('div');
    stats.className = 'compare-stats';
    stats.appendChild(createStatCard(t('Shared IXPs'), data.shared_ixps.length));
    stats.appendChild(createStatCard(t('Shared Facilities'), data.shared_facilities.length));
    stats.appendChild(createStatCard(`${t('Only')} ${data.a.name}`, data.only_a_ixps.length + data.only_a_facilities.length));
    stats.appendChild(createStatCard(`${t('Only')} ${data.b.name}`, data.only_b_ixps.length + data.only_b_facilities.length));
    wrap.appendChild(stats);

    // Shared IXPs table
    if (data.shared_ixps.length > 0) {
        wrap.appendChild(createSection(t('Shared IXPs'), createIxpTable(data.shared_ixps, true)));
    }

    // Shared facilities table
    if (data.shared_facilities.length > 0) {
        wrap.appendChild(createSection(t('Shared Facilities'), createFacTable(data.shared_facilities)));
    }

    // Exclusive sections
    if (data.only_a_ixps.length > 0) {
        wrap.appendChild(createSection(`${t('IXPs only at')} ${data.a.name}`, createIxpTable(data.only_a_ixps, false)));
    }
    if (data.only_b_ixps.length > 0) {
        wrap.appendChild(createSection(`${t('IXPs only at')} ${data.b.name}`, createIxpTable(data.only_b_ixps, false)));
    }
    if (data.only_a_facilities.length > 0) {
        wrap.appendChild(createSection(`${t('Facilities only at')} ${data.a.name}`, createFacTable(data.only_a_facilities)));
    }
    if (data.only_b_facilities.length > 0) {
        wrap.appendChild(createSection(`${t('Facilities only at')} ${data.b.name}`, createFacTable(data.only_b_facilities)));
    }
}

/**
 * Renders ix↔ix comparison results: shared facilities, shared networks,
 * and exclusive sections.
 *
 * @param {HTMLElement} wrap - Page wrapper element.
 * @param {Record<string, any>} data - API response data.
 */
function renderIxIxResults(wrap, data) {
    const stats = document.createElement('div');
    stats.className = 'compare-stats';
    stats.appendChild(createStatCard(t('Shared Facilities'), data.shared_facilities.length));
    stats.appendChild(createStatCard(t('Shared Networks'), data.shared_networks.length));
    stats.appendChild(createStatCard(`${t('Only')} ${data.a.name}`, data.only_a_facilities.length + data.only_a_networks.length));
    stats.appendChild(createStatCard(`${t('Only')} ${data.b.name}`, data.only_b_facilities.length + data.only_b_networks.length));
    wrap.appendChild(stats);

    if (data.shared_facilities.length > 0) {
        wrap.appendChild(createSection(t('Shared Facilities'), createFacTable(data.shared_facilities)));
    }
    if (data.shared_networks.length > 0) {
        wrap.appendChild(createSection(t('Shared Networks'), createNetTable(data.shared_networks)));
    }
    if (data.only_a_facilities.length > 0) {
        wrap.appendChild(createSection(`${t('Facilities only at')} ${data.a.name}`, createFacTable(data.only_a_facilities)));
    }
    if (data.only_b_facilities.length > 0) {
        wrap.appendChild(createSection(`${t('Facilities only at')} ${data.b.name}`, createFacTable(data.only_b_facilities)));
    }
    if (data.only_a_networks.length > 0) {
        wrap.appendChild(createSection(`${t('Networks only at')} ${data.a.name}`, createNetTable(data.only_a_networks)));
    }
    if (data.only_b_networks.length > 0) {
        wrap.appendChild(createSection(`${t('Networks only at')} ${data.b.name}`, createNetTable(data.only_b_networks)));
    }
}

// ── Table builders ──────────────────────────────────────────────────────

/**
 * Creates a section with a heading and content element.
 *
 * @param {string} title - Section heading text.
 * @param {HTMLElement} content - Content element.
 * @returns {HTMLDivElement} Section wrapper.
 */
function createSection(title, content) {
    const section = document.createElement('div');
    section.className = 'compare-section';

    const h2 = document.createElement('h2');
    h2.className = 'compare-section__title';
    h2.textContent = title;
    section.appendChild(h2);
    section.appendChild(content);

    return section;
}

/**
 * Creates a stat card with a label and numeric value.
 *
 * @param {string} label - Stat label.
 * @param {number} value - Stat value.
 * @returns {HTMLDivElement} Stat card element.
 */
function createStatCard(label, value) {
    const card = document.createElement('div');
    card.className = 'compare-stat-card';

    const num = document.createElement('div');
    num.className = 'compare-stat-card__value';
    num.textContent = String(value);
    card.appendChild(num);

    const text = document.createElement('div');
    text.className = 'compare-stat-card__label';
    text.textContent = label;
    card.appendChild(text);

    return card;
}

/**
 * Creates an IXP table (for shared or exclusive IXPs).
 *
 * @param {any[]} ixps - Array of IXP overlap records.
 * @param {boolean} showSpeeds - Whether to show speed columns (shared mode).
 * @returns {HTMLTableElement} The IXP table.
 */
function createIxpTable(ixps, showSpeeds) {
    const table = document.createElement('table');
    table.className = 'compare-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of [t('Exchange'), t('Country'), t('City'),
        ...(showSpeeds ? [t('Speed A'), t('Speed B'), t('IPv4 A'), t('IPv4 B')] : [])]) {
        const th = document.createElement('th');
        th.textContent = col;
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const ix of ixps) {
        const tr = document.createElement('tr');

        // Exchange name (linked)
        const nameTd = document.createElement('td');
        nameTd.appendChild(createLink('ix', ix.ix_id, ix.ix_name));
        tr.appendChild(nameTd);

        tr.appendChild(textCell(ix.country || ''));
        tr.appendChild(textCell(ix.city || ''));

        if (showSpeeds) {
            tr.appendChild(textCell(formatSpeed(ix.speed_a)));
            tr.appendChild(textCell(formatSpeed(ix.speed_b)));
            tr.appendChild(textCell(ix.ipv4_a || '—'));
            tr.appendChild(textCell(ix.ipv4_b || '—'));
        }

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
}

/**
 * Creates a facility table.
 *
 * @param {any[]} facs - Array of facility records.
 * @returns {HTMLTableElement} The facility table.
 */
function createFacTable(facs) {
    const table = document.createElement('table');
    table.className = 'compare-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of [t('Facility'), t('Country'), t('City')]) {
        const th = document.createElement('th');
        th.textContent = col;
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const fac of facs) {
        const tr = document.createElement('tr');
        const nameTd = document.createElement('td');
        nameTd.appendChild(createLink('fac', fac.fac_id, fac.fac_name));
        tr.appendChild(nameTd);
        tr.appendChild(textCell(fac.country || ''));
        tr.appendChild(textCell(fac.city || ''));
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
}

/**
 * Creates a network table (for ix↔ix comparisons).
 *
 * @param {any[]} nets - Array of network records.
 * @returns {HTMLTableElement} The network table.
 */
function createNetTable(nets) {
    const table = document.createElement('table');
    table.className = 'compare-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of [t('Network'), t('ASN')]) {
        const th = document.createElement('th');
        th.textContent = col;
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const net of nets) {
        const tr = document.createElement('tr');
        const nameTd = document.createElement('td');
        nameTd.appendChild(createLink('net', net.net_id, net.net_name));
        tr.appendChild(nameTd);
        tr.appendChild(textCell(`AS${net.asn}`));
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
}

/**
 * Creates a simple text table cell.
 *
 * @param {string} text - Cell text.
 * @returns {HTMLTableCellElement} The td element.
 */
function textCell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
}
