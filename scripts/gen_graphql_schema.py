#!/usr/bin/env python3
"""
Generates GraphQL SDL type definitions and a resolver map from
extracted/entities.json.

Outputs:
    extracted/graphql-typedefs.js  — SDL schema as a JS string export
    extracted/graphql-resolvers.js — Resolver map as a JS export

Run after parse_django_models.py:
    python scripts/parse_django_models.py --force
    python scripts/gen_graphql_schema.py
"""

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENTITIES_PATH = REPO_ROOT / "extracted" / "entities.json"
TYPEDEFS_PATH = REPO_ROOT / "extracted" / "graphql-typedefs.js"
RESOLVERS_PATH = REPO_ROOT / "extracted" / "graphql-resolvers.js"

# ── Type mapping ─────────────────────────────────────────────────────────────

# Maps entities.json field types to GraphQL scalar types.
TYPE_MAP = {
    "string": "String",
    "number": "Int",
    "boolean": "Boolean",
    "datetime": "String",  # ISO 8601 string
    "json": "JSON",
}

# Maps entity tags to GraphQL type names.
# PascalCase, matching the PeeringDB model names.
TAG_TO_TYPE = {
    "org": "Organization",
    "campus": "Campus",
    "fac": "Facility",
    "net": "Network",
    "ix": "Exchange",
    "carrier": "Carrier",
    "carrierfac": "CarrierFacility",
    "ixfac": "ExchangeFacility",
    "ixlan": "ExchangeLan",
    "ixpfx": "ExchangePrefix",
    "poc": "PointOfContact",
    "netfac": "NetworkFacility",
    "netixlan": "NetworkExchangeLan",
}

# Maps entity tags to singular query names.
TAG_TO_SINGULAR = {
    "org": "organization",
    "campus": "campus",
    "fac": "facility",
    "net": "network",
    "ix": "exchange",
    "carrier": "carrier",
    "carrierfac": "carrierFacility",
    "ixfac": "exchangeFacility",
    "ixlan": "exchangeLan",
    "ixpfx": "exchangePrefix",
    "poc": "pointOfContact",
    "netfac": "networkFacility",
    "netixlan": "networkExchangeLan",
}

# Maps entity tags to plural query names.
TAG_TO_PLURAL = {
    "org": "organizations",
    "campus": "campuses",
    "fac": "facilities",
    "net": "networks",
    "ix": "exchanges",
    "carrier": "carriers",
    "carrierfac": "carrierFacilities",
    "ixfac": "exchangeFacilities",
    "ixlan": "exchangeLans",
    "ixpfx": "exchangePrefixes",
    "poc": "pointsOfContact",
    "netfac": "networkFacilities",
    "netixlan": "networkExchangeLans",
}

# Filter operators to generate per field type.
# string: eq, contains, startswith, in
# number: eq, lt, gt, lte, gte, in
# boolean: eq
# datetime: eq, lt, gt, lte, gte
FILTER_OPS = {
    "string":   ["", "_contains", "_startswith", "_in"],
    "number":   ["", "_lt", "_gt", "_lte", "_gte", "_in"],
    "boolean":  [""],
    "datetime": ["", "_lt", "_gt", "_lte", "_gte"],
}


def load_entities():
    """Load and return the entities dict from entities.json."""
    with open(ENTITIES_PATH) as f:
        data = json.load(f)
    return data["entities"]


def gql_type(field_type):
    """Convert an entities.json type to a GraphQL scalar type."""
    return TYPE_MAP.get(field_type, "String")


# ── SDL Generation ───────────────────────────────────────────────────────────

