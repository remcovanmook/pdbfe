/**
 * @fileoverview About page renderer.
 * Describes what pdbfe is, how it differs from the upstream PeeringDB,
 * and the applicable policies.
 */

/**
 * Renders the about page into the app container.
 *
 * @param {Record<string, string>} _params - Route params (unused).
 */
export async function renderAbout(_params) {
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    document.title = 'About — PeeringDB Mirror';

    app.innerHTML = `
        <article class="about-page">
            <h1 class="about-page__title">About This Mirror</h1>

            <section class="about-page__section">
                <h2>What is this?</h2>
                <p>
                    This site is a read-only mirror of the
                    <a href="https://www.peeringdb.com" target="_blank" rel="noopener">PeeringDB</a>
                    database. The data is synchronised periodically from the
                    PeeringDB API and served from Cloudflare's edge network for
                    low-latency lookups.
                </p>
                <p>
                    The mirror provides the same REST API interface as the
                    upstream PeeringDB, with the exception of write operations
                    (POST, PUT, PATCH, DELETE), which are not supported.
                    For account management, data submission, or any other write
                    operations, visit
                    <a href="https://www.peeringdb.com" target="_blank" rel="noopener">peeringdb.com</a>.
                </p>
            </section>

            <section class="about-page__section">
                <h2>Data Freshness</h2>
                <p>
                    The database is synchronised incrementally. The sync status
                    is displayed in the footer of every page. Typical sync
                    intervals are on the order of minutes, though delays may
                    occur. This mirror should not be considered authoritative —
                    the canonical source is always
                    <a href="https://www.peeringdb.com" target="_blank" rel="noopener">peeringdb.com</a>.
                </p>
            </section>

            <section class="about-page__section">
                <h2>Acceptable Use</h2>
                <p>
                    All data served by this mirror originates from PeeringDB and
                    is subject to the PeeringDB
                    <a href="https://www.peeringdb.com/aup" target="_blank" rel="noopener">Acceptable Use Policy</a>
                    and
                    <a href="https://docs.peeringdb.com/gov/misc/2017-04-02-PeeringDB_Privacy_Policy.pdf" target="_blank" rel="noopener">Privacy Policy</a>.
                </p>
            </section>

            <section class="about-page__section">
                <h2>API</h2>
                <p>
                    The mirror exposes a PeeringDB-compatible REST API. Example:
                </p>
                <pre class="about-page__code"><code>GET /api/net/694?depth=2</code></pre>
                <p>
                    Supported query parameters include <code>depth</code>,
                    <code>limit</code>, <code>skip</code>, <code>since</code>,
                    and the standard PeeringDB filter suffixes
                    (<code>__contains</code>, <code>__lt</code>,
                    <code>__gt</code>, <code>__in</code>, etc.).
                </p>
            </section>

            <section class="about-page__section">
                <h2>Source Code</h2>
                <p>
                    The code for this mirror is open source.
                    PeeringDB itself is maintained at
                    <a href="https://github.com/peeringdb/peeringdb" target="_blank" rel="noopener">github.com/peeringdb/peeringdb</a>.
                </p>
            </section>
        </article>
    `;
}
