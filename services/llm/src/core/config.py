"""Configuration for indexing, embeddings, and notebook-time chunking.

Precedence (low -> high): TOML file < environment variables.

    Chunk settings use ``KCHUNK_*`` environment overrides; index settings use
    ``KINDEX_*`` overrides.  No absolute path lives in code.
"""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, fields, replace
from pathlib import Path


@dataclass(frozen=True)
class Paths:
    corpus_dir: Path = Path("corpus")
    out_dir: Path = Path("out")
    # Optional list of corpus-relative file names to index (one per line,
    # '#' comments). Empty means every supported file under corpus_dir.
    include_file: str = ""

    def resolved(self) -> "Paths":
        """A copy with `~` expanded in every path (paths are not made absolute)."""
        return Paths(Path(self.corpus_dir).expanduser(), Path(self.out_dir).expanduser(),
                     str(Path(self.include_file).expanduser()) if self.include_file else "")


@dataclass(frozen=True)
class Chunk:
    # small-to-big retrieval: embed CHILD chunks for search, fetch PARENT for answering
    child_target: int = 450       # fine-grained chunk embedded for retrieval
    child_max: int = 700
    parent_max: int = 3000        # a parent larger than this splits into parent-parts
    min_chars: int = 150          # merge leaf sections smaller than this into a sibling
    parent_scope: str = "section"  # "section" (one clause) | "parent_clause" (roll up)


@dataclass(frozen=True)
class Config:
    paths: Paths = field(default_factory=Paths)
    chunk: Chunk = field(default_factory=Chunk)

    @classmethod
    def load(cls, path: str | Path | None = None) -> "Config":
        """Load TOML (if given), then apply ``KCHUNK_*`` environment overrides."""
        data: dict = {}
        if path is not None:
            with open(path, "rb") as fh:
                data = tomllib.load(fh)

        cfg = _apply_env(cls(
            paths=_build(Paths, data.get("paths", {})),
            chunk=_build(Chunk, data.get("chunk", {})),
        ))
        return replace(cfg, paths=cfg.paths.resolved())


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _coerce(current, value):
    """Coerce a string/other value to the type of the existing field value."""
    if isinstance(current, Path):
        return Path(value)
    if isinstance(current, bool):
        return value if isinstance(value, bool) else str(value).lower() in {"1", "true", "yes", "on"}
    if isinstance(current, int):
        return int(value)
    if isinstance(current, float):
        return float(value)
    if isinstance(current, str):
        return str(value)
    return value


def _build(cls, section: dict):
    """Build one config dataclass (`cls`) from its TOML section dict, coercing values to each field's declared type and ignoring unknown keys."""
    obj = cls()
    known = {f.name for f in fields(cls)}
    kw = {k: _coerce(getattr(obj, k), v) for k, v in section.items() if k in known}
    return replace(obj, **kw) if kw else obj


_ENV_MAP = {"paths": Paths, "chunk": Chunk}  # KCHUNK_<SECTION>_<FIELD>


def _apply_env(cfg: "Config") -> "Config":
    """Overlay ``KCHUNK_<SECTION>_<FIELD>`` values onto ``cfg``."""
    updates: dict[str, dict] = {sec: {} for sec in _ENV_MAP}
    for key, val in os.environ.items():
        if not key.startswith("KCHUNK_"):
            continue
        rest = key[len("KCHUNK_"):].lower()
        for sec in _ENV_MAP:
            prefix = sec + "_"
            if rest.startswith(prefix):
                field_name = rest[len(prefix):]
                sub = getattr(cfg, sec)
                if any(f.name == field_name for f in fields(sub)):
                    updates[sec][field_name] = _coerce(getattr(sub, field_name), val)
    for sec, kw in updates.items():
        if kw:
            cfg = replace(cfg, **{sec: replace(getattr(cfg, sec), **kw)})
    return cfg


@dataclass(frozen=True)
class IndexConfig:
    """Qdrant, embedding, retrieval, and MongoDB parent-store settings."""

    # Qdrant
    qdrant_url: str = "http://10.174.96.95:6333"
    qdrant_api_key: str = ""
    collection: str = "its-kosha-transport"
    # dense embedding: an OpenAI-compatible /embeddings endpoint
    embed_model: str = "Qwen/Qwen3-Embedding-8B"
    embed_dim: int = 4096
    embed_batch: int = 32
    embed_endpoint: str = "http://10.174.96.95:18000/v1"
    # Qwen3-Embedding instruction prepended to QUERIES only (documents are
    # embedded without it, so changing it needs no re-index).
    query_instruction: str = "주어진 질의에 답이 되는 KOSHA 운송·차량 안전지침 구절을 검색한다"
    # sparse (Kiwi -> FastEmbed BM25)
    sparse_model: str = "Qdrant/bm25"
    # indexing
    upsert_batch: int = 256
    qdrant_timeout: float = 60.0
    upsert_retries: int = 5
    # retrieval
    prefetch: int = 40
    top_k: int = 8
    # parent storage: jsonl keeps a local copy; mongodb is used in deployment
    parent_store: str = "jsonl"       # jsonl | mongodb
    parent_mongo_url: str = "mongodb://127.0.0.1:27017"
    parent_mongo_database: str = "rag"
    parent_mongo_collection: str = "parents"
    parent_mongo_timeout_ms: int = 5000

    @classmethod
    def load(cls, path: str | Path | None = None) -> "IndexConfig":
        """Load an ``[index]`` TOML table, then ``KINDEX_*`` environment overrides."""
        data: dict = {}
        if path is not None:
            with open(path, "rb") as fh:
                data = tomllib.load(fh).get("index", {})
        cfg = cls()
        merged = {f.name: data[f.name] for f in fields(cls) if f.name in data}
        for f in fields(cls):
            env = os.environ.get(f"KINDEX_{f.name.upper()}")
            if env is not None:
                merged[f.name] = env
        for k, v in merged.items():
            merged[k] = _coerce(getattr(cfg, k), v)
        return replace(cfg, **merged) if merged else cfg
