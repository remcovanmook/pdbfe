/**
 * @fileoverview Natural-language query parser for PeeringDB graph search.
 *
 * Decomposes a raw query string into typed predicates consumed by
 * graph-search.js. Uses rule-based pattern matching only — no external AI
 * or NLP library is required.
 *
 * Recognised predicate types (applied in priority order):
 *
 *   asn            — exact AS number extraction
 *   infoType       — network info_type category (CDN, transit, etc.)
 *   regionContinent— continent/region name
 *   country        — ISO 3166-1 alpha-2 country code
 *   city           — city name (preposition-anchored)
 *   similarToName  — entity name the user wants structurally similar results for
 *   anchorName     — named entity to traverse from (peering, presence, membership)
 *   traversalIntent— direction of traversal from the anchor: 'networks_at',
 *                    'facilities_at', 'exchanges_at', 'members_of'
 *   raw            — original query, used as keyword-search fallback
 *
 * Each exported function is pure; no I/O or module-level mutable state.
 */

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

/**
 * Common country names → ISO 3166-1 alpha-2 code.
 * Covers the bulk of PeeringDB-active nations; extend as needed.
 *
 * @type {Record<string, string>}
 */
const COUNTRY_NAME_TO_ISO2 = {
    'united states': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
    'united kingdom': 'GB', 'uk': 'GB', 'britain': 'GB', 'england': 'GB',
    'germany': 'DE', 'deutschland': 'DE',
    'netherlands': 'NL', 'holland': 'NL',
    'france': 'FR',
    'japan': 'JP',
    'australia': 'AU',
    'canada': 'CA',
    'switzerland': 'CH',
    'sweden': 'SE',
    'norway': 'NO',
    'denmark': 'DK',
    'finland': 'FI',
    'poland': 'PL',
    'spain': 'ES',
    'italy': 'IT',
    'portugal': 'PT',
    'belgium': 'BE',
    'austria': 'AT',
    'czech republic': 'CZ', 'czechia': 'CZ',
    'hungary': 'HU',
    'romania': 'RO',
    'russia': 'RU',
    'ukraine': 'UA',
    'turkey': 'TR',
    'israel': 'IL',
    'india': 'IN',
    'china': 'CN',
    'singapore': 'SG',
    'hong kong': 'HK',
    'south korea': 'KR', 'korea': 'KR',
    'taiwan': 'TW',
    'brazil': 'BR',
    'argentina': 'AR',
    'mexico': 'MX',
    'south africa': 'ZA',
    'nigeria': 'NG',
    'kenya': 'KE',
    'new zealand': 'NZ',
    'indonesia': 'ID',
    'malaysia': 'MY',
    'thailand': 'TH',
    'philippines': 'PH',
    'vietnam': 'VN',
    'uae': 'AE', 'united arab emirates': 'AE',
    'saudi arabia': 'SA',
    'egypt': 'EG',
    'greece': 'GR',
    'ireland': 'IE',
    'luxembourg': 'LU',
    'iceland': 'IS',
};

/**
 * Continent / region names → peeringdb region_continent values.
 * Case-insensitive during matching.
 *
 * @type {Record<string, string>}
 */
const REGION_NAME_TO_VALUE = {
    'europe': 'Europe',
    'european': 'Europe',
    'north america': 'North America',
    'north american': 'North America',
    'asia': 'Asia Pacific',
    'asia pacific': 'Asia Pacific',
    'apac': 'Asia Pacific',
    'south america': 'South America',
    'latin america': 'South America',
    'africa': 'Africa',
    'middle east': 'Middle East',
    'oceania': 'Oceania',
    'australia': 'Oceania',
};

/**
 * Terms that indicate a network info_type value.
 * The first matching key wins; keys are lowercased for comparison.
 *
 * @type {Array<[string, string]>}
 */
