"""Filesystem anchor for relative config and output paths."""
from pathlib import Path

# services/llm: config/ and out/ are resolved against this directory.
SERVICE_ROOT = Path(__file__).resolve().parents[2]
