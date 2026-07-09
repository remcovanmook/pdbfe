/**
 * @fileoverview GraphQL query-complexity guards.
 *
 * The GraphQL endpoint is unauthenticated and resolves foreign-key traversals
 * across the whole dataset, so a single deeply-nested or alias-amplified query
 * can fan out expensive resolver work. These validation rules bound both the
 * nesting DEPTH and the total FIELD count of an operation (fragments resolved,
 * cycles guarded) and reject anything past the limits before execution.
 *
 * Implemented as a graphql validation rule (no runtime cost beyond the normal
 * validation pass, no new dependency).
 */

import { GraphQLError } from 'graphql';

/** Max selection-set nesting depth. Legitimate pdbfe queries are ~4-6 deep. */
export const MAX_QUERY_DEPTH = 12;

/** Max total resolved fields in one operation (bounds alias amplification). */
export const MAX_QUERY_FIELDS = 1000;

/**
 * Measures the depth and total field count of a selection set, resolving
 * fragment spreads (with a cycle guard so a cyclic fragment can't recurse
 * forever — graphql's own NoFragmentCycles rule may not have run yet).
 *
 * @param {import('graphql').SelectionSetNode} selectionSet
 * @param {Record<string, import('graphql').FragmentDefinitionNode>} fragments
 * @param {Set<string>} visiting - Fragment names on the current spread path.
 * @returns {{depth: number, fields: number}}
 */
function measure(selectionSet, fragments, visiting) {
    let depth = 0;
    let fields = 0;
    for (const sel of selectionSet.selections) {
        if (sel.kind === 'Field') {
            fields += 1;
            if (sel.selectionSet) {
                const sub = measure(sel.selectionSet, fragments, visiting);
                fields += sub.fields;
                depth = Math.max(depth, 1 + sub.depth);
            }
        } else if (sel.kind === 'InlineFragment') {
            if (sel.selectionSet) {
                const sub = measure(sel.selectionSet, fragments, visiting);
                fields += sub.fields;
                depth = Math.max(depth, sub.depth);
            }
        } else if (sel.kind === 'FragmentSpread') {
            const name = sel.name.value;
            if (visiting.has(name)) continue; // cycle guard
            const frag = fragments[name];
            if (frag) {
                visiting.add(name);
                const sub = measure(frag.selectionSet, fragments, visiting);
                visiting.delete(name);
                fields += sub.fields;
                depth = Math.max(depth, sub.depth);
            }
        }
    }
    return { depth, fields };
}

/**
 * Builds a graphql validation rule that rejects operations exceeding the depth
 * or field-count limits.
 *
 * @param {{maxDepth?: number, maxFields?: number}} [opts]
 * @returns {import('graphql').ValidationRule}
 */
export function createComplexityRule({ maxDepth = MAX_QUERY_DEPTH, maxFields = MAX_QUERY_FIELDS } = {}) {
    return function ComplexityRule(context) {
        /** @type {Record<string, import('graphql').FragmentDefinitionNode>} */
        const fragments = {};
        return {
            Document(node) {
                for (const def of node.definitions) {
                    if (def.kind === 'FragmentDefinition') fragments[def.name.value] = def;
                }
            },
            OperationDefinition(node) {
                const { depth, fields } = measure(node.selectionSet, fragments, new Set());
                if (depth > maxDepth) {
                    context.reportError(new GraphQLError(
                        `Query is too deeply nested (depth ${depth} exceeds maximum of ${maxDepth}).`,
                        { nodes: [node] }
                    ));
                }
                if (fields > maxFields) {
                    context.reportError(new GraphQLError(
                        `Query selects too many fields (${fields} exceeds maximum of ${maxFields}).`,
                        { nodes: [node] }
                    ));
                }
            },
        };
    };
}

/**
 * graphql-yoga / envelop plugin that registers the complexity rule for every
 * request via the onValidate hook.
 * @type {{onValidate: (ctx: {addValidationRule: (rule: import('graphql').ValidationRule) => void}) => void}}
 */
export const complexityPlugin = {
    onValidate({ addValidationRule }) {
        addValidationRule(createComplexityRule());
    },
};
