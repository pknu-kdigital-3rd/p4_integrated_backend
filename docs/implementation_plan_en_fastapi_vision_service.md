
# FastAPI Vision Service
## Detailed Implementation Plan — v15 Architecture Baseline

**Role:** GPU-backed vision/inference service inside the larger Vehicle Intelligent Risk Detection & Route Control Platform  
**Not the role:** general business backend, operator authentication authority, route-control authority, replay/history API  
**Primary transport:** gRPC for high-frequency inference and live detection output  
**Secondary transport:** FastAPI HTTP for health/readiness/status/admin/diagnostics  
**Database rule:** vision-owned writes only; Prisma/Node owns migrations  

---

# 1. Mission

The FastAPI Vision Service turns camera frames into low-latency, auditable detection/risk results while remaining isolated from business/backend latency. Its core requirement is not simply “run YOLO.” It must keep the GPU fed, preserve frame identity, emit detections fast enough for the live dashboard, persist important results without blocking inference, and consume configuration owned by Node without performing per-frame control-plane round trips.

The service is a single deployment unit containing:

```text
FastAPI HTTP control surface
        +
gRPC inference server
        +
GPU model runtime
        +
post-processing / distance / risk logic
        +
Node context cache
        +
Tauri detection streaming
        +
bounded persistence subsystem
        +
event-image object-storage client
```

The actual **Vision gRPC Endpoint** belongs here. Node/Express only returns its address during bootstrap/service discovery.

---

# 2. Responsibility Boundary

## 2.1 FastAPI Vision owns

- gRPC inference endpoint.
- Frame payload validation at the vision boundary.
- Image decode/resize/normalize preprocessing.
- GPU model lifecycle and inference.
- Detection post-processing.
- Optional object tracking.
- Distance estimation and risk classification.
- Detection response streamed/sent to Tauri.
- Model-version and inference-latency metadata.
- Vision-context cache populated from Node.
- Bounded asynchronous persistence queue.
- Writes to `frame_inference`.
- Writes to `detection_event` for selected/risk events.
- Writes to `event_image` metadata plus event-image upload.
- Vision-origin `alert` inserts when policy requires them.
- Vision-specific health/readiness/metrics.

## 2.2 FastAPI Vision does not own

- operator user/password lifecycle;
- RBAC policy authority;
- JWT issuance;
- Android device registration authority;
- general vehicle CRUD;
- driver CRUD;
- trip lifecycle writes;
- route creation/deviation/rerouting;
- GPS history;
- alert acknowledgement/operator notes;
- replay/history public API;
- Prisma migrations;
- direct live-frame relay from Android to Tauri.

---

# 3. Runtime Topology

A recommended process topology is one application container/process group per GPU allocation:

```text
                         ┌───────────────────────────────┐
HTTP :8xxx ─────────────►│ FastAPI app                  │
                         │ health / ready / metrics     │
                         │ status / model info          │
                         ├───────────────────────────────┤
gRPC :5xxxx ────────────►│ grpc.aio server              │
                         │ VisionInference service      │
                         ├───────────────────────────────┤
                         │ Shared application state     │
                         │ - model runtime              │
                         │ - context cache              │
                         │ - persistence queue          │
                         │ - object storage client      │
                         └──────────────┬────────────────┘
                                        │
                                        ▼
                                      GPU
```

The HTTP and gRPC servers should share the same loaded model rather than starting independent workers that duplicate VRAM unless deliberate multi-worker GPU partitioning is introduced later.

---

# 4. Technology Baseline

A practical Python stack:

