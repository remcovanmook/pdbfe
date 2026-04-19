import { AUTH_ORIGIN } from '../config.js';
import { getSessionId, isAuthenticated, getUser, getFavorites, removeFavorite, reorderFavorites, fetchPreferenceOptions } from '../auth.js';
import { formatLocaleDate as formatDate, createLink, createEntityBadge } from '../render.js';
import { fetchEntity } from '../api.js';
import { t, setLanguage, LANGUAGES } from '../i18n.js';
import { getTheme, setTheme } from '../theme.js';
import { getTimezonePreference, setTimezone } from '../timezone.js';

// ── DOM helpers ─────────────────────────────────────────────────────

/**
 * Creates an element with optional className, style, and text.
 *
 * @param {string} tag - HTML tag name.
 * @param {Object} [opts] - Element options.
 * @param {string} [opts.className] - CSS class name.
 * @param {string} [opts.style] - Inline CSS text.
 * @param {string} [opts.id] - Element ID.
 * @param {string} [opts.text] - textContent.
 * @returns {HTMLElement}
 */
function el(tag, opts = {}) {
    const node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.style) node.style.cssText = opts.style;
    if (opts.id) node.id = opts.id;
    if (opts.text) node.textContent = opts.text;
    return node;
}

/**
 * Creates a card element with header title and body content.
 *
 * @param {string} title - Card header title.
 * @param {HTMLElement|DocumentFragment} body - Card body content.
 * @param {HTMLElement[]} [headerExtras] - Extra elements for the header (badges, buttons).
 * @returns {HTMLElement}
 */
function card(title, body, headerExtras = []) {
    const wrapper = el('div', { className: 'card' });
    const header = el('div', { className: 'card__header' });
    header.appendChild(el('span', { className: 'card__title', text: title }));
    for (const extra of headerExtras) header.appendChild(extra);
    wrapper.appendChild(header);
    const cardBody = el('div', { className: 'card__body' });
    cardBody.appendChild(body);
    wrapper.appendChild(cardBody);
    return wrapper;
}

/**
 * Creates a modal overlay with a card inside.
 *
 * @param {string} id - Modal element ID.
 * @param {string} title - Modal card title.
 * @param {HTMLElement|DocumentFragment} body - Modal body content.
 * @returns {HTMLElement}
 */
function modal(id, title, body) {
    const overlay = el('div', { id, className: 'key-modal-overlay', style: 'display:none' });
    const modalCard = el('div', { className: 'card key-modal' });
    const header = el('div', { className: 'card__header' });
    header.appendChild(el('span', { className: 'card__title', id: `${id}-title`, text: title }));
    modalCard.appendChild(header);
    const cardBody = el('div', { className: 'card__body', id: `${id}-body` });
    cardBody.appendChild(body);
    modalCard.appendChild(cardBody);
    overlay.appendChild(modalCard);
    return overlay;
}

// ── Page renderer ───────────────────────────────────────────────────

/**
 * Renders the /account page into the app container.
 * Shows profile information and API key management.
 *
 * @param {Record<string, string>} _params - Route params (unused).
 */
