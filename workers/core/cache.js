/**
 * @fileoverview TypedArray LRU isolate cache.
 * Provides contiguous high-performance RAM boundaries minimising V8 garbage
 * collection overheads.
 *
 * Exports:
 * - LRUCache: Slot-based LRU backed by flat arrays for eviction speed.
 *
 * IMPORTANT: get() returns a shared mutable object. Callers MUST read
 * its fields synchronously before the next get() call — the same object
 * is overwritten on every invocation. See ANTI_PATTERNS.md §11.
 */


/**
 * Constructs a slot-based LRU cache backed by TypedArrays.
 * Uses a clock-sweep approach over contiguous arrays rather than a
 * doubly-linked list. At the slot counts used here (128-1024), a
 * linear scan fits entirely in L1 CPU cache and avoids V8 heap
 * allocations for node wrappers.
 *
 * @param {number} maxSlots - Maximum number of cache entries.
 * @param {number} maxSize - Maximum total byte capacity.
 * @param {number} [ttlMs=3600000] - Time-to-live per entry in milliseconds.
 * @returns {LocalCache} The cache instance.
 */
export function LRUCache(maxSlots, maxSize, ttlMs = 3600000) {
  const index = new Map();
  let bufArray = new Array(maxSlots).fill(null); // ap-ok: cold-boot, runs once per isolate
  let metaArray = new Array(maxSlots).fill(null); // ap-ok: cold-boot, runs once per isolate
  let keyArray = new Array(maxSlots).fill(null); // ap-ok: cold-boot, runs once per isolate
  let hitsArray = new Int32Array(maxSlots);
  let usedArray = new Uint32Array(maxSlots);
  let bytesArray = new Int32Array(maxSlots);
  let addedArray = new Float64Array(maxSlots);
  let pinnedArray = new Uint8Array(maxSlots);

  let clock = 0;
  let size = 0;
  let freeSlot = 0;

  /**
   * Shared return object for get(). Mutated in place to avoid allocating
   * a fresh object on every cache hit. Callers must consume fields
   * synchronously before the next get() call.
   * @type {{buf: Uint8Array|null, meta: any, hits: number, addedAt: number}}
   */
  const _ret = { buf: null, meta: null, hits: 0, addedAt: 0 };

  function evict() {
    let lru = -1, lruTime = Infinity;
    for (let i = 0; i < maxSlots; i++) {
      if (keyArray[i] !== null && pinnedArray[i] === 0) {
        if (usedArray[i] < lruTime) {
          lruTime = usedArray[i]; lru = i;
        } else if (usedArray[i] === lruTime && lru !== -1 && hitsArray[i] < hitsArray[lru]) {
          lru = i;
        }
      }
    }
    if (lru === -1) return -1;
    index.delete(keyArray[lru]);
    size -= bytesArray[lru];
    bufArray[lru] = null;
    metaArray[lru] = null;
    keyArray[lru] = null;
    hitsArray[lru] = 0;
    usedArray[lru] = 0;
    bytesArray[lru] = 0;
    addedArray[lru] = 0;
    pinnedArray[lru] = 0;
    return lru;
  }

  return {
    /** @type {number} Hard expiry in milliseconds. */
    ttl: ttlMs,

    /**
     * In-flight promise map for cache stampede prevention.
     * When a key expires, the first caller stores its fetch promise here;
     * subsequent callers await the same promise instead of issuing
     * duplicate D1 queries. Cleaned up via .finally() in pipeline.js.
     * @type {Map<string, Promise<any>>}
     */
    pending: new Map(),

    /**
     * Adds or updates an entry. If the cache exceeds maxSize after
     * insertion, LRU entries are evicted until the byte budget is met.
     *
     * @param {string} key - Cache key.
     * @param {Uint8Array} buf - Payload bytes.
     * @param {any} meta - Arbitrary metadata (e.g. {entityTag, count}).
     * @param {number} now - Current timestamp in milliseconds.
     * @param {boolean} [pinned=false] - If true, entry is exempt from eviction.
     */
    add: (key, buf, meta, now, pinned = false) => {
      let slot = index.get(key);
      if (slot !== undefined) {
        size -= bytesArray[slot];
      } else {
        if (freeSlot < maxSlots) {
          slot = freeSlot++;
        } else {
          slot = -1;
          for (let i = 0; i < maxSlots; i++) {
            if (keyArray[i] === null) { slot = i; break; }
          }
          if (slot === -1) slot = evict();
          if (slot === -1) return; // Cache full of pinned items
        }
        index.set(key, slot);
        keyArray[slot] = key;
        hitsArray[slot] = 0;
        usedArray[slot] = clock = (clock + 1) >>> 0;
        if (clock === 0) usedArray.fill(0);
      }
      bufArray[slot] = buf;
      metaArray[slot] = meta;
      bytesArray[slot] = buf.byteLength;
      addedArray[slot] = now;
      pinnedArray[slot] = pinned ? 1 : 0;
      size += buf.byteLength;

      while (size > maxSize && index.size > 0) evict();
    },

    /**
     * Retrieves a cache entry by key. Returns a shared mutable object
     * whose fields ({buf, meta, hits, addedAt}) are overwritten on every
     * call. Callers MUST extract needed fields synchronously before the
     * next get() call or any await. See ANTI_PATTERNS.md §11.
     *
     * Returns null on cache miss.
     *
     * @param {string} key - Cache key.
     * @returns {{buf: Uint8Array|null, meta: any, hits: number, addedAt: number}|null}
     */
    get: (key) => {
      const slot = index.get(key);
      if (slot === undefined) return null;
      hitsArray[slot]++;
      usedArray[slot] = clock = (clock + 1) >>> 0;
      if (clock === 0) usedArray.fill(0);
      _ret.buf = bufArray[slot];
      _ret.meta = metaArray[slot];
      _ret.hits = hitsArray[slot];
      _ret.addedAt = addedArray[slot];
      return _ret;
    },

    /**
     * Checks whether a key exists in the cache without updating
     * access time or hit count.
     *
     * @param {string} key - Cache key.
     * @returns {boolean}
     */
    has: (key) => index.has(key),

    /**
     * Resets the insertion timestamp for an existing entry. Used by
     * SWR to extend the TTL of entries refreshed in the background
     * without re-adding the full payload.
     *
     * @param {string} key - Cache key.
     * @param {number} now - New timestamp in milliseconds.
     */
    updateTTL: (key, now) => {
      const slot = index.get(key);
      if (slot !== undefined) addedArray[slot] = now;
    },

    /**
     * Purges one or all entries. When called with a key, removes only
     * that entry. When called without arguments, clears the entire
     * cache by reallocating the backing arrays.
     *
     * @param {string} [key] - Specific key to purge. Omit to flush all.
     */
    purge: (key) => {
      if (key !== undefined) {
        const slot = index.get(key);
        if (slot !== undefined) {
          index.delete(key);
          size -= bytesArray[slot];
          bufArray[slot] = null;
          metaArray[slot] = null;
          keyArray[slot] = null;
          hitsArray[slot] = 0;
          usedArray[slot] = 0;
          bytesArray[slot] = 0;
          addedArray[slot] = 0;
          pinnedArray[slot] = 0;
        }
      } else {
        index.clear();
        bufArray = new Array(maxSlots).fill(null); // ap-ok: admin flush, not hot path
        metaArray = new Array(maxSlots).fill(null); // ap-ok: admin flush, not hot path
        keyArray = new Array(maxSlots).fill(null); // ap-ok: admin flush, not hot path
        hitsArray = new Int32Array(maxSlots);
        usedArray = new Uint32Array(maxSlots);
        bytesArray = new Int32Array(maxSlots);
        addedArray = new Float64Array(maxSlots);
        pinnedArray = new Uint8Array(maxSlots);
        size = 0;
        freeSlot = 0;
        clock = 0;
      }
    },

    /**
     * Returns aggregate cache statistics: entry count, total bytes
     * stored, and the byte budget ceiling.
     *
     * @returns {{items: number, bytes: number, limit: number}}
     */
    getStats: () => ({ items: index.size, bytes: size, limit: maxSize })
  };
}

/**
 * Normalises a cache key from a URL path and query string.
 * Sorts query parameters alphabetically to ensure that identical
 * queries with different parameter orderings hit the same cache slot.
 *
 * @param {string} path - The URL path (e.g. "api/net").
 * @param {string} queryString - Raw query string without leading '?'.
 * @returns {string} Normalised cache key.
 */
export function normaliseCacheKey(path, queryString) {
    if (!queryString) return path;
    const sorted = queryString.split("&").sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join("&"); // ap-ok: bounded by URL length
    return `${path}?${sorted}`;
}
