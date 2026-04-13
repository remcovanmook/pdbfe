/**
 * @fileoverview <pdb-stats-bar> custom element.
 *
 * A horizontal bar of label/value statistic pairs. Replaces the
 * renderStatsBar() string builder. Accepts items via configure().
 *
 * Usage:
 *   const el = document.createElement('pdb-stats-bar');
 *   el.configure({
 *       items: [
 *           { label: 'Peers', value: '42' },
 *           { label: 'Total Speed', value: '100G' },
 *       ],
 *   });
 *   container.appendChild(el);
 */

import { t } from '../i18n.js';

/**
 * @typedef {Object} StatsBarConfig
 * @property {Array<{label: string, value: string|number}>} items - Stats items.
 */

class PdbStatsBar extends HTMLElement {
    constructor() {
        super();
        /** @type {StatsBarConfig|null} */
        this._config = null;
    }

    /**
     * Sets the stats bar configuration.
     *
     * @param {StatsBarConfig} config - Configuration object.
     */
    configure(config) {
        this._config = config;
    }

    /**
     * Builds the stats bar DOM when connected. Each item uses the
     * tpl-stats-item template from index.html.
     */
    connectedCallback() {
        if (!this._config) return;

        const bar = document.createElement('div');
        bar.className = 'stats-bar';

        const tpl = /** @type {HTMLTemplateElement|null} */ (
            document.getElementById('tpl-stats-item')
        );

        for (const item of this._config.items) {
            if (tpl) {
                const clone = /** @type {HTMLDivElement} */ (
                    /** @type {DocumentFragment} */ (tpl.content.cloneNode(true)).firstElementChild
                );
                clone.querySelector('.stats-bar__value').textContent = String(item.value);
                clone.querySelector('.stats-bar__label').textContent = t(item.label);
                bar.appendChild(clone);
            } else {
                // Fallback: build without template
                const itemDiv = document.createElement('div');
                itemDiv.className = 'stats-bar__item';

                const valSpan = document.createElement('span');
                valSpan.className = 'stats-bar__value';
                valSpan.textContent = String(item.value);

                const labelSpan = document.createElement('span');
                labelSpan.className = 'stats-bar__label';
                labelSpan.textContent = t(item.label);

                itemDiv.append(valSpan, labelSpan);
                bar.appendChild(itemDiv);
            }
        }

        this.appendChild(bar);
    }
}

customElements.define('pdb-stats-bar', PdbStatsBar);
