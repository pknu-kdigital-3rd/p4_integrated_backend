"""Deployment configuration comes from the environment (Compose)."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from core.config import IndexConfig  # noqa: E402
from serve.llm import ServeConfig  # noqa: E402

CONFIG = Path(__file__).resolve().parents[1] / "config" / "its-kosha-transport.toml"


class ConfigFromEnvironmentTests(unittest.TestCase):
    def test_toml_defaults(self):
        with patch.dict(os.environ, {}, clear=False):
            for key in [k for k in os.environ if k.startswith(("KINDEX_", "KSERVE_"))]:
                os.environ.pop(key)
            index = IndexConfig.load(CONFIG)
            serve = ServeConfig.load(CONFIG)
        self.assertEqual(index.collection, "its-kosha-transport")
        self.assertIn("KOSHA", index.query_instruction)
        self.assertEqual([endpoint.model for endpoint in serve.endpoints], ["EXAONE4.5"])

    def test_index_settings_and_credentials_come_from_the_environment(self):
        env = {"KINDEX_QDRANT_URL": "http://qdrant:6333", "KINDEX_PARENT_MONGO_URL": "mongodb://u:p@mongo:27017/?authSource=admin",
               "KINDEX_TOP_K": "4"}
        with patch.dict(os.environ, env):
            index = IndexConfig.load(CONFIG)
        self.assertEqual(index.qdrant_url, "http://qdrant:6333")
        self.assertEqual(index.parent_mongo_url, "mongodb://u:p@mongo:27017/?authSource=admin")
        self.assertEqual(index.top_k, 4)

    def test_chat_endpoint_can_be_replaced_from_the_environment(self):
        with patch.dict(os.environ, {"KSERVE_LLM_BASE_URL": "http://vllm:8000/v1", "KSERVE_LLM_MODEL": "other-model"}):
            serve = ServeConfig.load(CONFIG)
        self.assertEqual([(e.base_url, e.model) for e in serve.endpoints], [("http://vllm:8000/v1", "other-model")])
        with patch.dict(os.environ, {"KSERVE_LLM_BASE_URL": "http://vllm:8000/v1"}):
            os.environ.pop("KSERVE_LLM_MODEL", None)
            serve = ServeConfig.load(CONFIG)
        self.assertEqual(serve.endpoints[0].model, "EXAONE4.5")


if __name__ == "__main__":
    unittest.main()
