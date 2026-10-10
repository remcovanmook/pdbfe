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
 */

/**
 * @typedef {{ calls: number, sqlMs: number, rowsRead: number }} D1Stats
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

    /** @param {any} st */
    const wrap = (st) => ({
        __inner: st,
        bind: (/** @type {any[]} */ ...args) => wrap(st.bind(...args)),
        all: async () => {
            stats.calls++;
            const r = await st.all();
            record(r?.meta);
            return r;
        },
        first: async (/** @type {string} */ col) => {
            stats.calls++;
            const r = await st.all();
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
            const results = await db.batch(stmts.map(s => s?.__inner ?? s)); // ap-ok: cold path, one map per batch
            for (const r of results) record(r?.meta);
            return results;
        },
        withSession: () => session,
        getBookmark: () => db.getBookmark?.() ?? null,
    };
    return { db: session, stats };
}
