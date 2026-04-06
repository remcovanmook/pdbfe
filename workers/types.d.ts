/**
 * Shared type definitions for the pdbfe Cloudflare Workers codebase.
 * Consumed by tsc --noEmit via tsconfig.json. Never imported at runtime.
 */

// ── Environment Bindings ─────────────────────────────────────────────────────

/**
 * Environment bindings for the API worker.
 * Matches workers/wrangler.toml d1_databases, kv_namespaces, and vars.
 */
interface PdbApiEnv {
    PDB: D1Database;
    SESSIONS: KVNamespace;
    USERS: KVNamespace;
    ADMIN_SECRET?: string;
}

/**
 * Common interface for D1Database and D1DatabaseSession.
 * Both provide .prepare(), which is the only method the API worker uses.
 * Used for handler parameters that accept either a raw binding or a
 * session-wrapped binding for read replication.
 */
type D1Session = D1Database | D1DatabaseSession;

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
 * Environment bindings for the auth worker (pdbfe-auth).
 * Matches workers/wrangler-auth.toml kv_namespaces, vars, and secrets.
 */
interface PdbAuthEnv {
    SESSIONS: KVNamespace;
    USERS: KVNamespace;
    OAUTH_CLIENT_ID: string;
    OAUTH_CLIENT_SECRET: string;
    OAUTH_REDIRECT_URI: string;
    FRONTEND_ORIGIN: string;
    PEERINGDB_API_KEY: string;
}

/**
 * Session data stored in the SESSIONS KV namespace.
 * Written by pdbfe-auth on successful OAuth callback,
 * read by pdbfe-api to determine authentication status.
 */
interface SessionData {
    /** PeeringDB user ID. */
    id: number;
    /** Full display name. */
    name: string;
    /** First name. */
    given_name: string;
    /** Last name. */
    family_name: string;
    /** Email address (requires 'email' scope). */
    email: string;
    /** Whether the PeeringDB account is verified. */
    verified_user: boolean;
    /** Whether the email is verified (requires 'email' scope). */
    verified_email: boolean;
    /** Network affiliations with CRUD permission bitmasks (requires 'networks' scope). */
    networks: Array<{ perms: number; asn: number; name: string; id: number }>;
    /** ISO 8601 timestamp when the session was created. */
    created_at: string;
}

/**
 * Per-user record stored in the USERS KV namespace.
 * Key format: `user:<peeringdb_user_id>`.
 */
interface UserRecord {
    /** PeeringDB user ID (same as SessionData.id). */
    id: number;
    /** Display name. */
    name: string;
    /** Email address. */
    email: string;
    /** API keys owned by this user (stores prefix + metadata, never the full key). */
    api_keys: ApiKeyMeta[];
    /** ISO 8601 timestamp of record creation. */
    created_at: string;
    /** ISO 8601 timestamp of last modification. */
    updated_at: string;
}

/**
 * API key metadata stored in the user record.
 * The full key is only returned once at creation time — the user
 * record stores only the 4-character prefix for display purposes.
 */
interface ApiKeyMeta {
    /** Key identifier (first 8 hex chars of the full key). */
    id: string;
    /** User-assigned label (e.g. "curl scripts"). */
    label: string;
    /** First 4 hex characters of the key, for display (e.g. "a1b2"). */
    prefix: string;
    /** ISO 8601 timestamp of key creation. */
    created_at: string;
}

/**
 * Reverse-index entry stored in USERS KV for API key lookups.
 * Key format: `apikey:<full_key>`. Looked up by pdbfe-api to
 * verify incoming Api-Key headers.
 */
interface ApiKeyEntry {
    /** PeeringDB user ID that owns this key. */
    user_id: number;
    /** User-assigned label. */
    label: string;
    /** ISO 8601 timestamp of key creation. */
    created_at: string;
}

/**
 * Union type for shared core code that accepts any worker's env.
 * Excludes PdbAuthEnv because the auth worker has its own entry
 * point and doesn't use admin.js (which expects ADMIN_SECRET).
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
    /** Whether this entity requires authentication for full data access. */
    _restricted?: boolean;
    /** Mandatory filter applied to anonymous queries (e.g. {field: 'visible', value: 'Public'}). */
    _anonFilter?: { field: string; value: string };
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