- Python 3.12-class runtime.
- FastAPI + Uvicorn for HTTP control endpoints.
- `grpcio` / `grpcio-tools`, preferably `grpc.aio` for async server integration.
- Pydantic v2 for configuration and HTTP schemas.
- PyTorch or TensorRT runtime depending on model export/performance stage.
- OpenCV/Pillow only where actually required for decode/preprocessing.
- NumPy for tensor preparation/post-processing.
- `httpx` for internal Node context calls.
- `asyncpg` or SQLAlchemy async for high-throughput DB writer.
- GeoAlchemy2/explicit PostGIS SQL for geography-bearing event writes where appropriate.
- S3-compatible SDK/client for event images.
- Prometheus/OpenTelemetry-compatible instrumentation as needed.
- `pytest`, `pytest-asyncio`, gRPC test clients, and Testcontainers or equivalent integration environment.

The code should not couple the application domain to one inference engine. Put the engine behind a small model-runtime interface so PyTorch → ONNX/TensorRT changes do not rewrite the gRPC or persistence layers.

---

# 5. Suggested Repository Structure

```text
backend-vision-fastapi/
├── pyproject.toml
├── README.md
├── proto/
│   └── vision/v1/vision.proto
├── app/
│   ├── main.py
│   ├── lifecycle.py
│   ├── config.py
│   ├── http/
│   │   ├── health.py
│   │   ├── status.py
│   │   └── metrics.py
│   ├── grpc/
│   │   ├── server.py
│   │   ├── interceptors.py
│   │   ├── mapper.py
│   │   └── vision_service.py
│   ├── auth/
│   │   ├── token_verifier.py
│   │   └── principals.py
│   ├── inference/
│   │   ├── runtime.py
│   │   ├── preprocess.py
│   │   ├── postprocess.py
│   │   ├── tracker.py
│   │   ├── distance.py
│   │   ├── risk.py
│   │   └── pipeline.py
│   ├── context/
│   │   ├── node_client.py
│   │   ├── cache.py
│   │   └── models.py
│   ├── persistence/
│   │   ├── queue.py
│   │   ├── worker.py
│   │   ├── db.py
│   │   ├── frame_writer.py
│   │   ├── event_writer.py
│   │   └── schemas.py
│   ├── storage/
│   │   └── event_image_store.py
│   ├── models/
│   │   ├── manifest.py
│   │   └── loader.py
│   └── observability/
│       ├── logging.py
│       └── metrics.py
├── tests/
│   ├── unit/
│   ├── grpc/
│   ├── integration/
│   └── replay/
└── deploy/
    ├── Dockerfile
    └── compose.override.yml
```

---

# 6. gRPC Contract

## 6.1 Design goals

The protobuf contract must be stable across Android, Tauri and FastAPI releases. It should represent domain information, not framework-specific tensors.

Requirements:
- protocol/package version in namespace (`vision.v1`);
- integer IDs with clear signed/unsigned semantics;
- canonical frame identity;
- source dimensions and encoding;
- model version in response;
- optional fields used carefully to preserve backward compatibility;
- bounded message sizes;
- explicit error status model.

## 6.2 Representative contract

```proto
syntax = "proto3";
package vision.v1;

message FrameEnvelope {
  string session_id = 1;
  uint64 frame_id = 2;
  uint64 capture_timestamp_ns = 3;
  int64 vehicle_id = 4;
  bytes image = 5;
  uint32 width = 6;
  uint32 height = 7;
  string encoding = 8;
  optional float pitch_deg = 9;
  optional float roll_deg = 10;
}

message Detection {
  int32 class_id = 1;
  string class_name = 2;
  string display_name = 3;
  float confidence = 4;
  float x1 = 5;
  float y1 = 6;
  float x2 = 7;
  float y2 = 8;
  optional int64 track_id = 9;
  optional float estimated_distance_m = 10;
  string risk_level = 11;
}

message DetectionFrame {
  string session_id = 1;
  uint64 frame_id = 2;
  uint64 capture_timestamp_ns = 3;
  int64 vehicle_id = 4;
  string model_version = 5;
  float inference_latency_ms = 6;
  repeated Detection detections = 7;
}
```

The final contract can use unary, client-streaming or bidirectional streaming depending on measured throughput. For sustained camera inference, bidirectional streaming usually avoids per-frame connection/setup overhead and allows results to flow independently.