def generate_type(tag, entity):
    """
    Generate a GraphQL type definition for a single entity.

    Each field from entities.json becomes a GraphQL field. Foreign key
    fields get an additional resolved field pointing to the related type
    (e.g. org_id: Int! plus org: Organization).
    """
    type_name = TAG_TO_TYPE[tag]
    lines = [f"type {type_name} {{"]
    lines.append("  id: Int!")
    lines.append('  status: String!')

    for field in entity["fields"]:
        name = field["name"]
        ft = field["type"]
        gt = gql_type(ft)
        nullable = field.get("nullable", False)
        suffix = "" if nullable else "!"

        lines.append(f"  {name}: {gt}{suffix}")

        # For FK fields, add a resolved relationship field
        fk_target = field.get("foreignKey")
        if fk_target and fk_target in TAG_TO_TYPE:
            # Strip _id suffix for the relationship name
            rel_name = name[:-3] if name.endswith("_id") else fk_target
            rel_type = TAG_TO_TYPE[fk_target]
            lines.append(f"  {rel_name}: {rel_type}")

    lines.append("}")
    return "\n".join(lines)


def generate_where_input(tag, entity):
    """
    Generate a WhereInput type for filtering list queries.

    Only queryable fields get filter predicates. The available operators
    depend on the field type (see FILTER_OPS).
    """
    type_name = TAG_TO_TYPE[tag]
    lines = [f"input {type_name}Where {{"]

    for field in entity["fields"]:
        queryable = field.get("queryable", True)
        if not queryable:
            continue

        name = field["name"]
        ft = field["type"]
        gt = gql_type(ft)
        ops = FILTER_OPS.get(ft, [""])

        for op in ops:
            if op == "_in":
                lines.append(f"  {name}{op}: [{gt}]")
            else:
                lines.append(f"  {name}{op}: {gt}")

    # Allow filtering by id
    lines.append("  id: Int")
    lines.append("  id_in: [Int]")

    lines.append("}")
    return "\n".join(lines)


def generate_query_type(entities):
    """
    Generate the root Query type with per-entity singular and list queries.

    Includes a networkByAsn convenience query.
    """
    lines = ["type Query {"]

    for tag in entities:
        type_name = TAG_TO_TYPE[tag]
        singular = TAG_TO_SINGULAR[tag]
        plural = TAG_TO_PLURAL[tag]

        lines.append(f"  {singular}(id: Int!): {type_name}")
        lines.append(f"  {plural}(where: {type_name}Where, limit: Int, skip: Int): [{type_name}!]!")

    # Convenience query for ASN lookup
    lines.append("  networkByAsn(asn: Int!): Network")

    lines.append("}")
    return "\n".join(lines)


def generate_sdl(entities):
    """
    Generate the complete GraphQL SDL schema string.

    Includes a JSON scalar declaration, all entity types, WhereInput
    types, and the root Query type.
    """
    parts = []

    # JSON scalar for json-typed fields
    parts.append("scalar JSON")
    parts.append("")

    for tag, entity in entities.items():
        parts.append(generate_type(tag, entity))
        parts.append("")
        parts.append(generate_where_input(tag, entity))
        parts.append("")

    parts.append(generate_query_type(entities))

    return "\n".join(parts)


# ── Resolver Generation ──────────────────────────────────────────────────────

