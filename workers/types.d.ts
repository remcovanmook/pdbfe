/**
 * Shared type definitions for the pdbfe Cloudflare Workers codebase.
 * Consumed by tsc --noEmit via tsconfig.json. Never imported at runtime.
 *
 * Cloudflare Workers runtime types (D1, KV, ExecutionContext, etc.) are
 * defined here instead of importing @cloudflare/workers-types (11 MB).
 * Only the interfaces actually used in source code are included.
 */

// ── Cloudflare Workers Runtime Types ─────────────────────────────────────────
// Extracted from @cloudflare/workers-types. Only the subset used by this
// project is included. Update these if new CF APIs are adopted.

interface ExecutionContext {
    waitUntil(promise: Promise<any>): void;
    passThroughOnException(): void;
}

/**
 * Cloudflare Workers extension to SubtleCrypto.
 * timingSafeEqual is not in the standard WebCrypto spec but is
 * available in the Workers runtime for constant-time comparisons.
 */
interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}

// ── D1 Database ──────────────────────────────────────────────────────────────

interface D1Meta {
    duration: number;
    size_after: number;
    rows_read: number;
    rows_written: number;
    last_row_id: number;
    changed_db: boolean;
    changes: number;
}

interface D1Response {
    success: true;
    meta: D1Meta & Record<string, unknown>;
}

type D1Result<T = unknown> = D1Response & {
    results: T[];
};

interface D1ExecResult {
    count: number;
    duration: number;
}

declare abstract class D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    exec(query: string): Promise<D1ExecResult>;
    withSession(constraintOrBookmark?: string): D1DatabaseSession;
}

declare abstract class D1DatabaseSession {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
    getBookmark(): string | null;
}

declare abstract class D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(colName: string): Promise<T | null>;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

// ── KV Namespace ─────────────────────────────────────────────────────────────

interface KVNamespacePutOptions {
    expiration?: number;
    expirationTtl?: number;
    metadata?: any | null;
}

interface KVNamespace<Key extends string = string> {
    get(key: Key, options?: { type?: "text"; cacheTtl?: number }): Promise<string | null>;
    get<T = unknown>(key: Key, type: "json"): Promise<T | null>;
    get<T = unknown>(key: Key, options: { type: "json"; cacheTtl?: number }): Promise<T | null>;
    get(key: Key, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
    put(key: Key, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: KVNamespacePutOptions): Promise<void>;
    delete(key: Key): Promise<void>;
    list<Metadata = unknown>(options?: { limit?: number; prefix?: string | null; cursor?: string | null }): Promise<{
        keys: { name: Key; expiration?: number; metadata?: Metadata }[];
        list_complete: boolean;
        cursor?: string;
    }>;
}

// ── R2 Object Storage ────────────────────────────────────────────────────────

interface R2HTTPMetadata {
    contentType?: string;
    contentLanguage?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    cacheControl?: string;
    cacheExpiry?: Date;
}

interface R2PutOptions {
    httpMetadata?: R2HTTPMetadata;
    customMetadata?: Record<string, string>;
}

interface R2ObjectBody {
    readonly key: string;
    readonly size: number;
    readonly etag: string;
    readonly httpEtag: string;
    readonly httpMetadata?: R2HTTPMetadata;
    readonly customMetadata?: Record<string, string>;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
    blob(): Promise<Blob>;
}

interface R2Object {
    readonly key: string;
    readonly size: number;
    readonly etag: string;
    readonly httpEtag: string;
    readonly httpMetadata?: R2HTTPMetadata;
    readonly customMetadata?: Record<string, string>;
}

interface R2Bucket {
    head(key: string): Promise<R2Object | null>;
    get(key: string): Promise<R2ObjectBody | null>;
    put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions): Promise<R2Object>;
    delete(key: string | string[]): Promise<void>;
    list(options?: { prefix?: string; limit?: number; cursor?: string; delimiter?: string }): Promise<{
        objects: R2Object[];
        truncated: boolean;
        cursor?: string;
        delimitedPrefixes: string[];
    }>;
}

// ── Scheduled Events ─────────────────────────────────────────────────────────

interface ScheduledEvent {
    readonly scheduledTime: number;
    readonly cron: string;
    noRetry(): void;
}

interface ScheduledController {
    readonly scheduledTime: number;
    readonly cron: string;
    noRetry(): void;
}

// ── Workers AI ────────────────────────────────────────────────────────────────