## 6.3 Flow control

Do not allow an unbounded list of pending frames. Choose a maximum in-flight budget per stream/device. When the service is saturated, prefer a documented policy such as:

- reject with resource-exhausted status;
- drop/replace stale not-yet-processed frames at the client;
- apply inference sampling before transmission.

For a live safety system, processing a very stale queue of frames is usually worse than maintaining bounded latency.

---

# 7. Authentication and Authorization

FastAPI is not an auth authority. It validates credentials issued by Node.

## 7.1 Recommended mechanism

- Node signs JWTs with asymmetric keys.
- FastAPI has the verification public key/JWKS.
- gRPC metadata carries `authorization: Bearer ...`.
- A gRPC interceptor verifies signature, issuer, audience, expiry and required scope.
- HTTP endpoints use the same verifier for protected diagnostic/admin endpoints.
- Public liveness can remain minimal and unauthenticated if deployment policy allows; readiness/model details may be restricted.

## 7.2 Example scopes

```text
vision:infer
vision:observe
vision:admin
internal:vision-context
```

Device tokens and operator tokens should not be interchangeable unless policy explicitly allows it.

---

# 8. Node-Owned Context Cache

The vision pipeline needs configuration that belongs to Node:

| Data | Why Vision needs it | Cache behavior |
|---|---|---|
| camera calibration | distance projection | long TTL, refresh on version change |
| object class display/threshold policy | warning/danger decision | long TTL, policy-version aware |
| active trip id | persistence foreign key/context | short TTL or event invalidation |

A representative internal endpoint:

```text
GET /internal/vehicles/{vehicleId}/vision-context
```

Possible response:

```json
{
  "vehicleId": 12,
  "activeTripId": 991,
  "calibration": {
    "cameraHeightM": 1.72,
    "cameraPitchDeg": -3.2,
    "cameraRollDeg": 0.4,
    "cameraYawDeg": 0.0,
    "focalLengthMm": 4.3,
    "sensorWidthMm": 6.2
  },
  "policyVersion": "object-policy-18",
  "classes": [
    {"classId": 0, "displayName": "Person", "warningDistanceM": 7.5}
  ]
}
```

Failure behavior matters. If context is temporarily unavailable:
- existing unexpired cache can continue for a bounded period;
- stale-context age must be observable;
- if calibration is missing, do not invent distance values;
- if active trip is unknown, live detection may continue but persistence requiring a valid trip should follow an explicit fallback/quarantine policy.

---

# 9. Model Lifecycle

## 9.1 Startup

1. Parse and validate configuration.
2. Initialize logging/metrics.
3. Initialize DB and object-storage clients.
4. Load model manifest.
5. Load model artifact into GPU once.
6. Run a warmup inference.
7. Start context cache subsystem.
8. Start bounded persistence queue and worker.
9. Start gRPC server.
10. Mark readiness true only after the service can actually infer.

## 9.2 Model runtime interface

```python
class VisionRuntime(Protocol):
    @property
    def model_version(self) -> str: ...

    async def infer(self, image_batch: list[PreparedFrame]) -> list[RawOutput]: ...
```

Keep preprocessing/post-processing outside the engine wrapper where possible so output semantics remain testable without GPU execution.

## 9.3 Model upgrade

A simple baseline uses restart-to-upgrade:
- deploy new image/config;
- load candidate model;
- readiness stays false until warmup succeeds;
- traffic shifts after readiness;
- previous container remains available for rollback.

Hot model swapping can be added later but is not necessary for the first stable implementation.

---

# 10. Inference Pipeline

```text
FrameEnvelope
   ↓ validate identity / auth / dimensions
Decode image
   ↓
Preprocess
   ↓
GPU inference
   ↓
Postprocess (NMS / class mapping)
   ↓
Optional tracking
   ↓
Distance estimation
   ↓
Risk evaluation
   ├──► DetectionFrame → Tauri
   └──► PersistenceEnvelope → bounded queue
```

