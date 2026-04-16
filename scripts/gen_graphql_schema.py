#!/usr/bin/env python3
"""
Generates GraphQL SDL type definitions and a resolver map from
extracted/entities.json.

Outputs:
    extracted/graphql-typedefs.js  — SDL schema as a JS string export
    extracted/graphql-resolvers.js — Resolver map as a JS export

Features:
    - Per-entity object types with FK fields resolved to related types
    - Reverse edge fields (parent → children) with limit/skip args
    - WhereInput filter types with eq, comparison, pattern, negation,
      and nil operators
    - Relay cursor pagination (Connection/Edge/PageInfo) alongside
      offset/limit list queries
    - Query aliases for PeeringDB Plus naming compatibility
    - networkByAsn convenience query

Run after parse_django_models.py:
    python scripts/parse_django_models.py --force
    python scripts/gen_graphql_schema.py
"""

import json
import sys
from collections import defaultdict
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

# ── Naming helpers ───────────────────────────────────────────────────────────
# All naming (type, singular, plural, aliases) is read from entities.json's
# naming property, which is the single source of truth set by
# parse_django_models.py's ENTITY_NAMING dict.

def _naming(entity):
    """Return the naming dict for an entity, falling back to tag-derived defaults."""
    return entity.get("naming", {})


def _type_name(entity):
    """Return the GraphQL type name for an entity."""
    return _naming(entity).get("type", entity.get("tag", "Unknown"))


def _singular(entity):
    """Return the singular query name for an entity."""
    return _naming(entity).get("singular", entity.get("tag", "unknown"))


def _plural(entity):
    """Return the plural query name for an entity."""
    return _naming(entity).get("plural", entity.get("tag", "unknowns"))


def _aliases(entity):
    """Return the PDB+ aliases dict, or None if no aliases defined."""
    return _naming(entity).get("aliases")

# Filter operators per field type. Includes negation, suffix, and nil
# operators alongside the PeeringDB-compatible set.
FILTER_OPS = {
    "string":   ["", "_contains", "_startswith", "_endswith", "_in",
                 "_not", "_notIn", "_containsFold", "_equalFold"],
    "number":   ["", "_lt", "_gt", "_lte", "_gte", "_in",
                 "_not", "_notIn"],
    "boolean":  [""],
    "datetime": ["", "_lt", "_gt", "_lte", "_gte",
                 "_not"],
}

# Operators that map to a different GraphQL argument type than the
# field's natural type (e.g. _in takes a list, _isNil takes Boolean).
SPECIAL_TYPE_OPS = {"_in", "_notIn"}
NIL_OP = "_isNil"


def load_entities():
    """Load and return the entities dict from entities.json."""
    with open(ENTITIES_PATH) as f:
        data = json.load(f)
    return data["entities"]


def gql_type(field_type):
    """Convert an entities.json type to a GraphQL scalar type."""
    return TYPE_MAP.get(field_type, "String")


def build_reverse_map(entities):
    """
    Build a mapping of parent_tag → [(child_tag, fk_field)] from FK
    declarations in entities.json. Used for reverse edge generation.
    """
    reverse = defaultdict(list)
    for tag, entity in entities.items():
        for field in entity["fields"]:
            fk_target = field.get("foreignKey")
            if fk_target and fk_target in entities:
                reverse[fk_target].append((tag, field["name"]))
    return reverse


# ── SDL Generation ───────────────────────────────────────────────────────────

def generate_type(tag, entity, reverse_map, entities):
    """
    Generate a GraphQL type definition for a single entity.

    Each field from entities.json becomes a GraphQL field. Foreign key
    fields get an additional resolved field pointing to the related type.
    Reverse edges add list fields for child entities.
    """
    type_name = _type_name(entity)
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
        if fk_target and fk_target in entities:
            rel_name = name[:-3] if name.endswith("_id") else fk_target
            rel_type = _type_name(entities[fk_target])
            lines.append(f"  {rel_name}: {rel_type}")

    # Reverse edges: child collections
    child_tags = [c for c, _ in reverse_map.get(tag, [])]
    for child_tag, fk_field in reverse_map.get(tag, []):
        child_type = _type_name(entities[child_tag])
        child_plural = _plural(entities[child_tag])
        if child_tags.count(child_tag) > 1:
            suffix = "By" + "".join(word.capitalize() for word in fk_field.split('_'))
            child_plural += suffix
        lines.append(f"  {child_plural}(limit: Int, skip: Int): [{child_type}!]!")

    lines.append("}")
    return "\n".join(lines)