const INFO_TYPE_TERMS = [
    ['route server',     'Route Server'],
    ['route-server',     'Route Server'],
    ['cdn',              'Content'],
    ['content network',  'Content'],
    ['content delivery', 'Content'],
    ['transit',          'NSP'],
    ['tier 1',           'NSP'],
    ['tier1',            'NSP'],
    ['backbone',         'NSP'],
    ['enterprise',       'Enterprise'],
    ['educational',      'Educational'],
    ['non-profit',       'Non-Profit'],
    ['nonprofit',        'Non-Profit'],
    ['government',       'Government'],
    ['military',         'Government'],
    ['ixp',              'IXP'],
    ['exchange operator','IXP'],
    ['nsp',              'NSP'],
    ['hosting',          'Hosting and Co-Location'],
    ['colocation',       'Hosting and Co-Location'],
    ['colo',             'Hosting and Co-Location'],
];

/**
 * Preposition phrases that introduce a city or location anchor.
 * Used to extract the anchor name from traversal-style queries.
 *
 * @type {string[]}
 */
const LOCATION_PREPS = ['in ', 'at ', 'near ', 'around ', 'from '];

/**
 * Words that suggest "find entities present at / connected to Y"
 * rather than "find entities similar to Y".
 *
 * @type {Set<string>}
 */
const TRAVERSAL_VERBS = new Set([
    'at', 'in', 'member', 'members', 'peering', 'connected', 'present',
    'located', 'hosted', 'collocated', 'collocated', 'present',
]);

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

/**
 * Matches standalone AS numbers: AS15169, ASN15169, AS 15169, ASN 15169.
 * Capturing group 1 is the numeric portion.
 */
const ASN_RE = /\basn?\s*(\d+)\b/i;

/**
 * Matches "similar to <name>" or "like <name>".
 * Capturing group 1 is the reference entity name.
 */
const SIMILAR_RE = /\b(?:similar\s+to|like)\s+(.+?)(?:\s+(?:in|at|from|near)\b.*)?$/i;

/**
 * Matches "peers of <name>", "members of <name>", "peering with <name>",
 * "connected to <name>", "networks at <name>", "present at <name>".
 * Capturing group 1 is the anchor entity name.
 */
const TRAVERSAL_RE = /\b(?:peers?\s+of|members?\s+of|peering\s+with|connected\s+to|present\s+at|at|member\s+of)\s+(.+?)(?:\s*$)/i;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to extract an ISO 3166-1 alpha-2 country code from the
 * lowercased query. Tries a preposition-anchored country name first
 * ("in Germany", "from Netherlands"), then a standalone match.
 *
 * @param {string} lower - Lowercased query string.
 * @returns {string|null} ISO-2 code, or null if none found.
 */
function extractCountry(lower) {
    // Try preposition-anchored country names first (longest first to avoid
    // "South America" being matched as "America").
    const sortedNames = Object.keys(COUNTRY_NAME_TO_ISO2).sort((a, b) => b.length - a.length);
    for (const name of sortedNames) {
        for (const prep of ['in ', 'from ', 'at ']) {
            if (lower.includes(prep + name)) {
                return COUNTRY_NAME_TO_ISO2[name];
            }
        }
    }
    // Standalone match (last resort — more likely to produce false positives).
    for (const name of sortedNames) {
        if (name.length < 4) continue; // skip short codes like 'us'
        if (lower.includes(name)) return COUNTRY_NAME_TO_ISO2[name];
    }
    return null;
}

/**
 * Attempts to extract a continent/region value from the lowercased query.
 *
 * @param {string} lower - Lowercased query string.
 * @returns {string|null} Continent value, or null if none found.
 */
function extractRegion(lower) {
    const sortedNames = Object.keys(REGION_NAME_TO_VALUE).sort((a, b) => b.length - a.length);
    for (const name of sortedNames) {
        if (lower.includes(name)) return REGION_NAME_TO_VALUE[name];
    }
    return null;
}

/**
 * Extracts a city name anchored by a location preposition.
 *
 * Heuristic: takes the two words following "in / at / near" if they start
 * with an uppercase letter in the original query (indicating a proper noun).
 * Returns only the city portion, not the surrounding context.
 *
 * @param {string} original - Original (cased) query string.
 * @returns {string|null} City name, or null if none detected.
 */
