/**
 * @fileoverview Advanced search page module. Renders a tabbed interface
 * for building multi-field queries against all PeeringDB entity types.
 *
 * Each tab generates a form from hardcoded field definitions, with text
 * inputs, enum chip-selects, boolean tri-states, and presence typeaheads.
 * Results render inline as paginated pdb-table elements.
 *
 * URL state is serialised into query params so searches are shareable.
 */

import { fetchList, fetchByAsn } from '../api.js';
import {
    createLoading, createError, createEntityBadge, createEmptyState, createLink
} from '../render.js';
import { t } from '../i18n.js';
import { ChipSelect } from '../components/chip-select.js';
import { COUNTRIES } from '../countries.js';

// ── Enum definitions (from upstream django-peeringdb schema) ────────────

/**
 * @typedef {Object} EnumDef
 * @property {string} field - API field name.
 * @property {string} label - Display label.
 * @property {{value: string, label: string}[]} options - Enum options.
 */

/** @type {Record<string, EnumDef[]>} */
const ENUMS = {
    net: [
        {
            field: 'info_type', label: 'Network Type', options: [
                { value: 'Not Disclosed', label: 'Not Disclosed' },
                { value: 'NSP', label: 'NSP' },
                { value: 'Content', label: 'Content' },
                { value: 'Cable/DSL/ISP', label: 'Cable/DSL/ISP' },
                { value: 'Enterprise', label: 'Enterprise' },
                { value: 'Educational/Research', label: 'Educational/Research' },
                { value: 'Non-Profit', label: 'Non-Profit' },
                { value: 'Route Server', label: 'Route Server' },
                { value: 'Network Services', label: 'Network Services' },
                { value: 'Route Collector', label: 'Route Collector' },
                { value: 'Government', label: 'Government' },
            ]
        },
        {
            field: 'info_traffic', label: 'Traffic Levels', options: [
                { value: 'Not Disclosed', label: 'Not Disclosed' },
                { value: '0-20Mbps', label: '0-20Mbps' },
                { value: '20-100Mbps', label: '20-100Mbps' },
                { value: '100-1000Mbps', label: '100-1000Mbps' },
                { value: '1-5Gbps', label: '1-5Gbps' },
                { value: '5-10Gbps', label: '5-10Gbps' },
                { value: '10-20Gbps', label: '10-20Gbps' },
                { value: '20-50Gbps', label: '20-50Gbps' },
                { value: '50-100Gbps', label: '50-100Gbps' },
                { value: '100+Gbps', label: '100+Gbps' },
                { value: '100-1Tbps', label: '100-1Tbps' },
                { value: '1+Tbps', label: '1+Tbps' },
            ]
        },
        {
            field: 'info_ratio', label: 'Traffic Ratio', options: [
                { value: 'Not Disclosed', label: 'Not Disclosed' },
                { value: 'Heavy Outbound', label: 'Heavy Outbound' },
                { value: 'Mostly Outbound', label: 'Mostly Outbound' },
                { value: 'Balanced', label: 'Balanced' },
                { value: 'Mostly Inbound', label: 'Mostly Inbound' },
                { value: 'Heavy Inbound', label: 'Heavy Inbound' },
            ]
        },
        {
            field: 'info_scope', label: 'Geographic Scope', options: [
                { value: 'Not Disclosed', label: 'Not Disclosed' },
                { value: 'Regional', label: 'Regional' },
                { value: 'North America', label: 'North America' },
                { value: 'Asia Pacific', label: 'Asia Pacific' },
                { value: 'Europe', label: 'Europe' },
                { value: 'South America', label: 'South America' },
                { value: 'Africa', label: 'Africa' },
                { value: 'Australia', label: 'Australia' },
                { value: 'Middle East', label: 'Middle East' },
                { value: 'Global', label: 'Global' },
            ]
        },
        {
            field: 'policy_general', label: 'General Peering Policy', options: [
                { value: 'Open', label: 'Open' },
                { value: 'Selective', label: 'Selective' },
                { value: 'Restrictive', label: 'Restrictive' },
                { value: 'No', label: 'No' },
            ]
        },
    ],
    ix: [
        { field: 'region_continent', label: 'Continental Region', options: null },
        {
            field: 'service_level', label: 'Service Level', options: [
                { value: 'Not Disclosed', label: 'Not Disclosed' },
                { value: 'Best Effort', label: 'Best Effort (no SLA)' },
                { value: 'Normal Business Hours', label: 'Normal Business Hours' },
                { value: '24/7 Support', label: '24/7 Support' },
            ]
        },
        {
            field: 'terms', label: 'Terms', options: [
                { value: 'Not Disclosed', label: 'Not Disclosed' },
                { value: 'No Commercial Terms', label: 'No Commercial Terms' },
                { value: 'Bundled With Other Services', label: 'Bundled With Other Services' },
                { value: 'Non-recurring Fees Only', label: 'Non-recurring Fees Only' },
                { value: 'Recurring Fees', label: 'Recurring Fees' },
            ]
        },
    ],
    fac: [
        { field: 'region_continent', label: 'Continental Region', options: null },
        {
            field: 'property', label: 'Property', options: [
                { value: 'Owner', label: 'Owner' },
                { value: 'Lessee', label: 'Lessee' },
                { value: 'Not Disclosed', label: 'Not Disclosed' },
            ]
        },
    ],
    org: [],
    campus: [],
    carrier: [],
};

