import unittest
import sys
from pathlib import Path

# Add scripts directory to path to import generation scripts
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.append(str(REPO_ROOT / "scripts"))

from gen_openapi_spec import openapi_type, build_entity_schema, _label, _subresource

class TestGenOpenAPISpec(unittest.TestCase):
    def test_naming_helpers(self):
        """Test the extraction of label and subresource from entity."""
        # Standard entity with naming overrides
        entity_valid = {
            "tag": "ix",
            "naming": {"label": "Internet Exchange", "subresource": "ixs"}
        }
        self.assertEqual(_label(entity_valid), "Internet Exchange")
        self.assertEqual(_subresource(entity_valid), "ixs")
        
        # Fallback missing naming
        entity_fallback = {"tag": "net"}
        self.assertEqual(_label(entity_fallback), "net")
        self.assertEqual(_subresource(entity_fallback), "net")

    def test_openapi_type_mapping(self):
        """Test mapping JSON schema types to OpenAPI types including nullability."""
        # Basic string non-nullable
        t1 = openapi_type({"type": "string"})
        self.assertEqual(t1, {"type": "string"})
        
        # Basic integer non-nullable
        t2 = openapi_type({"type": "number"})
        self.assertEqual(t2, {"type": "integer"})
        
        # Basic json non-nullable
        t3 = openapi_type({"type": "json"})
        self.assertEqual(t3, {})
        
        # Nullable string
        t4 = openapi_type({"type": "string", "nullable": True})
        self.assertIn("oneOf", t4)
        self.assertEqual(len(t4["oneOf"]), 2)
        self.assertIn({"type": "string"}, t4["oneOf"])
        self.assertIn({"type": "null"}, t4["oneOf"])

        # Nullable ANY type (e.g., json)
        t5 = openapi_type({"type": "json", "nullable": True})
        self.assertEqual(t5, {})  # Handled nicely, returning {}

    def test_build_entity_schema(self):
        """Test schema construction for an entire entity."""
        mock_entity = {
            "tag": "test_tag",
            "fields": [
                {"name": "asn", "type": "number", "nullable": False},
                {"name": "name", "type": "string", "nullable": True}
            ]
        }
        schema = build_entity_schema(mock_entity)
        
        # Check standard properties are injected
        self.assertIn("id", schema["properties"])
        self.assertIn("status", schema["properties"])
        
        # Check mapped properties
        self.assertIn("asn", schema["properties"])
        self.assertEqual(schema["properties"]["asn"]["type"], "integer")
        
        self.assertIn("name", schema["properties"])
        self.assertIn("oneOf", schema["properties"]["name"])
        
        # Required array
        self.assertIn("id", schema["required"])
        self.assertIn("status", schema["required"])
        self.assertIn("asn", schema["required"])
        self.assertNotIn("name", schema["required"]) # nullable fields aren't required
        
if __name__ == '__main__':
    unittest.main()
