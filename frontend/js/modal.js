/**
 * @fileoverview Lightweight modal + toast helpers shared across the frontend.
 *
 * DOM-based (no innerHTML). Modals close on backdrop click, Escape, or the ✕
 * button, and are removed from the DOM on close. Toasts are brief, auto-
 * dismissing status messages anchored to the bottom of the viewport.
 */

import { t } from './i18n.js';

/**
 * Opens a modal dialog containing the given body element.
 * Closes on backdrop click, Escape, or the ✕ button.
 *
 * @param {Object} opts - Modal options.
 * @param {string} opts.title - Modal heading.
 * @param {HTMLElement|DocumentFragment} opts.body - Modal body content.
 * @returns {() => void} A function that dismisses the modal.
 */
export function openModal({ title, body }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);

    const card = document.createElement('div');
    card.className = 'card modal-card';

    const header = document.createElement('div');
    header.className = 'modal-card__header';

    const titleEl = document.createElement('span');
    titleEl.className = 'modal-card__title';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-card__close';
    closeBtn.textContent = '✕';
    closeBtn.title = t('Close');
    closeBtn.setAttribute('aria-label', t('Close'));
    header.appendChild(closeBtn);

    card.appendChild(header);

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'modal-card__body';
    bodyWrap.appendChild(body);
    card.appendChild(bodyWrap);

    overlay.appendChild(card);

    /** @param {KeyboardEvent} e */
    function onKey(e) {
        if (e.key === 'Escape') close();
    }

    function close() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    }

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    closeBtn.focus();
    return close;
}

/**
 * Shows a brief, auto-dismissing toast message at the bottom of the viewport.
 *
 * @param {string} message - Text to display.
 * @param {number} [ms=1800] - How long to stay before fading out.
 */
export function showToast(message, ms = 1800) {
    let host = document.getElementById('toast-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toast-host';
        host.className = 'toast-host';
        host.setAttribute('role', 'status');
        host.setAttribute('aria-live', 'polite');
        document.body.appendChild(host);
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    host.appendChild(toast);

    setTimeout(() => { toast.classList.add('toast--out'); }, ms);
    setTimeout(() => { toast.remove(); }, ms + 300);
}

/**
 * Copies text to the clipboard and confirms with a toast.
 *
 * @param {string} text - Text to copy.
 * @param {string} [toastMsg] - Confirmation message (defaults to "Copied to clipboard").
 * @returns {Promise<boolean>} Whether the copy succeeded.
 */
export async function copyText(text, toastMsg) {
    try {
        await navigator.clipboard.writeText(text);
        showToast(toastMsg || t('Copied to clipboard'));
        return true;
    } catch {
        showToast(t('Copy failed'));
        return false;
    }
}