// ── Tab definitions ─────────────────────────────────────────────────────

/**
 * @typedef {Object} TabDef
 * @property {string} key - URL hash key and entity tag.
 * @property {string} label - Display label.
 * @property {string} badge - Entity badge tag for visual language.
 * @property {TextField[]} textFields - Free-text search fields.
 * @property {string[]} boolFields - Boolean tri-state filter fields.
 * @property {boolean} [hasCountry] - Whether to show the country chip-select.
 */

/**
 * @typedef {Object} TextField
 * @property {string} field - API field name.
 * @property {string} label - Display label.
 * @property {string} [placeholder] - Input placeholder.
 */

/** @type {TabDef[]} */
const TABS = [
    {
        key: 'ix', label: 'Exchanges', badge: 'ix',
        textFields: [
            { field: 'name', label: 'Name' },
            { field: 'city', label: 'City' },
            { field: 'name_long', label: 'Organization', placeholder: 'Search by organization name...' },
        ],
        boolFields: ['proto_unicast', 'proto_multicast', 'proto_ipv6'],
        hasCountry: true,
    },
    {
        key: 'net', label: 'Networks', badge: 'net',
        textFields: [
            { field: 'name', label: 'Name' },
            { field: 'asn', label: 'ASN' },
            { field: 'irr_as_set', label: 'IRR as-set/route-set' },
        ],
        boolFields: ['info_unicast', 'info_multicast', 'info_ipv6', 'info_never_via_route_servers'],
        hasCountry: false,
    },
    {
        key: 'asn_connectivity', label: 'ASN Connectivity', badge: 'asn',
        textFields: [],
        boolFields: [],
        hasCountry: false,
    },
    {
        key: 'fac', label: 'Facilities', badge: 'fac',
        textFields: [
            { field: 'name', label: 'Name' },
            { field: 'address1', label: 'Address' },
            { field: 'city', label: 'City' },
            { field: 'state', label: 'State' },
            { field: 'zipcode', label: 'Postal Code' },
            { field: 'clli', label: 'CLLI' },
            { field: 'npanxx', label: 'NPA-NXX' },
        ],
        boolFields: ['diverse_serving_substations'],
        hasCountry: true,
    },
    {
        key: 'org', label: 'Organizations', badge: 'org',
        textFields: [
            { field: 'name', label: 'Name' },
            { field: 'city', label: 'City' },
            { field: 'state', label: 'State' },
        ],
        boolFields: [],
        hasCountry: true,
    },
    {
        key: 'campus', label: 'Campus', badge: 'campus',
        textFields: [
            { field: 'name', label: 'Name' },
        ],
        boolFields: [],
        hasCountry: false,
    },
    {
        key: 'carrier', label: 'Carriers', badge: 'carrier',
        textFields: [
            { field: 'name', label: 'Name' },
        ],
        boolFields: [],
        hasCountry: false,
    },
];

/** Country chip-select options, derived from ISO-3166 list. */
const COUNTRY_OPTIONS = COUNTRIES.map(c => ({ value: c.code, label: `${c.name} (${c.code})` }));

/**
 * Region chip-select options, shared across ix/fac.
 * ENUMS entries with `options: null` for region_continent resolve to this.
 */
