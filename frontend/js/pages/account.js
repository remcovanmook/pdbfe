/**
 * @fileoverview Account page — user profile and API key management.
 *
 * Displays the authenticated user's profile information and provides
 * a CRUD interface for managing API keys. All data is fetched from
 * the pdbfe-auth worker's /account/* endpoints.
 *
 * Requires an active session (redirects to homepage if not logged in).
 */

import { AUTH_ORIGIN } from '/js/config.js';
import { getSessionId, isAuthenticated, getUser } from '/js/auth.js';

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
                    <p style="color:var(--text-secondary);margin-bottom:var(--space-md)">Sign in to access your account.</p>
                    <a href="${AUTH_ORIGIN}/auth/login" class="auth-link">Sign in with PeeringDB</a>
                </div>
            </div>
        `;
        return;
    }

    const sid = getSessionId();
    const user = getUser();

    container.innerHTML = `
        <h1 class="detail-header__title" style="margin-bottom:var(--space-xl)">Account</h1>

        <div class="detail-layout">
            <div class="detail-sidebar">
                <div class="card">
                    <div class="card__header">
                        <span class="card__title">Profile</span>
                    </div>
                    <div class="card__body">
                        <div class="info-group" id="profile-info">
                            <div class="info-field">
                                <span class="info-field__label">Name</span>
                                <span class="info-field__value">${esc(user?.name || '')}</span>
                            </div>
                            <div class="info-field">
                                <span class="info-field__label">Email</span>
                                <span class="info-field__value">${esc(user?.email || '—')}</span>
                            </div>
                            <div class="info-field">
                                <span class="info-field__label">User ID</span>
                                <span class="info-field__value info-field__value--muted">${user?.id || '—'}</span>
                            </div>
                        </div>
                    </div>
                </div>

                ${renderNetworks(user)}
            </div>

            <div class="detail-main">
                <div class="card">
                    <div class="card__header">
                        <span class="card__title">API Keys</span>
                        <button id="btn-create-key" class="auth-link" style="cursor:pointer;background:none">+ New Key</button>
                    </div>
                    <div class="card__body" id="keys-container">
                        <p style="color:var(--text-muted);font-size:0.8125rem">Loading...</p>
                    </div>
                </div>
            </div>
        </div>

        <div id="key-modal" style="display:none" class="key-modal-overlay">
            <div class="card key-modal">
                <div class="card__header">
                    <span class="card__title" id="key-modal-title">Create API Key</span>
                </div>
                <div class="card__body" id="key-modal-body">
                    <div id="key-modal-create">
                        <label style="display:block;color:var(--text-secondary);font-size:0.8125rem;margin-bottom:var(--space-xs)">Label</label>
                        <input type="text" id="key-label-input" class="key-label-input"
                               placeholder='e.g. "curl scripts"' maxlength="64" autofocus>
                        <div style="display:flex;gap:var(--space-sm);margin-top:var(--space-md)">
                            <button id="btn-do-create" class="auth-link" style="cursor:pointer;background:none;flex:1">Create</button>
                            <button id="btn-cancel-create" class="auth-link" style="cursor:pointer;background:none;flex:1;color:var(--text-muted);border-color:var(--border)">Cancel</button>
                        </div>
                    </div>
                    <div id="key-modal-result" style="display:none">
                        <p style="color:var(--status-warn);font-size:0.8125rem;margin-bottom:var(--space-md)">
                            Copy this key now — it will not be shown again.
                        </p>
                        <code id="key-modal-value" class="key-display"></code>
                        <button id="btn-copy-key" class="auth-link" style="cursor:pointer;margin-top:var(--space-md);display:block;background:none;width:100%">
                            Copy to clipboard
                        </button>
                        <button id="btn-close-modal" class="auth-link" style="cursor:pointer;margin-top:var(--space-sm);display:block;background:none;color:var(--text-muted);border-color:var(--border);width:100%">
                            Close
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <div id="revoke-modal" style="display:none" class="key-modal-overlay">
            <div class="card key-modal">
                <div class="card__header">
                    <span class="card__title">Revoke API Key</span>
                </div>
                <div class="card__body">
                    <p style="color:var(--status-error);font-size:0.8125rem;margin-bottom:var(--space-md)">
                        This will permanently revoke the key. Any client using it will lose access.
                    </p>
                    <p id="revoke-key-info" style="font-size:0.8125rem;color:var(--text-secondary);margin-bottom:var(--space-md)"></p>
                    <div style="display:flex;gap:var(--space-sm)">
                        <button id="btn-do-revoke" class="auth-link" style="cursor:pointer;background:none;flex:1;color:var(--status-error);border-color:var(--status-error)">Revoke</button>
                        <button id="btn-cancel-revoke" class="auth-link" style="cursor:pointer;background:none;flex:1;color:var(--text-muted);border-color:var(--border)">Cancel</button>
                    </div>
                    <p id="revoke-error" class="modal-error" style="display:none;color:var(--status-error);font-size:0.8125rem;margin-top:var(--space-sm)"></p>
                </div>
            </div>
        </div>
    `;

    // Wire up create key button
    document.getElementById('btn-create-key')?.addEventListener('click', () => showCreateDialog(sid));

    // Load keys
    await loadKeys(sid);
}

/**
 * Renders the user's network affiliations as a sidebar card.
 *
 * @param {SessionData|null} user - The session/user data.
 * @returns {string} HTML string.
 */
function renderNetworks(user) {
    const nets = user?.networks || [];
    if (nets.length === 0) return '';

    const rows = nets.map(n =>
        `<div class="info-field">
            <span class="info-field__label">AS${n.asn}</span>
            <span class="info-field__value"><a href="/net/${n.id}" data-link>${esc(n.name)}</a></span>
        </div>`
    ).join('');

    return `
        <div class="card">
            <div class="card__header">
                <span class="card__title">Networks</span>
                <span class="card__badge">${nets.length}</span>
            </div>
            <div class="card__body">
                <div class="info-group">${rows}</div>
            </div>
        </div>
    `;
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
            keysContainer.innerHTML = `<p style="color:var(--status-error);font-size:0.8125rem">Failed to load API keys.</p>`;
            return;
        }

        const data = await res.json();
        const keys = data.keys || [];

        if (keys.length === 0) {
            keysContainer.innerHTML = `
                <p style="color:var(--text-muted);font-size:0.8125rem">
                    No API keys yet. Create one to enable authenticated API access.
                </p>
                <p style="color:var(--text-muted);font-size:0.75rem;margin-top:var(--space-sm)">
                    Use: <code style="color:var(--accent)">Authorization: Api-Key pdbfe.xxxxx</code>
                </p>
            `;
            return;
        }

        keysContainer.innerHTML = `
            <div class="data-table-wrapper">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Label</th>
                            <th>Key Prefix</th>
                            <th>Created</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${keys.map(k => `
                            <tr>
                                <td>${esc(k.label)}</td>
                                <td class="td-mono">pdbfe.${esc(k.prefix)}…</td>
                                <td>${formatDate(k.created_at)}</td>
                                <td>
                                    <button class="auth-link btn-delete-key"
                                            data-key-id="${esc(k.id)}"
                                            data-key-label="${esc(k.label)}"
                                            data-key-prefix="${esc(k.prefix)}"
                                            style="cursor:pointer;background:none;color:var(--status-error);border-color:var(--status-error)">
                                        Revoke
                                    </button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <p style="color:var(--text-muted);font-size:0.6875rem;margin-top:var(--space-sm)">
                ${keys.length} / ${data.max_keys} keys used
            </p>
        `;

        // Wire up delete buttons
        keysContainer.querySelectorAll('.btn-delete-key').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const el = /** @type {HTMLElement} */ (e.target);
                const keyId = el.dataset.keyId;
                const keyLabel = el.dataset.keyLabel || '';
                const keyPrefix = el.dataset.keyPrefix || '';
                if (!keyId) return;
                showRevokeDialog(sid, keyId, keyLabel, keyPrefix);
            });
        });

    } catch (err) {
        console.error('Failed to load keys:', err);
        keysContainer.innerHTML = `<p style="color:var(--status-error);font-size:0.8125rem">Error loading API keys.</p>`;
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
    titleEl.textContent = 'Create API Key';
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
        if (createBtn) createBtn.textContent = 'Creating...';

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
                if (createBtn) createBtn.textContent = 'Create';
                // Show inline error instead of alert
                const existing = createView.querySelector('.modal-error');
                if (existing) existing.remove();
                const errEl = document.createElement('p');
                errEl.className = 'modal-error';
                errEl.style.cssText = 'color:var(--status-error);font-size:0.8125rem;margin-top:var(--space-sm)';
                errEl.textContent = data.error || 'Failed to create key';
                createView.appendChild(errEl);
                return;
            }

            // Switch to result view
            titleEl.textContent = 'API Key Created';
            createView.style.display = 'none';
            resultView.style.display = 'block';

            const keyValue = document.getElementById('key-modal-value');
            if (keyValue) keyValue.textContent = data.key;

            const copyBtn = document.getElementById('btn-copy-key');
            if (copyBtn) {
                copyBtn.textContent = 'Copy to clipboard';
                copyBtn.onclick = () => {
                    navigator.clipboard.writeText(data.key).then(() => {
                        copyBtn.textContent = 'Copied!';
                    });
                };
            }

            const closeBtn = document.getElementById('btn-close-modal');
            if (closeBtn) closeBtn.onclick = closeModal;

        } catch (err) {
            console.error('Create key error:', err);
            if (createBtn) createBtn.textContent = 'Create';
        }
    }

    // Wire up buttons
    const createBtn = document.getElementById('btn-do-create');
    const cancelBtn = document.getElementById('btn-cancel-create');
    if (createBtn) {
        createBtn.textContent = 'Create';
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

    infoEl.innerHTML = `<strong>${esc(label)}</strong> <span class="td-mono" style="display:inline">(pdbfe.${esc(prefix)}…)</span>`;
    errorEl.style.display = 'none';
    modal.style.display = 'flex';

    /** Closes the revoke modal. */
    function closeModal() {
        modal.style.display = 'none';
    }

    /** Performs the DELETE request and refreshes the list. */
    async function doRevoke() {
        const revokeBtn = document.getElementById('btn-do-revoke');
        if (revokeBtn) revokeBtn.textContent = 'Revoking...';

        try {
            const res = await fetch(`${AUTH_ORIGIN}/account/keys/${keyId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${sid}` },
            });

            if (!res.ok) {
                const data = await res.json();
                errorEl.textContent = data.error || 'Failed to revoke key';
                errorEl.style.display = 'block';
                if (revokeBtn) revokeBtn.textContent = 'Revoke';
                return;
            }

            closeModal();
            await loadKeys(sid);
        } catch (err) {
            console.error('Delete key error:', err);
            errorEl.textContent = 'Network error';
            errorEl.style.display = 'block';
            if (revokeBtn) revokeBtn.textContent = 'Revoke';
        }
    }

    const revokeBtn = document.getElementById('btn-do-revoke');
    const cancelBtn = document.getElementById('btn-cancel-revoke');
    if (revokeBtn) {
        revokeBtn.textContent = 'Revoke';
        revokeBtn.onclick = doRevoke;
    }
    if (cancelBtn) cancelBtn.onclick = closeModal;
}

/**
 * Formats an ISO date string for display.
 *
 * @param {string} iso - ISO 8601 date string.
 * @returns {string} Formatted date.
 */
function formatDate(iso) {
    try {
        return new Date(iso).toLocaleDateString('en-GB', {
            year: 'numeric', month: 'short', day: 'numeric',
        });
    } catch {
        return iso;
    }
}

/**
 * HTML-escapes a string.
 *
 * @param {string} str - Input string.
 * @returns {string} Escaped string.
 */
function esc(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}