def generate_resolvers_js(entities):
    """
    Generate the resolver map as a JS module.

    Each resolver translates GraphQL where-args into ParsedFilter arrays,
    then calls buildRowQuery() from the existing query builder. FK fields
    are resolved via simple D1 lookups.
    """
    lines = []
    lines.append('/**')
    lines.append(' * @fileoverview Auto-generated GraphQL resolvers.')
    lines.append(' * Generated by scripts/gen_graphql_schema.py. Do not edit.')
    lines.append(' */')
    lines.append('')
    lines.append("import { ENTITIES } from '../workers/api/entities.js';")
    lines.append("import { buildRowQuery } from '../workers/api/query.js';")
    lines.append('')
    lines.append('/**')
    lines.append(' * Maps a GraphQL operator suffix to the PeeringDB filter operator.')
    lines.append(' * @type {Record<string, string>}')
    lines.append(' */')
    lines.append('const OP_MAP = {')
    lines.append("    '': 'eq',")
    lines.append("    '_lt': 'lt',")
    lines.append("    '_gt': 'gt',")
    lines.append("    '_lte': 'lte',")
    lines.append("    '_gte': 'gte',")
    lines.append("    '_contains': 'contains',")
    lines.append("    '_startswith': 'startswith',")
    lines.append("    '_in': 'in',")
    lines.append('};')
    lines.append('')
    lines.append('/**')
    lines.append(' * Converts GraphQL where-args into an array of ParsedFilter objects')
    lines.append(' * compatible with the existing query builder.')
    lines.append(' *')
    lines.append(' * @param {Record<string, any>} where - GraphQL where input.')
    lines.append(' * @returns {ParsedFilter[]} Parsed filter array.')
    lines.append(' */')
    lines.append('function whereToFilters(where) {')
    lines.append('    if (!where) return [];')
    lines.append('    /** @type {ParsedFilter[]} */')
    lines.append('    const filters = [];')
    lines.append('    for (const [key, value] of Object.entries(where)) {')
    lines.append('        if (value === undefined || value === null) continue;')
    lines.append('        let field = key;')
    lines.append("        let op = 'eq';")
    lines.append('        for (const [suffix, mappedOp] of Object.entries(OP_MAP)) {')
    lines.append("            if (suffix && key.endsWith(suffix)) {")
    lines.append('                field = key.slice(0, -suffix.length);')
    lines.append('                op = mappedOp;')
    lines.append('                break;')
    lines.append('            }')
    lines.append('        }')
    lines.append("        const strVal = op === 'in' && Array.isArray(value)")
    lines.append("            ? value.join(',')")
    lines.append('            : String(value);')
    lines.append('        filters.push({ field, op, value: strVal });')
    lines.append('    }')
    lines.append('    return filters;')
    lines.append('}')
    lines.append('')

    # Build a list resolver factory and a detail resolver factory
    # Shared code fragments used by multiple resolver factories.
    # Extracted here to avoid duplicating string literals.
    RESOLVER_RETURN_DOC = ' * @returns {Function} GraphQL resolver function.'
    BUILD_ROW = '        const { sql, params } = buildRowQuery(entity, filters, opts);'
    EXEC_QUERY = '        const result = await ctx.db.prepare(sql).bind(...params).all();'
    CLOSE_FN = '    };'

    lines.append('/**')
    lines.append(' * Creates a list resolver for the given entity tag.')
    lines.append(' *')
    lines.append(' * @param {string} tag - Entity tag (e.g. "net").')
    lines.append(f' {RESOLVER_RETURN_DOC[2:]}')
    lines.append(' */')
    lines.append('function listResolver(tag) {')
    lines.append('    return async (_parent, args, ctx) => {')
    lines.append('        const entity = ENTITIES[tag];')
    lines.append('        const filters = whereToFilters(args.where);')
    lines.append('        const opts = {')
    lines.append('            depth: 0,')
    lines.append('            limit: Math.min(args.limit ?? 20, 250),')
    lines.append('            skip: args.skip ?? 0,')
    lines.append('            since: 0,')
    lines.append("            sort: '',")
    lines.append('        };')
    lines.append(BUILD_ROW)
    lines.append(EXEC_QUERY)
    lines.append('        return result.results || [];')
    lines.append(CLOSE_FN)
    lines.append('}')
    lines.append('')
    lines.append('/**')
    lines.append(' * Creates a detail resolver for the given entity tag.')
    lines.append(' *')
    lines.append(' * @param {string} tag - Entity tag (e.g. "net").')
    lines.append(f' {RESOLVER_RETURN_DOC[2:]}')
    lines.append(' */')
    lines.append('function detailResolver(tag) {')
    lines.append('    return async (_parent, args, ctx) => {')
    lines.append('        const entity = ENTITIES[tag];')
    lines.append("        const filters = [{ field: 'id', op: 'eq', value: String(args.id) }];")
    lines.append('        const opts = { depth: 0, limit: 1, skip: 0, since: 0, sort: \'\' };')
    lines.append(BUILD_ROW)
    lines.append(EXEC_QUERY)
    lines.append('        return (result.results || [])[0] || null;')
    lines.append(CLOSE_FN)
    lines.append('}')
    lines.append('')

    # FK resolver factory
    lines.append('/**')
    lines.append(' * Creates a foreign-key resolver that loads a related entity by ID.')
    lines.append(' *')
    lines.append(' * @param {string} fkField - The FK field name on the parent (e.g. "org_id").')
    lines.append(' * @param {string} targetTag - Target entity tag (e.g. "org").')
    lines.append(f' {RESOLVER_RETURN_DOC[2:]}')
    lines.append(' */')
    lines.append('function fkResolver(fkField, targetTag) {')
    lines.append('    return async (parent, _args, ctx) => {')
    lines.append('        const id = parent[fkField];')
    lines.append('        if (!id) return null;')
    lines.append('        const entity = ENTITIES[targetTag];')
    lines.append("        const filters = [{ field: 'id', op: 'eq', value: String(id) }];")
    lines.append("        const opts = { depth: 0, limit: 1, skip: 0, since: 0, sort: '' };")
    lines.append(BUILD_ROW)
    lines.append(EXEC_QUERY)
    lines.append('        return (result.results || [])[0] || null;')
    lines.append(CLOSE_FN)
    lines.append('}')
    lines.append('')

    # Build the resolvers object
    lines.append('/** @type {Record<string, any>} */')
    lines.append('export const resolvers = {')

    # Query resolvers
    lines.append('    Query: {')
    for tag in entities:
        singular = TAG_TO_SINGULAR[tag]
        plural = TAG_TO_PLURAL[tag]
        lines.append(f"        {singular}: detailResolver('{tag}'),")
        lines.append(f"        {plural}: listResolver('{tag}'),")

    lines.append("        networkByAsn: async (_parent, args, ctx) => {")
    lines.append("            const entity = ENTITIES['net'];")
    lines.append("            const filters = [{ field: 'asn', op: 'eq', value: String(args.asn) }];")
    lines.append("            const opts = { depth: 0, limit: 1, skip: 0, since: 0, sort: '' };")
    lines.append("            const { sql, params } = buildRowQuery(entity, filters, opts);")
    lines.append("            const result = await ctx.db.prepare(sql).bind(...params).all();")
    lines.append("            return (result.results || [])[0] || null;")
    lines.append("        },")
    lines.append('    },')

    # Type resolvers for FK fields
    for tag, entity in entities.items():
        type_name = TAG_TO_TYPE[tag]
        fk_fields = [f for f in entity["fields"] if "foreignKey" in f]
        if not fk_fields:
            continue

        lines.append(f'    {type_name}: {{')
        for field in fk_fields:
            fk_target = field["foreignKey"]
            if fk_target not in TAG_TO_TYPE:
                continue
            name = field["name"]
            rel_name = name[:-3] if name.endswith("_id") else fk_target
            lines.append(f"        {rel_name}: fkResolver('{name}', '{fk_target}'),")
        lines.append('    },')

    lines.append('};')
    lines.append('')

    return "\n".join(lines)


def main():
    """Main entry point: load entities, generate SDL and resolvers, write files."""
    if not ENTITIES_PATH.exists():
        print(f"Error: {ENTITIES_PATH} not found. Run parse_django_models.py first.", file=sys.stderr)
        sys.exit(1)

    entities = load_entities()

    # Generate SDL
    sdl = generate_sdl(entities)
    typedefs_js = (
        '/**\n'
        ' * @fileoverview Auto-generated GraphQL type definitions.\n'
        ' * Generated by scripts/gen_graphql_schema.py. Do not edit.\n'
        ' */\n\n'
        f'export const typeDefs = /* GraphQL */ `\n{sdl}\n`;\n'
    )
    TYPEDEFS_PATH.write_text(typedefs_js)
    print(f"Wrote {TYPEDEFS_PATH} ({len(typedefs_js):,} bytes)")

    # Generate resolvers
    resolvers_js = generate_resolvers_js(entities)
    RESOLVERS_PATH.write_text(resolvers_js)
    print(f"Wrote {RESOLVERS_PATH} ({len(resolvers_js):,} bytes)")


if __name__ == "__main__":
    main()