## 10.1 Validation

Reject or flag:
- empty/oversized image payload;
- unsupported encoding;
- invalid width/height;
- missing session identity;
- impossible frame ID values;
- unauthorized vehicle;
- timestamp outside defined domain if sanity checking is enabled.

Do not silently regenerate `session_id`, `frame_id` or `capture_timestamp_ns` on the server.

## 10.2 Preprocessing

Version preprocessing. Persist/configure enough information to reproduce model input behavior:
- resize strategy;
- letterbox parameters;
- normalization;
- channel order;
- quantization if applicable.

## 10.3 Batching

Start with batch size 1 if low latency is the priority. Introduce micro-batching only after measurement. A bounded micro-batcher can combine frames arriving within a very short window, but must not introduce unpredictable display latency.

## 10.4 Post-processing

Standardize results into project-domain detections. Avoid leaking model-library-specific structures beyond the inference module.

---

# 11. Distance Estimation and Risk Logic

Distance/risk code should be a deterministic application module with unit tests independent from the GPU model.

Inputs can include:
- bbox / contact point;
- source frame dimensions;
- camera intrinsics/calibration;
- camera height;
- configured static pitch/roll/yaw;
- instantaneous frame pitch/roll when available;
- object class warning threshold.

Outputs should distinguish:

```text
estimated_distance_m: number | null
risk_level: NORMAL | WARNING | DANGER | UNKNOWN
risk_reason: structured enum/code
```

Never emit a fake numeric distance when calibration/telemetry is insufficient. `UNKNOWN` is preferable to a fabricated estimate.

When creating `detection_event`, persist the relevant capture-time telemetry (`pitch_at_capture_deg`, `roll_at_capture_deg`, `telemetry_source`) required for later audit.

---

# 12. Tauri Detection Output

FastAPI's live output path must not wait for PostgreSQL. Sequence:

```text
postprocess complete
    ├── send DetectionFrame to Tauri
    └── enqueue persistence envelope
```

If Tauri is temporarily unavailable, define whether detections are simply dropped for the live path while persistent event logic continues. Do not let a slow dashboard connection block GPU inference globally.

If multiple dashboards may subscribe, add a fan-out layer with bounded per-subscriber queues; never maintain unbounded lists of pending frames.

---

# 13. Persistence Architecture

## 13.1 Why a bounded queue

An async database driver alone is not enough. This is wrong for the critical path:

```python
result = infer(frame)
await db.insert(result)   # inference waits for commit
```

Correct high-level pattern:

```text
GPU/postprocess
   ↓
construct PersistenceEnvelope
   ↓
queue.try_put(...)
   ↓
continue inference immediately

background worker
   ↓
batch by row count or short time window
   ↓
transactional INSERT/COMMIT
```

## 13.2 Queue priorities

Suggested logical classes:

- **P0 critical:** DANGER detection event / alert transaction.
- **P1 important:** WARNING event and event image metadata.
- **P2 telemetry:** ordinary `frame_inference` row.

If overload policy ever drops data, drop/sampling should target P2 before P0/P1.

## 13.3 `frame_inference`

Purpose:
- preserve inferred frame identity;
- model version;
- inference latency;
- frame-level detection JSON/summary as designed;
- support replay/debug/latency analysis.

Primary identity is `(session_id, frame_id)`.

## 13.4 `detection_event`

Create only for policy-selected significant events rather than every raw detection. Include:
- vehicle/trip;
- exact frame identity;
- capture time;
- class/display policy snapshot fields;
- confidence;
- estimated distance;
- warning threshold snapshot;
- spatial location if available according to schema;
- pitch/roll/telemetry source;
- risk level/severity.

## 13.5 Vision-origin alerts

Where the ERD requires an alert for a vision event, `detection_event` + associated `alert` should be committed coherently. The operator later acknowledges/updates that alert through Node.

## 13.6 Migration rule

