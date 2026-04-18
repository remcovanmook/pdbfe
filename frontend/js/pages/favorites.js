/**
 * @fileoverview Favorites management page.
 *
 * Renders a draggable, reorderable list of the user's favorite entities
 * with delete buttons. Works for both anonymous (localStorage) and
 * authenticated (D1-backed) users via the shared auth module API.
 *
 * Drag-and-drop reorder uses the native HTML5 Drag and Drop API
 * with no external dependencies.
 */

import { getFavorites, removeFavorite, reorderFavorites } from '../auth.js';
import { createLink, createEntityBadge, createEmptyState } from '../render.js';
import { t } from '../i18n.js';

/**
 * Renders the /favorites page.
 *
 * @param {Record<string, string>} _params - Route params (unused).
 */
export async function renderFavorites(_params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    document.title = `★ ${t('Favorites')} — PDBFE`;

    const wrap = document.createElement('div');
    wrap.className = 'favorites-page';

    // Page heading
    const heading = document.createElement('h1');
    heading.className = 'detail-header__title';
    heading.textContent = '★ ' + t('Your Favorites');
    wrap.appendChild(heading);

    const subtitle = document.createElement('p');
    subtitle.className = 'favorites-page__subtitle';
    subtitle.textContent = t('Drag to reorder. Use the star button on any entity page to add favorites.');
    wrap.appendChild(subtitle);

    const favorites = getFavorites();

    if (favorites.length === 0) {
        const emptyEl = createEmptyState(t('No favorites yet'));
        const hint = document.createElement('p');
        hint.className = 'empty-state__hint';
        hint.textContent = t('Use the ★ button on any network, exchange, or facility page to add it here.');
        wrap.appendChild(emptyEl);
        wrap.appendChild(hint);
        app.replaceChildren(wrap);
        return;
    }

    const list = document.createElement('div');
    list.className = 'favorites-manage';
    list.id = 'favorites-manage-list';

    for (const fav of favorites) {
        list.appendChild(buildFavoriteRow(fav, list));
    }

    wrap.appendChild(list);

    // Count
    const countEl = document.createElement('p');
    countEl.className = 'favorites-page__count';
    countEl.id = 'favorites-count';
    countEl.textContent = t('{n} favorites', { n: String(favorites.length) });
    wrap.appendChild(countEl);

    app.replaceChildren(wrap);
}

/**
 * Builds a single draggable favorite row.
 *
 * @param {{entity_type: string, entity_id: number, label: string}} fav - Favorite entry.
 * @param {HTMLElement} listEl - Parent list element for reorder persistence.
 * @returns {HTMLElement} The row element.
 */
function buildFavoriteRow(fav, listEl) {
    const row = document.createElement('div');
    row.className = 'favorites-manage__item';
    row.draggable = true;
    row.dataset.key = `${fav.entity_type}:${fav.entity_id}`;

    // Drag handle
    const handle = document.createElement('span');
    handle.className = 'favorites-manage__handle';
    handle.textContent = '⠿';
    handle.title = t('Drag to reorder');
    row.appendChild(handle);

    // Entity badge
    row.appendChild(createEntityBadge(fav.entity_type));

    // Entity link
    const link = createLink(fav.entity_type, fav.entity_id, fav.label || `${fav.entity_type} ${fav.entity_id}`);
    link.className += ' favorites-manage__name';
    row.appendChild(link);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'favorites-manage__delete';
    deleteBtn.textContent = '×';
    deleteBtn.title = t('Remove from favorites');
    deleteBtn.setAttribute('aria-label', t('Remove from favorites'));
    deleteBtn.addEventListener('click', async () => {
        deleteBtn.disabled = true;
        const ok = await removeFavorite(fav.entity_type, fav.entity_id);
        if (ok) {
            row.remove();
            updateCount();
            // Show empty state if list is now empty
            if (listEl.children.length === 0) {
                renderFavorites({});
            }
        } else {
            deleteBtn.disabled = false;
        }
    });
    row.appendChild(deleteBtn);

    // ── Drag and drop handlers ──────────────────────────────────────

    row.addEventListener('dragstart', (e) => {
        row.classList.add('favorites-manage__item--dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', row.dataset.key || '');
        }
    });

    row.addEventListener('dragend', () => {
        row.classList.remove('favorites-manage__item--dragging');
        // Persist new order
        persistOrder(listEl);
    });

    row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

        const dragging = listEl.querySelector('.favorites-manage__item--dragging');
        if (!dragging || dragging === row) return;

        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
            listEl.insertBefore(dragging, row);
        } else {
            listEl.insertBefore(dragging, row.nextSibling);
        }
    });

    return row;
}

/**
 * Reads the current DOM order and persists it via reorderFavorites().
 *
 * @param {HTMLElement} listEl - The list container.
 */
function persistOrder(listEl) {
    /** @type {string[]} */
    const keys = [];
    for (const child of listEl.children) {
        const key = /** @type {HTMLElement} */ (child).dataset.key;
        if (key) keys.push(key);
    }
    reorderFavorites(keys);
}

/**
 * Updates the favorites count display after a deletion.
 */
function updateCount() {
    const countEl = document.getElementById('favorites-count');
    const listEl = document.getElementById('favorites-manage-list');
    if (countEl && listEl) {
        const n = listEl.children.length;
        countEl.textContent = t('{n} favorites', { n: String(n) });
    }
}
