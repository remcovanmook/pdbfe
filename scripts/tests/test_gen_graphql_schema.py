import unittest
import sys
from pathlib import Path

# Add scripts directory to path to import generation scripts
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.append(str(REPO_ROOT / "scripts"))

from gen_graphql_schema import _type_name, _singular, _plural, _naming, gql_type, build_reverse_map

class TestGenGraphQLSchema(unittest.TestCase):
    def test_naming_helpers(self):
        """Test entity naming resolution helpers."""
        entity = {
            "tag": "net",
            "naming": {
                "type": "Network",
                "singular": "network",
                "plural": "networks"
            }
        }
        self.assertEqual(_type_name(entity), "Network")
        self.assertEqual(_singular(entity), "network")
        self.assertEqual(_plural(entity), "networks")
        
        # Test defaults
        empty_ent = {"tag": "custom"}
        self.assertEqual(_type_name(empty_ent), "custom")
        self.assertEqual(_singular(empty_ent), "custom")
        self.assertEqual(_plural(empty_ent), "custom")

    def test_gql_type_mapper(self):
        """Test extraction and mapping of GraphQL primitives."""
        self.assertEqual(gql_type("string"), "String")
        self.assertEqual(gql_type("number"), "Int")
        self.assertEqual(gql_type("boolean"), "Boolean")
        self.assertEqual(gql_type("datetime"), "String")
        self.assertEqual(gql_type("json"), "JSON")
        self.assertEqual(gql_type("unknown_type"), "String") # Default to String

    def test_build_reverse_map(self):
        """Test the extraction of FK declarations into a directional reverse map."""
        mock_entities = {
            "org": {
                "fields": [{"name": "name", "type": "string"}]
            },
            "net": {
                "fields": [
                    {"name": "org_id", "type": "number", "foreignKey": "org"},
                    {"name": "name", "type": "string"}
                ]
            },
            "ix": {
                "fields": [
                    {"name": "org_id", "type": "number", "foreignKey": "org"}
                ]
            }
        }
        
        reverse = build_reverse_map(mock_entities)
        
        self.assertIn("org", reverse)
        self.assertEqual(len(reverse["org"]), 2)
        # Should contain references back to net and ix through org_id
        edges = set(reverse["org"])
        self.assertIn(("net", "org_id"), edges)
        self.assertIn(("ix", "org_id"), edges)
        
        self.assertNotIn("net", reverse)

if __name__ == '__main__':
    unittest.main()