export async function renderAccount(_params) {
    const container = /** @type {HTMLElement} */ (document.getElementById('app'));
    document.title = 'Account — PDBFE';

    if (!isAuthenticated()) {
        const card_ = el('div', { className: 'card', style: 'max-width:480px;margin:var(--space-2xl) auto;text-align:center' });
        const body = el('div', { className: 'card__body' });
        body.appendChild(el('p', { style: 'color:var(--text-secondary);margin-bottom:var(--space-md)', text: t('Sign in to access your account.') }));
        const loginLink = document.createElement('a');
        loginLink.href = `${AUTH_ORIGIN}/auth/login`;
        loginLink.className = 'auth-link';
        loginLink.textContent = t('Sign in with PeeringDB');
        body.appendChild(loginLink);
        card_.appendChild(body);
        container.replaceChildren(card_);
        return;
    }

    const sid = getSessionId();
    const user = getUser();

    const frag = document.createDocumentFragment();

    // ── Page heading ─────────────────────────────────────────────
    frag.appendChild(el('h1', { className: 'detail-header__title', style: 'margin-bottom:var(--space-xl)', text: t('Account') }));

    // Two-column layout: profile (left) + affiliations/favorites/keys (right)
    const topRow = el('div', { className: 'account-top' });

    const profileGroup = el('div', { className: 'info-group', id: 'profile-info' });

    // Name field
    const nameField = el('div', { className: 'info-field' });
    nameField.appendChild(el('span', { className: 'info-field__label', text: t('Name') }));
    nameField.appendChild(el('span', { className: 'info-field__value', text: user?.name || '' }));
    profileGroup.appendChild(nameField);

    // Email field
    const emailField = el('div', { className: 'info-field' });
    emailField.appendChild(el('span', { className: 'info-field__label', text: t('Email') }));
    emailField.appendChild(el('span', { className: 'info-field__value', text: user?.email || '—' }));
    profileGroup.appendChild(emailField);

    // User ID field
    const idField = el('div', { className: 'info-field' });
    idField.appendChild(el('span', { className: 'info-field__label', text: t('User ID') }));
    const idValue = el('span', { className: 'info-field__value info-field__value--muted', text: String(user?.id || '—') });
    idField.appendChild(idValue);
    profileGroup.appendChild(idField);

    // Language field with <select> — options loaded from API
    const langField = el('div', { className: 'info-field' });
    langField.appendChild(el('span', { className: 'info-field__label', text: t('Language') }));
    const langValue = el('span', { className: 'info-field__value' });
    const langSelect = /** @type {HTMLSelectElement} */ (document.createElement('select'));
    langSelect.id = 'account-lang-select';
    langSelect.className = 'site-footer__lang-select';
    langSelect.setAttribute('aria-label', t('Language'));
    langValue.appendChild(langSelect);
    langField.appendChild(langValue);
    profileGroup.appendChild(langField);

    // Theme field with <select> — options loaded from API
    const themeField = el('div', { className: 'info-field' });
    themeField.appendChild(el('span', { className: 'info-field__label', text: t('Theme') }));
    const themeValue = el('span', { className: 'info-field__value' });
    const themeSelect = /** @type {HTMLSelectElement} */ (document.createElement('select'));
    themeSelect.id = 'account-theme-select';
    themeSelect.className = 'site-footer__lang-select';
    themeSelect.setAttribute('aria-label', t('Theme'));
    themeValue.appendChild(themeSelect);
    themeField.appendChild(themeValue);
    profileGroup.appendChild(themeField);

    // Timezone field with <select> — options loaded from API
    const tzField = el('div', { className: 'info-field' });
    tzField.appendChild(el('span', { className: 'info-field__label', text: t('Timezone') }));
    const tzValue = el('span', { className: 'info-field__value' });
    const tzSelect = /** @type {HTMLSelectElement} */ (document.createElement('select'));
    tzSelect.id = 'account-tz-select';
    tzSelect.className = 'site-footer__lang-select';
    tzSelect.setAttribute('aria-label', t('Timezone'));
    tzValue.appendChild(tzSelect);
    tzField.appendChild(tzValue);
    profileGroup.appendChild(tzField);

    // Populate selectors from API (non-blocking)
    fetchPreferenceOptions().then(prefOptions => {
        const storedLang = localStorage.getItem('pdbfe-lang');
        const activeLang = storedLang || 'auto';
        const langCodes = prefOptions.language || ['auto', 'en', ...Object.keys(LANGUAGES)];
        for (const code of langCodes) {
            const opt = document.createElement('option');
            opt.value = code;
            opt.textContent = code === 'auto' ? t('Auto') : /** @type {string} */ (LANGUAGES[code] || code);
            opt.selected = code === activeLang;
            langSelect.appendChild(opt);
        }

        const currentTheme = getTheme();
        /** @type {Record<string, string>} */
        const themeLabels = { auto: t('Auto'), dark: t('Dark'), light: t('Light') };
        const themeValues = prefOptions.theme || ['auto', 'dark', 'light'];
        for (const value of themeValues) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = themeLabels[value] || value;
            opt.selected = value === currentTheme;
            themeSelect.appendChild(opt);
        }

        const activeTz = getTimezonePreference();
        const tzValues = prefOptions.timezone || ['auto', 'UTC'];
        for (const value of tzValues) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = value === 'auto' ? t('Auto') : value.replaceAll('_', ' ');
            opt.selected = value === activeTz;
            tzSelect.appendChild(opt);
        }
    }).catch(() => { /* Non-critical */ });

    // ── Left column: Profile card ────────────────────────────────
    const profileCard = card(t('Profile'), profileGroup);
    topRow.appendChild(profileCard);

    // ── Right column: Affiliations, Favorites, API Keys ──────────
    const rightCol = el('div', { className: 'account-main' });

    // Networks container (populated async after mount)
    const netsContainer = el('div', { id: 'networks-container' });
    rightCol.appendChild(netsContainer);

    // Favorites card with drag-and-drop reorder
    const favBody = el('div', { id: 'favorites-container' });
    const favorites = getFavorites();
    if (favorites.length === 0) {
        favBody.appendChild(el('p', { style: 'color:var(--text-muted);font-size:0.8125rem', text: t('No favorites yet. Use the star button on any entity page to add favorites.') }));
    } else {
        favBody.appendChild(buildFavoritesList(favorites));
    }
    const favCard = card(t('Favorites'), favBody);
    rightCol.appendChild(favCard);

    // API Keys card
    const createBtn = el('button', { id: 'btn-create-key', className: 'auth-link', style: 'cursor:pointer;background:none', text: `+ ${t('New Key')}` });
    const keysLoading = el('p', { style: 'color:var(--text-muted);font-size:0.8125rem', text: `${t('Loading')}...` });
    const keysBody = el('div', { id: 'keys-container' });
    keysBody.appendChild(keysLoading);
    const keysCard = card(t('API Keys'), keysBody, [createBtn]);
    rightCol.appendChild(keysCard);

    topRow.appendChild(rightCol);

    frag.appendChild(topRow);

    // ── Create key modal ─────────────────────────────────────────
    const createModalBody = document.createDocumentFragment();

    const createDiv = el('div', { id: 'key-modal-create' });
    createDiv.appendChild(el('label', { style: 'display:block;color:var(--text-secondary);font-size:0.8125rem;margin-bottom:var(--space-xs)', text: t('Label') }));
    const labelInput = /** @type {HTMLInputElement} */ (document.createElement('input'));
    labelInput.type = 'text';
    labelInput.id = 'key-label-input';
    labelInput.className = 'key-label-input';
    labelInput.placeholder = 'e.g. "curl scripts"';
    labelInput.maxLength = 64;
    labelInput.autofocus = true;
    createDiv.appendChild(labelInput);
    const createBtnRow = el('div', { style: 'display:flex;gap:var(--space-sm);margin-top:var(--space-md)' });
    createBtnRow.appendChild(el('button', { id: 'btn-do-create', className: 'auth-link', style: 'cursor:pointer;background:none;flex:1', text: t('Create') }));
    createBtnRow.appendChild(el('button', { id: 'btn-cancel-create', className: 'auth-link', style: 'cursor:pointer;background:none;flex:1;color:var(--text-muted);border-color:var(--border)', text: t('Cancel') }));
    createDiv.appendChild(createBtnRow);
    createModalBody.appendChild(createDiv);

    const resultDiv = el('div', { id: 'key-modal-result', style: 'display:none' });
    resultDiv.appendChild(el('p', { style: 'color:var(--status-warn);font-size:0.8125rem;margin-bottom:var(--space-md)', text: t('Copy this key now \u2014 it will not be shown again.') }));
    resultDiv.appendChild(el('code', { id: 'key-modal-value', className: 'key-display' }));
    resultDiv.appendChild(el('button', { id: 'btn-copy-key', className: 'auth-link', style: 'cursor:pointer;margin-top:var(--space-md);display:block;background:none;width:100%', text: t('Copy to clipboard') }));
    resultDiv.appendChild(el('button', { id: 'btn-close-modal', className: 'auth-link', style: 'cursor:pointer;margin-top:var(--space-sm);display:block;background:none;color:var(--text-muted);border-color:var(--border);width:100%', text: t('Close') }));
    createModalBody.appendChild(resultDiv);

    frag.appendChild(modal('key-modal', t('Create API Key'), createModalBody));

    // ── Revoke key modal ─────────────────────────────────────────
    const revokeBody = document.createDocumentFragment();
    revokeBody.appendChild(el('p', { style: 'color:var(--status-error);font-size:0.8125rem;margin-bottom:var(--space-md)', text: t('This will permanently revoke the key. Any client using it will lose access.') }));
    revokeBody.appendChild(el('p', { id: 'revoke-key-info', style: 'font-size:0.8125rem;color:var(--text-secondary);margin-bottom:var(--space-md)' }));
    const revokeBtnRow = el('div', { style: 'display:flex;gap:var(--space-sm)' });
    revokeBtnRow.appendChild(el('button', { id: 'btn-do-revoke', className: 'auth-link', style: 'cursor:pointer;background:none;flex:1;color:var(--status-error);border-color:var(--status-error)', text: t('Revoke') }));
    revokeBtnRow.appendChild(el('button', { id: 'btn-cancel-revoke', className: 'auth-link', style: 'cursor:pointer;background:none;flex:1;color:var(--text-muted);border-color:var(--border)', text: t('Cancel') }));
    revokeBody.appendChild(revokeBtnRow);
    revokeBody.appendChild(el('p', { id: 'revoke-error', className: 'modal-error', style: 'display:none;color:var(--status-error);font-size:0.8125rem;margin-top:var(--space-sm)' }));

    frag.appendChild(modal('revoke-modal', t('Revoke API Key'), revokeBody));

    // ── Mount and wire ───────────────────────────────────────────
    container.replaceChildren(frag);

    // Wire up create key button
    document.getElementById('btn-create-key')?.addEventListener('click', () => showCreateDialog(sid));

    // Render org-grouped affiliations into the left column
    renderAffiliations(user, netsContainer);

    // Wire up language preference selector — persists to server
    langSelect.addEventListener('change', async () => {
        const newLang = langSelect.value;

        // Persist the preference server-side
        try {
            await fetch(`${AUTH_ORIGIN}/account/profile`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${sid}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ preferences: { language: newLang } }),
            });
        } catch (err) {
            console.warn('Failed to persist language preference:', err);
        }

        setLanguage(newLang, () => {
            // Sync the footer language selector to match the new preference
            const footerSelect = /** @type {HTMLSelectElement|null} */ (
                document.getElementById('lang-select')
            );
            if (footerSelect) footerSelect.value = newLang;
            renderAccount(_params);
        });
    });

    // Wire up theme preference selector — persists to server
    themeSelect.addEventListener('change', async () => {
        const newTheme = themeSelect.value;
        setTheme(newTheme);

        // Sync the footer theme selector
        const footerTheme = /** @type {HTMLSelectElement|null} */ (
            document.getElementById('theme-select')
        );
        if (footerTheme) footerTheme.value = newTheme;

        // Persist server-side
        try {
            await fetch(`${AUTH_ORIGIN}/account/profile`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${sid}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ preferences: { theme: newTheme } }),
            });
        } catch (err) {
            console.warn('Failed to persist theme preference:', err);
        }
    });

    // Wire up timezone preference selector — persists to server
    tzSelect.addEventListener('change', async () => {
        const newTz = tzSelect.value;
        setTimezone(newTz);

        // Sync the footer timezone selector
        const footerTz = /** @type {HTMLSelectElement|null} */ (
            document.getElementById('tz-select')
        );
        if (footerTz) footerTz.value = newTz;

        // Persist server-side
        try {
            await fetch(`${AUTH_ORIGIN}/account/profile`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${sid}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ preferences: { timezone: newTz } }),
            });
        } catch (err) {
            console.warn('Failed to persist timezone preference:', err);
        }
    });

    // Load keys
    await loadKeys(sid);
}

