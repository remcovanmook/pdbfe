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
}

/**
 * Metadata registry entry for a single PeeringDB entity type.
 */
interface EntityMeta {
    /** D1 table name (e.g. "peeringdb_network"). */
    table: string;
    /** API endpoint tag (e.g. "net"). */
    tag: string;
    /** Columns to SELECT. */
    columns: string[];
    /** Allowed filter fields (whitelisted from the OpenAPI spec). */
    filters: Record<string, 'string' | 'number' | 'boolean' | 'datetime'>;
    /** Relationship definitions for depth expansion. */
    relationships: EntityRelationship[];
}

// ── Query Builder Types ──────────────────────────────────────────────────────

/**
 * Parsed filter from a URL query parameter.
 */
interface ParsedFilter {
    /** Column name. */
    field: string;
    /** Operator (eq, lt, gt, lte, gte, contains, startswith, in). */
    op: string;
    /** Raw value(s) from the query string. */
    value: string;
}

/**
 * Result of the query builder: a parameterised SQL string and its bindings.
 */
interface BuiltQuery {
    sql: string;
    params: (string | number)[];
}
