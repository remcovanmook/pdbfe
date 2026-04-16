/**
 * @fileoverview Compare page renderer.
 *
 * Displays an entity overlap analysis between two PeeringDB entities.
 * The user selects two entities via search-style inputs, and the page
 * shows shared and exclusive resources using <pdb-table> components.
 *
 * URL: /compare?a={tag}:{id}&b={tag}:{id}
 * If query params are missing, shows the selection form.
 */

import { fetchCompare, searchWithAsn } from '../api.js';
import {
    createLoading, createError, createLink, createEntityBadge,
    createStatsBar, createEmptyState, formatSpeed
} from '../render.js';
import { t } from '../i18n.js';

/**
 * Entity type labels for the selector dropdowns.
 * Only types that support comparison are listed.
 * @type {Record<string, string>}
 */
const TYPE_LABELS = { net: 'Network', ix: 'Exchange' };

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
 * Uses existing card/form design patterns from index.css.
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

    const card = document.createElement('div');
    card.className = 'card';

    const cardBody = document.createElement('div');
    cardBody.className = 'card__body';

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

    cardBody.appendChild(form);
    card.appendChild(cardBody);
    wrap.appendChild(card);

    // Supported pairs hint
    const hint = document.createElement('p');
    hint.className = 'compare-page__hint';
    hint.textContent = t('Supported: Network ↔ Network, Exchange ↔ Exchange');
    wrap.appendChild(hint);

    app.replaceChildren(wrap);
}

/**
 * Creates an entity input group with a type selector, search input,
 * and hidden ref field. The search input has typeahead backed by
 * searchWithAsn() from api.js.
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
    input.className = 'search-input';
    input.placeholder = t('Search by name or ASN...');
    input.autocomplete = 'off';
    searchWrapper.appendChild(input);

    // Dropdown for results — reuses the existing search-dropdown styling
    const dropdown = document.createElement('div');
    dropdown.className = 'search-dropdown';
    searchWrapper.appendChild(dropdown);

    row.appendChild(searchWrapper);
    group.appendChild(row);

    // Hidden field to store the selected entity ref
    const refInput = document.createElement('input');
    refInput.type = 'hidden';
    refInput.id = `${prefix}-ref`;
    if (initialRef) {
        refInput.value = initialRef;
        input.value = initialRef;
    }
    group.appendChild(refInput);

    // Selected entity display — uses entity badge
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
            dropdown.classList.remove('is-open');
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
                    dropdown.classList.remove('is-open');
                    // Show selected entity with badge
                    selectedDisplay.replaceChildren();
                    selectedDisplay.appendChild(createEntityBadge(tag));
                    selectedDisplay.appendChild(document.createTextNode(` ${tag}:${id} — ${name}`));
                    if (TYPE_LABELS[tag]) typeSelect.value = tag;
                });
            } catch { /* aborted or error */ }
        }, 250);
    });

    // Close dropdown on blur (with delay for click)
    input.addEventListener('blur', () => {
        globalThis.setTimeout(() => { dropdown.classList.remove('is-open'); }, 200);
    });

    return group;
}

/**
 * Renders typeahead search results into a dropdown using the
 * existing search-dropdown component structure.
 *
 * @param {HTMLElement} dropdown - Dropdown container.
 * @param {Record<string, any[]>} results - Search results grouped by type.
 * @param {string} preferredType - Currently selected entity type.
 * @param {(tag: string, id: number, name: string) => void} onSelect - Selection callback.
 */
function renderDropdown(dropdown, results, preferredType, onSelect) {
    dropdown.replaceChildren();

    // Show preferred type first, then others
    const types = [preferredType, ...Object.keys(TYPE_LABELS).filter(k => k !== preferredType)];

    let hasResults = false;
    for (const tag of types) {
        const items = results[tag];
        if (!items || items.length === 0) continue;
        hasResults = true;

        const groupDiv = document.createElement('div');
        groupDiv.className = 'search-dropdown__group';

        const groupLabel = document.createElement('div');
        groupLabel.className = 'search-dropdown__label';
        groupLabel.textContent = t(TYPE_LABELS[tag] || tag);
        groupDiv.appendChild(groupLabel);

        for (const item of items.slice(0, 5)) {
            const row = document.createElement('div');
            row.className = 'search-dropdown__item';
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                onSelect(tag, item.id, item.name);
            });

            const badge = createEntityBadge(tag);
            row.appendChild(badge);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'search-dropdown__item-name';
            nameSpan.textContent = item.name;
            row.appendChild(nameSpan);

            if (tag === 'net' && item.asn) {
                const sub = document.createElement('span');
                sub.className = 'search-dropdown__item-sub';
                sub.textContent = `AS${item.asn}`;
                row.appendChild(sub);
            }

            groupDiv.appendChild(row);
        }

        dropdown.appendChild(groupDiv);
    }

    if (hasResults) {
        dropdown.classList.add('is-open');
    } else {
        dropdown.classList.remove('is-open');
    }
}

