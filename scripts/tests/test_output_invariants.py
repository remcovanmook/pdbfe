import unittest
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
EXTRACTED_DIR = REPO_ROOT / "extracted"
LIB_DIR = REPO_ROOT / "scripts" / "lib"

class TestOutputInvariants(unittest.TestCase):
    def test_entities_json(self):
        """Test extracted/entities.json is valid and contains standard entries."""
        path = EXTRACTED_DIR / "entities.json"
        self.assertTrue(path.exists(), "entities.json should exist")
        
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        self.assertIn("schema_version", data)
        self.assertIn("entities", data)
        entities = data["entities"]
        
        # Verify core entities exist
        core_tags = ["net", "ix", "fac", "org"]
        for tag in core_tags:
            self.assertIn(tag, entities, f"Missing core entity branch: {tag}")
            
    def test_openapi_json(self):
        """Test extracted/openapi.json is valid OpenAPI format."""
        path = EXTRACTED_DIR / "openapi.json"
        self.assertTrue(path.exists(), "openapi.json should exist")
        
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        self.assertIn("openapi", data)
        self.assertTrue(data["openapi"].startswith("3.1"), "Should be OpenAPI 3.1.x")
        self.assertIn("paths", data)
        self.assertIn("components", data)
        
        # Basic check for an endpoint
        self.assertIn("/v1/net", data["paths"])
        self.assertIn("/v1/net/{id}", data["paths"])

    def test_graphql_typedefs(self):
        """Test extracted/graphql-typedefs.js compiles as a valid template."""
        path = EXTRACTED_DIR / "graphql-typedefs.js"
        self.assertTrue(path.exists(), "graphql-typedefs.js should exist")
        
        content = path.read_text(encoding="utf-8")
        self.assertIn("export const typeDefs =", content)
        self.assertIn("type Query {", content)
        self.assertIn("networkByAsn(asn: Int!): Network", content)
        
    def test_graphql_resolvers(self):
        """Test extracted/graphql-resolvers.js contains basic mappings."""
        path = EXTRACTED_DIR / "graphql-resolvers.js"
        self.assertTrue(path.exists(), "graphql-resolvers.js should exist")
        
        content = path.read_text(encoding="utf-8")
        self.assertIn("export const resolvers =", content)
        self.assertIn("networkByAsn:", content)
        self.assertIn("listResolver('net')", content)

    def test_lib_integrity(self):
        """Test the integrity of static files in scripts/lib/."""
        # Check entity-overrides.json
        overrides = LIB_DIR / "entity-overrides.json"
        self.assertTrue(overrides.exists(), "entity-overrides.json should exist")
        with open(overrides, "r", encoding="utf-8") as f:
            data = json.load(f)
            self.assertIsInstance(data, dict)
            
        # Check graphql_resolvers.template.js
        template = LIB_DIR / "graphql_resolvers.template.js"
        self.assertTrue(template.exists(), "graphql_resolvers.template.js should exist")
        content = template.read_text(encoding="utf-8")
        self.assertIn("function listResolver(", content)
        self.assertNotIn("{{", content, "Should not contain raw Jinja tags")
        
        # Check SQL files
        for sql_file in ["fk_cleanup.sql", "fk_verify.sql"]:
            path = LIB_DIR / sql_file
            self.assertTrue(path.exists())
            self.assertGreater(len(path.read_text()), 10)

if __name__ == '__main__':
    unittest.main()