FastAPI does **not** run Alembic/schema migrations for the shared DB. Prisma schema/migrations are the source of truth. CI should verify that FastAPI SQL/SQLAlchemy mappings still match the migrated test database.

---

# 14. Event Images

Event images are a secondary path:

1. Select image only for configured event types/severity.
2. Encode JPEG/WebP with bounded size.
3. Upload to object storage with deterministic object key.
4. Write `event_image` metadata referencing the object.
5. Do not block the initial live detection response on image upload.

A useful object key pattern:

```text
vision-events/{vehicle_id}/{trip_id}/{session_id}/{frame_id}/{event_id}.jpg
```

Avoid placing secrets or user-provided arbitrary paths into object keys.

---

# 15. HTTP Control Endpoints

Representative endpoints:

```text
GET /health/live
GET /health/ready
GET /status
GET /status/model
GET /metrics
```

`/health/live` answers whether the process is alive. `/health/ready` should fail until model warmup and required dependencies are sufficiently ready. Do not make liveness depend on PostgreSQL; a temporary DB outage should not cause an orchestrator to kill a healthy GPU inference process repeatedly.

Readiness can report degraded status if persistence is unavailable, depending on deployment policy.

---

# 16. Configuration

Use typed environment/config models. Representative categories:

```text
SERVER
- HTTP_HOST / PORT
- GRPC_HOST / PORT

MODEL
- MODEL_PATH
- MODEL_MANIFEST
- DEVICE
- PRECISION
- INPUT_SIZE

INFERENCE
- MAX_INFLIGHT_PER_STREAM
- CONFIDENCE_PROFILE
- MICRO_BATCH_MAX
- MICRO_BATCH_WAIT_MS

NODE_CONTEXT
- NODE_INTERNAL_BASE_URL
- CACHE_TTL_CALIBRATION_SEC
- CACHE_TTL_POLICY_SEC
- CACHE_TTL_ACTIVE_TRIP_SEC

PERSISTENCE
- DATABASE_URL
- QUEUE_CAPACITY
- BATCH_MAX_ROWS
- BATCH_MAX_WAIT_MS

OBJECT_STORAGE
- ENDPOINT
- BUCKET
- PREFIX

AUTH
- JWT_ISSUER
- JWT_AUDIENCE
- JWKS_URL or PUBLIC_KEY
```

Secrets must not be printed in startup logs.

---

# 17. Observability

## 17.1 Structured logs

Include when known:
- vehicle_id;
- trip_id;
- session_id;
- frame_id;
- model_version;
- gRPC stream/connection id;
- latency phase;
- event/alert id.

## 17.2 Metrics

Required first-class metrics:

```text
vision_frames_received_total
vision_frames_rejected_total
vision_inference_latency_ms
vision_preprocess_latency_ms
vision_postprocess_latency_ms
vision_detection_send_latency_ms
vision_active_streams
vision_context_cache_age_seconds
vision_persistence_queue_depth
vision_persistence_dropped_total
vision_persistence_batch_rows
vision_persistence_batch_latency_ms
vision_event_image_upload_latency_ms
vision_gpu_memory_bytes
```

## 17.3 Trace timeline

For debugging a particular frame, logs should allow reconstruction:

```text
capture_timestamp_ns
→ server receive
→ preprocess start/end
→ inference start/end
→ postprocess end
→ detection send
→ persistence enqueue
→ DB commit
```

---

# 18. Failure and Backpressure Policy

## Node unavailable
- Continue using valid cached context for a bounded period.
- Mark cache staleness metric.
- Do not invent missing configuration.

## PostgreSQL unavailable
- Continue inference/live detection.
- Queue only up to configured capacity.
- Apply documented priority/drop policy.
- Surface degraded persistence status.

## Object storage unavailable
- Continue live detection and DB event creation if possible.
- Mark image as pending/failed according to schema/workflow.
- Retry with bounded policy, not unbounded tasks.

## GPU OOM/model failure
- Mark readiness false.
- Fail new inference requests clearly.
- Capture diagnostics without automatically looping reloads indefinitely.

