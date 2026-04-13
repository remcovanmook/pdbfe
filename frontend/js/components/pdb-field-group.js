/**
 * @fileoverview <pdb-field-group> custom element.
 *
 * A container for info fields with a section title. Replaces the
 * renderFieldGroup() string builder. Accepts an array of DOM nodes
 * (from createField()) via configure().
 *
 * Usage:
 *   const el = document.createElement('pdb-field-group');
 *   el.configure({
 *       title: 'General',
 *       fields: [createField('Name', data.name), createField('ASN', data.asn)],
 *   });
 *   container.appendChild(el);
 */

import { t } from '../i18n.js';

/**
 * @typedef {Object} FieldGroupConfig
 * @property {string} title - Section title (passed through t()).
 * @property {Array<HTMLElement|null>} fields - Field nodes (nulls are filtered).
 */

class PdbFieldGroup extends HTMLElement {
    constructor() {
        super();
        /** @type {FieldGroupConfig|null} */
        this._config = null;
    }

    /**
     * Sets the field group configuration.
     *
     * @param {FieldGroupConfig} config - Configuration object.
     */
    configure(config) {
        this._config = config;
    }

    /**
     * Builds the field group DOM when connected. If all fields are
     * null/empty, the element remains empty (no visible output).
     */
    connectedCallback() {
        if (!this._config) return;

        const populated = this._config.fields.filter(Boolean);
        if (populated.length === 0) return;

        const group = document.createElement('div');
        group.className = 'info-group';

        const titleEl = document.createElement('div');
        titleEl.className = 'info-group__title';
        titleEl.textContent = t(this._config.title);
        group.appendChild(titleEl);

        for (const field of populated) {
            group.appendChild(/** @type {Node} */ (field));
        }

        this.appendChild(group);
    }
}

customElements.define('pdb-field-group', PdbFieldGroup);
