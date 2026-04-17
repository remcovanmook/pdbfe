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
    Build a mapping of parent entities to their child entities based on Foreign Key (FK) declarations.
    
    This function iterates through all fields in `entities.json`. When it encounters a field
    with a `foreignKey` attribute, it records that the current entity is a child of the
    target entity. This mapping is critical for generating GraphQL reverse edges (e.g.,
    allowing a `Network` query to resolve its associated `Facilities`).
    
    Args:
        entities (dict): The dictionary of all loaded entities.
        
    Returns:
        collections.defaultdict: A mapping of `parent_tag` → `[(child_tag, fk_field_name)]`.
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
    Generate the formal GraphQL Type Definition String (SDL) for a single entity.

    Algorithmic Flow:
    1. Base Structure: Asserts foundational fields like `id` and `status`.
    2. Field Mapping: Loops through all `entities.json` fields, mapping native JSON types 
       into strict GraphQL scalar equivalents using `gql_type()`. Handles nullability annotations.
    3. Forward Edges (FK Lookups): When an FK field is detected, dynamically injects a resolver 
       object field to query the parent entity natively (e.g. `org_id` yielding an `org` type).
    4. Reverse Edges (Child Connections): Inspects `reverse_map` to see if any entities 
       point to this entity, and provisions list queries (e.g. `facilities(limit, skip)`) 
       to allow nested hierarchical querying. Prevent collisions by appending suffix if needed.
       
    Args:
        tag (str): The entity tag (e.g., 'net').
        entity (dict): The entity schema definition.
        reverse_map (dict): The map of parent -> child relationships.
        entities (dict): The full dictionary of schemas for lookup validation.
        
    Returns:
        str: A valid, multi-line GraphQL type definition block.
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
    Generate the `WhereInput` GraphQL input type to empower complex filter querying.

    Provides a highly expressive querying DSL. For every field marked `queryable: true`, 
    this calculates the permissible operator suffixes based on the field's data type.
    
    Features built into generated filters:
    - Comparison: `_lt`, `_gt`, `_lte`, `_gte`
    - Inclusion: `_in`, `_notIn`
    - Partial text matching: `_contains`, `_startswith`, `_endswith`
    - Insensitive matching: `_containsFold`, `_equalFold`
    - Negation: `_not`
    - Null checking (implicit): `_isNil` (only appended for fields inherently nullable).
    
    Args:
        entity (dict): The entity payload dict containing its field maps.
        
    Returns:
        str: A valid GraphQL `input` type block utilized as resolver arguments.
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
    Generate Relay-compliant pagination types: `PageInfo`, Connections, and Edges.

    To support high-performance structured pagination across the API without
    depending strictly on integer offsets, this provisions standard cursor wrappers.
    Generates the core `PageInfo` block once, then iterates through every entity
    to generate its explicit `Edge` structure (node + cursor) and `Connection`
    structure (edges + pageInfo + totalCount).
    
    Args:
        entities (dict): The full entity schema.
        
    Returns:
        str: A multi-line string containing all pagination type extensions.
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
    Generate the root `Query` mechanism spanning all known system entities.
    
    Iterates over the global entity framework to expose three core resolver variants
    per entity:
    - Singular Fetch: Get by ID (`network(id: Int!): Network`)
    - Offset/Limit List: Filterable flat fetch (`networks(...): [Network!]!`)
    - Cursor Connection List: Relay fetch with edges/pages (`networksConnection(...): NetworkConnection!`)
    
    Also intelligently binds `aliases` derived from PeeringDB Plus configuration 
    (e.g., exposing `internetExchange` alongside `ix`) and injects hardcoded
    top-tier conveniences like `networkByAsn`.
    
    Args:
        entities (dict): Global namespace object of registered schemas.
        
    Returns:
        str: The monolithic GraphQL `type Query { ... }` block declaration.
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
    Generate the complete GraphQL Schema Definition Language (SDL) string.

    This function coordinates the complete top-to-bottom compilation of the schema:
    1. Base scalars (`JSON`).
    2. Shared pagination architecture (`PageInfo`).
    3. Iterating over all entities to spawn their Input types, native object Types,
       and their connections.
    4. Capping it off with the monolithic `Query` block.
    
    Args:
        entities (dict): The full entity repository.
        reverse_map (dict): The computed parent -> child linkage map.
        
    Returns:
        str: The full raw SDL text, ready to be exported to `graphql-typedefs.js`.
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
    Generates the JavaScript execution Map (`graphql-resolvers.js`) binding GraphQL
    Schema endpoints to physical database extraction queries.

    Instead of appending raw JS strings via Python, this heavily relies on the
    `graphql_resolvers.template.js` template to inject constant utilities. It then
    loops over the system entities rendering specific resolution rules for each:
    - Root Queries (`singular`, `plural`, `connection` patterns).
    - Aliases mapped explicitly alongside root queries.
    - Field Resolvers mapping Object-level FK and Reverse Edges (e.g. `Network.org`
      fetching from `org_id`).
    
    Args:
        entities (dict): The core entity definitions mappings.
        reverse_map (dict): The reverse edge linkages.
        
    Returns:
        str: A syntactically valid JavaScript module exporting `export const resolvers = {...}`.
    """
    lines = []
    template_path = REPO_ROOT / "scripts" / "lib" / "graphql_resolvers.template.js"
    with open(template_path, "r", encoding="utf-8") as f:
        lines.extend(f.read().splitlines())
    lines.append("")
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
    lines.append("            const { sql, params } = buildRowQuery(entity, filters, opts);")
    lines.append("            const result = await ctx.db.prepare(sql).bind(...params).all();")
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
