"""Query-time hybrid retrieval and minimal LLM context formatting.

The retrieval path is deliberately independent of a client UI or a particular
document dataset: Qdrant returns searchable children, then the configured
parent store expands them into answer context.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from core.config import IndexConfig


def build_context(parents: list[dict], max_chars: int) -> tuple[str, list[dict]]:
    """Build numbered evidence text and compact source metadata.

    Parent blocks are kept whole and added in rank order until the character
    budget is reached. The first result is always included.
    """
    blocks: list[str] = []
    sources: list[dict] = []
    used = 0
    for rank, parent in enumerate(parents, 1):
        heading = str(parent.get("heading_path") or parent.get("clause") or "").strip()
        body = str(parent.get("text") or "").strip()
        header = f"[S{rank}] {heading}".rstrip()
        block = f"{header}\n{body}" if body else header

        if used + len(block) > max_chars and blocks:
            break
        blocks.append(block)
        used += len(block) + 2

        source = {
            "rank": rank,
            "doc_id": parent.get("doc_id"),
            "source_relpath": parent.get("source_relpath"),
            "category_path": parent.get("category_path"),
            "heading_path": heading,
            "page_start": parent.get("page_start"),
            "page_end": parent.get("page_end"),
            "score": parent.get("score"),
            "matched_child": parent.get("matched_child"),
        }
        sources.append({key: value for key, value in source.items()
                        if value is not None and value != ""})

    return "\n\n".join(blocks), sources


@dataclass
class Hit:
    """One dense+sparse Qdrant result before parent expansion."""

    chunk_id: str
    text: str
    score: float
    payload: dict


def load_parents(path: str | Path) -> dict[str, dict]:
    """Load ``parent_id -> parent record`` from the JSONL parent store."""
    parents: dict[str, dict] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                record = json.loads(line)
                parents[record["parent_id"]] = record
    return parents


def hybrid_search(client, cfg: IndexConfig, query: str) -> list[Hit]:
    """Search child chunks with dense+sparse Qdrant RRF."""
    from qdrant_client import models
    from core import embedding

    dense = embedding.embed_dense([query], cfg, is_query=True)[0]
    sparse = embedding.embed_sparse([query], cfg, is_query=True)[0]
    response = client.query_points(
        collection_name=cfg.collection,
        prefetch=[
            models.Prefetch(query=dense, using="dense", limit=cfg.prefetch),
            models.Prefetch(query=models.SparseVector(**sparse), using="sparse",
                            limit=cfg.prefetch),
        ],
        query=models.FusionQuery(fusion=models.Fusion.RRF),
        limit=cfg.top_k, with_payload=True,
    )
    return [Hit(str((point.payload or {}).get("chunk_id") or point.id),
                str((point.payload or {}).get("text") or ""),
                float(point.score or 0.0), dict(point.payload or {}))
            for point in response.points]


def expand_parents(hits: list[Hit], parents: dict[str, dict]) -> list[dict]:
    """Expand each child hit to its context parent and deduplicate parents."""
    out: list[dict] = []
    seen: set[str] = set()
    for hit in hits:
        parent_id = hit.payload.get("parent_id")
        parent = parents.get(parent_id) if parent_id else None
        if parent is None:
            out.append({"score": hit.score, "matched_child": hit.chunk_id,
                        **hit.payload})
            continue
        if parent_id in seen:
            continue
        seen.add(parent_id)
        out.append({**parent, "score": hit.score,
                    "matched_child": hit.chunk_id, "matched_text": hit.text})
    return out


def retrieve(client, cfg: IndexConfig, query: str,
             parents: dict[str, dict]) -> list[dict]:
    """Run hybrid search and expand results to their context parents."""
    return expand_parents(hybrid_search(client, cfg, query), parents)
