# Fleet Assistant (ITS RAG + live fleet state) — Plan

## Goal

An assistant panel in the operator dashboard that answers Korean questions
about the **current fleet state** and produces an **on-demand fleet status
report**, grounded in **KOSHA transport safety guides** (ITS domain, not the
CIDC infectious-disease corpus).

Decisions (from the operator):

| Topic | Decision |
|---|---|
| UI | Operator web panel |
| Fleet data | Real vehicles, virtual scenarios, vision detections/alerts |
| Documents | KOSHA guides on transport rules and safety only |
| Output | Q&A chat + on-demand structured report |

## Architecture

```text
operator-web  ──POST /api/v1/assistant/chat──►  p4 Node
                                                  │ 1. build fleet snapshot (read-only DB queries)
                                                  │ 2. render compact Korean snapshot text
                                                  ▼
                                   pce assistant API  POST /v1/assistant/chat
                                                  │ 3. hybrid search: KOSHA transport collection
                                                  │    (Qdrant dense+BM25, MongoDB parents)
                                                  │ 4. EXAONE4.5 with snapshot + guide context
                                                  ▼
                                   answer + KOSHA sources  ──►  Node  ──►  panel
```

Responsibilities stay separated: p4 owns fleet data and access control; the
RAG project (`E:\project_chatbot\pce`) owns documents, retrieval and the LLM.
The RAG API accepts the snapshot as opaque text, so it stays domain-neutral.

## Components

### 1. pce: KOSHA transport corpus (PDF ingestion)

* PyMuPDF text extraction per page → `Block`s → existing
  `build_structure` / `chunk_document` (KOSHA guides use the numbered
  "1. 목적 / 2. 적용범위 / 3. 용어의 정의" structure the HTML path already
  understands). Repeated page headers/footers are dropped.
* Curated document list (`config/its-kosha-transport.files.txt`) selected
  from `E:\project3\kosha\kosha_pdfs_current` — vehicle operation, trucks,
  forklifts, loading/unloading, hazardous-material transport, driver
  fitness. Plant "운전 (operation)" guides are excluded.
* New config `config/its-kosha-transport.toml`: collection
  `its-kosha-transport`, MongoDB database `its`, Qdrant
  `http://10.174.96.119:36333`, Qwen3-Embedding-8B, EXAONE4.5.
* Indexing is run manually once the services are up.

### 2. pce: assistant HTTP API

`POST /v1/assistant/chat`

```json
{ "question": "...", "mode": "qa" | "report", "live_context": "...", "top_k": 5 }
```

returns `{ answer, sources[], model, retrieval_ms, generation_ms }`.
Health: `GET /health`. FastAPI + uvicorn, run with
`uv run uvicorn serve.api:app --host 0.0.0.0 --port 18080`.

Prompts: ITS fleet-operations assistant; fleet facts only from the live
snapshot, rules only from retrieved KOSHA text with `[S1]` citations, say so
when evidence is missing, never invent numbers.

### 3. p4 Node: read-only fleet snapshot

`GET /api/v1/fleet/summary` (ADMIN/OPERATOR/VIEWER). Read-only Prisma
queries — **not** `GET /tracking/vehicles`, which upserts BIMS vehicles and
persists history on every call:

* Real vehicles: status counts by source, latest position age per vehicle,
  stale telemetry (no fix > 2 min), active trips.
* Virtual scenarios (active): vehicles by simulation status (DRIVING,
  BLOCKED_AWAITING_OPERATOR, NO_ROUTE, …), active restrictions, recent
  operator events.
* Vision: detection events and alerts in the last 30 minutes by risk level,
  unconfirmed alerts.

The snapshot is rendered to a compact Korean text block (bounded size)
for the LLM.

### 4. p4 Node: assistant proxy

`POST /api/v1/assistant/chat` (ADMIN/OPERATOR/VIEWER) → builds the snapshot,
calls `ASSISTANT_BASE_URL` (env; the pce API), returns the answer, sources
and the snapshot time. In **report** mode the numeric sections (counts,
lists) are generated deterministically by Node from the snapshot; the LLM
only writes the narrative assessment and KOSHA-based recommendations, so
report figures cannot be hallucinated.

### 5. operator-web: assistant panel

A collapsible panel: message list, input, **현황 보고서** button, KOSHA
source chips per answer, snapshot timestamp, loading/error states.

## Context budget

EXAONE4.5 is served with `max_model_len = 8192` tokens. Budget per request:
system prompt ~400 tokens, snapshot ≤ 2,500 chars, KOSHA context ≤ 4,000
chars, answer `max_tokens` 1,000.

## Deployment

The pce API runs as a separate container, `p4-assistant`, on the same host
and Compose network as p4-node (opt-in `assistant` profile, built from a
pce checkout next to this repository). p4-node reaches it at
`ASSISTANT_BASE_URL` (default `http://p4-assistant:18080`); MongoDB
credentials come from the host `.env` as `ASSISTANT_PARENT_MONGO_URL`.
See "Fleet assistant" in `docs/integration/DOCKER_OPERATIONS.md`.

## Commits

pce: (1) PDF ingestion + KOSHA transport config, (2) assistant API.
p4: (3) fleet snapshot endpoint, (4) assistant proxy + report,
(5) operator panel. Each with tests.

## Not in scope (first version)

Streaming responses, conversation memory beyond the current exchange,
scheduled reports, writing anything back to the fleet from the assistant.
