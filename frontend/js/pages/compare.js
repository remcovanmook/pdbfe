/**
 * @fileoverview Compare page renderer.
 *
 * Displays an entity overlap analysis between two PeeringDB entities.
 * The user selects two entities via side-by-side typeahead search inputs,
 * and the page shows shared and exclusive resources using <pdb-table>.
 *
 * Entity type is inferred from the selected search result — no separate
 * type selector needed. The typeahead is filtered to only return types
 * that support comparison (net, ix).
 *
 * URL: /compare?a={tag}:{id}&b={tag}:{id}
 */

import { fetchCompare, searchWithAsn, fetchEntity } from '../api.js';
import {
    createLoading, createError, createLink, createEntityBadge,
    createStatsBar, createEmptyState, formatSpeed
} from '../render.js';
import { t } from '../i18n.js';

/**
 * Entity types that support comparison — used to filter typeahead results.
 * @type {string[]}
 */
const COMPARE_TYPES = ['net', 'ix', 'fac'];

/**
 * Display labels keyed by entity tag.
 * @type {Record<string, string>}
 */
const TYPE_LABELS = { net: 'Network', ix: 'Exchange', fac: 'Facility' };

/**
 * Maps a compare table title keyword to the entity type tag
 * used for the section badge icon.
 * @type {Record<string, string>}
 */
const SECTION_BADGE_MAP = {
    'IXP':      'ix',
    'Exchange': 'ix',
    'Facilit':  'fac',
    'Network':  'net',
    'Member':   'ix',
};

/**
 * Wraps a pdb-table element inside a .compare-section container
 * with a prominent section header that includes an entity-type
 * badge for quick visual identification.
 *
 * @param {string} title - Section title text.
 * @param {HTMLElement} tableEl - The <pdb-table> element to wrap.
 * @returns {HTMLElement} The .compare-section wrapper.
 */
function wrapSection(title, tableEl) {
    const section = document.createElement('div');
    section.className = 'compare-section';

    const header = document.createElement('div');
    header.className = 'compare-section__header';

    // Determine the badge type from the title by matching keywords
    let badgeTag = '';
    for (const [keyword, tag] of Object.entries(SECTION_BADGE_MAP)) {
        if (title.includes(keyword)) {
            badgeTag = tag;
            break;
        }
    }
    if (badgeTag) {
        header.appendChild(createEntityBadge(badgeTag));
    }

    const titleSpan = document.createElement('span');
    titleSpan.className = 'compare-section__title';
    titleSpan.textContent = title;
    header.appendChild(titleSpan);

    section.appendChild(header);
    section.appendChild(tableEl);
    return section;
}

/**
 * Renders the compare page into the app container.
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
 * Renders the entity selection form with two side-by-side search inputs.
 * The type is inferred from the selected typeahead result — each result
 * shows an entity badge indicating its type.
 *
 * @param {HTMLElement} app - App container element.
 * @param {string} initialA - Pre-filled value for entity A.
 * @param {string} initialB - Pre-filled value for entity B.
 */