/**
 * Fetches and renders the user's organisational affiliations as an
 * org-grouped tree. Each org acts as a divider/header row, with its
 * child entities (networks, exchanges, facilities) listed beneath.
 *
 * Data flow:
 *   1. Start from user.networks (already in session data)
 *   2. Fetch each network at depth=0 to resolve org_id
 *   3. Deduplicate org IDs, fetch each org at depth=1
 *   4. Render grouped tree into the container
 *
 * @param {SessionData|null} user - The session/user data.
 * @param {HTMLElement} container - DOM element to render into.
 */
async function renderAffiliations(user, container) {
    const nets = user?.networks || [];
    if (nets.length === 0) {
        container.appendChild(
            el('p', { style: 'color:var(--text-muted);font-size:0.8125rem', text: t('No network affiliations.') })
        );
        return;
    }

    // Show loading state
    container.appendChild(
        el('p', { style: 'color:var(--text-muted);font-size:0.8125rem', text: `${t('Loading affiliations')}...` })
    );

    try {
        // Fetch each network at depth=0 to get their org_id
        const netDetails = await Promise.all(
            nets.map(n => fetchEntity('net', n.id, 0).catch(/** @returns {null} */() => null))
        );

        // Collect unique org IDs
        /** @type {Set<number>} */
        const orgIds = new Set();
        for (const net of netDetails) {
            if (net?.org_id) orgIds.add(net.org_id);
        }

        // Fetch each org at depth=2 to get expanded net_set, ix_set, fac_set
        const orgEntries = await Promise.all(
            [...orgIds].map(async (orgId) => {
                const org = await fetchEntity('org', orgId, 2).catch(/** @returns {null} */() => null);
                return org ? { id: orgId, org } : null;
            })
        );

        const orgs = orgEntries.filter(Boolean);

        if (orgs.length === 0) {
            container.replaceChildren(
                el('p', { style: 'color:var(--text-muted);font-size:0.8125rem', text: t('No affiliations found.') })
            );
            return;
        }

        container.replaceChildren(buildOrgTree(orgs));
    } catch (err) {
        console.warn('Failed to load affiliations:', err);
        container.replaceChildren(
            el('p', { style: 'color:var(--status-error);font-size:0.8125rem', text: t('Failed to load affiliations.') })
        );
    }
}

