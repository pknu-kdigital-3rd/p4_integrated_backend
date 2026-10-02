"""Qdrant collection, payload, and point-building helpers.

One collection, two named vectors: 'dense' (Qwen3, cosine) and 'sparse'
(BM25 with server-side IDF). Only child chunks are indexed here; context
parents live in the parent store and are joined at retrieval time.
qdrant-client is imported lazily so this module loads without it.
"""
from __future__ import annotations

import time
import uuid

from core.config import IndexConfig

# Payload fields copied from a chunk record.  Keeping this next to point
# construction makes the complete Qdrant storage contract visible in one module.
_PAYLOAD_FIELDS = (
    "doc_id", "parent_id", "clause", "heading_path", "level",
    "page_start", "page_end",
    "title", "source_relpath", "category", "subcategory", "category_path",
)


def point_id(chunk_id: str) -> str:
    """Deterministic Qdrant UUID for a chunk id (stable re-index)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(chunk_id)))


def to_payload(rec: dict) -> dict:
    """Flatten a child record into a Qdrant point payload."""
    payload: dict = {
        "chunk_id": rec.get("child_id") or rec.get("parent_id"),
        "text": rec.get("text", ""),
    }
    for key in _PAYLOAD_FIELDS:
        value = rec.get(key)
        if value is not None and value != [] and value != "":
            payload[key] = value
    return payload


def ensure_collection(client, cfg: IndexConfig) -> None:
    """Create `cfg.collection` if missing; if it exists, validate its dense dim matches.

    A fresh collection is created with a `dense` named vector
    (`cfg.embed_dim`, cosine distance) and a `sparse` named vector with
    IDF modifier enabled server-side (required for BM25-style scoring).

    Args:
        client: a QdrantClient (see `make_client`).
        cfg: index settings; `cfg.collection` and `cfg.embed_dim` are used.

    Raises:
        ValueError: the collection already exists with a different dense
            vector size than `cfg.embed_dim` — indicates an embedding-model
            change that requires dropping/recreating the collection rather
            than upserting into it.
    """
    from qdrant_client import models
    if client.collection_exists(cfg.collection):
        vectors = client.get_collection(cfg.collection).config.params.vectors or {}
        dense = vectors.get("dense") if isinstance(vectors, dict) else vectors
        existing = getattr(dense, "size", None)
        if existing is not None and existing != cfg.embed_dim:
            raise ValueError(
                f"collection '{cfg.collection}' dense dim {existing} != embed_dim {cfg.embed_dim}; "
                "drop the collection or fix embed_dim")
        return
    client.create_collection(
        collection_name=cfg.collection,
        vectors_config={"dense": models.VectorParams(size=cfg.embed_dim,
                                                     distance=models.Distance.COSINE)},
        sparse_vectors_config={"sparse": models.SparseVectorParams(modifier=models.Modifier.IDF)},
    )


def build_points(payloads: list[dict], dense: list[list[float]], sparse: list[dict]):
    """Combine payloads + both vectors into qdrant PointStructs."""
    from qdrant_client import models
    if not (len(payloads) == len(dense) == len(sparse)):
        raise ValueError("payloads, dense and sparse must be the same length")
    return [
        models.PointStruct(
            id=point_id(p["chunk_id"]),
            vector={"dense": d, "sparse": models.SparseVector(**s)},
            payload=p,
        )
        for p, d, s in zip(payloads, dense, sparse)
    ]


def make_client(cfg: IndexConfig):
    """Build a `QdrantClient` from `cfg` (url, optional api key, timeout)."""
    from qdrant_client import QdrantClient
    return QdrantClient(url=cfg.qdrant_url, api_key=cfg.qdrant_api_key or None,
                        timeout=cfg.qdrant_timeout)


def upsert_with_retry(client, cfg: IndexConfig, points):
    """Upsert one batch, surviving transient Qdrant disconnects.

    A long index run occasionally hits 'Server disconnected without sending a
    response' (Qdrant restart, dropped keep-alive, load spike). Retry with a
    fresh client so one blip doesn't sink the whole run. Upserts are idempotent
    (deterministic point ids), so re-sending a batch is safe. Returns the client
    to use next (possibly reconnected).
    """
    from qdrant_client.http.exceptions import (
        ResponseHandlingException,
        UnexpectedResponse,
    )
    transient = (ResponseHandlingException, UnexpectedResponse, ConnectionError, OSError)
    last: Exception | None = None
    for attempt in range(1, max(1, cfg.upsert_retries) + 1):
        try:
            client.upsert(collection_name=cfg.collection, points=points, wait=True)
            return client
        except transient as exc:  # noqa: PERF203
            last = exc
            if attempt >= cfg.upsert_retries:
                break
            delay = min(2.0 * attempt, 20.0)
            print(f"  ! qdrant upsert failed ({type(exc).__name__}); "
                  f"retry {attempt}/{cfg.upsert_retries - 1} in {delay:.0f}s", flush=True)
            time.sleep(delay)
            try:
                client = make_client(cfg)   # reconnect
            except Exception:  # noqa: BLE001
                pass
    raise RuntimeError(f"qdrant upsert failed after {cfg.upsert_retries} attempts") from last