const REGION_OPTIONS = [
    { value: 'North America', label: 'North America' },
    { value: 'Asia Pacific', label: 'Asia Pacific' },
    { value: 'Europe', label: 'Europe' },
    { value: 'South America', label: 'South America' },
    { value: 'Africa', label: 'Africa' },
    { value: 'Australia', label: 'Australia' },
    { value: 'Middle East', label: 'Middle East' },
];

// ── Boolean field labels ────────────────────────────────────────────────

/** @type {Record<string, string>} */
const BOOL_LABELS = {
    proto_unicast: 'Unicast',
    proto_multicast: 'Multicast',
    proto_ipv6: 'IPv6',
    info_unicast: 'Unicast',
    info_multicast: 'Multicast',
    info_ipv6: 'IPv6',
    info_never_via_route_servers: 'Never via Route Servers',
    diverse_serving_substations: 'Diverse Serving Substations',
};

// ── Result columns per entity type ──────────────────────────────────────

/** @type {Record<string, {field: string, label: string, link?: boolean}[]>} */
const RESULT_COLUMNS = {
    ix: [
        { field: 'name', label: 'Name', link: true },
        { field: 'country', label: 'Country' },
        { field: 'city', label: 'City' },
        { field: 'net_count', label: 'Networks' },
    ],
    net: [
        { field: 'name', label: 'Name', link: true },
        { field: 'aka', label: 'Also known as' },
        { field: 'asn', label: 'ASN' },
        { field: 'info_type', label: 'Network Type' },
        { field: 'policy_general', label: 'General Policy' },
        { field: 'info_traffic', label: 'Traffic Levels' },
        { field: 'ix_count', label: 'Exchanges' },
        { field: 'fac_count', label: 'Facilities' },
    ],
    fac: [
        { field: 'name', label: 'Name', link: true },
        { field: 'clli', label: 'CLLI' },
        { field: 'npanxx', label: 'NPA-NXX' },
        { field: 'city', label: 'City' },
        { field: 'country', label: 'Country' },
        { field: 'state', label: 'State' },
        { field: 'zipcode', label: 'Postal Code' },
        { field: 'net_count', label: 'Networks' },
    ],
    org: [
        { field: 'name', label: 'Name', link: true },
        { field: 'city', label: 'City' },
        { field: 'country', label: 'Country' },
        { field: 'state', label: 'State' },
    ],
    campus: [
        { field: 'name', label: 'Name', link: true },
        { field: 'country', label: 'Country' },
        { field: 'city', label: 'City' },
    ],
    carrier: [
        { field: 'name', label: 'Name', link: true },
        { field: 'fac_count', label: 'Facilities' },
    ],
};

// ── Page entry point ────────────────────────────────────────────────────

/**
 * Renders the advanced search page.
 *
 * @param {Record<string, string>} params - Route params (query params + hash).
 */
export async function renderAdvancedSearch(params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    document.title = `${t('Advanced Search')} — PDBFE`;

    const wrap = document.createElement('div');
    wrap.className = 'adv-search';

    // Determine active tab from URL hash or params
    const hash = globalThis.location.hash.replace('#', '');
    const activeTab = TABS.find(tb => tb.key === hash) ? hash : 'ix';

    // Tab bar
    const tabBar = buildTabBar(activeTab);
    wrap.appendChild(tabBar);

    // Form + results container
    const formWrap = document.createElement('div');
    formWrap.id = 'adv-search-form-wrap';
    wrap.appendChild(formWrap);

    const resultsWrap = document.createElement('div');
    resultsWrap.id = 'adv-search-results';
    resultsWrap.className = 'adv-search__results';
    wrap.appendChild(resultsWrap);

    app.replaceChildren(wrap);

    // Render the active tab form
    renderTabForm(activeTab, formWrap, resultsWrap, params);
}

// ── Tab bar ─────────────────────────────────────────────────────────────

/**
 * Builds the tab navigation bar with entity badges.
 *
 * @param {string} activeKey - The currently active tab key.
 * @returns {HTMLElement} The tab bar element.
 */