/** Workers AI response envelope from ai.run(). */
interface AiRunResponse {
    /** Embedding vectors — present for embedding models. */
    data?: number[][];
    /** Text response — present for text-generation models. */
    response?: string;
}

/**
 * Workers AI binding.
 * Only the run() method is used; full type is in @cloudflare/workers-types.
 */
interface Ai {
    run(model: string, inputs: Record<string, unknown>): Promise<AiRunResponse>;
}

// ── Vectorize ─────────────────────────────────────────────────────────────────

/** A single vector to upsert into a Vectorize index. */
interface VectorizeVector {
    id: string;
    values: number[];
    metadata?: Record<string, unknown>;
}

/** Vectorize index binding. */
interface VectorizeIndex {
    upsert(vectors: VectorizeVector[]): Promise<{ count: number }>;
    query(vector: number[], options?: { topK?: number; returnMetadata?: boolean }): Promise<{
        matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }>;
    }>;
    deleteByIds(ids: string[]): Promise<{ count: number }>;
}

// ── Request.cf Extension ─────────────────────────────────────────────────────
// Cloudflare-specific properties on incoming Request objects.

interface IncomingRequestCfProperties {
    colo?: string;
    country?: string;
    city?: string;
    continent?: string;
    latitude?: string;
    longitude?: string;
    region?: string;
    regionCode?: string;
    timezone?: string;
    asn?: number;
    asOrganization?: string;
    httpProtocol?: string;
    tlsVersion?: string;
    tlsCipher?: string;
    [key: string]: unknown;
}

interface Request {
    readonly cf?: IncomingRequestCfProperties;
}

// ── Environment Bindings ─────────────────────────────────────────────────────

/**
 * Environment bindings for the API worker.
 * Matches workers/wrangler.toml d1_databases, kv_namespaces, and vars.
 */
interface PdbApiEnv {
    PDB: D1Database;
    USERDB: D1Database;
    SESSIONS: KVNamespace;
    ADMIN_SECRET?: string;
    /** Release version string injected at deploy time from the VERSION file. */
    PDBFE_VERSION?: string;
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
    LOGOS?: R2Bucket;
    ADMIN_SECRET?: string;
    PEERINGDB_API_KEY?: string;
    /** Workers AI binding for BGE-large-en-v1.5 embedding. Optional — sync degrades to data-only without it. */
    AI?: Ai;
    /** Vectorize index for semantic search embedding upserts. Optional. */
    VECTORIZE?: VectorizeIndex;
    /** Release version string injected at deploy time from the VERSION file. */
    PDBFE_VERSION?: string;
}

/**
 * Environment bindings for the search worker (pdbfe-search).
 * Matches workers/wrangler-search.toml d1_databases, kv_namespaces, ai, vectorize, and vars.
 *
 * AI and VECTORIZE are optional — the worker degrades gracefully to keyword-only
 * mode when either binding is absent.
 */
interface PdbSearchEnv {
    /** PeeringDB mirror D1 database (read-only for search). */
    PDB: D1Database;
    /** OAuth session KV namespace — required by resolveAuth(). */
    SESSIONS: KVNamespace;
    /** Users D1 database — required by resolveAuth() for API key verification. */
    USERDB: D1Database;
    /** Workers AI binding for BGE-large-en-v1.5 embedding. Optional. */
    AI?: Ai;
    /** Vectorize index for semantic search. Optional. */
    VECTORIZE?: VectorizeIndex;
    /** Release version string injected at deploy time from the VERSION file. */
    PDBFE_VERSION?: string;
    /** Admin secret for /_admin/* endpoints. */
    ADMIN_SECRET?: string;
}

/**
 * Environment bindings for the auth worker (pdbfe-auth).
 * Matches workers/wrangler-auth.toml d1_databases, kv_namespaces, vars, and secrets.
 */
