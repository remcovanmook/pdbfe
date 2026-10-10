/**
 * @fileoverview Per-request D1 accounting for Server-Timing.
 *
 * Wraps a D1 session so every call records what D1 itself reports in the
 * result meta: SQL execution time (`timings.sql_duration_ms`, falling back
 * to `duration`) and rows read, plus the number of calls — each prepare()
 * execution or batch() is one network round trip. Next to the wall-clock
 * `db` phase this splits D1 time into execution vs round-trip overhead.
 *
 * `.first()` returns no meta, so the wrapper serves it through `.all()`:
 * same single call, same data (D1's first() fetches the result set and
 * returns the first row).
 *
 * Riders: `carry(rider)` attaches one extra read statement (the sync
 * freshness poll) to the request's FIRST D1 call — sent in the same batch,
 * so it costs no round trip; its results go to `rider.apply`, not to the
 * caller, and its meta does not count toward the request's stats. If the
 * request makes no D1 call, `takeRider()` hands it back for the caller to
 * run separately.
 */

/**
 * @typedef {{ calls: number, sqlMs: number, rowsRead: number }} D1Stats
 * @typedef {{ sql: string, apply: (results: Record<string, any>[]) => void }} Rider
 */

/**
 * @param {any} db - A D1 database or session.
 * @returns {{ db: any, stats: D1Stats }} The wrapped session and its live counters.
 */
export function withD1Stats(db) {
    /** @type {D1Stats} */
    const stats = { calls: 0, sqlMs: 0, rowsRead: 0 };

    /** @param {any} meta */
    const record = (meta) => {
        if (!meta) return;
        const ms = meta.timings?.sql_duration_ms ?? meta.duration;
        if (Number.isFinite(ms)) stats.sqlMs += ms;
        if (Number.isFinite(meta.rows_read)) stats.rowsRead += meta.rows_read;
    };

    /** @type {Rider|null} */
    let rider = null;

    /** @param {Rider} r @param {any} result */
    const deliver = (r, result) => {
        try { r.apply(result?.results || []); } catch (err) { console.error('[d1] rider apply failed:', err); }
    };

    /**
     * Executes one statement's all(), sending the pending rider (if any) in
     * the same batch.
     * @param {any} st
     */
    const allWithRider = async (st) => {
        const r = rider;
        if (!r) return st.all();
        rider = null;
        const [main, extra] = await db.batch([st, db.prepare(r.sql)]);
        deliver(r, extra);
        return main;
    };

    /** @param {any} st */
    const wrap = (st) => ({
        __inner: st,
        bind: (/** @type {any[]} */ ...args) => wrap(st.bind(...args)),
        all: async () => {
            stats.calls++;
            const r = await allWithRider(st);
            record(r?.meta);
            return r;
        },
        first: async (/** @type {string} */ col) => {
            stats.calls++;
            const r = await allWithRider(st);
            record(r?.meta);
            const row = r?.results?.[0] ?? null;
            if (col === undefined) return row;
            return row ? row[col] ?? null : null;
        },
        run: async () => {
            stats.calls++;
            const r = await st.run();
            record(r?.meta);
            return r;
        },
        raw: (/** @type {any} */ opts) => { stats.calls++; return st.raw(opts); },
    });

    const session = {
        prepare: (/** @type {string} */ sql) => wrap(db.prepare(sql)),
        batch: async (/** @type {any[]} */ stmts) => {
            stats.calls++;
            const inner = stmts.map(s => s?.__inner ?? s); // ap-ok: cold path, one map per batch
            const r = rider;
            rider = null;
            if (r) inner.push(db.prepare(r.sql));
            const results = await db.batch(inner);
            if (r) deliver(r, results.pop());
            for (const res of results) record(res?.meta);
            return results;
        },
        /** Attaches a read statement to the next D1 call (see file overview). @param {Rider} r */
        carry: (r) => { rider = r; },
        /** The rider, if no D1 call took it (then cleared). @returns {Rider|null} */
        takeRider: () => { const r = rider; rider = null; return r; },
        withSession: () => session,
        getBookmark: () => db.getBookmark?.() ?? null,
    };
    return { db: session, stats };
}