// ── Results display ─────────────────────────────────────────────────────

/**
 * Fetches and renders the overlap analysis results using the
 * existing detail page layout components (stats bar, pdb-table).
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
        header.className = 'detail-header';

        header.appendChild(createEntityHeader(data.a));
        const vs = document.createElement('span');
        vs.className = 'detail-header__subtitle';
        vs.textContent = 'vs';
        vs.style.margin = '0 var(--space-md)';
        header.appendChild(vs);
        header.appendChild(createEntityHeader(data.b));

        wrap.appendChild(header);

        // Back link
        const back = document.createElement('a');
        back.href = '/compare';
        back.dataset.link = '';
        back.style.display = 'inline-block';
        back.style.marginBottom = 'var(--space-lg)';
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
 * Creates an entity header fragment with badge and name link.
 *
 * @param {Record<string, any>} entity - Entity header from the API.
 * @returns {DocumentFragment} Fragment with badge + name link.
 */
function createEntityHeader(entity) {
    const frag = document.createDocumentFragment();

    frag.appendChild(createEntityBadge(entity.tag, { header: true }));

    const nameLink = createLink(entity.tag, entity.id, entity.name);
    frag.appendChild(nameLink);

    if (entity.asn) {
        const asn = document.createElement('span');
        asn.className = 'detail-header__subtitle';
        asn.textContent = `AS${entity.asn}`;
        frag.appendChild(asn);
    }

    return frag;
}

/**
 * Renders net↔net comparison results using createStatsBar
 * and <pdb-table> components.
 *
 * @param {HTMLElement} wrap - Page wrapper element.
 * @param {Record<string, any>} data - API response data.
 */
function renderNetNetResults(wrap, data) {
    // Stats bar — reuses the existing stats-bar component
    wrap.appendChild(createStatsBar([
        { label: t('Shared IXPs'), value: data.shared_ixps.length },
        { label: t('Shared Facilities'), value: data.shared_facilities.length },
        { label: `${t('Only')} ${data.a.name}`, value: data.only_a_ixps.length + data.only_a_facilities.length },
        { label: `${t('Only')} ${data.b.name}`, value: data.only_b_ixps.length + data.only_b_facilities.length },
    ]));

    // Shared IXPs — <pdb-table> with speed columns
    if (data.shared_ixps.length > 0) {
        wrap.appendChild(createIxpTable(t('Shared IXPs'), data.shared_ixps, true));
    }

    // Shared facilities
    if (data.shared_facilities.length > 0) {
        wrap.appendChild(createFacTable(t('Shared Facilities'), data.shared_facilities));
    }

    // Exclusive sections
    if (data.only_a_ixps.length > 0) {
        wrap.appendChild(createIxpTable(`${t('IXPs only at')} ${data.a.name}`, data.only_a_ixps, false));
    }
    if (data.only_b_ixps.length > 0) {
        wrap.appendChild(createIxpTable(`${t('IXPs only at')} ${data.b.name}`, data.only_b_ixps, false));
    }
    if (data.only_a_facilities.length > 0) {
        wrap.appendChild(createFacTable(`${t('Facilities only at')} ${data.a.name}`, data.only_a_facilities));
    }
    if (data.only_b_facilities.length > 0) {
        wrap.appendChild(createFacTable(`${t('Facilities only at')} ${data.b.name}`, data.only_b_facilities));
    }

    if (data.shared_ixps.length === 0 && data.shared_facilities.length === 0) {
        wrap.appendChild(createEmptyState(t('No shared infrastructure found between these networks.')));
    }
}

/**
 * Renders ix↔ix comparison results using createStatsBar
 * and <pdb-table> components.
 *
 * @param {HTMLElement} wrap - Page wrapper element.
 * @param {Record<string, any>} data - API response data.
 */
function renderIxIxResults(wrap, data) {
    wrap.appendChild(createStatsBar([
        { label: t('Shared Facilities'), value: data.shared_facilities.length },
        { label: t('Shared Networks'), value: data.shared_networks.length },
        { label: `${t('Only')} ${data.a.name}`, value: data.only_a_facilities.length + data.only_a_networks.length },
        { label: `${t('Only')} ${data.b.name}`, value: data.only_b_facilities.length + data.only_b_networks.length },
    ]));

    if (data.shared_facilities.length > 0) {
        wrap.appendChild(createFacTable(t('Shared Facilities'), data.shared_facilities));
    }
    if (data.shared_networks.length > 0) {
        wrap.appendChild(createNetTable(t('Shared Networks'), data.shared_networks));
    }
    if (data.only_a_facilities.length > 0) {
        wrap.appendChild(createFacTable(`${t('Facilities only at')} ${data.a.name}`, data.only_a_facilities));
    }
    if (data.only_b_facilities.length > 0) {
        wrap.appendChild(createFacTable(`${t('Facilities only at')} ${data.b.name}`, data.only_b_facilities));
    }
    if (data.only_a_networks.length > 0) {
        wrap.appendChild(createNetTable(`${t('Networks only at')} ${data.a.name}`, data.only_a_networks));
    }
    if (data.only_b_networks.length > 0) {
        wrap.appendChild(createNetTable(`${t('Networks only at')} ${data.b.name}`, data.only_b_networks));
    }

    if (data.shared_facilities.length === 0 && data.shared_networks.length === 0) {
        wrap.appendChild(createEmptyState(t('No shared infrastructure found between these exchanges.')));
    }
}

