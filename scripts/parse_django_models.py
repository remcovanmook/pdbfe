#!/usr/bin/env python3
"""
Upstream schema pipeline: extracts PeeringDB entity definitions.

Combines two upstream inputs:
  1. django-peeringdb abstract.py + concrete.py (parsed via Python AST)
     → field names, types, nullability, table names, API tags, FK relationships
  2. PeeringDB OpenAPI api-schema.yaml (parsed via pyyaml)
     → queryable fields, restricted/anonFilter, API-injected fields

Outputs to the extracted/ directory:
  - extracted/entities.json   — consolidated entity definitions
  - extracted/schema.sql      — D1 CREATE TABLE statements
  - extracted/src/            — cached upstream source files (gitignored)

Both entities.json and schema.sql are consumed by the API worker and
frontend respectively.

Requires pyyaml (install via: .venv/bin/pip install pyyaml).

Usage:
    .venv/bin/python scripts/parse_django_models.py [--force]

    --force     Re-generate even if upstream versions haven't changed.
"""

import ast
import json
import sys
import urllib.request
from pathlib import Path

try:
    import yaml
except ImportError:
    print("pyyaml required. Install via: .venv/bin/pip install pyyaml")
    sys.exit(1)

# ── Configuration ────────────────────────────────────────────────────────────

DJANGO_PEERINGDB_REPO = "peeringdb/django-peeringdb"
DJANGO_PEERINGDB_BRANCHES = ["main", "master"]
PEERINGDB_REPO = "peeringdb/peeringdb"
PEERINGDB_BRANCHES = ["master", "main"]


def _raw_url(repo, branch, path):
    """Build a raw.githubusercontent.com URL."""
    return f"https://raw.githubusercontent.com/{repo}/{branch}/{path}"


DJANGO_PEERINGDB_FILES = [
    "src/django_peeringdb/models/abstract.py",
    "src/django_peeringdb/models/concrete.py",
]
DJANGO_PEERINGDB_TAGS_URL = (
    f"https://api.github.com/repos/{DJANGO_PEERINGDB_REPO}/tags?per_page=1"
)
PEERINGDB_VERSION_PATH = "Ctl/VERSION"
API_SCHEMA_URL_TEMPLATE = "https://www.peeringdb.com/s/{version}/api-schema.yaml"

# Django field type → our simplified type system
FIELD_TYPE_MAP = {
    "CharField": "string",
    "TextField": "string",
    "EmailField": "string",
    "URLField": "string",
    "LG_URLField": "string",
    "CountryField": "string",
    "MacAddressField": "string",
    "IPAddressField": "string",
    "IPPrefixField": "string",
    "IntegerField": "number",
    "PositiveIntegerField": "number",
    "ASNField": "number",
    "DecimalField": "number",
    "BooleanField": "boolean",
    "DateTimeField": "datetime",
    "JSONField": "json",
    "MultipleChoiceField": "json",
    "ForeignKey": "foreignkey",
}

TABLE_PREFIX = "peeringdb_"


# ── HTTP helpers ─────────────────────────────────────────────────────────────

