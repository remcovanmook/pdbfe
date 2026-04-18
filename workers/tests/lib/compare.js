/**
 * @fileoverview Structural JSON comparison engine.
 *
 * Recursively compares two JSON object trees and reports path-level
 * differences in field names, value types, and nesting depth. Values
 * themselves are not compared — only shape matters.
 *
 * Ported from peeringdb-plus/internal/conformance/compare.go.
 *
 * @module tests/lib/compare
 */

/**
 * @typedef {Object} Difference
 * @property {string} path  - Dot-separated JSON path (e.g. "data[0].net_set[0].asn").
 * @property {string} kind  - One of "missing_field", "extra_field", "type_mismatch".
 * @property {string} details - Human-readable description of the divergence.
 */

/**
 * Returns the JSON type name for a decoded JS value.
 *
 * Maps null → "null", booleans → "bool", numbers → "number",
 * strings → "string", arrays → "array", plain objects → "object".
 *
 * @param {any} v - A value produced by JSON.parse.
 * @returns {string} The JSON type name.
 */
export function jsonType(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') return 'string';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'object') return 'object';
    return `unknown(${typeof v})`;
}

/**
 * Builds a dot-separated JSON path from a prefix and a key.
 *
 * @param {string} prefix - The path so far (empty string for root).
 * @param {string} key    - The field name to append.
 * @returns {string} The combined path.
 */
function joinPath(prefix, key) {
    return prefix ? `${prefix}.${key}` : key;
}

/**
 * Compares two JS values structurally, recursing into objects and
 * probing arrays via their first element.
 *
 * Null is compatible with any type — a field that is null in one
 * response and populated in the other does not constitute a type
 * mismatch (PeeringDB has many nullable fields).
 *
 * @param {string} path   - Current JSON path for error reporting.
 * @param {any}    refVal - Reference value.
 * @param {any}    actVal - Actual value.
 * @returns {Difference[]} Structural differences found.
 */
function compareValues(path, refVal, actVal) {
    const refType = jsonType(refVal);
    const actType = jsonType(actVal);

    // Null is compatible with any type.
    if (refType === 'null' || actType === 'null') return [];

    if (refType !== actType) {
        return [{
            path,
            kind: 'type_mismatch',
            details: `reference type "${refType}", actual type "${actType}"`,
        }];
    }

    // Recurse into nested objects.
    if (refType === 'object') {
        return compareStructureInternal(path, refVal, actVal);
    }

    // Compare array element structure using first element.
    if (refType === 'array' && refVal.length > 0 && actVal.length > 0) {
        return compareValues(`${path}[0]`, refVal[0], actVal[0]);
    }

    return [];
}

/**
 * Recursively compares two plain objects, reporting missing fields,
 * extra fields, and type mismatches at each key.
 *
 * @param {string} prefix    - Dot-separated path prefix.
 * @param {Record<string, any>} reference - The reference object.
 * @param {Record<string, any>} actual    - The actual object.
 * @returns {Difference[]} Structural differences found.
 */
function compareStructureInternal(prefix, reference, actual) {
    /** @type {Difference[]} */
    const diffs = [];

    for (const key of Object.keys(reference)) {
        const path = joinPath(prefix, key);
        if (!(key in actual)) {
            diffs.push({
                path,
                kind: 'missing_field',
                details: 'field present in reference but missing in actual',
            });
            continue;
        }
        diffs.push(...compareValues(path, reference[key], actual[key]));
    }

    for (const key of Object.keys(actual)) {
        if (!(key in reference)) {
            diffs.push({
                path: joinPath(prefix, key),
                kind: 'extra_field',
                details: 'field present in actual but missing in reference',
            });
        }
    }

    return diffs;
}

/**
 * Compares the JSON structure of two objects. Reports missing fields,
 * extra fields, and type mismatches at every level of the tree.
 * Results are sorted by path for deterministic output.
 *
 * @param {Record<string, any>} reference - The reference object tree.
 * @param {Record<string, any>} actual    - The actual object tree.
 * @returns {Difference[]} Sorted list of structural differences.
 */
export function compareStructure(reference, actual) {
    const diffs = compareStructureInternal('', reference, actual);
    diffs.sort((a, b) => a.path.localeCompare(b.path));
    return diffs;
}

/**
 * Convenience wrapper that parses two JSON byte strings and compares
 * their structures. Returns an empty array when shapes match.
 *
 * @param {string} referenceJSON - Reference JSON string.
 * @param {string} actualJSON   - Actual JSON string.
 * @returns {Difference[]} Sorted list of structural differences.
 */
export function compareResponses(referenceJSON, actualJSON) {
    const ref = JSON.parse(referenceJSON);
    const act = JSON.parse(actualJSON);
    return compareStructure(ref, act);
}