/**
 * Builds the org-grouped affiliation tree as a card element.
 * Each org is a divider row, with child nets/ixes/facs below it.
 *
 * @param {Array<{id: number, org: any}>} orgs - Org entries with depth=1 data.
 * @returns {HTMLElement} Card element containing the tree.
 */
function buildOrgTree(orgs) {
    // Count total entities across all orgs
    let totalCount = 0;
    for (const { org } of orgs) {
        totalCount += (org.net_set?.length || 0) + (org.ix_set?.length || 0) + (org.fac_set?.length || 0);
    }

    const wrapper = el('div', { className: 'card' });
    const header = el('div', { className: 'card__header' });
    header.appendChild(el('span', { className: 'card__title', text: t('My Affiliations') }));
    const badge = el('span', { className: 'card__badge' });
    badge.textContent = String(totalCount);
    header.appendChild(badge);
    wrapper.appendChild(header);

    const body = el('div', { className: 'card__body' });
    const tree = el('div', { className: 'affiliation-tree' });

    for (const { org } of orgs) {
        // ── Org divider row ──
        const orgRow = el('div', { className: 'affiliation-tree__org' });
        orgRow.appendChild(createEntityBadge('org'));
        orgRow.appendChild(createLink('org', org.id, org.name || `Org ${org.id}`));
        tree.appendChild(orgRow);

        // ── Child entities: networks, then exchanges, then facilities ──
        if (org.net_set) {
            for (const net of org.net_set) {
                tree.appendChild(buildEntityRow('net', net.id, net.name ? `AS${net.asn} — ${net.name}` : `AS${net.asn}`));
            }
        }
        if (org.ix_set) {
            for (const ix of org.ix_set) {
                tree.appendChild(buildEntityRow('ix', ix.id, ix.name || `IX ${ix.id}`));
            }
        }
        if (org.fac_set) {
            for (const fac of org.fac_set) {
                tree.appendChild(buildEntityRow('fac', fac.id, fac.name || `Fac ${fac.id}`));
            }
        }
    }

    body.appendChild(tree);
    wrapper.appendChild(body);
    return wrapper;
}