function buildTabBar(activeKey) {
    const bar = document.createElement('nav');
    bar.className = 'adv-search__tabs';
    bar.setAttribute('role', 'tablist');

    for (const tab of TABS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'adv-search__tab';
        if (tab.key === activeKey) btn.classList.add('adv-search__tab--active');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', tab.key === activeKey ? 'true' : 'false');
        btn.dataset.tab = tab.key;

        // Entity badge for visual reinforcement
        btn.appendChild(createEntityBadge(tab.badge));

        const label = document.createElement('span');
        label.textContent = t(tab.label);
        btn.appendChild(label);

        btn.addEventListener('click', () => {
            globalThis.history.replaceState(null, '', `/advanced_search#${tab.key}`);
            // Re-render
            const formWrap = /** @type {HTMLElement} */ (document.getElementById('adv-search-form-wrap'));
            const resultsWrap = /** @type {HTMLElement} */ (document.getElementById('adv-search-results'));
            if (formWrap && resultsWrap) {
                // Update active state
                for (const b of bar.querySelectorAll('.adv-search__tab')) {
                    const htmlB = /** @type {HTMLElement} */ (b);
                    b.classList.toggle('adv-search__tab--active', htmlB.dataset.tab === tab.key);
                    b.setAttribute('aria-selected', htmlB.dataset.tab === tab.key ? 'true' : 'false');
                }
                resultsWrap.innerHTML = '';
                renderTabForm(tab.key, formWrap, resultsWrap, {});
            }
        });

        bar.appendChild(btn);
    }

    return bar;
}

// ── Tab form rendering ──────────────────────────────────────────────────

/**
 * Renders the search form for a specific tab.
 *
 * @param {string} tabKey - The tab key (entity type or 'asn_connectivity').
 * @param {HTMLElement} formWrap - Container for the form.
 * @param {HTMLElement} resultsWrap - Container for results.
 * @param {Record<string, string>} params - URL query params to pre-fill.
 */
function renderTabForm(tabKey, formWrap, resultsWrap, params) {
    formWrap.innerHTML = '';

    if (tabKey === 'asn_connectivity') {
        renderAsnConnectivityForm(formWrap, resultsWrap);
        return;
    }

    const tabDef = TABS.find(tb => tb.key === tabKey);
    if (!tabDef) return;

    const form = document.createElement('form');
    form.className = 'adv-search__form';
    form.addEventListener('submit', (e) => e.preventDefault());

    const grid = document.createElement('div');
    grid.className = 'adv-search__grid';

    /** @type {Map<string, () => string|string[]>} */
    const fieldGetters = new Map();

    // Text fields
    for (const tf of tabDef.textFields) {
        const { el, getValue } = createTextField(tf.field, tf.label, tf.placeholder, params[tf.field] || '');
        grid.appendChild(el);
        fieldGetters.set(tf.field, getValue);
    }



    // Enum chip-selects (region_continent entries with null options resolve to REGION_OPTIONS)
    const enums = ENUMS[tabKey] || [];
    for (const enumDef of enums) {
        const options = enumDef.options || REGION_OPTIONS;
        const { el, chipSelect } = createChipField(enumDef.field, t(enumDef.label), options, params[`${enumDef.field}__in`]);
        grid.appendChild(el);
        fieldGetters.set(`${enumDef.field}__in`, () => chipSelect.getValues());
    }

    // Country chip-select (separate from enums — uses typeahead-style search)
    if (tabDef.hasCountry) {
        const { el, chipSelect } = createChipField('country', t('Country'), COUNTRY_OPTIONS, params.country__in);
        grid.appendChild(el);
        fieldGetters.set('country__in', () => chipSelect.getValues());
    }

    // Boolean tri-state fields
    for (const bf of tabDef.boolFields) {
        const { el, getValue } = createBoolField(bf, BOOL_LABELS[bf] || bf, params[bf]);
        grid.appendChild(el);
        fieldGetters.set(bf, getValue);
    }

    form.appendChild(grid);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'adv-search__actions';

    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'btn btn--primary';
    searchBtn.textContent = t('Search');
    searchBtn.addEventListener('click', () => {
        executeSearch(tabKey, fieldGetters, resultsWrap);
    });
    actions.appendChild(searchBtn);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn btn--secondary';
    resetBtn.textContent = t('Reset');
    resetBtn.addEventListener('click', () => {
        form.querySelectorAll('input[type="text"]').forEach(/** @param {any} inp */ (inp) => { inp.value = ''; });
        form.querySelectorAll('select').forEach(/** @param {any} sel */ (sel) => { sel.value = ''; });
        // Clear chip selects
        form.querySelectorAll('.chip-select').forEach((/** @type {any} */ cs) => {
            // Find the ChipSelect instance — we stored it as a data attribute
            const instance = cs._chipSelectInstance;
            if (instance) instance.clear();
        });
        resultsWrap.innerHTML = '';
    });
    actions.appendChild(resetBtn);

    form.appendChild(actions);
    formWrap.appendChild(form);
}

