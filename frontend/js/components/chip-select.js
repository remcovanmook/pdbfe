/**
 * @fileoverview Custom multi-select chip component for advanced search
 * filter dropdowns. Replaces native `<select multiple>` with a filterable
 * dropdown and removable chip tags.
 *
 * Usage:
 *   const cs = new ChipSelect({ options: [{value, label}], placeholder: '...' });
 *   container.appendChild(cs.el);
 *   cs.onChange = (values) => { ... };
 *
 * Keyboard navigation: ArrowDown/Up to navigate, Enter to select,
 * Backspace to remove last chip, Escape to close dropdown.
 */

import { t } from '../i18n.js';

/**
 * @typedef {Object} ChipOption
 * @property {string} value - Option value (sent in API queries).
 * @property {string} label - Display label (passed through t() for i18n).
 */

/**
 * @typedef {Object} ChipSelectConfig
 * @property {ChipOption[]} options - Available options.
 * @property {string} [placeholder] - Input placeholder text.
 * @property {string[]} [initial] - Initially selected values.
 */

/**
 * Multi-select component with chip display and filterable dropdown.
 * Not a Web Component — just a plain class that creates and manages
 * a DOM subtree, keeping things simple and avoiding Shadow DOM
 * style isolation issues with the main theme.
 */
export class ChipSelect {
    /**
     * Creates a new chip-select instance.
     *
     * @param {ChipSelectConfig} config - Component configuration.
     */
    constructor(config) {
        /** @type {ChipOption[]} */
        this._options = config.options;

        /** @type {Set<string>} */
        this._selected = new Set(config.initial || []);

        /** @type {number} */
        this._highlightIdx = -1;

        /** @type {((values: string[]) => void)|null} */
        this.onChange = null;

        // Build DOM
        /** @type {HTMLElement} */
        this.el = document.createElement('div');
        this.el.className = 'chip-select';

        /** @type {HTMLElement} */
        this._chipArea = document.createElement('div');
        this._chipArea.className = 'chip-select__chips';
        this.el.appendChild(this._chipArea);

        /** @type {HTMLInputElement} */
        this._input = document.createElement('input');
        this._input.type = 'text';
        this._input.className = 'chip-select__input';
        this._input.placeholder = config.placeholder || t('Type to filter...');
        this._input.setAttribute('autocomplete', 'off');
        this._chipArea.appendChild(this._input);

        /** @type {HTMLElement} */
        this._dropdown = document.createElement('div');
        this._dropdown.className = 'chip-select__dropdown';
        this._dropdown.hidden = true;
        this.el.appendChild(this._dropdown);

        this._bindEvents();
        this._renderChips();
    }

    /**
     * Returns the currently selected values as an array.
     *
     * @returns {string[]} Selected option values.
     */
    getValues() {
        return [...this._selected];
    }

    /**
     * Programmatically sets the selection and re-renders.
     *
     * @param {string[]} values - Values to select.
     */
    setValues(values) {
        this._selected = new Set(values);
        this._renderChips();
    }

    /**
     * Clears all selected values and re-renders.
     */
    clear() {
        this._selected.clear();
        this._input.value = '';
        this._renderChips();
        this._notifyChange();
    }

