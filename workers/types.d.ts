/**
 * Shared type definitions for the pdbfe Cloudflare Workers codebase.
 * Consumed by tsc --noEmit via tsconfig.json. Never imported at runtime.
 */

// ── Environment Bindings ─────────────────────────────────────────────────────

/**
 * Environment bindings for the API worker.
 * Matches workers/wrangler.toml d1_databases and vars.
 */
interface PdbApiEnv {
    PDB: D1Database;
    ADMIN_SECRET?: string;
}

/**
 * Environment bindings for the sync worker.
 * Matches workers/wrangler-sync.toml d1_databases and vars.
 */
interface PdbSyncEnv {
    PDB: D1Database;
    ADMIN_SECRET?: string;
    PEERINGDB_API_KEY?: string;
}

/**
 * Union type for shared core code that accepts any worker's env.
 */
type PdbEnv = PdbApiEnv | PdbSyncEnv;

// ── LRU Cache Types ──────────────────────────────────────────────────────────

/**
 * A single entry returned by LocalCache.get().
 */
interface CacheEntry {
    buf: ArrayBuffer | Uint8Array;
    meta: Record<string, any>;
    hits: number;
    addedAt: number;
}

/**
 * The object returned by the LRUCache() factory function (core/cache.js).
 */
interface LocalCache {
    ttl: number;
    pending: Map<string, Promise<any>>;
    add(key: string, buf: ArrayBuffer | Uint8Array, meta: Record<string, any>, now: number, pinned?: boolean): void;
    get(key: string): CacheEntry | null;
    has(key: string): boolean;
    updateTTL(key: string, now: number): void;
    purge(key?: string): void;
    getStats(): { items: number; bytes: number; limit: number };
}

// ── Entity Metadata Types ────────────────────────────────────────────────────

/**
 * Defines a LEFT JOIN for resolving cross-entity names on junction
 * table records. Mirrors the upstream Django ORM's select_related().
 */
interface JoinColumnDef {
    /** D1 table name to JOIN (e.g. "peeringdb_network"). */
    table: string;
    /** FK column on the source table that points to the JOINed table's id. */
    localFk: string;
    /** Map of source column → alias in the output (e.g. { name: "net_name" }). */
    columns: Record<string, string>;
}

/**
 * Describes a relationship between a parent entity and a child set.
 * Used for depth expansion (depth=1 returns IDs, depth=2 returns objects).
 */
interface EntityRelationship {
    /** The _set field name in the API response (e.g. "net_set"). */
    field: string;
    /** The D1 table name for the child entity. */
    table: string;
    /** The foreign key column in the child table pointing back to the parent. */
    fk: string;
    /** Optional JOIN definitions for cross-entity name resolution in depth=2. */
    joinColumns?: JoinColumnDef[];
}

/**
 * Describes a single column/field on a PeeringDB entity.
 * Foreign key annotations drive automatic derivation of joinColumns
 * and relationships — see deriveRelationships() in entities.js.
 */
interface FieldDef {
    /** Column name in D1 (e.g. "asn", "name"). */
    name: string;
    /** Data type for filter coercion and validation. */
    type: 'string' | 'number' | 'boolean' | 'datetime';
    /** Whether this field can be used in query filters. Defaults to true. */
    queryable?: boolean;
    /** Whether D1 stores this as a JSON TEXT column (needs json() wrapping). Defaults to false. */
    json?: boolean;
    /** Target entity tag if this field is a foreign key (e.g. "org"). id column implied. */
    foreignKey?: string;
    /** Columns to resolve via LEFT JOIN when this FK is present (e.g. { name: "org_name" }). */
    resolve?: Record<string, string>;
}

/**
 * Options for Entity builder field methods.
 */
interface FieldOpts {
    queryable?: boolean;
    json?: boolean;
    foreignKey?: string;
    resolve?: Record<string, string>;
}

/**
 * Metadata registry entry for a single PeeringDB entity type.
 */
interface EntityMeta {
    /** D1 table name (e.g. "peeringdb_network"). */
    table: string;
    /** API endpoint tag (e.g. "net"). */
    tag: string;
    /** Field definitions — the single source of truth for columns, types, and filterability. */
    fields: FieldDef[];
    /** Relationship definitions for depth expansion. */
    relationships: EntityRelationship[];
    /** Optional JOIN definitions for direct list/detail queries. */
    joinColumns?: JoinColumnDef[];
}


// ── Query Builder Types ──────────────────────────────────────────────────────

/**
 * Parsed filter from a URL query parameter.
 */
interface ParsedFilter {
    /** Column name (on the current entity, or on the referenced entity for cross-entity filters). */
    field: string;
    /** Operator (eq, lt, gt, lte, gte, contains, startswith, in). */
    op: string;
    /** Raw value(s) from the query string. */
    value: string;
    /** Cross-entity reference tag (e.g. "fac" for fac__state). When set, field is on this entity. */
    entity?: string;
}

/**
 * Result of the query builder: a parameterised SQL string and its bindings.
 */
interface BuiltQuery {
    sql: string;
    params: (string | number)[];
}
