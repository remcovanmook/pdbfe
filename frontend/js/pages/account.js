/**
 * @fileoverview Account page — user profile and API key management.
 *
 * Displays the authenticated user's profile information and provides
 * a CRUD interface for managing API keys. All data is fetched from
 * the pdbfe-auth worker's /account/* endpoints.
 *
 * Requires an active session (redirects to homepage if not logged in).
 */

import { AUTH_ORIGIN } from '../config.js';
import { getSessionId, isAuthenticated, getUser } from '../auth.js';
import { escapeHTML, formatLocaleDate as formatDate, createLink } from '../render.js';
import { t, setLanguage, getCurrentLang, LANGUAGES } from '../i18n.js';

/**
 * Renders the /account page into the app container.
 * Shows profile information and API key management.
 *
 * @param {Record<string, string>} _params - Route params (unused).
 */
export async function renderAccount(_params) {
    const container = /** @type {HTMLElement} */ (document.getElementById('app'));
    document.title = 'Account — PeeringDB';

    if (!isAuthenticated()) {
        container.innerHTML = `
            <div class="card" style="max-width:480px;margin:var(--space-2xl) auto;text-align:center">
                <div class="card__body">
                    <p style="color:var(--text-secondary);margin-bottom:var(--space-md)">${t('Sign in to access your account.')}</p>
                    <a href="${AUTH_ORIGIN}/auth/login" class="auth-link">${t('Sign in with PeeringDB')}</a>
                </div>
            </div>
        `;
        return;
    }

    const sid = getSessionId();
    const user = getUser();

    container.innerHTML = `
        <h1 class="detail-header__title" style="margin-bottom:var(--space-xl)">${t('Account')}</h1>

        <div class="detail-layout">
            <div class="detail-sidebar">
                <div class="card">
                    <div class="card__header">
                        <span class="card__title">${t('Profile')}</span>
                    </div>
                    <div class="card__body">
                        <div class="info-group" id="profile-info">
                            <div class="info-field">
                                <span class="info-field__label">${t('Name')}</span>
                                <span class="info-field__value">${escapeHTML(user?.name || '')}</span>
                            </div>
                            <div class="info-field">
                                <span class="info-field__label">${t('Email')}</span>
                                <span class="info-field__value">${escapeHTML(user?.email || '—')}</span>
                            </div>
                            <div class="info-field">
                                <span class="info-field__label">${t('User ID')}</span>
                                <span class="info-field__value info-field__value--muted">${/* safe — numeric id */ user?.id || '—'}</span>
                            </div>
                            <div class="info-field">
                                <span class="info-field__label">${t('Language')}</span>
                                <span class="info-field__value">
                                    <select id="account-lang-select" class="site-footer__lang-select">
                                        <option value="en"${!getCurrentLang() || getCurrentLang() === 'en' ? ' selected' : ''}>English</option>
                                        ${Object.entries(LANGUAGES).map(([code, name]) =>
                                            `<option value="${code}"${getCurrentLang() === code ? ' selected' : ''}>${escapeHTML(name)}</option>`
                                        ).join('')}
                                    </select>
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

            </div>
            <div id="networks-container"></div>

            <div class="detail-main">
                <div class="card">
                    <div class="card__header">
                        <span class="card__title">${t('API Keys')}</span>
                        <button id="btn-create-key" class="auth-link" style="cursor:pointer;background:none">+ ${t('New Key')}</button>
                    </div>
                    <div class="card__body" id="keys-container">
                        <p style="color:var(--text-muted);font-size:0.8125rem">${t('Loading')}...</p>
                    </div>
                </div>
            </div>
        </div>

        <div id="key-modal" style="display:none" class="key-modal-overlay">
            <div class="card key-modal">
                <div class="card__header">
                    <span class="card__title" id="key-modal-title">${t('Create API Key')}</span>
                </div>
                <div class="card__body" id="key-modal-body">
                    <div id="key-modal-create">
                        <label style="display:block;color:var(--text-secondary);font-size:0.8125rem;margin-bottom:var(--space-xs)">${t('Label')}</label>
                        <input type="text" id="key-label-input" class="key-label-input"
                               placeholder='e.g. "curl scripts"' maxlength="64" autofocus>
                        <div style="display:flex;gap:var(--space-sm);margin-top:var(--space-md)">
                            <button id="btn-do-create" class="auth-link" style="cursor:pointer;background:none;flex:1">${t('Create')}</button>
                            <button id="btn-cancel-create" class="auth-link" style="cursor:pointer;background:none;flex:1;color:var(--text-muted);border-color:var(--border)">${t('Cancel')}</button>
                        </div>
                    </div>
                    <div id="key-modal-result" style="display:none">
                        <p style="color:var(--status-warn);font-size:0.8125rem;margin-bottom:var(--space-md)">
                            ${t('Copy this key now — it will not be shown again.')}
                        </p>
                        <code id="key-modal-value" class="key-display"></code>
                        <button id="btn-copy-key" class="auth-link" style="cursor:pointer;margin-top:var(--space-md);display:block;background:none;width:100%">
                            ${t('Copy to clipboard')}
                        </button>
                        <button id="btn-close-modal" class="auth-link" style="cursor:pointer;margin-top:var(--space-sm);display:block;background:none;color:var(--text-muted);border-color:var(--border);width:100%">
                            ${t('Close')}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <div id="revoke-modal" style="display:none" class="key-modal-overlay">
            <div class="card key-modal">
                <div class="card__header">
                    <span class="card__title">${t('Revoke API Key')}</span>
                </div>
                <div class="card__body">
                    <p style="color:var(--status-error);font-size:0.8125rem;margin-bottom:var(--space-md)">
                        ${t('This will permanently revoke the key. Any client using it will lose access.')}
                    </p>
                    <p id="revoke-key-info" style="font-size:0.8125rem;color:var(--text-secondary);margin-bottom:var(--space-md)"></p>
                    <div style="display:flex;gap:var(--space-sm)">
                        <button id="btn-do-revoke" class="auth-link" style="cursor:pointer;background:none;flex:1;color:var(--status-error);border-color:var(--status-error)">${t('Revoke')}</button>
                        <button id="btn-cancel-revoke" class="auth-link" style="cursor:pointer;background:none;flex:1;color:var(--text-muted);border-color:var(--border)">${t('Cancel')}</button>
                    </div>
                    <p id="revoke-error" class="modal-error" style="display:none;color:var(--status-error);font-size:0.8125rem;margin-top:var(--space-sm)"></p>
                </div>
            </div>
        </div>
    `;

    // Wire up create key button
    document.getElementById('btn-create-key')?.addEventListener('click', () => showCreateDialog(sid));

    // Render network affiliations into the sidebar
    const netsContainer = document.getElementById('networks-container');
    if (netsContainer) {
        netsContainer.appendChild(renderNetworks(user));
    }

    // Wire up language preference selector
    const langSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('account-lang-select'));
    if (langSelect) {
        langSelect.addEventListener('change', () => {
            setLanguage(langSelect.value, () => renderAccount(_params));
        });
    }

    // Load keys
    await loadKeys(sid);
}