// ── Field builders ──────────────────────────────────────────────────────

/**
 * Creates the shared wrapper + label structure for form fields.
 *
 * @param {string} field - API field name (used for label `for` attribute).
 * @param {string} label - Display label.
 * @param {boolean} [linkFor] - Whether to set the label's `for` attribute.
 * @returns {HTMLElement} The wrapper element with a label already appended.
 */
function createFieldWrapper(field, label, linkFor = true) {
    const wrapper = document.createElement('div');
    wrapper.className = 'form-field';
    const lbl = document.createElement('label');
    lbl.className = 'form-label';
    lbl.textContent = t(label);
    if (linkFor) lbl.setAttribute('for', `adv-${field}`);
    wrapper.appendChild(lbl);
    return wrapper;
}

/**
 * Creates a labelled text input field.
 *
 * @param {string} field - API field name.
 * @param {string} label - Display label.
 * @param {string} [placeholder] - Input placeholder.
 * @param {string} [initialValue] - Pre-filled value.
 * @returns {{el: HTMLElement, getValue: () => string}} Field element and value getter.
 */
function createTextField(field, label, placeholder, initialValue) {
    const wrapper = createFieldWrapper(field, label);
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `adv-${field}`;
    input.className = 'form-input';
    input.placeholder = placeholder || '';
    if (initialValue) input.value = initialValue;
    wrapper.appendChild(input);
    return { el: wrapper, getValue: () => input.value.trim() };
}

/**
 * Creates a chip-select multi-value field.
 *
 * @param {string} field - API field name.
 * @param {string} label - Display label.
 * @param {{value: string, label: string}[]} options - Available options.
 * @param {string} [initialCsv] - Comma-separated initial values.
 * @returns {{el: HTMLElement, chipSelect: ChipSelect}} Field element and component.
 */
function createChipField(field, label, options, initialCsv) {
    const wrapper = createFieldWrapper(field, label, false);
    const initial = initialCsv ? initialCsv.split(',').filter(Boolean) : [];
    const chipSelect = new ChipSelect({ options, initial, placeholder: t('Select...') });
    /** @type {any} */ (chipSelect.el)._chipSelectInstance = chipSelect;
    wrapper.appendChild(chipSelect.el);
    return { el: wrapper, chipSelect };
}

/**
 * Creates a boolean tri-state dropdown (Any / Yes / No).
 *
 * @param {string} field - API field name.
 * @param {string} label - Display label.
 * @param {string} [initialValue] - Pre-filled value ('true'/'false'/undefined).
 * @returns {{el: HTMLElement, getValue: () => string}} Field element and value getter.
 */
function createBoolField(field, label, initialValue) {
    const wrapper = createFieldWrapper(field, label);
    const select = document.createElement('select');
    select.id = `adv-${field}`;
    select.className = 'form-select';

    const optAny = document.createElement('option');
    optAny.value = '';
    optAny.textContent = t('Does not matter');
    select.appendChild(optAny);

    const optYes = document.createElement('option');
    optYes.value = 'true';
    optYes.textContent = t('Yes');
    if (initialValue === 'true') optYes.selected = true;
    select.appendChild(optYes);

    const optNo = document.createElement('option');
    optNo.value = 'false';
    optNo.textContent = t('No');
    if (initialValue === 'false') optNo.selected = true;
    select.appendChild(optNo);

    wrapper.appendChild(select);
    return { el: wrapper, getValue: () => select.value };
}

// ── ASN Connectivity form ───────────────────────────────────────────────

/**
 * Renders the ASN Connectivity verification form.
 * Accepts a list of ASNs and checks which ones are registered in PeeringDB.
 *
 * @param {HTMLElement} formWrap - Container for the form.
 * @param {HTMLElement} resultsWrap - Container for results.
 */