/**
 * Builds a single entity row for the affiliation tree.
 * Contains an entity badge, a link to the entity, and a compare shortcut.
 *
 * @param {string} tag - Entity type tag (net, ix, fac).
 * @param {number} id - Entity ID.
 * @param {string} name - Display name.
 * @returns {HTMLElement} Row element.
 */
function buildEntityRow(tag, id, name) {
    const row = el('div', { className: 'affiliation-tree__entity' });
    row.appendChild(createEntityBadge(tag));

    const link = createLink(tag, id, name);
    link.className += ' affiliation-tree__name';
    row.appendChild(link);

    // Compare shortcut (only for types that support comparison)
    if (['net', 'ix', 'fac'].includes(tag)) {
        const cmpLink = document.createElement('a');
        cmpLink.href = `/compare?a=${tag}:${id}`;
        cmpLink.dataset.link = '';
        cmpLink.className = 'affiliation-tree__compare';
        cmpLink.textContent = '↔ ' + t('Compare');
        cmpLink.title = t('Compare with another entity');
        row.appendChild(cmpLink);
    }

    return row;
}

/**
 * Fetches and renders the API keys table.
 *
 * @param {string} sid - Session ID for Authorization header.
 */
async function loadKeys(sid) {
    const keysContainer = document.getElementById('keys-container');
    if (!keysContainer) return;

    try {
        const res = await fetch(`${AUTH_ORIGIN}/account/keys`, {
            headers: { 'Authorization': `Bearer ${sid}` },
        });

        if (!res.ok) {
            const errP = document.createElement('p');
            errP.style.cssText = 'color:var(--status-error);font-size:0.8125rem';
            errP.textContent = t('Failed to load API keys.');
            keysContainer.replaceChildren(errP);
            return;
        }

        const data = await res.json();
        const keys = data.keys || [];

        if (keys.length === 0) {
            const p1 = document.createElement('p');
            p1.style.cssText = 'color:var(--text-muted);font-size:0.8125rem';
            p1.textContent = t('No API keys yet. Create one to enable authenticated API access.');

            const p2 = document.createElement('p');
            p2.style.cssText = 'color:var(--text-muted);font-size:0.75rem;margin-top:var(--space-sm)';
            p2.append(t('Use') + ': ');
            const code = document.createElement('code');
            code.style.color = 'var(--accent)';
            code.textContent = 'Authorization: Api-Key pdbfe.xxxxx';
            p2.appendChild(code);

            keysContainer.replaceChildren(p1, p2);
            return;
        }

        // Build key table with DOM nodes
        const wrapper = document.createElement('div');
        wrapper.className = 'data-table-wrapper';

        const table = document.createElement('table');
        table.className = 'data-table';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (const label of [t('Label'), t('Key Prefix'), t('Created'), '']) {
            const th = document.createElement('th');
            th.textContent = label;
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const k of keys) {
            const tr = document.createElement('tr');

            const tdLabel = document.createElement('td');
            tdLabel.textContent = k.label;
            tr.appendChild(tdLabel);

            const tdPrefix = document.createElement('td');
            tdPrefix.className = 'td-mono';
            tdPrefix.textContent = `pdbfe.${k.prefix}…`;
            tr.appendChild(tdPrefix);

            const tdDate = document.createElement('td');
            tdDate.textContent = formatDate(k.created_at);
            tr.appendChild(tdDate);

            const tdAction = document.createElement('td');
            const revokeBtn = document.createElement('button');
            revokeBtn.className = 'auth-link btn-delete-key';
            revokeBtn.style.cssText = 'cursor:pointer;background:none;color:var(--status-error);border-color:var(--status-error)';
            revokeBtn.textContent = t('Revoke');
            revokeBtn.setAttribute('aria-label', t('Revoke API key'));
            revokeBtn.addEventListener('click', () => {
                showRevokeDialog(sid, k.key_id, k.label, k.prefix);
            });
            tdAction.appendChild(revokeBtn);
            tr.appendChild(tdAction);

            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrapper.appendChild(table);

        const usageP = document.createElement('p');
        usageP.style.cssText = 'color:var(--text-muted);font-size:0.6875rem;margin-top:var(--space-sm)';
        usageP.textContent = t('{n} / {max} keys used', { n: keys.length, max: data.max_keys });

        keysContainer.replaceChildren(wrapper, usageP);

    } catch (err) {
        console.error('Failed to load keys:', err);
        const errP = document.createElement('p');
        errP.style.cssText = 'color:var(--status-error);font-size:0.8125rem';
        errP.textContent = t('Error loading API keys.');
        keysContainer.replaceChildren(errP);
    }
}

/**
 * Shows the create-key modal with a label input.
 * On submit, creates the key and switches to the result view
 * showing the full key value.
 *
 * @param {string} sid - Session ID.
 */
function showCreateDialog(sid) {
    const modal = document.getElementById('key-modal');
    const createView = document.getElementById('key-modal-create');
    const resultView = document.getElementById('key-modal-result');
    const titleEl = document.getElementById('key-modal-title');
    const labelInput = /** @type {HTMLInputElement|null} */ (document.getElementById('key-label-input'));

    if (!modal || !createView || !resultView || !titleEl || !labelInput) return;

    // Reset to input state
    titleEl.textContent = t('Create API Key');
    createView.style.display = 'block';
    resultView.style.display = 'none';
    labelInput.value = '';
    modal.style.display = 'flex';
    labelInput.focus();

    /** Closes the modal and refreshes the key list. */
    function closeModal() {
        modal.style.display = 'none';
        loadKeys(sid);
    }

    /** Submits the create request and shows the result. */
    async function doCreate() {
        const label = labelInput.value.trim() || 'Unnamed key';
        const createBtn = document.getElementById('btn-do-create');
        if (createBtn) createBtn.textContent = t('Creating...');

        try {
            const res = await fetch(`${AUTH_ORIGIN}/account/keys`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${sid}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ label }),
            });

            const data = await res.json();
            if (!res.ok) {
                if (createBtn) createBtn.textContent = t('Create');
                // Show inline error instead of alert
                const existing = createView.querySelector('.modal-error');
                if (existing) existing.remove();
                const errEl = document.createElement('p');
                errEl.className = 'modal-error';
                errEl.style.cssText = 'color:var(--status-error);font-size:0.8125rem;margin-top:var(--space-sm)';
                errEl.textContent = data.error || t('Failed to create key');
                createView.appendChild(errEl);
                return;
            }

            // Switch to result view
            titleEl.textContent = t('API Key Created');
            createView.style.display = 'none';
            resultView.style.display = 'block';

            const keyValue = document.getElementById('key-modal-value');
            if (keyValue) keyValue.textContent = data.key;

            const copyBtn = document.getElementById('btn-copy-key');
            if (copyBtn) {
                copyBtn.textContent = t('Copy to clipboard');
                copyBtn.onclick = () => {
                    navigator.clipboard.writeText(data.key).then(() => {
                        copyBtn.textContent = t('Copied!');
                    });
                };
            }

            const closeBtn = document.getElementById('btn-close-modal');
            if (closeBtn) closeBtn.onclick = closeModal;

        } catch (err) {
            console.error('Create key error:', err);
            if (createBtn) createBtn.textContent = t('Create');
        }
    }

    // Wire up buttons
    const createBtn = document.getElementById('btn-do-create');
    const cancelBtn = document.getElementById('btn-cancel-create');
    if (createBtn) {
        createBtn.textContent = t('Create');
        createBtn.onclick = doCreate;
    }
    if (cancelBtn) cancelBtn.onclick = closeModal;

    // Submit on Enter
    labelInput.onkeydown = (e) => {
        if (e.key === 'Enter') doCreate();
        if (e.key === 'Escape') closeModal();
    };
}