## Slow Tauri consumer
- Bound outbound detection queue.
- Drop stale live detections for that subscriber rather than blocking global inference.

---

# 19. Testing Plan

## 19.1 Pure unit tests
- protobuf/domain mapping;
- preprocessing math;
- bbox coordinate transforms;
- distance projection;
- risk threshold logic;
- context-cache TTL behavior;
- queue priority/drop behavior.

## 19.2 GPU/model tests
- deterministic fixture images;
- expected class/output tolerance;
- input-size variants;
- model manifest mismatch;
- warmup/readiness.

## 19.3 gRPC integration
- token accepted/rejected;
- frame identity preserved;
- streaming order and concurrency;
- invalid payload handling;
- max message size;
- slow-client behavior.

## 19.4 Persistence integration
Run against the actual Prisma-migrated PostgreSQL schema:
- `frame_inference` insert/idempotency;
- event transaction;
- geography insert/extraction;
- alert relationship;
- DB outage/recovery;
- queue overload.

## 19.5 End-to-end replay fixtures
Use recorded frame sequences with expected detection/event markers. Verify that persisted `(session_id, frame_id, capture_timestamp_ns)` match what the Android fixture emitted.

---

# 20. Performance Targets and Measurement

Do not invent fixed performance promises before measurement. Establish budgets and measure each phase. A useful budget worksheet:

| Phase | Metric | Baseline target |
|---|---|---|
| Android encode/send | capture→network | measured |
| network | Android→FastAPI | measured |
| preprocessing | server | measured |
| GPU inference | server | measured |
| postprocess | server | measured |
| detection network | FastAPI→Tauri | measured |
| frame/detection join | Tauri | measured |
| total | capture→overlay | acceptance target after profiling |

The most important invariant is bounded latency under load, not maximum throughput at the cost of ever-growing queues.

---

# 21. Implementation Stages

## Stage F0 — Contracts and skeleton
- protobuf v1;
- FastAPI health endpoints;
- gRPC server with echo/mock response;
- configuration model;
- structured logging.

## Stage F1 — Auth and context
- JWT verification interceptor;
- Node context client;
- TTL cache;
- active trip mapping.

## Stage F2 — Mock pipeline integration
- FrameEnvelope validator;
- deterministic detection output;
- Tauri compatibility;
- load/backpressure test without GPU complexity.

## Stage F3 — Real model runtime
- model manifest;
- GPU loader;
- preprocess/postprocess;
- inference metrics;
- warmup/readiness.

## Stage F4 — Distance/risk
- calibration mapping;
- telemetry handling;
- distance module;
- policy thresholds;
- audit fields.

## Stage F5 — Persistence
- bounded queue;
- DB worker;
- `frame_inference`;
- selected `detection_event`;
- alert transaction;
- drift tests against Prisma schema.

## Stage F6 — Event image storage
- image extraction/encode;
- object upload;
- `event_image` metadata;
- retry/degraded behavior.

## Stage F7 — Hardening
- multi-stream load tests;
- DB slowdown/failure test;
- Tauri slow-consumer test;
- GPU fault handling;
- dashboard metrics.

## Stage F8 — Model promotion workflow
- staging model deployment;
- recorded-trip evaluation;
- model version/report;
- rollback procedure.

---

# 22. FastAPI Definition of Done

The service is ready for project integration when:

- it owns exactly one documented Vision gRPC endpoint;
- Node-issued credentials are verified;
- canonical frame identity is never rewritten;
- model is loaded once and readiness reflects true inferability;
- a frame produces a Tauri detection without waiting for PostgreSQL;
- persistence is bounded and asynchronous;
- critical events survive ordinary telemetry overload;
- vision writes match the Prisma-migrated schema;
- Node-owned context is cached rather than fetched per frame;
- event images can be stored without blocking live inference;
- metrics expose inference and persistence health;
- recorded fixture tests prove identity and replay metadata are preserved.