function renderAsnConnectivityForm(formWrap, resultsWrap) {
    const form = document.createElement('form');
    form.className = 'adv-search__form';
    form.addEventListener('submit', (e) => e.preventDefault());

    const desc = document.createElement('p');
    desc.className = 'adv-search__desc';
    desc.textContent = t('Enter a list of ASNs (one per line or comma-separated) to check their PeeringDB registration and connectivity.');
    form.appendChild(desc);

    const textarea = document.createElement('textarea');
    textarea.className = 'form-textarea';
    textarea.placeholder = t('e.g. 13335, 20940, 15169');
    textarea.rows = 6;
    form.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'adv-search__actions';

    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'btn btn--primary';
    searchBtn.textContent = t('Verify ASNs');
    searchBtn.addEventListener('click', async () => {
        const raw = textarea.value.trim();
        if (!raw) return;

        const asns = raw.split(/[,\s\n]+/).map(s => s.trim().replace(/^as/i, '')).filter(s => /^\d+$/.test(s));
        if (asns.length === 0) {
            resultsWrap.replaceChildren(createError(t('No valid ASNs found in input.')));
            return;
        }

        resultsWrap.replaceChildren(createLoading(t('Verifying {count} ASNs...', { count: String(asns.length) })));

        try {
            const results = await Promise.all(
                asns.map(async (asn) => {
                    const net = await fetchByAsn(asn).catch(/** @returns {null} */ () => null);
                    return { asn, net };
                })
            );

            renderAsnResults(resultsWrap, results);
        } catch (err) {
            resultsWrap.replaceChildren(createError(t('ASN verification failed: {error}', { error: /** @type {Error} */(err).message })));
        }
    });
    actions.appendChild(searchBtn);

    form.appendChild(actions);
    formWrap.appendChild(form);
}

/**
 * Renders ASN verification results as a table.
 *
 * @param {HTMLElement} wrap - Results container.
 * @param {{asn: string, net: any}[]} results - ASN lookup results.
 */
function renderAsnResults(wrap, results) {
    const found = results.filter(r => r.net);
    const missing = results.filter(r => !r.net);

    const summary = document.createElement('p');
    summary.className = 'adv-search__summary';
    summary.textContent = t('{found} of {total} ASNs registered in PeeringDB.', {
        found: String(found.length),
        total: String(results.length),
    });
    wrap.replaceChildren(summary);

    if (found.length > 0) {
        const columns = [
            { label: 'ASN', render: (/** @type {any} */ r) => `AS${r.net.asn}` },
            { label: 'Name', render: (/** @type {any} */ r) => createLink('net', r.net.id, r.net.name) },
            { label: 'Network Type', render: (/** @type {any} */ r) => r.net.info_type || '—' },
            { label: 'Policy', render: (/** @type {any} */ r) => r.net.policy_general || '—' },
            { label: 'IXPs', render: (/** @type {any} */ r) => String(r.net.ix_count ?? 0) },
            { label: 'Facilities', render: (/** @type {any} */ r) => String(r.net.fac_count ?? 0) },
        ];
        wrap.appendChild(buildTable(columns, found));
    }

    if (missing.length > 0) {
        const missingHeader = document.createElement('h3');
        missingHeader.className = 'adv-search__missing-header';
        missingHeader.textContent = t('Not found in PeeringDB');
        wrap.appendChild(missingHeader);

        const missingList = document.createElement('p');
        missingList.className = 'adv-search__missing-list';
        missingList.textContent = missing.map(r => `AS${r.asn}`).join(', ');
        wrap.appendChild(missingList);
    }
}

// ── Search execution ────────────────────────────────────────────────────

/**
 * Collects form values, builds API query params, executes the search,
 * and renders results.
 *
 * @param {string} entityType - Entity tag to query.
 * @param {Map<string, () => string|string[]>} fieldGetters - Map of field name → value getter.
 * @param {HTMLElement} resultsWrap - Results container.
 */