/**
 * Shows a confirmation modal before revoking an API key.
 *
 * @param {string} sid - Session ID.
 * @param {string} keyId - The 8-char key ID to revoke.
 * @param {string} label - Display label for the key.
 * @param {string} prefix - 4-char key prefix.
 */
function showRevokeDialog(sid, keyId, label, prefix) {
    const modal = document.getElementById('revoke-modal');
    const infoEl = document.getElementById('revoke-key-info');
    const errorEl = document.getElementById('revoke-error');
    if (!modal || !infoEl || !errorEl) return;

    // Build the info text with DOM nodes — user key label goes through textContent
    infoEl.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const prefixSpan = document.createElement('span');
    prefixSpan.className = 'td-mono';
    prefixSpan.style.display = 'inline';
    prefixSpan.textContent = ` (pdbfe.${prefix}…)`;
    infoEl.append(strong, prefixSpan);
    errorEl.style.display = 'none';
    modal.style.display = 'flex';

    /** Closes the revoke modal. */
    function closeModal() {
        modal.style.display = 'none';
    }

    /** Performs the DELETE request and refreshes the list. */
    async function doRevoke() {
        const revokeBtn = document.getElementById('btn-do-revoke');
        if (revokeBtn) revokeBtn.textContent = t('Revoking...');

        try {
            const res = await fetch(`${AUTH_ORIGIN}/account/keys/${keyId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${sid}` },
            });

            if (!res.ok) {
                const data = await res.json();
                errorEl.textContent = data.error || t('Failed to revoke key');
                errorEl.style.display = 'block';
                if (revokeBtn) revokeBtn.textContent = t('Revoke');
                return;
            }

            closeModal();
            await loadKeys(sid);
        } catch (err) {
            console.error('Delete key error:', err);
            errorEl.textContent = t('Network error');
            errorEl.style.display = 'block';
            if (revokeBtn) revokeBtn.textContent = t('Revoke');
        }
    }

    const revokeBtn = document.getElementById('btn-do-revoke');
    const cancelBtn = document.getElementById('btn-cancel-revoke');
    if (revokeBtn) {
        revokeBtn.textContent = t('Revoke');
        revokeBtn.onclick = doRevoke;
    }
    if (cancelBtn) cancelBtn.onclick = closeModal;
}

