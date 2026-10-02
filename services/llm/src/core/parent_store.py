"""Parent-chunk persistence.

Qdrant stores the searchable child vectors.  Parent chunks are kept in MongoDB
for the configured deployment and mirrored to JSONL for export/debugging.
"""
from __future__ import annotations

def _auth_error(exc: Exception) -> RuntimeError:
    if getattr(exc, "code", None) != 13:
        return RuntimeError(f"MongoDB parent store is unavailable: {exc}")
    return RuntimeError(
        "MongoDB parent-store authentication failed; set "
        "KINDEX_PARENT_MONGO_URL to an authenticated MongoDB URI"
    )


def _connect(cfg):
    """Open and ping a MongoDB client; return it with the parent collection.

    The client is closed again if the ping fails, so callers only own a client
    that reached the server.
    """
    try:
        from pymongo import MongoClient
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise RuntimeError(
            "MongoDB parent storage requires pymongo; run `uv sync`"
        ) from exc
    client = MongoClient(
        cfg.parent_mongo_url,
        serverSelectionTimeoutMS=cfg.parent_mongo_timeout_ms,
        connectTimeoutMS=cfg.parent_mongo_timeout_ms,
    )
    try:
        client.admin.command("ping")
    except Exception as exc:  # noqa: BLE001 -- preserve a useful deployment error
        client.close()
        raise _auth_error(exc) from exc
    return client, client[cfg.parent_mongo_database][cfg.parent_mongo_collection]


class MongoParentWriter:
    """Buffered upsert writer for parent records."""

    def __init__(self, cfg):
        self._client, self._collection = _connect(cfg)
        try:
            # an unauthenticated server answers ping but refuses the first write
            self._collection.create_index("parent_id", unique=True)
            self._collection.create_index("doc_id")
            self._collection.create_index("category_path")
        except Exception as exc:  # noqa: BLE001 -- preserve a useful deployment error
            self._client.close()
            raise _auth_error(exc) from exc
        self._buffer: list[dict] = []

    def reset(self) -> None:
        """Delete the configured parent collection for a fresh rebuild."""
        self._collection.delete_many({})

    def write(self, record: dict) -> None:
        self._buffer.append(record)
        if len(self._buffer) >= 500:
            self.flush()

    def flush(self) -> None:
        if not self._buffer:
            return
        from pymongo import UpdateOne
        self._collection.bulk_write(
            [UpdateOne({"parent_id": r["parent_id"]}, {"$set": r}, upsert=True)
             for r in self._buffer],
            ordered=False,
        )
        self._buffer.clear()

    def close(self) -> None:
        self.flush()
        self._client.close()


def load_mongo(cfg) -> dict[str, dict]:
    """Load parent records from MongoDB into the retrieval-time lookup map."""
    client, collection = _connect(cfg)
    try:
        return {r["parent_id"]: r for r in collection.find({}, {"_id": 0})
                if r.get("parent_id")}
    except Exception as exc:  # noqa: BLE001 -- auth errors occur on first query
        raise _auth_error(exc) from exc
    finally:
        client.close()