function renderSelector(app, initialA, initialB) {
    const wrap = document.createElement('div');
    wrap.className = 'main-content';

    // Page header — reuses detail-header pattern
    const header = document.createElement('div');
    header.className = 'detail-header';

    const title = document.createElement('span');
    title.className = 'detail-header__title';
    title.textContent = t('Compare Entities');
    header.appendChild(title);

    const subtitle = document.createElement('span');
    subtitle.className = 'detail-header__subtitle';
    subtitle.textContent = t('Analyze overlapping infrastructure between two entities.');
    header.appendChild(subtitle);

    wrap.appendChild(header);

    // Explanatory text
    const intro = document.createElement('div');
    intro.className = 'compare-intro';

    const p1 = document.createElement('p');
    p1.textContent = t('Select two Networks, Exchanges, or Facilities below to see where their infrastructure overlaps. The comparison shows shared and exclusive resources: which IXPs both networks peer at, which facilities they both occupy, or which members two exchanges have in common.');
    intro.appendChild(p1);

    const p2 = document.createElement('p');
    p2.textContent = t('Results are split into three sections: resources shared by both entities, resources exclusive to entity A, and resources exclusive to entity B. Use this to evaluate redundancy, identify potential peering opportunities, or plan infrastructure expansion.');
    intro.appendChild(p2);

    wrap.appendChild(intro);

    // Card containing the selection form
    const card = document.createElement('div');
    card.className = 'card';

    const cardBody = document.createElement('div');
    cardBody.className = 'card__body';

    const form = document.createElement('form');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const a = /** @type {HTMLInputElement} */ (form.querySelector('#compare-a-ref')).value;
        const b = /** @type {HTMLInputElement} */ (form.querySelector('#compare-b-ref')).value;
        if (a && b) {
            globalThis.__router.navigate(`/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
        }
    });

    // Side-by-side grid — just two search inputs
    const grid = document.createElement('div');
    grid.className = 'compare-grid';
    grid.appendChild(createEntityInput('A', 'compare-a', initialA));
    grid.appendChild(createEntityInput('B', 'compare-b', initialB));
    form.appendChild(grid);

    // Submit button — centered below grid
    const actions = document.createElement('div');
    actions.className = 'compare-actions';

    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'compare-submit';
    btn.textContent = t('Compare');
    actions.appendChild(btn);
    form.appendChild(actions);

    cardBody.appendChild(form);
    card.appendChild(cardBody);
    wrap.appendChild(card);

    app.replaceChildren(wrap);
}

/**
 * Creates an entity input group with a search input that doubles as the
 * type selector. The typeahead only returns compare-supported types
 * (net, ix), and each dropdown result shows an entity badge so the
 * user can distinguish types visually.
 *
 * @param {string} label - Display label (e.g. "A", "B").
 * @param {string} prefix - ID prefix for the input elements.
 * @param {string} initialRef - Pre-filled entity reference.
 * @returns {HTMLDivElement} The input group element.
 */
function createEntityInput(label, prefix, initialRef) {
    const group = document.createElement('div');

    // Section label
    const lbl = document.createElement('div');
    lbl.className = 'card__title';
    lbl.style.marginBottom = 'var(--space-sm)';
    lbl.textContent = `${t('Entity')} ${label}`;
    group.appendChild(lbl);

    // Search input with typeahead
    const searchWrap = document.createElement('div');
    searchWrap.className = 'compare-search-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = `${prefix}-search`;
    input.className = 'search-input';
    input.placeholder = t('Search by name or ASN...');
    input.autocomplete = 'off';
    searchWrap.appendChild(input);

    // Dropdown — reuses search-dropdown from index.css
    const dropdown = document.createElement('div');
    dropdown.className = 'search-dropdown';
    searchWrap.appendChild(dropdown);

    group.appendChild(searchWrap);

    // Hidden field to store the resolved entity ref
    const refInput = document.createElement('input');
    refInput.type = 'hidden';
    refInput.id = `${prefix}-ref`;
    if (initialRef) {
        refInput.value = initialRef;
        const [tag, id] = initialRef.split(':');
        input.value = initialRef;
        input.disabled = true;

        fetchEntity(tag, id)
            .then(entity => {
                if (entity) {
                    const name = entity.name || initialRef;
                    input.value = name;
                    selected.replaceChildren();
                    selected.appendChild(createEntityBadge(tag));
                    const desc = document.createElement('span');
                    desc.textContent = ` ${name}`;
                    selected.appendChild(desc);
                }
            })
            .catch(() => { /* ignore fetch errors on bootstrap */ })
            .finally(() => {
                input.disabled = false;
            });
    }
    group.appendChild(refInput);

    // Selection confirmation — shows badge + entity name after pick
    const selected = document.createElement('div');
    selected.className = 'compare-selected';
    selected.id = `${prefix}-selected`;
    group.appendChild(selected);

    // Wire up typeahead — filtered to COMPARE_TYPES only
    let debounceTimer = 0;
    let abortCtrl = /** @type {AbortController|null} */ (null);

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        // Clear the previous selection when the user edits
        refInput.value = '';
        selected.replaceChildren();

        const q = input.value.trim();
        if (q.length < 2) {
            dropdown.classList.remove('is-open');
            return;
        }
        debounceTimer = globalThis.setTimeout(async () => {
            if (abortCtrl) abortCtrl.abort();
            abortCtrl = new AbortController();
            try {
                const results = await searchWithAsn(q, abortCtrl.signal, COMPARE_TYPES);
                renderDropdown(dropdown, results, (tag, id, name) => {
                    refInput.value = `${tag}:${id}`;
                    input.value = name;
                    dropdown.classList.remove('is-open');
                    // Show badge + name in selection confirmation
                    selected.replaceChildren();
                    selected.appendChild(createEntityBadge(tag));
                    const desc = document.createElement('span');
                    desc.textContent = ` ${name}`;
                    selected.appendChild(desc);
                });
            } catch { /* aborted or network error */ }
        }, 250);
    });

    input.addEventListener('blur', () => {
        globalThis.setTimeout(() => { dropdown.classList.remove('is-open'); }, 200);
    });

    return group;
}

/**
 * Renders typeahead search results into a dropdown using the
 * search-dropdown structure from index.css. Results are grouped by
 * type, each item prefixed with an entity badge.
 *
 * @param {HTMLElement} dropdown - Dropdown container.
 * @param {Record<string, any[]>} results - Search results grouped by type.
 * @param {(tag: string, id: number, name: string) => void} onSelect - Selection callback.
 */
function renderDropdown(dropdown, results, onSelect) {
    dropdown.replaceChildren();

    let hasResults = false;
    for (const tag of COMPARE_TYPES) {
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

            row.appendChild(createEntityBadge(tag));

            const nameSpan = document.createElement('span');
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
 * Fetches and renders the overlap analysis results. Uses the existing
 * detail-header, stats-bar, and <pdb-table> components.
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
        wrap.className = 'main-content';

        // Header: badge + name for each entity, with "vs" between them
        const header = document.createElement('div');
        header.className = 'detail-header';

        header.appendChild(createEntityBadge(data.a.tag, { header: true }));
        header.appendChild(createLink(data.a.tag, data.a.id, data.a.name));

        if (data.a.asn) {
            const asnA = document.createElement('span');
            asnA.className = 'detail-header__subtitle';
            asnA.textContent = `AS${data.a.asn}`;
            header.appendChild(asnA);
        }

        const vs = document.createElement('span');
        vs.className = 'detail-header__subtitle';
        vs.textContent = 'vs';
        header.appendChild(vs);

        header.appendChild(createEntityBadge(data.b.tag, { header: true }));
        header.appendChild(createLink(data.b.tag, data.b.id, data.b.name));

        if (data.b.asn) {
            const asnB = document.createElement('span');
            asnB.className = 'detail-header__subtitle';
            asnB.textContent = `AS${data.b.asn}`;
            header.appendChild(asnB);
        }

        // "New comparison" link
        const newLink = document.createElement('a');
        newLink.href = '/compare';
        newLink.dataset.link = '';
        newLink.className = 'detail-header__share';
        newLink.textContent = t('New comparison');
        header.appendChild(newLink);

        wrap.appendChild(header);

        const pairKey = data.a.tag < data.b.tag ? `${data.a.tag}+${data.b.tag}` : `${data.b.tag}+${data.a.tag}`;
        if (pairKey === 'net+net') {
            renderNetNetResults(wrap, data);
        } else if (pairKey === 'ix+ix') {
            renderIxIxResults(wrap, data);
        } else if (pairKey === 'fac+fac') {
            renderFacFacResults(wrap, data);
        } else if (pairKey === 'ix+net') {
            renderNetIxResults(wrap, data);
        } else if (pairKey === 'fac+net') {
            renderFacNetResults(wrap, data);
        } else if (pairKey === 'fac+ix') {
            renderFacIxResults(wrap, data);
        }

        app.replaceChildren(wrap);
    } catch (err) {
        app.replaceChildren(createError(err.message));
    }
}

/**
 * Renders net↔net comparison results.
 *
 * @param {HTMLElement} wrap - Page wrapper element.
 * @param {Record<string, any>} data - API response data.
 */
function renderNetNetResults(wrap, data) {
    wrap.appendChild(createStatsBar([
        { label: t('Shared IXPs'), value: data.shared_ixps.length },
        { label: t('Shared Facilities'), value: data.shared_facilities.length },
        { label: `${t('Only')} ${data.a.name}`, value: data.only_a_ixps.length + data.only_a_facilities.length },
        { label: `${t('Only')} ${data.b.name}`, value: data.only_b_ixps.length + data.only_b_facilities.length },
    ]));

    if (data.shared_ixps.length > 0) {
        wrap.appendChild(wrapSection(t('Shared IXPs'), createIxpTable(t('Shared IXPs'), data.shared_ixps, true)));
    }
    if (data.shared_facilities.length > 0) {
        wrap.appendChild(wrapSection(t('Shared Facilities'), createFacTable(t('Shared Facilities'), data.shared_facilities)));
    }
    if (data.only_a_ixps.length > 0) {
        const title = `${t('IXPs only at')} ${data.a.name}`;
        wrap.appendChild(wrapSection(title, createIxpTable(title, data.only_a_ixps, false)));
    }
    if (data.only_b_ixps.length > 0) {
        const title = `${t('IXPs only at')} ${data.b.name}`;
        wrap.appendChild(wrapSection(title, createIxpTable(title, data.only_b_ixps, false)));
    }
    if (data.only_a_facilities.length > 0) {
        const title = `${t('Facilities only at')} ${data.a.name}`;
        wrap.appendChild(wrapSection(title, createFacTable(title, data.only_a_facilities)));
    }
    if (data.only_b_facilities.length > 0) {
        const title = `${t('Facilities only at')} ${data.b.name}`;
        wrap.appendChild(wrapSection(title, createFacTable(title, data.only_b_facilities)));
    }

    if (data.shared_ixps.length === 0 && data.shared_facilities.length === 0) {
        wrap.appendChild(createEmptyState(t('No shared infrastructure found between these networks.')));
    }
}

/**
 * Renders ix↔ix comparison results.
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
        wrap.appendChild(wrapSection(t('Shared Facilities'), createFacTable(t('Shared Facilities'), data.shared_facilities)));
    }
    if (data.shared_networks.length > 0) {
        wrap.appendChild(wrapSection(t('Shared Networks'), createNetTable(t('Shared Networks'), data.shared_networks)));
    }
    if (data.only_a_facilities.length > 0) {
        const title = `${t('Facilities only at')} ${data.a.name}`;
        wrap.appendChild(wrapSection(title, createFacTable(title, data.only_a_facilities)));
    }
    if (data.only_b_facilities.length > 0) {
        const title = `${t('Facilities only at')} ${data.b.name}`;
        wrap.appendChild(wrapSection(title, createFacTable(title, data.only_b_facilities)));
    }
    if (data.only_a_networks.length > 0) {
        const title = `${t('Networks only at')} ${data.a.name}`;
        wrap.appendChild(wrapSection(title, createNetTable(title, data.only_a_networks)));
    }
    if (data.only_b_networks.length > 0) {
        const title = `${t('Networks only at')} ${data.b.name}`;
        wrap.appendChild(wrapSection(title, createNetTable(title, data.only_b_networks)));
    }

    if (data.shared_facilities.length === 0 && data.shared_networks.length === 0) {
        wrap.appendChild(createEmptyState(t('No shared infrastructure found between these exchanges.')));
    }
}

/**
 * Renders fac↔fac comparison results.
 *
 * @param {HTMLElement} wrap - Page wrapper element.
 * @param {Record<string, any>} data - API response data.
 */
function renderFacFacResults(wrap, data) {
    wrap.appendChild(createStatsBar([
        { label: t('Shared Networks'), value: data.shared_networks.length },
        { label: t('Shared IXPs'), value: data.shared_ixps.length },
        { label: `${t('Only')} ${data.a.name}`, value: data.only_a_networks.length + data.only_a_ixps.length },
        { label: `${t('Only')} ${data.b.name}`, value: data.only_b_networks.length + data.only_b_ixps.length },
    ]));

    if (data.shared_networks.length > 0) {
        wrap.appendChild(wrapSection(t('Shared Networks'), createNetTable(t('Shared Networks'), data.shared_networks)));
    }
    if (data.shared_ixps.length > 0) {
        wrap.appendChild(wrapSection(t('Shared IXPs'), createIxpTable(t('Shared IXPs'), data.shared_ixps, false)));
    }
    if (data.only_a_networks.length > 0) {
        const title = `${t('Networks only at')} ${data.a.name}`;
        wrap.appendChild(wrapSection(title, createNetTable(title, data.only_a_networks)));
    }
    if (data.only_b_networks.length > 0) {
        const title = `${t('Networks only at')} ${data.b.name}`;
        wrap.appendChild(wrapSection(title, createNetTable(title, data.only_b_networks)));
    }
    if (data.only_a_ixps.length > 0) {
        const title = `${t('IXPs only at')} ${data.a.name}`;
        wrap.appendChild(wrapSection(title, createIxpTable(title, data.only_a_ixps, false)));
    }
    if (data.only_b_ixps.length > 0) {
        const title = `${t('IXPs only at')} ${data.b.name}`;
        wrap.appendChild(wrapSection(title, createIxpTable(title, data.only_b_ixps, false)));
    }

    if (data.shared_networks.length === 0 && data.shared_ixps.length === 0) {
        wrap.appendChild(createEmptyState(t('No shared topology found between these facilities.')));
    }
}

/**
 * Renders net↔ix comparison results.
 *
 * @param {HTMLElement} wrap - Page wrapper element.
 * @param {Record<string, any>} data - API response data.
 */
function renderNetIxResults(wrap, data) {
    const isNetA = data.a.tag === 'net';
    const net = isNetA ? data.a : data.b;
    const ix = isNetA ? data.b : data.a;
    const netFacs = isNetA ? data.only_a_facilities : data.only_b_facilities;
    const ixFacs = isNetA ? data.only_b_facilities : data.only_a_facilities;

    wrap.appendChild(createStatsBar([
        { label: t('Shared Facilities'), value: data.shared_facilities.length },
        { label: `${t('Only')} ${net.name}`, value: netFacs.length },
        { label: `${t('Only')} ${ix.name}`, value: ixFacs.length },
    ]));

    if (data.membership && data.membership.length > 0) {
        const memberTitle = t('Direct Membership Details');
        const membershipTable = createIxpTable(memberTitle, data.membership.map((/** @type {any} */ m) => ({ ...m, ix_id: ix.id, ix_name: ix.name, speed_a: m.speed, ipv4_a: m.ipaddr4, ipv6_a: m.ipaddr6 })), true);
        wrap.appendChild(wrapSection(memberTitle, membershipTable));
    } else {
        wrap.appendChild(createEmptyState(t('{net} is NOT currently peering at {ix}.', { net: net.name, ix: ix.name })));
    }

    if (data.shared_facilities.length > 0) {
        wrap.appendChild(wrapSection(t('Shared Facilities'), createFacTable(t('Shared Facilities'), data.shared_facilities)));
    }
    if (netFacs.length > 0) {
        const title = `${t('Facilities only at')} ${net.name}`;
        wrap.appendChild(wrapSection(title, createFacTable(title, netFacs)));
    }
    if (ixFacs.length > 0) {
        const title = `${t('Facilities only at')} ${ix.name}`;
        wrap.appendChild(wrapSection(title, createFacTable(title, ixFacs)));
    }
}

/**
 * Renders fac↔net comparison results.
 *
 * @param {HTMLElement} wrap - Page wrapper element.
 * @param {Record<string, any>} data - API response data.
 */
function renderFacNetResults(wrap, data) {
    const isFacA = data.a.tag === 'fac';
    const fac = isFacA ? data.a : data.b;
    const net = isFacA ? data.b : data.a;
    const facIxps = isFacA ? data.only_a_ixps : data.only_b_ixps;
    const netIxps = isFacA ? data.only_b_ixps : data.only_a_ixps;

    wrap.appendChild(createStatsBar([
        { label: t('Shared IXPs'), value: data.shared_ixps.length },
        { label: `${t('Only')} ${fac.name}`, value: facIxps.length },
        { label: `${t('Only')} ${net.name}`, value: netIxps.length },
    ]));

    if (data.shared_ixps.length > 0) {
        const title = t('IXPs in facility {fac} that {net} peers at').replace('{fac}', fac.name).replace('{net}', net.name);
        wrap.appendChild(wrapSection(title, createIxpTable(title, data.shared_ixps, true)));
    }
    if (facIxps.length > 0) {
        const title = `${t('IXPs at')} ${fac.name} ${t('missing from')} ${net.name}`;
        wrap.appendChild(wrapSection(title, createIxpTable(title, facIxps, false)));
    }
    if (netIxps.length > 0) {
        const title = `${t('IXPs')} ${net.name} ${t('peers at that are NOT at')} ${fac.name}`;
        wrap.appendChild(wrapSection(title, createIxpTable(title, netIxps, true)));
    }
}

/**
 * Renders fac↔ix comparison results.
 *
 * @param {HTMLElement} wrap - Page wrapper element.
 * @param {Record<string, any>} data - API response data.
 */
function renderFacIxResults(wrap, data) {
    const isFacA = data.a.tag === 'fac';
    const fac = isFacA ? data.a : data.b;
    const ix = isFacA ? data.b : data.a;
    const facNets = isFacA ? data.only_a_networks : data.only_b_networks;
    const ixNets = isFacA ? data.only_b_networks : data.only_a_networks;

    wrap.appendChild(createStatsBar([
        { label: t('Shared Networks'), value: data.shared_networks.length },
        { label: `${t('Only')} ${fac.name}`, value: facNets.length },
        { label: `${t('Only')} ${ix.name}`, value: ixNets.length },
    ]));

    if (data.shared_networks.length > 0) {
        const title = t('Networks in facility {fac} peering at {ix}').replace('{fac}', fac.name).replace('{ix}', ix.name);
        wrap.appendChild(wrapSection(title, createNetTable(title, data.shared_networks)));
    }
    if (facNets.length > 0) {
        const title = `${t('Networks at')} ${fac.name} ${t('missing from')} ${ix.name}`;
        wrap.appendChild(wrapSection(title, createNetTable(title, facNets)));
    }
    if (ixNets.length > 0) {
        const title = `${t('Networks at')} ${ix.name} ${t('NOT at')} ${fac.name}`;
        wrap.appendChild(wrapSection(title, createNetTable(title, ixNets)));
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