def generate_where_input(entity):
    """
    Generate a WhereInput type for filtering list queries.

    Only queryable fields get filter predicates. Includes negation,
    suffix, fold, and nil operators alongside the standard set.
    """
    type_name = _type_name(entity)
    lines = [f"input {type_name}Where {{"]

    for field in entity["fields"]:
        if not field.get("queryable", True):
            continue

        name = field["name"]
        ft = field["type"]
        gt = gql_type(ft)
        ops = FILTER_OPS.get(ft, [""])

        for op in ops:
            if op in SPECIAL_TYPE_OPS:
                lines.append(f"  {name}{op}: [{gt}]")
            else:
                lines.append(f"  {name}{op}: {gt}")

        # Nil operator only for nullable fields
        if field.get("nullable", False):
            lines.append(f"  {name}{NIL_OP}: Boolean")

    # Allow filtering by id
    lines.append("  id: Int")
    lines.append("  id_in: [Int]")
    lines.append("  id_not: Int")
    lines.append("  id_notIn: [Int]")

    lines.append("}")
    return "\n".join(lines)


def generate_connection_types(entities):
    """
    Generate Relay-style pagination types: PageInfo and per-entity
    Connection/Edge types.
    """
    parts = []

    # Shared PageInfo
    parts.append("type PageInfo {")
    parts.append("  hasNextPage: Boolean!")
    parts.append("  hasPreviousPage: Boolean!")
    parts.append("  startCursor: String")
    parts.append("  endCursor: String")
    parts.append("}")
    parts.append("")

    for tag in entities:
        type_name = _type_name(entities[tag])

        # Edge type
        parts.append(f"type {type_name}Edge {{")
        parts.append(f"  node: {type_name}!")
        parts.append("  cursor: String!")
        parts.append("}")
        parts.append("")

        # Connection type
        parts.append(f"type {type_name}Connection {{")
        parts.append(f"  edges: [{type_name}Edge!]!")
        parts.append("  pageInfo: PageInfo!")
        parts.append("  totalCount: Int!")
        parts.append("}")
        parts.append("")

    return "\n".join(parts)


def generate_query_type(entities):
    """
    Generate the root Query type with per-entity singular, list, and
    connection queries. Includes aliases for PDB+ naming compatibility
    and the networkByAsn convenience query.
    """
    lines = ["type Query {"]

    for tag in entities:
        entity = entities[tag]
        type_name = _type_name(entity)
        singular = _singular(entity)
        plural = _plural(entity)

        # Detail query
        lines.append(f"  {singular}(id: Int!): {type_name}")

        # Offset/limit list query
        lines.append(f"  {plural}(where: {type_name}Where, limit: Int, skip: Int): [{type_name}!]!")

        # Relay connection query
        lines.append(
            f"  {plural}Connection("
            f"after: String, first: Int, before: String, last: Int, "
            f"orderBy: String, "
            f"where: {type_name}Where"
            f"): {type_name}Connection!"
        )

        # PDB+ naming aliases (only for entities that differ)
        entity_aliases = _aliases(entity)
        if entity_aliases:
            alias_s = entity_aliases.get("singular")
            alias_p = entity_aliases.get("plural")
            if alias_s:
                lines.append(f"  {alias_s}(id: Int!): {type_name}")
            if alias_p:
                lines.append(f"  {alias_p}(where: {type_name}Where, limit: Int, skip: Int): [{type_name}!]!")
                lines.append(
                    f"  {alias_p}Connection("
                    f"after: String, first: Int, before: String, last: Int, "
                    f"orderBy: String, "
                    f"where: {type_name}Where"
                    f"): {type_name}Connection!"
                )

    # Convenience query for ASN lookup
    lines.append("  networkByAsn(asn: Int!): Network")

    # Sync status query
    lines.append("  syncStatus: [SyncStatus!]!")

    lines.append("}")
    return "\n".join(lines)


def generate_sdl(entities, reverse_map):
    """
    Generate the complete GraphQL SDL schema string.

    Includes a JSON scalar, all entity types with reverse edges,
    WhereInput types, Connection/Edge types, and the root Query type.
    """
    parts = []

    # JSON scalar for json-typed fields
    parts.append("scalar JSON")
    parts.append("")

    for tag, entity in entities.items():
        parts.append(generate_type(tag, entity, reverse_map, entities))
        parts.append("")
        parts.append(generate_where_input(entity))
        parts.append("")

    parts.append(generate_connection_types(entities))

    # SyncStatus type
    parts.append("type SyncStatus {")
    parts.append("  entity: String!")
    parts.append("  lastSync: Int!")
    parts.append("  rowCount: Int!")
    parts.append("  updatedAt: String!")
    parts.append("  lastModifiedAt: Int!")
    parts.append("}")
    parts.append("")

    parts.append(generate_query_type(entities))

    return "\n".join(parts)