interface PdbAuthEnv {
    USERDB: D1Database;
    SESSIONS: KVNamespace;
    OAUTH_CLIENT_ID: string;
    OAUTH_CLIENT_SECRET: string;
    OAUTH_REDIRECT_URI: string;
    FRONTEND_ORIGIN: string;
    PEERINGDB_API_KEY: string;
    /** Release version string injected at deploy time from the VERSION file. */
    PDBFE_VERSION?: string;
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
 * Per-user record stored in the USERDB D1 database (users table).
 */
interface UserRecord {
    /** PeeringDB user ID (same as SessionData.id). */
    id: number;
    /** Display name. */
    name: string;
    /** Email address. */
    email: string;
    /** JSON-encoded user preferences (language, etc.). */
    preferences: string;
    /** ISO 8601 timestamp of record creation. */
    created_at: string;
    /** ISO 8601 timestamp of last modification. */
    updated_at: string;
}

/**
 * Parsed user preferences object. Stored as JSON TEXT in the
 * users.preferences column. All fields are optional — absent
 * keys mean "use platform defaults."
 */
interface UserPreferences {
    /** ISO language code (e.g. 'en', 'de', 'ja'). */
    language?: string;
}

/**
 * A single favorited entity row from the user_favorites table.
 */
interface UserFavorite {
    /** PeeringDB user ID. */
    user_id: number;
    /** Entity type tag ('net', 'ix', 'fac', 'org', 'carrier', 'campus'). */
    entity_type: string;
    /** Entity ID in the PeeringDB mirror. */
    entity_id: number;
    /** Cached display name (for listing without an API roundtrip). */
    label: string;
    /** ISO 8601 timestamp of when the favorite was added. */
    created_at: string;
}

/**
 * API key row from the USERDB D1 database (api_keys table).
 * Each key is a separate row — no more JSON arrays in a user blob.
 * The full key is never stored; only its SHA-256 hash for verification.
 */
interface ApiKeyRow {
    /** Key identifier (first 8 hex chars of the full key). */
    key_id: string;
    /** PeeringDB user ID that owns this key. */
    user_id: number;
    /** User-assigned label (e.g. "curl scripts"). */
    label: string;
    /** First 4 hex characters of the key, for UI display (e.g. "a1b2"). */
    prefix: string;
    /** SHA-256 hex digest of the full key. Indexed for hot-path lookups. */
    hash: string;
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
    type: 'string' | 'number' | 'boolean' | 'datetime' | 'json';
    /** Whether this field can be used in query filters. Defaults to true. */
    queryable?: boolean;
    /** Whether D1 stores this as a JSON TEXT column (needs json() wrapping). Defaults to false. */
    json?: boolean;
    /** Whether this column is nullable in D1 (TEXT without NOT NULL). Defaults to false. */
    nullable?: boolean;
    /** Whether to omit this field from JSON output when its value is null/empty/zero. Defaults to false. */
    omitempty?: boolean;
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
    nullable?: boolean;
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
    /** Entity naming metadata from the codegen pipeline. */
    naming?: {
        type?: string;
        singular?: string;
        plural?: string;
        subresource?: string;
        label?: string;
        aliases?: { singular?: string; plural?: string };
    };
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
    /** Precompiled ordered column names. */
    _columns?: string[];
    /** Precompiled set of JSON-stored column names. */
    _jsonColumns?: Set<string>;
    /** Precompiled set of boolean-typed column names. */
    _boolColumns?: Set<string>;
    /** Precompiled set of nullable column names. */
    _nullableColumns?: Set<string>;
    /** Precompiled set of omitempty column names (stripped via json_remove when empty). */
    _omitEmptyColumns?: Set<string>;
    /** Precompiled set of all field names. */
    _fieldNames?: Set<string>;
    /** Precompiled map of filterable field name → field type. */
    _filterTypes?: Map<string, string>;
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

/**
 * Pagination, depth, and feature-flag options passed through the query
 * pipeline. Constructed by the router and threaded to query builders,
 * handlers, and depth expansion.
 */
interface QueryOpts {
    depth: number;
    limit: number;
    skip: number;
    since: number;
    sort: string;
    fields?: string[];
    /** When true, include pdbfe-local extension columns (e.g. __logo_migrated). */
    pdbfe?: boolean;
}

/**
 * Common context passed to list/detail handlers, bundling request
 * metadata and parsed query state to reduce parameter counts.
 */
interface HandlerContext {
    request: Request;
    db: D1Session;
    ctx: ExecutionContext;
    entityTag: string;
    filters: ParsedFilter[];
    opts: QueryOpts;
    rawPath: string;
    queryString: string;
    authenticated: boolean;
    /** Entity last-modified epoch ms (0 if unknown). serveJSON uses this to set Last-Modified. */
    entityVersionMs?: number;
    /** Authenticated user ID (null for anon). serveJSON uses this to set X-Auth-Id. */
    userId?: number | null;
}
