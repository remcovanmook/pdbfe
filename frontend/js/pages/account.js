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
                    <span class="card__title">New API Key Created</span>
                </div>
                <div class="card__body">
                    <p style="color:var(--status-warn);font-size:0.8125rem;margin-bottom:var(--space-md)">
                        Copy this key now — it will not be shown again.
                    </p>
                    <code id="key-modal-value" class="key-display"></code>
                    <button id="btn-copy-key" class="auth-link" style="cursor:pointer;margin-top:var(--space-md);display:block;background:none">
                        Copy to clipboard
                    </button>
                    <button id="btn-close-modal" class="auth-link" style="cursor:pointer;margin-top:var(--space-sm);display:block;background:none;color:var(--text-muted)">
                        Close
                    </button>
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
            <span class="info-field__value">${esc(n.name)}</span>
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
                                    <button class="auth-link btn-delete-key" data-key-id="${esc(k.id)}"
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
            btn.addEventListener('click', async (e) => {
                const keyId = /** @type {HTMLElement} */ (e.target).dataset.keyId;
                if (!keyId) return;
                if (!confirm(`Revoke API key ${keyId}? This cannot be undone.`)) return;
                await deleteKey(sid, keyId);
            });
        });

    } catch (err) {
        console.error('Failed to load keys:', err);
        keysContainer.innerHTML = `<p style="color:var(--status-error);font-size:0.8125rem">Error loading API keys.</p>`;
    }
}

/**
 * Shows a prompt for key label and creates the key.
 *
 * @param {string} sid - Session ID.
 */
async function showCreateDialog(sid) {
    const label = prompt('Label for the new API key (e.g. "curl scripts"):');
    if (label === null) return; // Cancelled

    try {
        const res = await fetch(`${AUTH_ORIGIN}/account/keys`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${sid}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ label: label || 'Unnamed key' }),
        });

        const data = await res.json();
        if (!res.ok) {
            alert(data.error || 'Failed to create key');
            return;
        }

        // Show the full key in the modal
        const modal = document.getElementById('key-modal');
        const keyValue = document.getElementById('key-modal-value');
        if (modal && keyValue) {
            keyValue.textContent = data.key;
            modal.style.display = 'flex';

            document.getElementById('btn-copy-key')?.addEventListener('click', () => {
                navigator.clipboard.writeText(data.key).then(() => {
                    const btn = document.getElementById('btn-copy-key');
                    if (btn) btn.textContent = 'Copied!';
                });
            });

            document.getElementById('btn-close-modal')?.addEventListener('click', () => {
                modal.style.display = 'none';
                loadKeys(sid);
            });
        }

    } catch (err) {
        console.error('Create key error:', err);
        alert('Failed to create API key');
    }
}

/**
 * Deletes an API key by its ID.
 *
 * @param {string} sid - Session ID.
 * @param {string} keyId - The 8-char key ID to revoke.
 */
async function deleteKey(sid, keyId) {
    try {
        const res = await fetch(`${AUTH_ORIGIN}/account/keys/${keyId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${sid}` },
        });

        if (!res.ok) {
            const data = await res.json();
            alert(data.error || 'Failed to revoke key');
            return;
        }

        await loadKeys(sid);
    } catch (err) {
        console.error('Delete key error:', err);
        alert('Failed to revoke API key');
    }
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