function extractCity(original) {
    const lc = original.toLowerCase();
    for (const prep of LOCATION_PREPS) {
        const idx = lc.indexOf(prep);
        if (idx === -1) continue;
        // Extract up to two words after the preposition from the original string.
        const after = original.slice(idx + prep.length).trim();
        const words = after.split(/\s+/);
        let city = '';
        for (const word of words) {
            // Stop at lower-case connectors: 'and', 'or', 'with', prepositions.
            if (word.length > 0 && word[0] === word[0].toUpperCase() && /^[A-Za-z]/.test(word)) {
                city += (city ? ' ' : '') + word;
                if (city.split(' ').length >= 2) break;
            } else {
                break;
            }
        }
        if (city.length > 2) return city;
    }
    return null;
}

/**
 * Extracts a PeeringDB info_type value from the lowercased query.
 *
 * @param {string} lower - Lowercased query string.
 * @returns {string|null} info_type value string, or null if not matched.
 */
function extractInfoType(lower) {
    for (const [term, value] of INFO_TYPE_TERMS) {
        if (lower.includes(term)) return value;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ParsedQuery
 * @property {number|null}  asn             - Extracted AS number, or null.
 * @property {string|null}  country         - ISO-2 country code, or null.
 * @property {string|null}  city            - City name, or null.
 * @property {string|null}  regionContinent - Continent value, or null.
 * @property {string|null}  infoType        - Network info_type value, or null.
 * @property {string|null}  similarToName   - Reference entity name for kNN, or null.
 * @property {string|null}  anchorName      - Named anchor entity for traversal, or null.
 * @property {string|null}  traversalIntent - One of: 'networks_at', 'facilities_at',
 *                                            'exchanges_at', 'members_of', or null.
 * @property {string}       raw             - Original, untransformed query string.
 */

/**
 * Parses a natural language PeeringDB query into structured predicates.
 *
 * Extraction runs in priority order: ASN → info_type → region → country → city
 * → similarity → traversal. Each step operates on the lowercased query.
 * The original casing is preserved in the `raw` and `city` fields where
 * proper-noun capitalisation matters for D1 LIKE matching.
 *
 * @param {string} q - Raw user query string.
 * @returns {ParsedQuery} Extracted predicates.
 */
export function parseQuery(q) {
    const lower = q.toLowerCase().trim();

    /** @type {ParsedQuery} */
    const result = {
        asn:             null,
        country:         null,
        city:            null,
        regionContinent: null,
        infoType:        null,
        similarToName:   null,
        anchorName:      null,
        traversalIntent: null,
        raw:             q,
    };

    // 1. ASN — most specific; short-circuits most other extraction.
    const asnMatch = ASN_RE.exec(q);
    if (asnMatch) {
        result.asn = parseInt(asnMatch[1], 10);
        return result; // ASN lookup is always exact; nothing else needed.
    }

    // 2. Info type.
    result.infoType = extractInfoType(lower);

    // 3. Region / continent.
    result.regionContinent = extractRegion(lower);

    // 4. Country — skip if a region was matched (avoids double-filtering).
    if (!result.regionContinent) {
        result.country = extractCountry(lower);
    }

    // 5. City.
    result.city = extractCity(q);

    // 6. Structural similarity intent ("similar to X", "like X").
    const simMatch = SIMILAR_RE.exec(q);
    if (simMatch) {
        result.similarToName = simMatch[1].trim();
        return result;
    }

    // 7. Traversal intent ("peers of X", "networks at AMS-IX", etc.).
    const travMatch = TRAVERSAL_RE.exec(q);
    if (travMatch) {
        result.anchorName = travMatch[1].trim();
        // Infer traversal direction from context in the leading portion of the query.
        const before = lower.slice(0, travMatch.index);
        if (before.includes('network') || before.includes('isp') || before.includes('peer')) {
            result.traversalIntent = 'networks_at';
        } else if (before.includes('facilit') || before.includes('datacenter') || before.includes('colo')) {
            result.traversalIntent = 'facilities_at';
        } else if (before.includes('exchange') || before.includes(' ix') || before.includes('ixp')) {
            result.traversalIntent = 'exchanges_at';
        } else if (before.includes('member')) {
            result.traversalIntent = 'members_of';
        } else {
            // Default: interpret "at X" as "networks at X" (most common intent).
            result.traversalIntent = 'networks_at';
        }
    }

    return result;
}
