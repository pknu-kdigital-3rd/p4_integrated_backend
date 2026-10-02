# ITS fleet assistant (`p4-llm`)

Answers operator questions and writes fleet reports for the dashboard's
AI 도우미 panel. p4-node sends the current fleet snapshot as text
(`POST /v1/assistant/chat`); this service retrieves KOSHA transport-guide
evidence (Qdrant dense + BM25 hybrid search, MongoDB parent chunks) and asks
an OpenAI-compatible LLM (EXAONE4.5) for a grounded Korean answer.

Originally developed in the separate `pce` RAG project; vendored here with
only the ITS path (KOSHA GUIDE PDFs). Design: `docs/fleet_assistant_plan.md`.

| Path | Purpose |
|---|---|
| `src/serve/api.py` | FastAPI app: `/v1/assistant/chat`, `/health` |
| `src/index/pipeline.py` | Build and index the corpus (`python -m index.pipeline`) |
| `src/index/pdf/` | KOSHA GUIDE PDF parsing |
| `config/its-kosha-transport.toml` | Defaults; deployment overrides with env |
| `config/its-kosha-transport.files.txt` | The 27 indexed KOSHA guides |

Configuration: the TOML holds defaults; `KINDEX_*` / `KSERVE_*` environment
variables override them. In Docker these are set by Compose from the host's
`LLM_*` variables (see "Fleet assistant" in
`docs/integration/DOCKER_OPERATIONS.md`).

```powershell
cd services/llm
uv sync
uv run python -m unittest discover -s tests
# rebuild the index (needs the KOSHA PDF folder and MongoDB credentials):
$env:KCHUNK_PATHS_CORPUS_DIR = "E:/project3/kosha/kosha_pdfs_current"
$env:KINDEX_PARENT_MONGO_URL = "mongodb://USER:PASSWORD@10.174.96.119:37017/?authSource=admin"
$env:PYTHONPATH = "src"
uv run python -m index.pipeline --recreate --search "지게차 보행자 통로"
```

`--build-only` parses and chunks without any network access. The API runs
with `uvicorn serve.api:app --app-dir src --port 18080`.