    /** Attaches DOM event listeners for input, keyboard, and click interactions. */
    _bindEvents() {
        this._input.addEventListener('focus', () => this._showDropdown());
        this._input.addEventListener('input', () => this._showDropdown());

        this._input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && this._input.value === '' && this._selected.size > 0) {
                // Remove last chip
                const vals = [...this._selected];
                this._selected.delete(vals.at(-1));
                this._renderChips();
                this._notifyChange();
                this._showDropdown();
                return;
            }
            if (e.key === 'Escape') {
                this._hideDropdown();
                this._input.blur();
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this._moveHighlight(1);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this._moveHighlight(-1);
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                const visible = this._getVisibleOptions();
                if (this._highlightIdx >= 0 && this._highlightIdx < visible.length) {
                    this._toggleOption(visible[this._highlightIdx].value);
                }
            }
        });

        // Close dropdown when clicking outside
        document.addEventListener('mousedown', (e) => {
            if (!this.el.contains(/** @type {Node} */(e.target))) {
                this._hideDropdown();
            }
        });

        // Click on the chip area to focus the input
        this._chipArea.addEventListener('click', (e) => {
            if (/** @type {HTMLElement} */(e.target).closest('.chip-select__chip-remove')) {
                return; // Handled by chip remove button
            }
            this._input.focus();
        });
    }

    /**
     * Returns the filtered list of options based on the current input value.
     *
     * @returns {ChipOption[]} Options matching the filter text.
     */
    _getVisibleOptions() {
        const filter = this._input.value.toLowerCase().trim();
        if (!filter) return this._options;
        return this._options.filter(o =>
            o.label.toLowerCase().includes(filter) ||
            o.value.toLowerCase().includes(filter)
        );
    }

    /** Renders the dropdown with filtered options. */
    _showDropdown() {
        const visible = this._getVisibleOptions();
        this._dropdown.innerHTML = '';
        this._highlightIdx = -1;

        if (visible.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'chip-select__empty';
            empty.textContent = t('No matches');
            this._dropdown.appendChild(empty);
        } else {
            for (let i = 0; i < visible.length; i++) {
                const opt = visible[i];
                const item = document.createElement('div');
                item.className = 'chip-select__option';
                if (this._selected.has(opt.value)) {
                    item.classList.add('chip-select__option--selected');
                }
                item.dataset.value = opt.value;
                item.textContent = t(opt.label);

                item.addEventListener('mousedown', (e) => {
                    e.preventDefault(); // Prevent input blur
                    this._toggleOption(opt.value);
                });
                item.addEventListener('mouseenter', () => {
                    this._highlightIdx = i;
                    this._updateHighlight();
                });
                this._dropdown.appendChild(item);
            }
        }

        this._dropdown.hidden = false;
    }

    /** Hides the dropdown. */
    _hideDropdown() {
        this._dropdown.hidden = true;
        this._highlightIdx = -1;
    }

    /**
     * Moves the keyboard highlight up or down.
     *
     * @param {number} delta - Direction to move (+1 down, -1 up).
     */
    _moveHighlight(delta) {
        const visible = this._getVisibleOptions();
        if (visible.length === 0) return;
        this._highlightIdx = Math.max(0, Math.min(visible.length - 1, this._highlightIdx + delta));
        this._updateHighlight();
    }

    /** Applies the highlight class to the currently highlighted option. */
    _updateHighlight() {
        const items = this._dropdown.querySelectorAll('.chip-select__option');
        for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('chip-select__option--highlight', i === this._highlightIdx);
        }
        // Scroll highlighted item into view
        if (this._highlightIdx >= 0 && items[this._highlightIdx]) {
            items[this._highlightIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    /**
     * Toggles an option's selection state.
     *
     * @param {string} value - The option value to toggle.
     */
    _toggleOption(value) {
        if (this._selected.has(value)) {
            this._selected.delete(value);
        } else {
            this._selected.add(value);
        }
        this._renderChips();
        this._notifyChange();
        this._showDropdown(); // Refresh dropdown to update selected state
    }

    /** Renders the selected values as removable chip tags. */
    _renderChips() {
        // Remove existing chips (keep the input)
        const chips = this._chipArea.querySelectorAll('.chip-select__chip');
        for (const chip of chips) chip.remove();

        // Add chips before the input
        for (const value of this._selected) {
            const opt = this._options.find(o => o.value === value);
            if (!opt) continue;

            const chip = document.createElement('span');
            chip.className = 'chip-select__chip';
            chip.textContent = t(opt.label);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'chip-select__chip-remove';
            remove.textContent = '×';
            remove.title = t('Remove');
            remove.addEventListener('click', (e) => {
                e.stopPropagation();
                this._selected.delete(value);
                this._renderChips();
                this._notifyChange();
            });
            chip.appendChild(remove);

            this._chipArea.insertBefore(chip, this._input);
        }
    }

    /** Fires the onChange callback with the current selection. */
    _notifyChange() {
        if (this.onChange) {
            this.onChange(this.getValues());
        }
    }
}
