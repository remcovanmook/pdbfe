/**
 * @fileoverview About page renderer.
 * Describes what pdbfe is, how it differs from the upstream PeeringDB,
 * authentication, API key management, and the applicable policies.
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
                <h2>Authentication</h2>
                <p>
                    You can sign in using your existing PeeringDB account.
                    Click <strong>Sign in with PeeringDB</strong> in the header
                    to authenticate via PeeringDB's OAuth2 flow. No separate
                    registration is required — your PeeringDB credentials are
                    used directly.
                </p>
                <p>
                    Signing in gives you access to contact information (POC data)
                    that is restricted to authenticated users on the upstream
                    PeeringDB. Your session lasts 24 hours.
                </p>
            </section>

            <section class="about-page__section">
                <h2>API Keys</h2>
                <p>
                    Once signed in, you can create API keys for programmatic
                    access to the mirror at
                    <a href="/account" data-link>your account page</a>.
                    These keys are specific to this mirror — upstream PeeringDB
                    API keys are not accepted here.
                </p>
                <p>
                    To use a key, include it in the <code>Authorization</code>
                    header of your API requests:
                </p>
                <pre class="about-page__code"><code>curl -H "Authorization: Api-Key pdbfe.your_key_here" \\
    ${window.location.origin}/api/net?asn=13335</code></pre>
                <p>
                    Keys follow the format <code>pdbfe.&lt;32 hex chars&gt;</code>.
                    You can create up to 5 keys per account. The full key is
                    shown only once at creation — copy it then. You can revoke
                    keys at any time from the account page.
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
                <p>
                    Endpoints available: <code>net</code>, <code>org</code>,
                    <code>fac</code>, <code>ix</code>, <code>ixlan</code>,
                    <code>ixpfx</code>, <code>netixlan</code>,
                    <code>netfac</code>, <code>poc</code>, <code>carrier</code>,
                    <code>carrierfac</code>, <code>ixfac</code>,
                    <code>campus</code>, <code>as_set</code>.
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