/**
 * Renders the user's network affiliations as a sidebar card.
 * Uses DOM builders — network names go through textContent.
 *
 * @param {SessionData|null} user - The session/user data.
 * @returns {HTMLDivElement|DocumentFragment} Card element, or empty fragment.
 */
function renderNetworks(user) {
    const nets = user?.networks || [];
    if (nets.length === 0) return document.createDocumentFragment();

    const card = document.createElement('div');
    card.className = 'card';

    const header = document.createElement('div');
    header.className = 'card__header';
    const title = document.createElement('span');
    title.className = 'card__title';
    title.textContent = t('Networks');
    const badge = document.createElement('span');
    badge.className = 'card__badge';
    badge.textContent = String(nets.length);
    header.append(title, badge);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'card__body';
    const group = document.createElement('div');
    group.className = 'info-group';

    for (const n of nets) {
        const field = document.createElement('div');
        field.className = 'info-field';

        const label = document.createElement('span');
        label.className = 'info-field__label';
        label.textContent = `AS${n.asn}`;

        const value = document.createElement('span');
        value.className = 'info-field__value';
        value.appendChild(createLink('net', n.id, n.name));

        field.append(label, value);
        group.appendChild(field);
    }

    body.appendChild(group);
    card.appendChild(body);
    return card;
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
            revokeBtn.addEventListener('click', () => {
                showRevokeDialog(sid, k.id, k.label, k.prefix);
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