async function executeSearch(entityType, fieldGetters, resultsWrap) {
    /** @type {Record<string, string|number>} */
    const filters = {};

    for (const [key, getter] of fieldGetters) {
        const value = getter();
        if (Array.isArray(value)) {
            // Chip-select: join values for __in operator
            if (value.length > 0) {
                filters[key] = value.join(',');
            }
        } else if (typeof value === 'string' && value !== '') {
            // Text or bool field
            if (key === 'asn') {
                // ASN is exact match
                filters[key] = value;
            } else if (key.endsWith('__in')) {
                filters[key] = value;
            } else if (value === 'true' || value === 'false') {
                // Boolean field
                filters[key] = value;
            } else {
                // Text field: use __contains for substring matching
                filters[`${key}__contains`] = value;
            }
        }
    }

    // Update URL with active filters
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
        searchParams.set(k, String(v));
    }
    const hash = globalThis.location.hash;
    const paramStr = searchParams.toString();
    const newUrl = `/advanced_search${hash}${paramStr ? '?' + paramStr : ''}`;
    globalThis.history.replaceState(null, '', newUrl);

    resultsWrap.replaceChildren(createLoading(t('Searching...')));

    try {
        const results = await fetchList(entityType, { ...filters, limit: 250 });
        renderResults(entityType, results, resultsWrap);
    } catch (err) {
        resultsWrap.replaceChildren(
            createError(t('Search failed: {error}', { error: /** @type {Error} */(err).message }))
        );
    }
}

// ── Table builder ───────────────────────────────────────────────────────

/**
 * Builds a `<table>` element from column definitions and row data.
 * Each column has a label (used for the header) and a render function
 * that returns either a string (set as textContent) or a DOM node
 * (appended as a child).
 *
 * Shared by renderResults and renderAsnResults to avoid duplicated
 * thead/tbody construction boilerplate.
 *
 * @param {{label: string, render: (item: any) => string|Node}[]} columns
 * @param {any[]} rows
 * @returns {HTMLTableElement}
 */
function buildTable(columns, rows) {
    const table = document.createElement('table');
    table.className = 'data-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of columns) {
        const th = document.createElement('th');
        th.textContent = t(col.label);
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const item of rows) {
        const tr = document.createElement('tr');
        for (const col of columns) {
            const td = document.createElement('td');
            const val = col.render(item);
            if (val instanceof Node) {
                td.appendChild(val);
            } else {
                td.textContent = val;
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
}

// ── Results rendering ───────────────────────────────────────────────────

/**
 * Renders search results as a table.
 *
 * @param {string} entityType - Entity tag.
 * @param {any[]} results - Array of entity objects from the API.
 * @param {HTMLElement} wrap - Results container.
 */
function renderResults(entityType, results, wrap) {
    if (results.length === 0) {
        wrap.replaceChildren(createEmptyState(t('No results found. Try broader search criteria.')));
        return;
    }

    const colDefs = RESULT_COLUMNS[entityType] || [{ field: 'name', label: 'Name', link: true }];

    const summary = document.createElement('p');
    summary.className = 'adv-search__summary';
    summary.textContent = t('{count} results', { count: String(results.length) });
    if (results.length >= 250) {
        summary.textContent += ` (${t('limit reached — refine your search')})`;
    }

    // Convert RESULT_COLUMNS format to buildTable column format
    const columns = colDefs.map(col => ({
        label: col.label,
        render: col.link && col.field === 'name'
            ? (/** @type {any} */ item) => createLink(entityType, item.id, item.name || '—')
            : (/** @type {any} */ item) => {
                const val = item[col.field];
                return val !== null && val !== undefined && val !== '' ? String(val) : '—';
            },
    }));

    const table = buildTable(columns, results);

    // CSV export
    const exportWrap = document.createElement('div');
    exportWrap.className = 'adv-search__export';

    const csvBtn = document.createElement('button');
    csvBtn.type = 'button';
    csvBtn.className = 'btn btn--secondary';
    csvBtn.textContent = t('Export CSV');
    csvBtn.addEventListener('click', () => {
        exportCsv(entityType, colDefs, results);
    });
    exportWrap.appendChild(csvBtn);

    wrap.replaceChildren(summary, table, exportWrap);
}

/**
 * Exports results as a CSV file download.
 *
 * @param {string} entityType - Entity tag (used in filename).
 * @param {{field: string, label: string}[]} columns - Column definitions.
 * @param {any[]} results - Entity objects.
 */
function exportCsv(entityType, columns, results) {
    const header = columns.map(c => c.label).join(',');
    const rows = results.map(item =>
        columns.map(c => {
            const val = String(item[c.field] ?? '');
            // Escape CSV values containing commas, quotes, or newlines
            if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                return `"${val.replaceAll('"', '""')}"`;
            }
            return val;
        }).join(',')
    );

    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `pdbfe_${entityType}_search.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