# ── Resolver Generation ──────────────────────────────────────────────────────

def generate_resolvers_js(entities, reverse_map):
    """
    Generate the resolver map as a JS module.

    Includes list, detail, FK, reverse edge, and connection resolvers.
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

    # Shared code fragments
    RESOLVER_RETURN_DOC = ' * @returns {Function} GraphQL resolver function.'
    BUILD_ROW = '        const { sql, params } = buildRowQuery(entity, filters, opts);'
    EXEC_QUERY = '        const result = await ctx.db.prepare(sql).bind(...params).all();'
    CLOSE_FN = '    };'

    # Common resolver generator string literals
    RES_PARAM_TAG = ' * @param {string} tag - Entity tag (e.g. "net").'
    RES_ASYNC_FN = '    return async (_parent, args, ctx) => {'
    RES_GET_ENT = '        const entity = ENTITIES[tag];'
    RES_OBJ_CLOSE = '        };'

    # ── OP_MAP for whereToFilters ────────────────────────────────────────
    lines.append('/**')
    lines.append(' * Maps a GraphQL operator suffix to the PeeringDB filter operator.')
    lines.append(' * @type {Record<string, string>}')
    lines.append(' */')
    lines.append('const OP_MAP = {')
    op_entries = [
        ("''", "'eq'"),
        ("'_lt'", "'lt'"),
        ("'_gt'", "'gt'"),
        ("'_lte'", "'lte'"),
        ("'_gte'", "'gte'"),
        ("'_contains'", "'contains'"),
        ("'_startswith'", "'startswith'"),
        ("'_endswith'", "'endswith'"),
        ("'_in'", "'in'"),
        ("'_not'", "'not'"),
        ("'_notIn'", "'notin'"),
        ("'_containsFold'", "'contains'"),  # COLLATE NOCASE already on contains
        ("'_equalFold'", "'equalfold'"),
        ("'_isNil'", "'isnil'"),
    ]
    for suffix, op in op_entries:
        lines.append(f"    {suffix}: {op},")
    lines.append('};')
    lines.append('')

    # ── whereToFilters ───────────────────────────────────────────────────
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
    lines.append("    for (const [key, value] of Object.entries(where)) {")
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
    lines.append("        const strVal = (op === 'in' || op === 'notin') && Array.isArray(value)")
    lines.append("            ? value.join(',')")
    lines.append("            : String(value);")
    lines.append('        filters.push({ field, op, value: strVal });')
    lines.append('    }')
    lines.append('    return filters;')
    lines.append('}')
    lines.append('')

    # ── Cursor helpers ───────────────────────────────────────────────────
    lines.append('/**')
    lines.append(' * Encodes a row ID as a Relay-style opaque cursor.')
    lines.append(' * @param {number} id - Row primary key.')
    lines.append(' * @returns {string} Base64-encoded cursor.')
    lines.append(' */')
    lines.append("function encodeCursor(id) { return btoa('id:' + id); }")
    lines.append('')
    lines.append('/**')
    lines.append(' * Decodes a Relay cursor back to a row ID.')
    lines.append(' * @param {string} cursor - Base64-encoded cursor.')
    lines.append(' * @returns {number} Decoded row ID.')
    lines.append(' */')
    lines.append("function decodeCursor(cursor) {")
    lines.append("    const decoded = atob(cursor);")
    lines.append("    return Number.parseInt(decoded.slice(3), 10);")
    lines.append("}")
    lines.append('')

    # ── Resolver factories ───────────────────────────────────────────────
    lines.append('/**')
    lines.append(' * Creates a list resolver for the given entity tag.')
    lines.append(' *')
    lines.append(RES_PARAM_TAG)
    lines.append(f' {RESOLVER_RETURN_DOC[2:]}')
    lines.append(' */')
    lines.append('function listResolver(tag) {')
    lines.append(RES_ASYNC_FN)
    lines.append(RES_GET_ENT)
    lines.append('        const filters = whereToFilters(args.where);')
    lines.append('        const opts = {')
    lines.append('            depth: 0,')
    lines.append('            limit: Math.min(args.limit ?? 20, 250),')
    lines.append('            skip: args.skip ?? 0,')
    lines.append('            since: 0,')
    lines.append("            sort: '',")
    lines.append(RES_OBJ_CLOSE)
    lines.append(BUILD_ROW)
    lines.append(EXEC_QUERY)
    lines.append('        return result.results || [];')
    lines.append(CLOSE_FN)
    lines.append('}')
    lines.append('')

    lines.append('/**')
    lines.append(' * Creates a detail resolver for the given entity tag.')
    lines.append(' *')
    lines.append(RES_PARAM_TAG)
    lines.append(f' {RESOLVER_RETURN_DOC[2:]}')
    lines.append(' */')
    lines.append('function detailResolver(tag) {')
    lines.append(RES_ASYNC_FN)
    lines.append(RES_GET_ENT)
    lines.append("        const filters = [{ field: 'id', op: 'eq', value: String(args.id) }];")
    lines.append("        const opts = { depth: 0, limit: 1, skip: 0, since: 0, sort: '' };")
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

    # Reverse edge resolver factory
    lines.append('/**')
    lines.append(' * Creates a reverse-edge resolver that loads child entities by parent ID.')
    lines.append(' *')
    lines.append(' * @param {string} fkField - The FK field on the child entity (e.g. "org_id").')
    lines.append(' * @param {string} childTag - Child entity tag (e.g. "net").')
    lines.append(f' {RESOLVER_RETURN_DOC[2:]}')
    lines.append(' */')
    lines.append('function reverseEdgeResolver(fkField, childTag) {')
    lines.append('    return async (parent, args, ctx) => {')
    lines.append('        const entity = ENTITIES[childTag];')
    lines.append("        const filters = [{ field: fkField, op: 'eq', value: String(parent.id) }];")
    lines.append('        const opts = {')
    lines.append('            depth: 0,')
    lines.append('            limit: Math.min(args.limit ?? 250, 250),')
    lines.append('            skip: args.skip ?? 0,')
    lines.append('            since: 0,')
    lines.append("            sort: '',")
    lines.append(RES_OBJ_CLOSE)
    lines.append(BUILD_ROW)
    lines.append(EXEC_QUERY)
    lines.append('        return result.results || [];')
    lines.append(CLOSE_FN)
    lines.append('}')
    lines.append('')

    # Connection resolver factory
    lines.append('/**')
    lines.append(' * Creates a Relay connection resolver for the given entity tag.')
    lines.append(' * Supports forward pagination (after + first) and backward (before + last).')
    lines.append(' *')
    lines.append(RES_PARAM_TAG)
    lines.append(f' {RESOLVER_RETURN_DOC[2:]}')
    lines.append(' */')
    lines.append('function connectionResolver(tag) {')
    lines.append(RES_ASYNC_FN)
    lines.append(RES_GET_ENT)
    lines.append('        const filters = whereToFilters(args.where);')
    lines.append('')
    lines.append('        // Count query')
    lines.append("        const countFilters = [...filters, { field: 'status', op: 'eq', value: 'ok' }];")
    lines.append("        const countOpts = { depth: 0, limit: -1, skip: 0, since: 0, sort: '' };")
    lines.append('        const { sql: countSql, params: countParams } = buildRowQuery(entity, countFilters, countOpts);')
    lines.append("        const countSqlWrapped = `SELECT COUNT(*) as cnt FROM (${countSql})`;")
    lines.append('        const countResult = await ctx.db.prepare(countSqlWrapped).bind(...countParams).first();')
    lines.append('        const totalCount = countResult?.cnt ?? 0;')
    lines.append('')
    lines.append('        // Pagination')
    lines.append('        const first = Math.min(args.first ?? 20, 250);')
    lines.append('        if (args.after) {')
    lines.append('            const afterId = decodeCursor(args.after);')
    lines.append("            filters.push({ field: 'id', op: 'gt', value: String(afterId) });")
    lines.append('        }')
    lines.append('        if (args.before) {')
    lines.append('            const beforeId = decodeCursor(args.before);')
    lines.append("            filters.push({ field: 'id', op: 'lt', value: String(beforeId) });")
    lines.append('        }')
    lines.append('')
    lines.append("        const sort = args.orderBy || 'id';")
    lines.append("        const opts = { depth: 0, limit: first + 1, skip: 0, since: 0, sort };")
    lines.append(BUILD_ROW)
    lines.append(EXEC_QUERY)
    lines.append('        const rows = result.results || [];')
    lines.append('        const hasNextPage = rows.length > first;')
    lines.append('        const nodes = hasNextPage ? rows.slice(0, first) : rows;')
    lines.append('')
    lines.append('        const edges = nodes.map(node => ({')
    lines.append('            node,')
    lines.append('            cursor: encodeCursor(node.id),')
    lines.append('        }));')
    lines.append('')
    lines.append('        return {')
    lines.append('            edges,')
    lines.append('            pageInfo: {')
    lines.append('                hasNextPage,')
    lines.append('                hasPreviousPage: !!args.after,')
    lines.append('                startCursor: edges.length > 0 ? edges[0].cursor : null,')
    lines.append('                endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,')
    lines.append('            },')
    lines.append('            totalCount,')
    lines.append(RES_OBJ_CLOSE)
    lines.append(CLOSE_FN)
    lines.append('}')
    lines.append('')

    # ── Build the resolvers object ───────────────────────────────────────
    lines.append('/** @type {Record<string, any>} */')
    lines.append('export const resolvers = {')

    # Query resolvers
    lines.append('    Query: {')
    for tag in entities:
        entity = entities[tag]
        singular = _singular(entity)
        plural = _plural(entity)
        lines.append(f"        {singular}: detailResolver('{tag}'),")
        lines.append(f"        {plural}: listResolver('{tag}'),")
        lines.append(f"        {plural}Connection: connectionResolver('{tag}'),")

        # Aliases
        entity_aliases = _aliases(entity)
        if entity_aliases:
            alias_s = entity_aliases.get("singular")
            alias_p = entity_aliases.get("plural")
            if alias_s:
                lines.append(f"        {alias_s}: detailResolver('{tag}'),")
            if alias_p:
                lines.append(f"        {alias_p}: listResolver('{tag}'),")
                lines.append(f"        {alias_p}Connection: connectionResolver('{tag}'),")

    lines.append("        networkByAsn: async (_parent, args, ctx) => {")
    lines.append("            const entity = ENTITIES['net'];")
    lines.append("            const filters = [{ field: 'asn', op: 'eq', value: String(args.asn) }];")
    lines.append("            const opts = { depth: 0, limit: 1, skip: 0, since: 0, sort: '' };")
    lines.append(BUILD_ROW)
    lines.append(EXEC_QUERY)
    lines.append("            return (result.results || [])[0] || null;")
    lines.append("        },")
    lines.append("        syncStatus: async (_parent, _args, ctx) => {")
    lines.append("            const result = await ctx.db.prepare(")
    lines.append("                'SELECT entity, last_sync AS lastSync, row_count AS rowCount, '")
    lines.append("                + 'updated_at AS updatedAt, last_modified_at AS lastModifiedAt '")
    lines.append("                + 'FROM _sync_meta ORDER BY entity'")
    lines.append("            ).all();")
    lines.append("            return result.results || [];")
    lines.append("        },")
    lines.append('    },')

    # Type resolvers for FK fields + reverse edges
    for tag, entity in entities.items():
        type_name = _type_name(entity)
        fk_fields = [f for f in entity["fields"] if "foreignKey" in f]
        rev_edges = reverse_map.get(tag, [])

        if not fk_fields and not rev_edges:
            continue

        lines.append(f'    {type_name}: {{')

        # Forward FK resolvers
        for field in fk_fields:
            fk_target = field["foreignKey"]
            if fk_target not in entities:
                continue
            name = field["name"]
            rel_name = name[:-3] if name.endswith("_id") else fk_target
            lines.append(f"        {rel_name}: fkResolver('{name}', '{fk_target}'),")

        # Reverse edge resolvers
        child_tags = [c for c, _ in rev_edges]
        for child_tag, fk_field in rev_edges:
            plural = _plural(entities[child_tag])
            if child_tags.count(child_tag) > 1:
                suffix = "By" + "".join(word.capitalize() for word in fk_field.split('_'))
                plural += suffix
            lines.append(f"        {plural}: reverseEdgeResolver('{fk_field}', '{child_tag}'),")

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
    reverse_map = build_reverse_map(entities)

    # Generate SDL
    sdl = generate_sdl(entities, reverse_map)
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
    resolvers_js = generate_resolvers_js(entities, reverse_map)
    RESOLVERS_PATH.write_text(resolvers_js)
    print(f"Wrote {RESOLVERS_PATH} ({len(resolvers_js):,} bytes)")


if __name__ == "__main__":
    main()