def fetch_url(url):
    """Fetch a URL and return its content as a string."""
    req = urllib.request.Request(url, headers={"User-Agent": "pdbfe-sync/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def fetch_with_branch_fallback(repo, branches, path):
    """
    Fetch a file from a GitHub repo, trying each branch name in order.

    This guards against upstream branch renames (e.g. master → main).
    Returns the content string. Raises on failure if all branches 404.
    """
    last_err = None
    for branch in branches:
        url = _raw_url(repo, branch, path)
        try:
            return fetch_url(url)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                last_err = e
                continue
            raise
    raise last_err or RuntimeError(f"Could not fetch {path} from {repo}")


def fetch_latest_django_peeringdb_tag():
    """
    Fetch the latest release tag from the django-peeringdb GitHub repo.

    Returns the tag name string (e.g. '3.7.0').
    """
    data = json.loads(fetch_url(DJANGO_PEERINGDB_TAGS_URL))
    if data and isinstance(data, list) and len(data) > 0:
        return data[0].get("name", "unknown")
    return "unknown"


def fetch_peeringdb_version():
    """
    Fetch the PeeringDB server version from the Ctl/VERSION file.

    Tries each branch in PEERINGDB_BRANCHES to handle renames.
    Returns a version string (e.g. '2.77.1').
    """
    return fetch_with_branch_fallback(
        PEERINGDB_REPO, PEERINGDB_BRANCHES, PEERINGDB_VERSION_PATH
    ).strip()


# ── AST parsing helpers ──────────────────────────────────────────────────────

def _get_attr_chain(node):
    """
    Convert a nested ast.Attribute node into a dotted string.

    Example: models.CharField → 'models.CharField'
    """
    if isinstance(node, ast.Attribute):
        parent = _get_attr_chain(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    if isinstance(node, ast.Name):
        return node.id
    return None


def _resolve_field_type(call_node):
    """
    Given a field assignment's Call node, resolve the Django field type.

    Handles both qualified calls (models.CharField(...)) and local names
    (URLField(...), ASNField(...)).
    """
    func_name = _get_attr_chain(call_node.func) if isinstance(call_node.func, ast.Attribute) else None
    if func_name is None and isinstance(call_node.func, ast.Name):
        func_name = call_node.func.id

    if func_name is None:
        return None

    short = func_name.split(".")[-1]
    return FIELD_TYPE_MAP.get(short)


def _has_kwarg(call_node, name, value=True):
    """Check whether a Call node has keyword arg `name` set to `value`."""
    for kw in call_node.keywords:
        if kw.arg == name:
            if isinstance(kw.value, ast.Constant):
                return kw.value.value == value
            if isinstance(kw.value, ast.NameConstant):  # Python 3.7 compat
                return kw.value.value == value
    return False


def _get_fk_target(call_node):
    """
    Extract the FK target model name from a ForeignKey(...) call.

    The first positional arg is the target class name.
    """
    if call_node.args:
        arg = call_node.args[0]
        if isinstance(arg, ast.Name):
            return arg.id
    return None


# ── Class-level parsing ──────────────────────────────────────────────────────

def _parse_inner_class(class_node, name):
    """Find an inner class by name (e.g. 'Meta', 'HandleRef') in a ClassDef."""
    for item in class_node.body:
        if isinstance(item, ast.ClassDef) and item.name == name:
            return item
    return None


def _parse_meta_db_table(meta_node):
    """
    Extract db_table from a Meta class.

    Handles the f-string pattern: db_table = f"{settings.TABLE_PREFIX}network"
    """
    if meta_node is None:
        return None
    for item in meta_node.body:
        if isinstance(item, ast.Assign):
            for target in item.targets:
                if isinstance(target, ast.Name) and target.id == "db_table":
                    if isinstance(item.value, ast.JoinedStr):
                        suffix = ""
                        for v in item.value.values:
                            if isinstance(v, ast.Constant):
                                suffix += v.value
                        return TABLE_PREFIX + suffix
                    if isinstance(item.value, ast.Constant) and isinstance(item.value.value, str):
                        return item.value.value
    return None


def _parse_handleref_tag(hr_node):
    """Extract the HandleRef tag string from a HandleRef inner class."""
    if hr_node is None:
        return None
    for item in hr_node.body:
        if isinstance(item, ast.Assign):
            for target in item.targets:
                if isinstance(target, ast.Name) and target.id == "tag":
                    if isinstance(item.value, ast.Constant):
                        return item.value.value
    return None


def _has_base_class(class_node, name):
    """Check if a class inherits from a given base class name."""
    for base in class_node.bases:
        if isinstance(base, ast.Name) and base.id == name:
            return True
        if isinstance(base, ast.Attribute) and base.attr == name:
            return True
    return False


def _parse_fields_from_class(class_node):
    """
    Extract field definitions from class-level annotated and simple assignments.

    Handles patterns like:
        name: models.CharField = models.CharField(...)
        social_media = models.JSONField(...)
    """
    fields = []
    for item in class_node.body:
        field_name = None
        call_node = None

        if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
            field_name = item.target.id
            if isinstance(item.value, ast.Call):
                call_node = item.value
        elif isinstance(item, ast.Assign) and len(item.targets) == 1:
            target = item.targets[0]
            if isinstance(target, ast.Name) and isinstance(item.value, ast.Call):
                field_name = target.id
                call_node = item.value

        if field_name is None or call_node is None:
            continue
        if field_name.startswith("_"):
            continue

        field_type = _resolve_field_type(call_node)
        if field_type is None:
            continue
        if field_type == "foreignkey":
            continue  # handled in concrete.py parsing

        field_def = {"name": field_name, "type": field_type}
        if _has_kwarg(call_node, "null", True):
            field_def["nullable"] = True
        fields.append(field_def)

    return fields


# ── Django model parsing ─────────────────────────────────────────────────────

def parse_abstract_models(source):
    """
    Parse abstract.py and extract base model definitions.

    Returns a dict mapping base class name → {tag, table, address, fields}.
    """
    tree = ast.parse(source)
    models = {}

    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        if not (node.name.endswith("Base") or node.name == "AddressModel"):
            continue

        meta = _parse_inner_class(node, "Meta")
        handleref = _parse_inner_class(node, "HandleRef")

        models[node.name] = {
            "tag": _parse_handleref_tag(handleref),
            "table": _parse_meta_db_table(meta),
            "address": _has_base_class(node, "AddressModel"),
            "fields": _parse_fields_from_class(node),
        }

    return models


def parse_concrete_models(source, abstract_models):
    """
    Parse concrete.py and merge with abstract model definitions.

    Concrete models inherit from Base classes and add ForeignKey fields.
    Some override Meta.db_table.

    Returns the final model dict keyed by API tag.
    """
    tree = ast.parse(source)
    entities = {}
    class_to_tag = {}

    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue

        base_model = None
        for base in node.bases:
            base_name = base.id if isinstance(base, ast.Name) else None
            if base_name and base_name in abstract_models:
                base_model = abstract_models[base_name]
                break

        if base_model is None:
            continue

        tag = base_model["tag"]
        if tag is None:
            continue

        fields = list(base_model.get("fields", []))
        address = base_model.get("address", False)

        concrete_meta = _parse_inner_class(node, "Meta")
        table = _parse_meta_db_table(concrete_meta) or base_model.get("table")

        for item in node.body:
            field_name = None
            call_node = None

            if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                field_name = item.target.id
                if isinstance(item.value, ast.Call):
                    call_node = item.value
            elif isinstance(item, ast.Assign) and len(item.targets) == 1:
                target = item.targets[0]
                if isinstance(target, ast.Name) and isinstance(item.value, ast.Call):
                    field_name = target.id
                    call_node = item.value

            if field_name is None or call_node is None:
                continue
            if field_name.startswith("_"):
                continue

            field_type = _resolve_field_type(call_node)
            if field_type is None:
                continue

            if field_type == "foreignkey":
                fk_target = _get_fk_target(call_node)
                nullable = _has_kwarg(call_node, "null", True)
                field_def = {
                    "name": f"{field_name}_id",
                    "type": "number",
                    "foreignKey": fk_target,
                }
                if nullable:
                    field_def["nullable"] = True
                fields.append(field_def)
            else:
                field_def = {"name": field_name, "type": field_type}
                if _has_kwarg(call_node, "null", True):
                    field_def["nullable"] = True
                fields.append(field_def)

        entities[tag] = {
            "tag": tag,
            "table": table,
            "address": address,
            "fields": fields,
        }
        class_to_tag[node.name] = tag

    # Resolve FK target class names to API tags
    for entity in entities.values():
        for field in entity["fields"]:
            if "foreignKey" in field:
                target_class = field["foreignKey"]
                field["foreignKey"] = class_to_tag.get(target_class, target_class)

    return entities


def _resolve_ref(spec, ref_str):
    """
    Resolve a $ref string (e.g. '#/components/schemas/NetworkList')
    against the full spec dict. Returns the referenced sub-dict or None.
    """
    if not ref_str or not ref_str.startswith("#/"):
        return None
    parts = ref_str[2:].split("/")
    node = spec
    for part in parts:
        if isinstance(node, dict):
            node = node.get(part)
        else:
            return None
    return node


def _extract_properties(schema, spec):
    """
    Extract properties dict from a schema, resolving $ref if present.

    Handles:
      - Direct properties: { type: object, properties: {...} }
      - $ref: '#/components/schemas/SomeName'
      - Wrapped in results array: { properties: { results: { items: { $ref } } } }
    """
    if "$ref" in schema:
        resolved = _resolve_ref(spec, schema["$ref"])
        if resolved:
            return resolved.get("properties", {})
        return {}

    properties = schema.get("properties", {})

    # Paginated list response: { count, next, previous, results: [items] }
    if "results" in properties:
        items = properties["results"].get("items", {})
        if "$ref" in items:
            resolved = _resolve_ref(spec, items["$ref"])
            if resolved:
                return resolved.get("properties", {})
        return items.get("properties", {})

    return properties


def parse_api_spec(spec):
    """
    Extract per-entity metadata from a parsed OpenAPI spec dict.

    For each entity endpoint (identified by operationId: 'list {tag}' on a
    GET /api/{tag} path), extracts:
      - queryable field names (from query parameters)
      - field schemas (from response component properties, resolving $ref)
      - restricted/anonFilter (from 'visible' enum on poc)

    Returns dict keyed by API tag.
    """
    entities = {}
    paths = spec.get("paths", {})

    for path_str, path_obj in paths.items():
        get_op = path_obj.get("get")
        if not get_op:
            continue

        op_id = get_op.get("operationId", "")
        if not op_id.startswith("list "):
            continue

        tag = op_id[5:]  # strip "list " prefix

        # Only match simple entity list endpoints: /api/{tag}
        # Skip paths with path parameters like /api/org/{org_id}/users/
        expected_path = f"/api/{tag}"
        if path_str.rstrip("/") != expected_path:
            continue

        # Extract queryable fields from query parameters
        queryable_fields = set()
        params = get_op.get("parameters", [])
        skip_params = {"depth", "limit", "skip", "since", "fields"}
        for param in params:
            if param.get("in") != "query":
                continue
            name = param.get("name", "")
            if name in skip_params:
                continue
            if "__" in name:
                continue
            queryable_fields.add(name)

        # Extract response schema fields (resolving $ref)
        response_fields = {}
        resp_200 = get_op.get("responses", {}).get("200", {})
        content = resp_200.get("content", {}).get("application/json", {})
        schema = content.get("schema", {})
        properties = _extract_properties(schema, spec)

        for field_name, field_schema in properties.items():
            field_info = {"name": field_name}

            schema_type = field_schema.get("type")
            if schema_type == "boolean":
                field_info["schema_type"] = "boolean"
            elif schema_type == "integer" or schema_type == "number":
                field_info["schema_type"] = "number"
            elif schema_type == "string":
                fmt = field_schema.get("format")
                if fmt == "date-time":
                    field_info["schema_type"] = "datetime"
                else:
                    field_info["schema_type"] = "string"
            elif schema_type == "array" or schema_type == "object":
                field_info["schema_type"] = "json"

            if "enum" in field_schema:
                field_info["enum"] = field_schema["enum"]

            if field_schema.get("nullable"):
                field_info["nullable"] = True

            response_fields[field_name] = field_info

        entities[tag] = {
            "queryable_fields": queryable_fields,
            "response_fields": response_fields,
        }

    return entities


# ── Merge logic ──────────────────────────────────────────────────────────────

# Display labels matching PeeringDB's naming conventions.
# Used by the frontend for search results, stats, recent updates.
ENTITY_LABELS = {
    "net": "Networks",
    "ix": "Exchanges",
    "fac": "Facilities",
    "org": "Organizations",
    "carrier": "Carriers",
    "campus": "Campuses",
    "poc": "Points of Contact",
    "netfac": "Network Facilities",
    "netixlan": "Network Exchange LANs",
    "ixfac": "Exchange Facilities",
    "ixlan": "Exchange LANs",
    "ixpfx": "Exchange Prefixes",
    "carrierfac": "Carrier Facilities",
}

def merge_models_and_spec(model_entities, spec_entities):
    """
    Merge Django model data with OpenAPI spec data to produce the final
    entity-schema.json entities section.

    For each entity present in both sources:
      - Uses model fields as the base (names, types, nullable, FK targets)
      - Adds API-injected fields found in the spec but not in the model
        (e.g. org_name, name, city, country on join tables, fac_count)
      - Marks queryability from the spec's query parameters
      - Detects restricted/anonFilter from the visible enum on poc

    Fields default to queryable:true. Only fields absent from the spec's
    query parameters get queryable:false.
    """
    merged = {}

    for tag, model in model_entities.items():
        spec = spec_entities.get(tag)
        if spec is None:
            # Entity in models but not in API spec — skip
            print(f"  Warning: {tag} not found in API spec, skipping")
            continue

        queryable = spec["queryable_fields"]
        response = spec["response_fields"]
        model_field_names = {f["name"] for f in model["fields"]}

        # Start with model fields, annotate queryability
        fields = []
        for field in model["fields"]:
            f = dict(field)  # copy
            name = f["name"]
            # FK fields are always queryable — our query builder needs them
            # for FK filtering and cross-entity subqueries, regardless of
            # whether the spec lists them as explicit query params.
            if "foreignKey" in f:
                is_queryable = True
            else:
                is_queryable = name in queryable
            if not is_queryable:
                f["queryable"] = False
            fields.append(f)

        # Add API-injected fields (in spec response but not in model)
        # These are SerializerMethodField or annotated fields like org_name,
        # name, city, country on join tables, *_count fields, ix_id, etc.
        # Exclude _set fields (depth expansion, not real columns).
        for field_name, field_info in response.items():
            if field_name in model_field_names:
                continue
            if field_name.endswith("_set"):
                continue
            # Skip meta/computed fields not stored in D1
            if field_name in ("id", "status", "created", "updated", "suggest"):
                continue
            # Skip virtual aggregation fields (computed by serializer, not
            # stored as columns). e.g. ix.prefix is aggregated from ixlan/ixpfx.
            if field_name == "prefix" and tag == "ix":
                continue

            f = {"name": field_name}

            # Use schema type from the spec, with corrections for
            # upstream spec bugs (e.g. fac_count typed as string)
            schema_type = field_info.get("schema_type", "string")
            if field_name.endswith("_count"):
                schema_type = "number"
            elif field_name.endswith("_updated"):
                schema_type = "datetime"
            f["type"] = schema_type

            if field_name not in queryable:
                f["queryable"] = False

            if field_info.get("nullable"):
                f["nullable"] = True

            fields.append(f)

        # Detect restricted/anonFilter from visible enum
        restricted = False
        anon_filter = None
        if "visible" in response:
            visible_info = response["visible"]
            enum_values = visible_info.get("enum", [])
            if "Private" in enum_values and "Public" in enum_values:
                restricted = True
                anon_filter = {"field": "visible", "value": "Public"}

        merged[tag] = {
            "tag": tag,
            "label": ENTITY_LABELS.get(tag, tag),
            "table": model["table"],
            "address": model["address"],
            "restricted": restricted,
            "fields": fields,
        }
        if anon_filter:
            merged[tag]["anonFilter"] = anon_filter

    return merged


# ── Schema.sql generation ────────────────────────────────────────────────────

# Maps our type system → D1/SQLite column types
SQL_TYPE_MAP = {
    "string": "TEXT",
    "number": "INTEGER",
    "boolean": "BOOL",
    "datetime": "DATETIME",
    "json": "TEXT",
}

# Fields present in every entity table (managed by the sync worker,
# not declared in entity-schema.json fields list)
META_COLUMNS = [
    '    "created" DATETIME NOT NULL DEFAULT \'\'',
    '    "updated" DATETIME NOT NULL DEFAULT \'\'',
    '    "status" TEXT NOT NULL DEFAULT \'\'',
]

# Field names that get NOCASE indexes for case-insensitive filtering
NOCASE_INDEX_FIELDS = {"name", "country", "city", "irr_as_set"}


def generate_schema_sql(entities, schema_version="unknown"):
    """
    Generate D1/SQLite CREATE TABLE statements from the merged entity data.

    Also emits CREATE INDEX statements for:
      - FK _id columns (for JOIN performance)
      - name, country, city, irr_as_set (COLLATE NOCASE for filtering)
      - asn (numeric lookup)

    Returns the full SQL string.
    """
    lines = [
        "-- D1 schema (auto-generated by parse_django_models.py)",
        f"-- Schema version: {schema_version}",
        "-- Do not edit by hand — regenerate with:",
        "--   .venv/bin/python scripts/parse_django_models.py --force",
        "",
        'CREATE TABLE IF NOT EXISTS "_sync_meta" (',
        '    "entity" TEXT NOT NULL PRIMARY KEY,',
        '    "last_sync" INTEGER NOT NULL DEFAULT 0,',
        '    "row_count" INTEGER NOT NULL DEFAULT 0,',
        '    "updated_at" TEXT NOT NULL DEFAULT \'\',',
        '    "last_modified_at" INTEGER NOT NULL DEFAULT 0',
        ');',
        "",
        'CREATE TABLE IF NOT EXISTS "_migrations" (',
        '    "name" TEXT NOT NULL PRIMARY KEY,',
        '    "applied_at" TEXT NOT NULL DEFAULT (datetime(\'now\'))',
        ');',
        "",
    ]

    for tag in sorted(entities.keys()):
        entity = entities[tag]
        table = entity["table"]
        cols = ['    "id" INTEGER NOT NULL PRIMARY KEY']

        for field in entity["fields"]:
            name = field["name"]
            ftype = field["type"]
            sql_type = SQL_TYPE_MAP.get(ftype, "TEXT")
            # Latitude/longitude are numeric but stored as floating point
            if name in ("latitude", "longitude"):
                sql_type = "REAL"
            nullable = field.get("nullable", False)

            if nullable:
                cols.append(f'    "{name}" {sql_type}')
            elif sql_type == "BOOL":
                cols.append(f'    "{name}" {sql_type} NOT NULL DEFAULT 0')
            elif sql_type == "INTEGER":
                cols.append(f'    "{name}" {sql_type} NOT NULL DEFAULT 0')
            elif sql_type == "REAL":
                cols.append(f'    "{name}" {sql_type}')
            else:
                cols.append(f'    "{name}" {sql_type} NOT NULL DEFAULT \'\'')

        cols.extend(META_COLUMNS)
        col_str = ",\n".join(cols)

        lines.append(f'CREATE TABLE IF NOT EXISTS "{table}" (')
        lines.append(col_str)
        lines.append(");")

        # Indexes
        indexes = []
        for field in entity["fields"]:
            name = field["name"]
            if name.endswith("_id") and "foreignKey" in field:
                indexes.append(
                    f'CREATE INDEX IF NOT EXISTS "{table}_{name}_idx" '
                    f'ON "{table}" ("{name}");'
                )
            elif name in NOCASE_INDEX_FIELDS:
                indexes.append(
                    f'CREATE INDEX IF NOT EXISTS "{table}_{name}_nocase_idx" '
                    f'ON "{table}" ("{name}" COLLATE NOCASE);'
                )
            elif name == "asn":
                indexes.append(
                    f'CREATE INDEX IF NOT EXISTS "{table}_{name}_idx" '
                    f'ON "{table}" ("{name}");'
                )
        if indexes:
            lines.extend(indexes)

        lines.append("")

    return "\n".join(lines) + "\n"


# ── ES module generation ─────────────────────────────────────────────────────

def generate_entities_js(output_data):
    """
    Generate an ES module exporting the entity schema data.

    Browsers cannot use `import ... with { type: 'json' }` yet, so
    this provides the same data as entities.json in a module that
    the frontend can import directly via `<script type="module">`.

    The generated module exports:
      - ENTITY_SCHEMA: the full entity data (same as entities.json)
      - ENTITIES: convenience map of tag → { label, fields, ... }
      - ENTITY_TAGS: ordered array of all entity tags
      - getLabel(tag): returns the display label for a tag

    Returns the JS source string.
    """
    json_str = json.dumps(output_data, indent=2)

    return f"""\
// Auto-generated by parse_django_models.py — do not edit by hand.
// Regenerate with: .venv/bin/python scripts/parse_django_models.py --force

/** Full entity schema including version tracking and field definitions. */
export const ENTITY_SCHEMA = {json_str};

/**
 * Convenience map: entity tag → entity definition.
 * @type {{Record<string, any>}}
 */
export const ENTITIES = ENTITY_SCHEMA.entities;

/**
 * Ordered array of all entity tags.
 * @type {{string[]}}
 */
export const ENTITY_TAGS = Object.keys(ENTITIES);

/**
 * Returns the display label for an entity tag (e.g. 'net' → 'Networks').
 *
 * @param {{string}} tag - Entity tag.
 * @returns {{string}} Human-readable label.
 */
export function getLabel(tag) {{
    return ENTITIES[tag]?.label ?? tag;
}}
"""


# ── Worker entities precompilation ───────────────────────────────────────────

# Address field names handled by the Entity.address() builder method.
# When an entity has address: true, these fields are emitted by .address()
# with fixed queryable/non-queryable settings rather than per-field overrides.
_ADDRESS_FIELDS = {
    "address1", "address2", "city", "country", "state", "zipcode",
    "floor", "suite", "latitude", "longitude",
}

# Cache tier configuration per entity — mirrors the TIERS map in cache.js.
# Entities not listed here get DEFAULT_TIER.
_CACHE_TIERS = {
    "net":      {"slots": 1024, "maxSize": 16 * 1024 * 1024},
    "netixlan": {"slots": 2048, "maxSize": 16 * 1024 * 1024},
    "netfac":   {"slots": 512,  "maxSize":  8 * 1024 * 1024},
    "fac":      {"slots": 512,  "maxSize":  4 * 1024 * 1024},
    "ix":       {"slots": 512,  "maxSize":  4 * 1024 * 1024},
    "org":      {"slots": 512,  "maxSize":  8 * 1024 * 1024},
    "poc":      {"slots": 256,  "maxSize":  1 * 1024 * 1024},
}

_DEFAULT_TIER = {"slots": 128, "maxSize": 1 * 1024 * 1024}


def _build_worker_entities(merged_entities, overrides):
    """
    Replicate the Entity builder pipeline (buildEntities + overrides +
    deriveRelationships + cacheFieldLookups) in Python.

    Takes the merged entity schema dict and entity-overrides.json dict.
    Returns a dict of tag → fully-built entity data ready for JS emission.
    """
    # ── Phase 1: build fields (mirrors buildEntities in entities.js) ────────

    entities = {}
    for tag, schema in merged_entities.items():
        tag_overrides = overrides.get(tag, {}).get("fieldOverrides", {})

        # Start with id field
        fields = [{"name": "id", "type": "number"}]

        # Track which fields are address fields handled by .address()
        has_address = schema.get("address", False)
        address_done = set()

        for field in schema["fields"]:
            name = field["name"]

            # Skip address fields if the entity uses .address()
            if has_address and name in _ADDRESS_FIELDS:
                address_done.add(name)
                continue

            field_override = tag_overrides.get(name, {})

            # Allow overrides to fix type or queryable
            effective_type = field_override.get("type", field.get("type", "string"))
            effective_queryable = field_override.get("queryable", field.get("queryable"))

            f = {"name": name, "type": effective_type}

            if effective_type == "json":
                f["queryable"] = False
                f["json"] = True
            else:
                if effective_queryable is False:
                    f["queryable"] = False
                if field.get("nullable"):
                    f["nullable"] = True
                if field.get("foreignKey"):
                    f["foreignKey"] = field["foreignKey"]
                    if field_override.get("resolve"):
                        f["resolve"] = field_override["resolve"]

            fields.append(f)

        # Add address group (mirrors Entity.address() — fixed order & queryable flags)
        if has_address:
            fields.append({"name": "address1", "type": "string", "queryable": False})
            fields.append({"name": "address2", "type": "string", "queryable": False})
            fields.append({"name": "city", "type": "string"})
            fields.append({"name": "country", "type": "string"})
            fields.append({"name": "state", "type": "string"})
            fields.append({"name": "zipcode", "type": "string"})
            fields.append({"name": "floor", "type": "string", "queryable": False})
            fields.append({"name": "suite", "type": "string", "queryable": False})
            fields.append({"name": "latitude", "type": "number", "queryable": False})
            fields.append({"name": "longitude", "type": "number", "queryable": False})

        # Seal: add standard timestamp fields (mirrors Entity.done())
        fields.append({"name": "created", "type": "datetime"})
        fields.append({"name": "updated", "type": "datetime"})
        fields.append({"name": "status", "type": "string"})

        entity = {
            "tag": tag,
            "table": schema["table"],
            "fields": fields,
            "_restricted": schema.get("restricted", False),
            "_anonFilter": schema.get("anonFilter"),
            "joinColumns": None,
            "relationships": [],
        }
        entities[tag] = entity

    # ── Phase 2: derive joinColumns (mirrors deriveRelationships pass 1) ────

    for entity in entities.values():
        joins = []
        for field in entity["fields"]:
            fk = field.get("foreignKey")
            resolve = field.get("resolve")
            if not fk or not resolve:
                continue
            target = entities.get(fk)
            if not target:
                continue
            joins.append({
                "table": target["table"],
                "localFk": field["name"],
                "columns": resolve,
            })
        entity["joinColumns"] = joins if joins else None

    # ── Phase 3: derive relationships (mirrors deriveRelationships pass 2) ──

    for entity in entities.values():
        entity["relationships"] = []

    for child_tag, child_entity in entities.items():
        for field in child_entity["fields"]:
            fk = field.get("foreignKey")
            if not fk:
                continue
            parent = entities.get(fk)
            if not parent:
                continue

            rel = {
                "field": f"{child_tag}_set",
                "table": child_entity["table"],
                "fk": field["name"],
            }

            # Sibling FK fields with resolve specs → joinColumns on relationship
            sibling_joins = []
            for sibling in child_entity["fields"]:
                if sibling is field:
                    continue
                s_fk = sibling.get("foreignKey")
                s_resolve = sibling.get("resolve")
                if not s_fk or not s_resolve:
                    continue
                s_target = entities.get(s_fk)
                if not s_target:
                    continue
                sibling_joins.append({
                    "table": s_target["table"],
                    "localFk": sibling["name"],
                    "columns": s_resolve,
                })
            if sibling_joins:
                rel["joinColumns"] = sibling_joins

            parent["relationships"].append(rel)

    # ── Phase 4: compute field lookup caches ────────────────────────────────

    for entity in entities.values():
        columns = []
        json_columns = set()
        bool_columns = set()
        nullable_columns = set()
        field_names = set()
        filter_types = {}

        for field in entity["fields"]:
            name = field["name"]
            columns.append(name)
            field_names.add(name)
            if field.get("json"):
                json_columns.add(name)
            if field["type"] == "boolean":
                bool_columns.add(name)
            if field.get("nullable"):
                nullable_columns.add(name)
            if field.get("queryable") is not False:
                filter_types[name] = field["type"]

        entity["_columns"] = columns
        entity["_jsonColumns"] = sorted(json_columns)
        entity["_boolColumns"] = sorted(bool_columns)
        entity["_nullableColumns"] = sorted(nullable_columns)
        entity["_fieldNames"] = sorted(field_names)
        entity["_filterTypes"] = filter_types

    return entities


def _emit_js_field(field):
    """Emit a single field definition as a JS object literal string."""
    parts = [f'name: {json.dumps(field["name"])}', f'type: {json.dumps(field["type"])}']
    if field.get("queryable") is False:
        parts.append("queryable: false")
    if field.get("json"):
        parts.append("json: true")
    if field.get("nullable"):
        parts.append("nullable: true")
    if field.get("foreignKey"):
        parts.append(f'foreignKey: {json.dumps(field["foreignKey"])}')
    if field.get("resolve"):
        resolve_parts = ", ".join(
            f"{json.dumps(k)}: {json.dumps(v)}"
            for k, v in field["resolve"].items()
        )
        parts.append(f"resolve: {{ {resolve_parts} }}")
    return "{ " + ", ".join(parts) + " }"


def _emit_js_join(join):
    """Emit a joinColumn def as a JS object literal string."""
    cols = ", ".join(
        f"{json.dumps(k)}: {json.dumps(v)}"
        for k, v in join["columns"].items()
    )
    return (
        f'{{ table: {json.dumps(join["table"])}, '
        f'localFk: {json.dumps(join["localFk"])}, '
        f'columns: {{ {cols} }} }}'
    )


def _emit_js_relationship(rel):
    """Emit a relationship def as a JS object literal string."""
    parts = [
        f'field: {json.dumps(rel["field"])}',
        f'table: {json.dumps(rel["table"])}',
        f'fk: {json.dumps(rel["fk"])}',
    ]
    if rel.get("joinColumns"):
        joins_str = ", ".join(_emit_js_join(j) for j in rel["joinColumns"])
        parts.append(f"joinColumns: [{joins_str}]")
    return "{ " + ", ".join(parts) + " }"


def generate_worker_entities_js(merged_entities, overrides):
    """
    Generate a precompiled ES module for the API and sync workers.

    Runs the full Entity building pipeline (build + overrides + derive
    relationships + cache field lookups) at generation time and emits
    the results as static JS object literals. The workers import this
    module directly — no JSON.parse, no Entity class, no runtime
    derivation.

    Returns the JS source string.
    """
    entities = _build_worker_entities(merged_entities, overrides)

    lines = [
        "// Auto-generated by parse_django_models.py — do not edit by hand.",
        "// Regenerate with: .venv/bin/python scripts/parse_django_models.py --force",
        "",
        "/**",
        " * @fileoverview Precompiled entity registry for API and sync workers.",
        " *",
        " * All entity metadata — fields, relationships, joinColumns, and cached",
        " * field lookups — are computed at generation time. Zero runtime derivation.",
        " */",
        "",
    ]

    # Emit each entity as a const
    entity_names = []
    for tag, entity in entities.items():
        var_name = f"_entity_{tag}"
        entity_names.append((tag, var_name))

        fields_str = ",\n        ".join(_emit_js_field(f) for f in entity["fields"])

        joins_str = "undefined"
        if entity["joinColumns"]:
            joins_items = ", ".join(_emit_js_join(j) for j in entity["joinColumns"])
            joins_str = f"[{joins_items}]"

        rels_str = "[]"
        if entity["relationships"]:
            rels_items = ",\n        ".join(
                _emit_js_relationship(r) for r in entity["relationships"]
            )
            rels_str = f"[\n        {rels_items}\n    ]"

        columns_str = json.dumps(entity["_columns"])
        json_cols_str = json.dumps(entity["_jsonColumns"])
        bool_cols_str = json.dumps(entity["_boolColumns"])
        nullable_cols_str = json.dumps(entity["_nullableColumns"])
        field_names_str = json.dumps(entity["_fieldNames"])

        # filterTypes as a Map initialiser array
        ft_pairs = ", ".join(
            f'[{json.dumps(k)}, {json.dumps(v)}]'
            for k, v in entity["_filterTypes"].items()
        )

        anon_filter_str = "undefined"
        if entity["_anonFilter"]:
            af = entity["_anonFilter"]
            anon_filter_str = f'{{ field: {json.dumps(af["field"])}, value: {json.dumps(af["value"])} }}'

        lines.append(f"/** @type {{EntityMeta}} */")
        lines.append(f"const {var_name} = {{")
        lines.append(f"    tag: {json.dumps(tag)},")
        lines.append(f"    table: {json.dumps(entity['table'])},")
        lines.append(f"    _restricted: {json.dumps(entity['_restricted'])},")
        lines.append(f"    _anonFilter: {anon_filter_str},")
        lines.append(f"    fields: [")
        lines.append(f"        {fields_str}")
        lines.append(f"    ],")
        lines.append(f"    joinColumns: {joins_str},")
        lines.append(f"    relationships: {rels_str},")
        lines.append(f"    _columns: {columns_str},")
        lines.append(f"    _jsonColumns: new Set({json_cols_str}),")
        lines.append(f"    _boolColumns: new Set({bool_cols_str}),")
        lines.append(f"    _nullableColumns: new Set({nullable_cols_str}),")
        lines.append(f"    _fieldNames: new Set({field_names_str}),")
        lines.append(f"    _filterTypes: new Map([{ft_pairs}]),")
        lines.append(f"}};")
        lines.append("")

    # ENTITIES record
    lines.append("/**")
    lines.append(" * Maps an API endpoint tag to its precompiled entity metadata.")
    lines.append(" * @type {Record<string, EntityMeta>}")
    lines.append(" */")
    entries_str = ", ".join(f'{json.dumps(tag)}: {var}' for tag, var in entity_names)
    lines.append(f"export const ENTITIES = {{ {entries_str} }};")
    lines.append("")

    # ENTITY_TAGS set
    tags_str = ", ".join(json.dumps(tag) for tag, _ in entity_names)
    lines.append("/**")
    lines.append(" * Set of valid entity tags for fast lookup in the router.")
    lines.append(" * @type {Set<string>}")
    lines.append(" */")
    lines.append(f"export const ENTITY_TAGS = new Set([{tags_str}]);")
    lines.append("")

    # Cache tiers
    lines.append("// ── Cache tier configuration ─────────────────────────────────────────────")
    lines.append("")
    lines.append("const MB = 1024 * 1024;")
    lines.append("")
    lines.append("/**")
    lines.append(" * Default cache tier for entities not in CACHE_TIERS.")
    lines.append(" * New entities from upstream automatically get this bucket.")
    lines.append(" * @type {{slots: number, maxSize: number}}")
    lines.append(" */")
    lines.append(f"export const DEFAULT_TIER = {{ slots: {_DEFAULT_TIER['slots']}, maxSize: {_DEFAULT_TIER['maxSize'] // (1024*1024)} * MB }};")
    lines.append("")

    lines.append("/**")
    lines.append(" * Per-entity cache tier configuration.")
    lines.append(" * Sized by query cardinality (slots) and measured response outliers (maxSize).")
    lines.append(" * @type {Record<string, {slots: number, maxSize: number}>}")
    lines.append(" */")
    tier_entries = []
    for tag, tier in _CACHE_TIERS.items():
        mb = tier["maxSize"] // (1024 * 1024)
        tier_entries.append(f"    {json.dumps(tag)}: {{ slots: {tier['slots']}, maxSize: {mb} * MB }}")
    lines.append("export const CACHE_TIERS = {")
    lines.append(",\n".join(tier_entries))
    lines.append("};")
    lines.append("")

    return "\n".join(lines) + "\n"


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    """
    Fetch all upstream sources, parse and merge them, emit:
      - extracted/entities.json
      - extracted/entities.js  (ES module for frontend import)
      - extracted/schema.sql
      - extracted/src/ (cached fetched sources)

    Version checking: compares both the django-peeringdb tag and the PeeringDB
    server Ctl/VERSION against the versions stored in the current output file.
    Skips regeneration if both match, unless --force is specified.
    """
    project_root = Path(__file__).parent.parent
    extracted_dir = project_root / "extracted"
    src_dir = extracted_dir / "src"
    entities_path = extracted_dir / "entities.json"
    schema_path = extracted_dir / "schema.sql"
    force = "--force" in sys.argv

    extracted_dir.mkdir(parents=True, exist_ok=True)
    src_dir.mkdir(parents=True, exist_ok=True)

    # ── Detect upstream versions ────────────────────────────────────────
    print("Fetching upstream versions...")
    django_peeringdb_version = fetch_latest_django_peeringdb_tag()
    print(f"  django-peeringdb: {django_peeringdb_version}")

    peeringdb_version = fetch_peeringdb_version()
    print(f"  peeringdb server: {peeringdb_version}")

    # ── Version check ───────────────────────────────────────────────────
    if entities_path.exists() and not force:
        try:
            existing = json.loads(entities_path.read_text())
            ev = existing.get("versions", {})
            if (
                ev.get("django_peeringdb") == django_peeringdb_version
                and ev.get("api_schema") == peeringdb_version
            ):
                print("  Versions unchanged, skipping. Use --force to override.")
                return
        except (json.JSONDecodeError, KeyError):
            pass

    # ── Stage 1: Django models ──────────────────────────────────────────
    for filename in DJANGO_PEERINGDB_FILES:
        short = Path(filename).name
        print(f"Fetching {short}...")
        source = fetch_with_branch_fallback(
            DJANGO_PEERINGDB_REPO, DJANGO_PEERINGDB_BRANCHES, filename
        )
        (src_dir / short).write_text(source)

    abstract_source = (src_dir / "abstract.py").read_text()
    concrete_source = (src_dir / "concrete.py").read_text()

    print("Parsing Django models...")
    abstract_models = parse_abstract_models(abstract_source)
    model_entities = parse_concrete_models(concrete_source, abstract_models)
    print(f"  {len(model_entities)} entities from models: "
          f"{', '.join(sorted(model_entities.keys()))}")

    # ── Stage 2: OpenAPI spec ───────────────────────────────────────────
    schema_url = API_SCHEMA_URL_TEMPLATE.format(version=peeringdb_version)
    print(f"Fetching api-schema.yaml ({peeringdb_version})...")
    spec_yaml = fetch_url(schema_url)
    (src_dir / "api-schema.yaml").write_text(spec_yaml)

    print("Parsing OpenAPI spec...")
    spec = yaml.safe_load(spec_yaml)
    spec_entities = parse_api_spec(spec)
    print(f"  {len(spec_entities)} entity endpoints in spec: "
          f"{', '.join(sorted(spec_entities.keys()))}")

    # ── Merge ───────────────────────────────────────────────────────────
    print("Merging models + spec...")
    merged = merge_models_and_spec(model_entities, spec_entities)
    print(f"  {len(merged)} entities in final schema")

    # ── Output: entities.json ───────────────────────────────────────────
    schema_version = f"{django_peeringdb_version}+{peeringdb_version}"
    output = {
        "_warning": "Auto-generated by parse_django_models.py. Do not edit.",
        "schema_version": schema_version,
        "versions": {
            "django_peeringdb": django_peeringdb_version,
            "api_schema": peeringdb_version,
        },
        "entities": merged,
    }

    entities_path.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Wrote {entities_path} (schema {schema_version})")

    # ── Output: schema.sql ──────────────────────────────────────────────
    sql = generate_schema_sql(merged, schema_version)
    schema_path.write_text(sql)
    print(f"Wrote {schema_path}")

    # ── Output: entities.js (ES module for browser + node) ────────────────
    entities_js = generate_entities_js(output)

    js_path = extracted_dir / "entities.js"
    js_path.write_text(entities_js)
    print(f"Wrote {js_path}")

    # Also write to frontend/js/ so browser ES module imports work.
    # The frontend is served from frontend/ as root, so imports must
    # stay within that tree.
    frontend_js_path = project_root / "frontend" / "js" / "entities.js"
    frontend_js_path.write_text(entities_js)
    print(f"Wrote {frontend_js_path}")

    # ── Output: entities-worker.js (precompiled worker registry) ─────────
    overrides_path = project_root / "workers" / "api" / "entity-overrides.json"
    overrides = {}
    if overrides_path.exists():
        overrides = json.loads(overrides_path.read_text())

    worker_js = generate_worker_entities_js(merged, overrides)
    worker_js_path = extracted_dir / "entities-worker.js"
    worker_js_path.write_text(worker_js)
    print(f"Wrote {worker_js_path}")

    # Summary of API-injected fields
    for tag in sorted(merged.keys()):
        entity = merged[tag]
        model_names = {f["name"] for f in model_entities.get(tag, {}).get("fields", [])}
        all_names = {f["name"] for f in entity["fields"]}
        injected = all_names - model_names
        if injected:
            print(f"  {tag}: API-injected fields: {', '.join(sorted(injected))}")


if __name__ == "__main__":
    main()

