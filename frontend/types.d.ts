/**
 * Frontend type definitions for TypeScript validation (tsc --noEmit).
 * These types are used in JSDoc annotations across the frontend JS files.
 */

/**
 * User session data returned by the auth worker's /session endpoint.
 */
interface SessionData {
    id: number;
    username: string;
    name: string;
    given_name?: string;
    email: string;
    networks: Array<{ id: number; asn: number; name: string }>;
    keys?: Array<{ name: string; created: string }>;
    preferences?: UserPreferences;
}

/**
 * Parsed user preferences. All fields optional — absent means "use default."
 */
interface UserPreferences {
    language?: string;
}

/**
 * PeeringDB entity record. Used as a generic type for API responses
 * where the exact shape depends on the entity type.
 */
interface PDBRecord {
    id: number;
    name?: string;
    asn?: number;
    city?: string;
    country?: string;
    [key: string]: any;
}

/**
 * Extend Window to include the SPA router exposed by boot.js.
 */
interface Window {
    __router: { navigate: (path: string) => void };
}

// ── Web Component types ─────────────────────────────────────────────

/**
 * Column definition for pdb-table.
 */
interface TableColumn {
    key: string;
    label: string;
    class?: string;
}

/**
 * Return type for cellRenderer when sort value differs from display.
 */
interface CellResult {
    node: Node;
    sortValue: string | number;
}

/**
 * Configuration accepted by <pdb-table>.configure().
 */
interface TableConfig {
    title: string;
    columns: TableColumn[];
    rows: any[];
    cellRenderer: (row: any, col: TableColumn) => Node | CellResult;
    filterable?: boolean;
    filterPlaceholder?: string;
    pageSize?: number;
}

/**
 * Configuration accepted by <pdb-field-group>.configure().
 */
interface FieldGroupConfig {
    title: string;
    fields: Array<HTMLElement | null>;
}

/**
 * Configuration accepted by <pdb-stats-bar>.configure().
 */
interface StatsBarConfig {
    items: Array<{ label: string; value: string | number }>;
}

/**
 * Options for the createField() DOM builder.
 */
interface CreateFieldOpts {
    href?: string;
    external?: boolean;
    linkType?: string;
    linkId?: number | string;
    markdown?: boolean;
    translate?: boolean;
}

/**
 * Options for the createDetailLayout() DOM builder.
 */
interface DetailLayoutOpts {
    title: string;
    subtitle?: string;
    statsBar?: HTMLElement;
    sidebar: HTMLElement | DocumentFragment;
    main: HTMLElement | DocumentFragment;
}

/**
 * Extend HTMLElementTagNameMap so document.createElement('pdb-table')
 * returns the correct type without explicit casting.
 */
interface HTMLElementTagNameMap {
    'pdb-table': HTMLElement & { configure(config: TableConfig): void };
    'pdb-field-group': HTMLElement & { configure(config: FieldGroupConfig): void };
    'pdb-stats-bar': HTMLElement & { configure(config: StatsBarConfig): void };
}
