#!/usr/bin/env python3
"""
Generates an OpenAPI 3.1 specification from extracted/entities.json.

Outputs:
    extracted/openapi.json — Complete OpenAPI spec with per-entity
    list/detail endpoints, filter parameters, and response schemas.

Run after parse_django_models.py:
    python scripts/parse_django_models.py --force
    python scripts/gen_openapi_spec.py
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENTITIES_PATH = REPO_ROOT / "extracted" / "entities.json"
OUTPUT_PATH = REPO_ROOT / "extracted" / "openapi.json"

# ── Type mapping ─────────────────────────────────────────────────────────────

# Maps entities.json types to OpenAPI schema types.
TYPE_MAP = {
    "string":   {"type": "string"},
    "number":   {"type": "integer"},
    "boolean":  {"type": "boolean"},
    "datetime": {"type": "string", "format": "date-time"},
    "json":     {},  # Any type (mixed arrays/objects)
}

# Media type constant used across response definitions.
MEDIA_JSON = "application/json"

# Reusable $ref for the Error schema in OpenAPI response definitions.
ERROR_REF = {"$ref": "#/components/schemas/Error"}

# ── Naming helpers ───────────────────────────────────────────────────────────
# Read from entities.json's naming property (set by parse_django_models.py).

def _label(entity):
    """Return the human-readable label for an entity."""
    return entity.get("naming", {}).get("label", entity.get("tag", "Unknown"))


def _subresource(entity):
    """Return the REST sub-resource URL slug for an entity."""
    return entity.get("naming", {}).get("subresource", entity.get("tag", "unknown"))

# Filter operators by field type, matching PeeringDB conventions.
FILTER_OPS = {
    "string":   ["", "__contains", "__startswith", "__in"],
    "number":   ["", "__lt", "__gt", "__lte", "__gte", "__in"],
    "boolean":  [""],
    "datetime": ["", "__lt", "__gt", "__lte", "__gte"],
}


def load_entities():
    """Load the entities dict from entities.json."""
    with open(ENTITIES_PATH) as f:
        data = json.load(f)
    return data["entities"], data.get("schema_version", "unknown")


def openapi_type(field):
    """
    Convert a system-agnostic `entities.json` field definition into an OpenAPI 3.1 JSON schema.

    OpenAPI strictness requires explicit nullability typing. If a field is native (e.g. `number`), 
    it maps to integer. If it inherits `nullable: true` from the Django models AST, this function 
    wraps the resulting OpenApi schema inside a `oneOf: [type, null]` constraint to ensure validators
    do not reject empty payloads upstream.
    
    Args:
        field (dict): A dictionary representing a single field's properties.
        
    Returns:
        dict: A valid OpenAPI property schema.
    """
    base = TYPE_MAP.get(field["type"], {"type": "string"}).copy()
    if field.get("nullable"):
        if base:
            return {"oneOf": [base, {"type": "null"}]}
        return {}
    return base if base else {}


def build_entity_schema(entity):
    """
    Construct the baseline OpenAPI `schema` definition for a single entity structure.

    Translates all dynamic fields extracted from `entities.json` into OpenAPI `properties`.
    Automatically enforces system-wide absolute requirements like `id` and `status` which 
    exist implicitly inside the upstream `BaseModel` classes, ensuring they are present 
    on every resource definition regardless of the field composition.
    
    Args:
        entity (dict): The entity framework object.
        
    Returns:
        dict: The OpenAPI Schema object representing the resource, specifying properties and required fields.
    """
    props = {
        "id": {"type": "integer", "description": "Primary key"},
        "status": {"type": "string", "description": "Record status (ok, deleted, pending)"},
    }
    required = ["id", "status"]

    for field in entity["fields"]:
        name = field["name"]
        schema = openapi_type(field)
        if not field.get("nullable", False):
            required.append(name)
        props[name] = schema

    return {
        "type": "object",
        "properties": props,
        "required": required,
    }


def build_filter_params(entity):
    """
    Generate comprehensive OpenAPI `parameter` definitions for entity filtering operators.

    Filters are dynamically provisioned based on field type. For any field explicitly marked
    `queryable: true`, this extrapolates the permissible PeeringDB filter suffixes (e.g., 
    `__in`, `__contains`, `__gte`) and constructs individual query parameters. This directly
    reflects the URL query structure the API Worker parses inside list endpoints.
    
    Args:
        entity (dict): The target entity.
        
    Returns:
        list[dict]: Array of OpenAPI parameter objects injected into path definitions.
    """
    params = []
    for field in entity["fields"]:
        if not field.get("queryable", True):
            continue

        name = field["name"]
        ft = field["type"]
        ops = FILTER_OPS.get(ft, [""])
        base_schema = TYPE_MAP.get(ft, {"type": "string"}).copy()

        for op in ops:
            param_name = name + op if op else name
            desc_parts = [f"Filter by {name}"]
            if op:
                desc_parts.append(f"({op.strip('_')} operator)")

            schema = base_schema.copy()
            if op == "__in":
                schema = {"type": "string"}
                desc_parts.append("— comma-separated values")

            params.append({
                "name": param_name,
                "in": "query",
                "required": False,
                "schema": schema,
                "description": " ".join(desc_parts),
            })

    return params


def build_common_params():
    """
    Build common query parameters shared across all list endpoints.

    These match the PeeringDB API conventions: limit, skip, depth,
    since, sort, fields.
    """
    return [
        {
            "name": "limit",
            "in": "query",
            "required": False,
            "schema": {"type": "integer", "default": 20, "maximum": 250},
            "description": "Maximum number of results to return (max 250).",
        },
        {
            "name": "skip",
            "in": "query",
            "required": False,
            "schema": {"type": "integer", "default": 0},
            "description": "Number of results to skip for pagination.",
        },
        {
            "name": "depth",
            "in": "query",
            "required": False,
            "schema": {"type": "integer", "default": 0, "maximum": 3},
            "description": "Expansion depth for related objects (0-3).",
        },
        {
            "name": "since",
            "in": "query",
            "required": False,
            "schema": {"type": "integer", "default": 0},
            "description": "Unix epoch. Only return records updated since this time.",
        },
        {
            "name": "sort",
            "in": "query",
            "required": False,
            "schema": {"type": "string"},
            "description": "Field name to sort by. Prefix with - for descending.",
        },
        {
            "name": "fields",
            "in": "query",
            "required": False,
            "schema": {"type": "string"},
            "description": "Comma-separated list of fields to include in the response.",
        },
    ]


def build_spec(entities, schema_version):
    """
    Orchestrate the assembly of the complete OpenAPI 3.1 JSON Specification blob.

    Aggregates all components into a compliant OpenAPI monolith:
    1. Base schemas (Entities).
    2. Response Envelopes (`ListResponse`, `DetailResponse` wrapped with `meta/data` arrays).
    3. URL Path structures (`/v1/{entity}`, `/v1/{entity}/{id}`).
    4. HTTP methods binded to parameters and defined schema envelopes.
    
    Args:
        entities (dict): The core registry of mapped objects.
        schema_version (str): Upstream version injected into API `.info`.
        
    Returns:
        dict: The final dictionary mapping directly to `openapi.json`.
    """
    schemas = {}
    paths = {}
    common_params = build_common_params()

    for tag, entity in entities.items():
        label = _label(entity)
        schema_name = label.replace(" ", "")

        # Build the entity schema
        schemas[schema_name] = build_entity_schema(entity)

        # Envelope schema for list responses
        envelope_name = schema_name + "ListResponse"
        schemas[envelope_name] = {
            "type": "object",
            "properties": {
                "data": {
                    "type": "array",
                    "items": {"$ref": f"#/components/schemas/{schema_name}"},
                },
                "meta": {"type": "object"},
            },
            "required": ["data", "meta"],
        }

        # Detail envelope
        detail_envelope_name = schema_name + "DetailResponse"
        schemas[detail_envelope_name] = {
            "type": "object",
            "properties": {
                "data": {
                    "type": "array",
                    "items": {"$ref": f"#/components/schemas/{schema_name}"},
                    "maxItems": 1,
                },
                "meta": {"type": "object"},
            },
            "required": ["data", "meta"],
        }

        # Filter parameters for this entity
        filter_params = build_filter_params(entity)

        # List endpoint: GET /v1/{tag}
        list_path = f"/v1/{tag}"
        paths[list_path] = {
            "get": {
                "operationId": f"list_{tag}",
                "summary": f"List {entity['label']}",
                "description": f"Returns a list of {entity['label'].lower()} matching the given filters.",
                "tags": [label],
                "parameters": common_params + filter_params,
                "responses": {
                    "200": {
                        "description": f"List of {entity['label'].lower()}.",
                        "content": {
                            MEDIA_JSON: {
                                "schema": {"$ref": f"#/components/schemas/{envelope_name}"},
                            },
                        },
                    },
                    "400": {
                        "description": "Invalid filter parameter.",
                        "content": {
                            MEDIA_JSON: {
                                "schema": ERROR_REF,
                            },
                        },
                    },
                },
            },
        }

        # Detail endpoint: GET /v1/{tag}/{id}
        detail_path = f"/v1/{tag}/{{id}}"
        paths[detail_path] = {
            "get": {
                "operationId": f"get_{tag}",
                "summary": f"Get {label} by ID",
                "description": f"Returns a single {label.lower()} by its primary key.",
                "tags": [label],
                "parameters": [
                    {
                        "name": "id",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "integer"},
                        "description": f"{label} primary key.",
                    },
                    common_params[2],  # depth
                    common_params[5],  # fields
                ],
                "responses": {
                    "200": {
                        "description": f"The {label.lower()}.",
                        "content": {
                            MEDIA_JSON: {
                                "schema": {"$ref": f"#/components/schemas/{detail_envelope_name}"},
                            },
                        },
                    },
                    "404": {
                        "description": f"{label} not found.",
                        "content": {
                            MEDIA_JSON: {
                                "schema": ERROR_REF,
                            },
                        },
                    },
                },
            },
        }

        # ── Sub-resource endpoints ───────────────────────────────────────
        # Forward FKs: /v1/{tag}/{id}/{relation} → parent entity
        for field in entity["fields"]:
            fk_target = field.get("foreignKey")
            if not fk_target or fk_target not in entities:
                continue

            fk_entity = entities[fk_target]
            fk_label = _label(fk_entity)
            rel_name = _subresource(fk_entity)
            sub_path = f"/v1/{tag}/{{id}}/{rel_name}"

            paths[sub_path] = {
                "get": {
                    "operationId": f"get_{tag}_{rel_name.replace('-', '_')}",
                    "summary": f"Get {fk_label} for {label}",
                    "description": f"Returns the {fk_label.lower()} associated with {label.lower()} {{id}} via the {field['name']} foreign key.",
                    "tags": [label],
                    "parameters": [
                        {
                            "name": "id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "integer"},
                            "description": f"{label} primary key.",
                        },
                    ],
                    "responses": {
                        "200": {
                            "description": f"The associated {fk_label.lower()}.",
                            "content": {
                                MEDIA_JSON: {
                                    "schema": {"$ref": f"#/components/schemas/{detail_envelope_name}"},
                                },
                            },
                        },
                        "404": {
                            "description": f"{label} not found or no {fk_label.lower()} associated.",
                            "content": {
                                MEDIA_JSON: {
                                    "schema": ERROR_REF,
                                },
                            },
                        },
                    },
                },
            }

        # Reverse edges: /v1/{tag}/{id}/{children} → child entities
        for child_tag, child_entity in entities.items():
            for child_field in child_entity["fields"]:
                fk_target = child_field.get("foreignKey")
                if fk_target != tag:
                    continue

                child_label = _label(child_entity)
                rel_name = _subresource(child_entity)
                sub_path = f"/v1/{tag}/{{id}}/{rel_name}"

                # Avoid duplicate paths (e.g. fac←netixlan via net_side_id and ix_side_id)
                if sub_path in paths:
                    continue

                paths[sub_path] = {
                    "get": {
                        "operationId": f"list_{tag}_{rel_name.replace('-', '_')}",
                        "summary": f"List {child_label}s for {label}",
                        "description": f"Returns {child_label.lower()} records where {child_field['name']} matches {{id}}.",
                        "tags": [label],
                        "parameters": [
                            {
                                "name": "id",
                                "in": "path",
                                "required": True,
                                "schema": {"type": "integer"},
                                "description": f"{label} primary key.",
                            },
                            common_params[0],  # limit
                            common_params[1],  # skip
                        ],
                        "responses": {
                            "200": {
                                "description": f"List of {child_label.lower()} records.",
                                "content": {
                                    MEDIA_JSON: {
                                        "schema": {"$ref": f"#/components/schemas/{envelope_name}"},
                                    },
                                },
                            },
                            "404": {
                                "description": f"{label} not found.",
                                "content": {
                                    MEDIA_JSON: {
                                        "schema": ERROR_REF,
                                    },
                                },
                            },
                        },
                    },
                }

    # Error schema
    schemas["Error"] = {
        "type": "object",
        "properties": {
            "error": {"type": "string"},
        },
        "required": ["error"],
    }

    spec = {
        "openapi": "3.1.0",
        "info": {
            "title": "PeeringDB REST API",
            "description": (
                "REST API for the PeeringDB dataset. "
                "Provides list and detail endpoints for all PeeringDB entity types "
                "with full filter support matching the upstream PeeringDB API conventions."
            ),
            "version": schema_version,
            "contact": {
                "name": "PDBFE",
                "url": "https://pdbfe.dev",
            },
        },
        "servers": [
            {"url": "https://rest.pdbfe.dev", "description": "Production"},
        ],
        "paths": paths,
        "components": {
            "schemas": schemas,
            "securitySchemes": {
                "apiKey": {
                    "type": "apiKey",
                    "in": "header",
                    "name": "Authorization",
                    "description": "API key authentication. Format: Api-Key <key>",
                },
            },
        },
    }

    return spec


def main():
    """Main entry point: load entities, generate spec, write JSON."""
    if not ENTITIES_PATH.exists():
        print(f"Error: {ENTITIES_PATH} not found. Run parse_django_models.py first.",
              file=sys.stderr)
        sys.exit(1)

    entities, schema_version = load_entities()
    spec = build_spec(entities, schema_version)

    output = json.dumps(spec, indent=2) + "\n"
    OUTPUT_PATH.write_text(output)
    print(f"Wrote {OUTPUT_PATH} ({len(output):,} bytes)")


if __name__ == "__main__":
    main()