// ── <pdb-table> factories ───────────────────────────────────────────────

/**
 * Creates a <pdb-table> for IXP rows.
 *
 * @param {string} title - Table title.
 * @param {any[]} rows - IXP overlap records.
 * @param {boolean} showSpeeds - Whether to show per-entity speed/IP columns.
 * @returns {HTMLElement} Configured <pdb-table> element.
 */
function createIxpTable(title, rows, showSpeeds) {
    /** @type {TableColumn[]} */
    const columns = [
        { key: 'ix_name', label: 'Exchange' },
        { key: 'country', label: 'Country', maxWidth: '100px' },
        { key: 'city',    label: 'City', maxWidth: '150px' },
    ];

    if (showSpeeds) {
        columns.push(
            { key: 'speed_a', label: 'Speed A', class: 'td-right', width: '90px' },
            { key: 'speed_b', label: 'Speed B', class: 'td-right', width: '90px' },
            { key: 'ipv4_a',  label: 'IPv4 A', class: 'td-mono', width: '140px' },
            { key: 'ipv4_b',  label: 'IPv4 B', class: 'td-mono', width: '140px' },
        );
    }

    const table = /** @type {any} */ (document.createElement('pdb-table'));
    table.configure({
        tableId: `cmp-ix-${title.slice(0, 10).toLowerCase().replaceAll(' ', '')}`,
        title,
        filterable: rows.length > 10,
        filterPlaceholder: t('Filter exchanges...'),
        columns,
        rows,
        cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
            switch (col.key) {
                case 'ix_name':
                    return createLink('ix', row.ix_id, row.ix_name || `IX ${row.ix_id}`);
                case 'speed_a':
                    return { node: document.createTextNode(formatSpeed(row.speed_a)), sortValue: row.speed_a || 0 };
                case 'speed_b':
                    return { node: document.createTextNode(formatSpeed(row.speed_b)), sortValue: row.speed_b || 0 };
                case 'ipv4_a':
                    return document.createTextNode(row.ipv4_a || '—');
                case 'ipv4_b':
                    return document.createTextNode(row.ipv4_b || '—');
                default:
                    return document.createTextNode(String(row[col.key] ?? '—'));
            }
        }
    });
    return table;
}

/**
 * Creates a <pdb-table> for facility rows.
 *
 * @param {string} title - Table title.
 * @param {any[]} rows - Facility records.
 * @returns {HTMLElement} Configured <pdb-table> element.
 */
function createFacTable(title, rows) {
    const table = /** @type {any} */ (document.createElement('pdb-table'));
    table.configure({
        tableId: `cmp-fac-${title.slice(0, 10).toLowerCase().replaceAll(' ', '')}`,
        title,
        filterable: rows.length > 10,
        filterPlaceholder: t('Filter facilities...'),
        columns: [
            { key: 'fac_name', label: 'Facility' },
            { key: 'country',  label: 'Country', maxWidth: '100px' },
            { key: 'city',     label: 'City', maxWidth: '200px' },
        ],
        rows,
        cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
            if (col.key === 'fac_name') {
                return createLink('fac', row.fac_id, row.fac_name || `Fac ${row.fac_id}`);
            }
            return document.createTextNode(String(row[col.key] ?? '—'));
        }
    });
    return table;
}

/**
 * Creates a <pdb-table> for network rows (ix↔ix comparisons).
 *
 * @param {string} title - Table title.
 * @param {any[]} rows - Network records.
 * @returns {HTMLElement} Configured <pdb-table> element.
 */
function createNetTable(title, rows) {
    const table = /** @type {any} */ (document.createElement('pdb-table'));
    table.configure({
        tableId: `cmp-net-${title.slice(0, 10).toLowerCase().replaceAll(' ', '')}`,
        title,
        filterable: rows.length > 10,
        filterPlaceholder: t('Filter networks...'),
        columns: [
            { key: 'net_name', label: 'Network' },
            { key: 'asn',      label: 'ASN', width: '110px' },
        ],
        rows,
        cellRenderer: (/** @type {any} */ row, /** @type {TableColumn} */ col) => {
            if (col.key === 'net_name') {
                return createLink('net', row.net_id, row.net_name || `Net ${row.net_id}`);
            }
            if (col.key === 'asn') {
                return document.createTextNode(`AS${row.asn}`);
            }
            return document.createTextNode(String(row[col.key] ?? '—'));
        }
    });
    return table;
}
