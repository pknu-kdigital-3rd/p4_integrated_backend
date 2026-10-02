"""Dense (Qwen3-Embedding-8B) + sparse (Kiwi -> BM25) embedding.

Dense runs against an OpenAI-compatible ``/embeddings`` endpoint
(``IndexConfig.embed_endpoint``), so no embedding model is loaded in this
process. Sparse is Kiwi content-morpheme tokens -> FastEmbed 'Qdrant/bm25'
-> Qdrant sparse vector.

Heavy deps (requests, fastembed) are imported lazily so the pure modules
import without them.
"""
from __future__ import annotations

from .config import IndexConfig
from .korean_tokenizer import tokenize_to_text

_SPARSE_MODEL = None


def embed_dense(texts: list[str], cfg: IndexConfig, *, is_query: bool = False) -> list[list[float]]:
    """Dense-embed `texts` by POSTing to `cfg.embed_endpoint` in `cfg.embed_batch` batches.

    Args:
        texts: raw passage texts (index-time) or query texts (`is_query`).
        cfg: embedding settings (`embed_model`, `embed_batch`, `embed_endpoint`).
        is_query: prepend the Qwen3 retrieval instruction prefix used for
            queries; document texts get no prefix. Must match how the
            corresponding vectors were indexed.

    Returns:
        One embedding vector (list of floats) per input text, same order,
        `[]` if `texts` is empty. Response items are re-sorted by their
        `index` field, since a server need not preserve request order.

    Note:
        Index-time and query-time calls must use the *same* `cfg.embed_model`
        — this function does not check that; a mismatch silently produces
        vectors in different embedding spaces and cosine similarity in
        Qdrant becomes meaningless.
    """
    if not texts:
        return []
    if not cfg.embed_endpoint:
        raise RuntimeError("no embedding endpoint configured (index.embed_endpoint)")
    import requests

    # Qwen3-Embedding retrieval instruction for QUERIES (documents get none).
    prefix = f"Instruct: {cfg.query_instruction}\nQuery: "
    inputs = [f"{prefix}{t}" for t in texts] if is_query else texts
    out: list[list[float]] = []
    headers = {"Content-Type": "application/json"}
    if cfg.qdrant_api_key:  # reuse key mechanism if the endpoint needs auth
        headers["Authorization"] = f"Bearer {cfg.qdrant_api_key}"
    for i in range(0, len(inputs), cfg.embed_batch):
        batch = inputs[i:i + cfg.embed_batch]
        r = requests.post(f"{cfg.embed_endpoint.rstrip('/')}/embeddings",
                          headers=headers, json={"model": cfg.embed_model, "input": batch},
                          timeout=120)
        r.raise_for_status()
        data = sorted(r.json()["data"], key=lambda x: x.get("index", 0))
        out.extend([float(x) for x in item["embedding"]] for item in data)
    return out


def embed_sparse(texts: list[str], cfg: IndexConfig, *, is_query: bool = False) -> list[dict]:
    """Kiwi-tokenize, then BM25 -> Qdrant sparse vectors {indices, values}."""
    if not texts:
        return []
    global _SPARSE_MODEL
    from fastembed import SparseTextEmbedding
    if _SPARSE_MODEL is None:
        _SPARSE_MODEL = SparseTextEmbedding(model_name=cfg.sparse_model, disable_stemmer=True)
    prepared = [tokenize_to_text(t) for t in texts]
    items = (_SPARSE_MODEL.query_embed(prepared) if is_query else _SPARSE_MODEL.embed(prepared))
    return [{"indices": [int(i) for i in it.indices.tolist()],
             "values": [float(v) for v in it.values.tolist()]} for it in items]