/**
 * Builds the favorites list for the account page with drag-and-drop
 * reorder support and delete buttons. Uses the same drag-and-drop
 * pattern as the standalone favorites management page.
 *
 * @param {Array<{entity_type: string, entity_id: number, label: string, created_at: string}>} favorites - User favorites.
 * @returns {HTMLElement} The favorites list element.
 */
function buildFavoritesList(favorites) {
    const list = el('div', { className: 'favorites-manage', id: 'account-favorites-list' });

    for (const fav of favorites) {
        list.appendChild(buildFavoriteRow(fav, list));
    }

    return list;
}

/**
 * Builds a single draggable favorite row with entity badge, link,
 * and delete button. Supports HTML5 drag-and-drop reorder.
 *
 * @param {{entity_type: string, entity_id: number, label: string}} fav - Favorite entry.
 * @param {HTMLElement} listEl - Parent list for reorder persistence.
 * @returns {HTMLElement} The row element.
 */
function buildFavoriteRow(fav, listEl) {
    const row = el('div', { className: 'favorites-manage__item' });
    row.draggable = true;
    row.dataset.key = `${fav.entity_type}:${fav.entity_id}`;

    // Drag handle
    const handle = el('span', { className: 'favorites-manage__handle', text: '⠿' });
    handle.title = t('Drag to reorder');
    row.appendChild(handle);

    // Entity badge
    row.appendChild(createEntityBadge(fav.entity_type));

    // Entity link
    const link = createLink(fav.entity_type, fav.entity_id, fav.label || `${fav.entity_type} ${fav.entity_id}`);
    link.className += ' favorites-manage__name';
    row.appendChild(link);

    // Delete button
    const deleteBtn = /** @type {HTMLButtonElement} */ (el('button', {
        className: 'favorites-manage__delete',
        text: '×',
    }));
    deleteBtn.title = t('Remove from favorites');
    deleteBtn.setAttribute('aria-label', t('Remove from favorites'));
    deleteBtn.addEventListener('click', async () => {
        deleteBtn.disabled = true;
        const ok = await removeFavorite(fav.entity_type, fav.entity_id);
        if (ok) {
            row.remove();
            // Show empty state if no favorites left
            const container = document.getElementById('favorites-container');
            if (container && container.querySelectorAll('.favorites-manage__item').length === 0) {
                container.replaceChildren(
                    el('p', {
                        style: 'color:var(--text-muted);font-size:0.8125rem',
                        text: t('No favorites yet. Use the star button on any entity page to add favorites.'),
                    })
                );
            }
        } else {
            deleteBtn.disabled = false;
        }
    });
    row.appendChild(deleteBtn);

    // ── Drag and drop handlers ──

    row.addEventListener('dragstart', (e) => {
        row.classList.add('favorites-manage__item--dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', row.dataset.key || '');
        }
    });

    row.addEventListener('dragend', () => {
        row.classList.remove('favorites-manage__item--dragging');
        persistFavoritesOrder(listEl);
    });

    row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

        const dragging = listEl.querySelector('.favorites-manage__item--dragging');
        if (!dragging || dragging === row) return;

        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
            row.before(dragging);
        } else {
            row.after(dragging);
        }
    });

    return row;
}

/**
 * Reads the current DOM order of favorite rows and persists it via
 * the auth module's reorderFavorites() function.
 *
 * @param {HTMLElement} listEl - The list container element.
 */
function persistFavoritesOrder(listEl) {
    /** @type {string[]} */
    const keys = [];
    for (const child of listEl.children) {
        const key = /** @type {HTMLElement} */ (child).dataset.key;
        if (key) keys.push(key);
    }
    reorderFavorites(keys);
}
