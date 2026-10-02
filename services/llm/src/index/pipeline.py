"""Build and index the ITS assistant's KOSHA transport-guide corpus.

Parses the curated KOSHA GUIDE PDFs into small-to-big chunks, embeds the
child chunks into Qdrant (dense Qwen3-Embedding + sparse BM25), and writes
parent chunks to MongoDB, which the assistant API expands at query time.

Run from services/llm with ``PYTHONPATH=src`` (the corpus path and
credentials come from the environment, e.g. KCHUNK_PATHS_CORPUS_DIR and
KINDEX_PARENT_MONGO_URL)::

    uv run python -m index.pipeline --build-only          # parse/chunk only
    uv run python -m index.pipeline --recreate            # rebuild the index

``--recreate`` drops only the configured collection and parent collection.
"""
from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from dataclasses import dataclass, replace
from pathlib import Path

from core import embedding
from core.config import Config, IndexConfig
from core.parent_store import MongoParentWriter, load_mongo
from core.paths import SERVICE_ROOT
from index import vector_store
from index.chunk import chunk_document, to_dicts
from index.pdf import extract_pdf_document
from serve import rag as retrieval

DEFAULT_CONFIG = "config/its-kosha-transport.toml"
# Document metadata copied onto every chunk record (and so into the payload).
_DOC_FIELDS = ("title", "source_relpath", "category", "subcategory", "category_path")


def _service_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else SERVICE_ROOT / path


@dataclass(frozen=True)
class BuildStats:
    documents: int
    parents: int
    children: int


class IndexPipeline:
    """Parse -> chunk -> embed -> upsert, with the parents kept for MongoDB."""

    def __init__(self, config: str | Path = DEFAULT_CONFIG) -> None:
        config = _service_path(config)
        chunk_cfg = Config.load(config)
        paths = chunk_cfg.paths
        self.chunk_cfg = replace(chunk_cfg, paths=replace(
            paths, corpus_dir=_service_path(paths.corpus_dir), out_dir=_service_path(paths.out_dir)))
        self.index_cfg = IndexConfig.load(config)
        self.corpus_dir = self.chunk_cfg.paths.corpus_dir
        self.out_dir = self.chunk_cfg.paths.out_dir
        self._parents: list[dict] = []
        self._children: list[dict] = []

    def sources(self) -> list[Path]:
        """The listed corpus files (``[paths].include_file``), or every PDF."""
        include = self.chunk_cfg.paths.include_file
        if not include:
            return sorted(self.corpus_dir.rglob("*.pdf"))
        names = [line.strip() for line in _service_path(include).read_text(encoding="utf-8").splitlines()
                 if line.strip() and not line.lstrip().startswith("#")]
        paths = [self.corpus_dir / name for name in names]
        missing = [str(path) for path in paths if not path.is_file()]
        if missing:
            raise FileNotFoundError("listed corpus files not found: " + ", ".join(missing))
        return paths

    def build(self) -> BuildStats:
        """Parse and chunk the corpus; no network calls."""
        self._parents, self._children = [], []
        paths = self.sources()
        for number, source in enumerate(paths, 1):
            doc = extract_pdf_document(source, self.corpus_dir)
            parents, children = chunk_document(doc, self.chunk_cfg.chunk)
            meta = {key: getattr(doc.meta, key) for key in _DOC_FIELDS}
            self._parents.extend({**record, **meta} for record in to_dicts(parents))
            self._children.extend({**record, **meta} for record in to_dicts(children))
            if number == 1 or number % 10 == 0 or number == len(paths):
                print(f"built {number}/{len(paths)}: {unicodedata.normalize('NFC', source.name)}", flush=True)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        with (self.out_dir / "index_parents.jsonl").open("w", encoding="utf-8") as fh:
            for parent in self._parents:
                fh.write(json.dumps(parent, ensure_ascii=False) + "\n")
        return BuildStats(len(paths), len(self._parents), len(self._children))

    def index(self, recreate: bool = False) -> int:
        """Embed children into Qdrant and write parents to MongoDB."""
        if not self._children:
            raise RuntimeError("call build() before index()")
        client = vector_store.make_client(self.index_cfg)
        if recreate and client.collection_exists(self.index_cfg.collection):
            client.delete_collection(self.index_cfg.collection)
        vector_store.ensure_collection(client, self.index_cfg)

        writer = MongoParentWriter(self.index_cfg) if self.index_cfg.parent_store == "mongodb" else None
        try:
            if writer is not None:
                if recreate:
                    writer.reset()
                for parent in self._parents:
                    writer.write(parent)
                writer.flush()
            for start in range(0, len(self._children), self.index_cfg.embed_batch):
                batch = self._children[start:start + self.index_cfg.embed_batch]
                texts = [child["text"] for child in batch]
                points = vector_store.build_points(
                    [vector_store.to_payload(child) for child in batch],
                    embedding.embed_dense(texts, self.index_cfg),
                    embedding.embed_sparse(texts, self.index_cfg),
                )
                for offset in range(0, len(points), self.index_cfg.upsert_batch):
                    client = vector_store.upsert_with_retry(
                        client, self.index_cfg, points[offset:offset + self.index_cfg.upsert_batch])
                print(f"indexed {min(start + len(batch), len(self._children))}/{len(self._children)}", flush=True)
        finally:
            if writer is not None:
                writer.close()
        return len(self._children)

    def search(self, question: str, top_k: int | None = None) -> list[dict]:
        """Hybrid search with parent expansion, as the assistant API runs it."""
        parents = load_mongo(self.index_cfg) if self.index_cfg.parent_store == "mongodb" else {}
        cfg = self.index_cfg if top_k is None else replace(self.index_cfg, top_k=top_k)
        return retrieval.retrieve(vector_store.make_client(cfg), cfg, question, parents)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--build-only", action="store_true", help="parse and chunk without indexing")
    parser.add_argument("--recreate", action="store_true", help="drop the collection and parent store first")
    parser.add_argument("--search", metavar="QUESTION", help="run one hybrid search after indexing")
    args = parser.parse_args(argv)

    pipeline = IndexPipeline(args.config)
    print(pipeline.build(), flush=True)
    if not args.build_only:
        print("indexed:", pipeline.index(recreate=args.recreate), flush=True)
    if args.search:
        for rank, result in enumerate(pipeline.search(args.search, top_k=5), 1):
            print(f"{rank}. {result.get('score', 0):.4f} {result.get('doc_id')} | {result.get('heading_path')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
