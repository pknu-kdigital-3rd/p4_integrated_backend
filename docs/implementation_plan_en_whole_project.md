
> Historical v15 plan. The current ITS integration is documented in `v17_its_integrated_erd.md` and the repository root `README.md`.

# Vehicle Intelligent Risk Detection & Route Control Platform
## Whole Project Implementation Plan — v15 Architecture Baseline

**Document type:** Project vision, system design, implementation roadmap, integration contract  
**Status:** Implementation baseline  
**Architecture version:** v15 service ownership + current compact architecture diagram  
**Primary system objective:** Build an end-to-end vehicle operations platform that combines camera-based hazard detection, vehicle/route control, live operator visualization, recorded-video replay, spatial event history, and operational analytics without coupling the high-frequency vision path to the business-control backend.

---

# 1. Executive Summary

This project is a vehicle intelligence and control platform, not only an object-detection demo and not only a CRUD backend. It combines five concerns that must work as one coherent system:

1. **Vehicle-side sensing and recording** — Android/CameraX is the authoritative source of camera frames, frame identity, source timestamps, local H.264 recording, and vehicle telemetry sent to the control plane.
2. **AI / vision processing** — a GPU-backed FastAPI Vision Service receives inference frames over gRPC, performs detection and post-processing, estimates risk/distance, streams detections to the desktop dashboard, and persists selected inference metadata asynchronously.
3. **Control and business operations** — Node/Express owns authentication, RBAC, service discovery, vehicles, drivers, trips, GPS history, routes, route deviation, alerts, transport-goal statistics, history, and replay metadata.
4. **Operator experience** — a Tauri desktop dashboard renders live video and detections by joining two direct streams, displays routes and operational state, and reconstructs synchronized historical replay.
5. **Persistent system record** — PostgreSQL/PostGIS stores business state, spatial history, inference metadata and risk events; object storage holds H.264 recordings and event images.

The architecture intentionally separates high-frequency media/vision traffic from ordinary business traffic. Live video must not be relayed through Node/Express. Inference must not wait for database commits. The Tauri live view must not query PostgreSQL for every frame. These constraints are central design rules, not later optimizations.

---

# 2. Product Vision

The final system should allow an operator to answer, in one application:

- Where is each active vehicle now?
- Which route is it expected to follow?
- Has it deviated from the route and, if so, how far?
- What is the camera seeing right now?
- Which objects are being detected and how dangerous are they?
- Which detections became persistent risk events or alerts?
- What happened earlier in the trip at a particular time and location?
- Can the operator replay the recorded video with detections and GPS synchronized to the same timeline?
- What operational patterns appear across vehicles and trips?
- Optionally, after a trip ends, can an AI-generated summary describe the important events without becoming the source of truth?

The platform's value is the **integration of live AI, spatial operations, replay, and auditable history**. A detection without frame identity is not enough. A stored video without a time anchor is not enough. A route without PostGIS distance computation is not enough. A dashboard that bypasses backend ownership rules is not acceptable.

---

# 3. Project Scope

## 3.1 In scope

### Vehicle / Android
- CameraX capture.
- Canonical `session_id`, `frame_id`, and `capture_timestamp_ns` generation.
- Downsampled or selected inference-frame stream to FastAPI Vision over gRPC.
- Direct live-preview frame stream to Tauri over gRPC.
- Local H.264 recording with stable video PTS.
- H.264 segment upload to object storage.
- Delivery of recording metadata and time anchors to Node/Express.
- GPS/vehicle telemetry delivery to Node/Express.
- Device bootstrap and service discovery through Node/Express.

### AI / Vision
- Object detection model training and evaluation.
- Runtime model packaging/versioning.
- GPU inference.
- Detection post-processing and tracking where required.
- Distance/risk calculation using calibration and frame telemetry.
- Live detection output to Tauri.
- Frame-level inference metadata persistence.
- Persistent risk/detection events.
- Event-image generation and storage.
- Vision-origin alerts.

### Control / Business backend
- Operator authentication and RBAC.
- JWT/token issuance.
- Android/Tauri service bootstrap and Vision Service Address discovery.
- Vehicle, driver, trip, route, alert, object-class policy and transport-goal management.
- GPS and route history.
- Route-deviation calculation and rerouting workflow.
- Replay metadata and presigned object-storage access.
- History, statistics, and dashboard business queries.
- Schema migration ownership through Prisma Migrate.

### Desktop / Tauri
- Operator login.
- Live video rendering.
- Live frame/detection join using exact frame identity.
- Current map, vehicles, routes, deviations, alerts.
- History and event inspection.
- Synchronized replay with video + inference + GPS + event markers.

### Data platform
- PostgreSQL + PostGIS.
- Object storage for H.264 and images.
- Consistent backups and retention policy.
- Query/index strategy for high-frequency position and inference data.

## 3.2 Explicitly out of scope for the baseline

- Full fleet-dispatch optimization and recommendation planning.
- A complex `dispatch_plan` / assignment-versioning subsystem.
- Direct PostgreSQL access from Tauri or Android.
- Relaying live video through Node/Express.
- Making Node/Express a second Vision gRPC server.
- Waiting for PostgreSQL commits in the inference critical path.
- Using network-arrival time as the authoritative synchronization key.
- Treating LLM summaries as authoritative event records.

`transport_goal` remains intentionally small and supports statistics/progress rather than a full dispatch optimizer.

---

# 4. Architecture Principles

## 4.1 Three-plane architecture

```text
MEDIA PLANE
Android  ── direct gRPC live frames ───────────────────────► Tauri
Android  ── local H.264 PUT ───────────────────────────────► Object Storage
Tauri    ◄─ presigned HTTP Range GET ────────────────────── Object Storage

VISION PLANE
Android  ── gRPC FrameEnvelope ────────────────────────────► FastAPI Vision + GPU
FastAPI  ── gRPC detections ───────────────────────────────► Tauri
FastAPI  ── async/batched inference/event metadata ───────► PostgreSQL
FastAPI  ── event images ──────────────────────────────────► Object Storage

CONTROL / BUSINESS PLANE
Android  ── HTTPS bootstrap / telemetry ───────────────────► Node / Express
Tauri    ◄─► HTTPS REST auth/business/history/replay ──────► Node / Express
Node     ── business/spatial queries ──────────────────────► PostgreSQL
Node     ── presigned media authorization ────────────────► Object Storage
FastAPI  ◄─ low-rate internal context/cache refresh ─────── Node / Express
```

The compact architecture diagram may omit the low-rate internal context refresh and event-image upload to keep the visual clean, but implementation documents and tests must include them.

## 4.2 Authoritative ownership

| Concern | Authority |
|---|---|
| Operator authentication / RBAC | Node/Express |
| Service discovery | Node/Express |
| Actual Vision gRPC endpoint | FastAPI Vision Service |
| Camera frame identity | Android |
| Live video bytes | Android → Tauri direct |
| Vision detections | FastAPI Vision |
| Business / history API | Node/Express |
| Spatial/business database schema | Prisma Migrate |
| Vision runtime DB writer | FastAPI, constrained to its owned write set |
| Recorded H.264 | Object Storage |
| Live visual composition | Tauri |
| Replay metadata queries | Node/Express |

## 4.3 Synchronization invariants

The system must preserve these invariants end-to-end:

- Canonical frame identity = `session_id + frame_id`.
- Source capture timeline = `capture_timestamp_ns`.
- Recorded video timeline = `video_pts_us`.
- Replay mapping = `capture_timestamp_ns ↔ video_pts_us` through `video_time_anchor`.
- Live frame and detection join = exact `(session_id, frame_id)` join.
- Network-arrival time is diagnostic only and must not become the synchronization source of truth.
- `fps` and `start_frame_id` can help diagnostics/range estimation, but replay must not be calculated as `frame_id / fps`.

---

# 5. Major System Components

## 5.1 Android vehicle application

### Responsibilities
- Own camera capture lifecycle.
- Create a new `session_id` whenever a camera/inference session is restarted in a way that can reset frame numbering.
- Increment `frame_id` monotonically within a session.
- Stamp every inference/live frame with `capture_timestamp_ns` from a monotonic source clock.
- Encode H.264 locally so recording does not depend on round trips to a backend.
- Produce PTS-aware time anchors while encoding.
- Upload video segments independently from live preview/inference.
- Obtain bootstrap credentials and service addresses from Node.

### Important separation
The camera should fan out into independent consumers rather than serially waiting for one consumer before serving another:

```text
CameraX frame
   ├── inference sampler/transform ─► FastAPI gRPC
   ├── live preview encoder/path ───► Tauri gRPC
   └── recording encoder ───────────► H.264 file/segment ─► Object Storage
```

Backpressure policies can differ by branch. A delayed inference consumer must not corrupt recording timestamps; a temporary object-storage upload delay must not stop live display.

## 5.2 FastAPI Vision Service

FastAPI Vision is an operational AI service, not the main business backend. It runs the GPU model and owns the actual Vision gRPC endpoint. The deployment unit includes:

- HTTP health/readiness/status endpoints;
- gRPC inference service;
- GPU model loaded once per process;
- model preprocessing/inference/post-processing;
- optional tracker;
- distance and risk logic;
- Node-issued credential verification;
- in-memory policy/calibration/active-trip cache;
- gRPC detection output for Tauri;
- bounded asynchronous persistence queue;
- DB writer for vision-owned records;
- event-image object-storage client.

## 5.3 Node/Express control and business backend

Node/Express is the application authority for non-vision operations. It owns:

- users, auth and RBAC;
- JWT/token issuance;
- service bootstrap/discovery;
- vehicle, camera calibration configuration and drivers;
- trip lifecycle;
- route versions and current-route selection;
- GPS position ingestion/history;
- route-deviation detection and reroute coordination;
- object-class warning policy;
- alert lifecycle and operator acknowledgement;
- trip-video metadata and time anchors;
- replay query composition and presigned URLs;
- statistics and transport-goal progress;
- database migrations.

## 5.4 Tauri dashboard

Tauri is intentionally more than a web page because it participates in direct native gRPC streams.

### Live view
- Receive Android live frames.
- Receive FastAPI detection messages.
- Keep short bounded buffers keyed by `(session_id, frame_id)`.
- Join only matching frames and detections.
- Render boxes, labels, distance/risk states and latency diagnostics.
- Drop stale unmatched data rather than allowing unbounded growth.

### Business view
- Use Node HTTPS REST for operator login, vehicles, trips, routes, alerts, statistics and history.
- Never query PostgreSQL directly.

### Replay
- Ask Node for replay metadata and authorized media URL.
- Range-GET H.264/MP4-compatible media from object storage.
- Load time anchors, GPS positions, frame inference/event data through Node.
- Convert playback PTS to capture time and select the matching overlays/location.

## 5.5 PostgreSQL/PostGIS

The database is a shared physical system with explicit logical ownership.

- Node is the schema/migration authority.
- Node performs most business reads/writes.
- FastAPI writes only the vision-side records explicitly assigned to it.
- PostGIS `geography` is the canonical location representation.
- GIS operations use TypedSQL/raw SQL where Prisma cannot express the operation natively.

## 5.6 Object storage

Object storage is used for large binary media. Database tables store identifiers, object keys, URLs/metadata—not the full video/image bytes.

Primary object types:
- H.264/video segments;
- event snapshot images;
- replay media artifacts if remuxed or generated.

---

# 6. AI / Vision Program

AI is a major workstream of this project, but it is not a separate product. The model must be developed around the operational contract required by the rest of the platform.

## 6.1 AI objectives

The baseline AI capability should:

1. detect defined road/worksite/vehicle-relevant object classes;
2. expose confidence and bounding geometry;
3. optionally maintain short-term tracking identities when needed for stable risk logic;
4. estimate distance or risk-relevant geometry using camera calibration and frame telemetry;
5. classify a frame/object state into normal/warning/danger according to policy;
6. produce deterministic machine-readable outputs suitable for both live UI and persistent audit;
7. attach a model version to persisted inference results.

## 6.2 Dataset workstream

Maintain a dataset manifest rather than treating training images as an unmanaged folder. At minimum record:

- dataset version;
- source/license;
- class map;
- train/validation/test split definition;
- image resolution distribution;
- environment categories (day/night/weather/indoor/outdoor as applicable);
- known negative/background subsets;
- annotation tool/version;
- preprocessing/augmentation configuration.

Tests must include hard negatives because a safety-oriented system is harmed by both missed hazards and frequent false warnings.

## 6.3 Model-development lifecycle

```text
Dataset version
   ↓
Training config + code commit
   ↓
Checkpoint / exported artifact
   ↓
Offline evaluation
   ↓
Latency + VRAM benchmark
   ↓
Candidate model manifest
   ↓
Staging FastAPI deployment
   ↓
Recorded-trip replay evaluation
   ↓
Approved runtime model version
```

Do not deploy a model only because its global mAP improved. Promotion should consider class-specific recall, false-positive behavior, inference latency, memory use, and end-to-end risk-event quality.

## 6.4 Runtime model contract

Each served model should have metadata such as:

```yaml
model_version: hazard-yolo-2026-09-01-a
artifact: model.engine
input_width: 960
input_height: 544
class_map_version: 4
preprocess_version: 3
postprocess_version: 6
confidence_profile: default-v2
calibration_contract_version: 1
```

Persist at least the runtime model version and latency with frame inference/event data so historical results remain explainable after model upgrades.

## 6.5 Distance and risk evaluation

Detection confidence alone is not a danger score. Risk evaluation should combine:

- detected class;
- object confidence;
- image geometry;
- camera calibration;
- instantaneous pitch/roll if used;
- estimated distance;
- class-specific warning threshold;
- optional temporal persistence/tracking.

When a detection is persisted as a risk event, the inputs needed to audit the calculation should also be persisted where practical. The ERD therefore retains capture-time pitch/roll/telemetry source for `detection_event`.

## 6.6 AI evaluation layers

### Model-level
- precision/recall per class;
- mAP50 and mAP50-95;
- confusion matrix;
- false positives per minute on negative video;
- recall on critical/danger classes;
- distance-estimation error where ground truth exists.

### Pipeline-level
- preprocessing latency;
- GPU inference latency;
- post-processing latency;
- gRPC end-to-end latency;
- frames dropped by inference sampling/backpressure;
- persistence queue depth/drops;
- detection-to-display latency.

### Product-level
- event precision: percentage of persisted warning/danger events judged valid;
- event recall on curated replay scenarios;
- alert noise per trip/hour;
- operator-visible overlay synchronization correctness;
- replay overlay synchronization correctness.

## 6.7 Optional LLM trip summary

`trip.ai_summary` is an enhancement after the structured event pipeline is reliable.

Input should be structured and bounded, for example:
- trip metadata;
- route deviations;
- counts of detections/alerts by type;
- significant event timestamps;
- trip duration/distance.

The LLM must summarize existing records; it must not fabricate new events. The structured database remains authoritative.

---

# 7. Database and ERD Strategy

The detailed schema is defined in the companion **v16 ERD document**. Key rules for the project plan are:

- total baseline tables: 15;
- migrations: Prisma Migrate only;
- state values: `VARCHAR + CHECK`, not PostgreSQL enum types;
- timestamps: `TIMESTAMPTZ`, except source monotonic capture/PTS integers;
- location: PostGIS `geography(Point, 4326)` as the only location source;
- route spatial line: `geography(LineString, 4326)`;
- `frame_inference` primary identity: `(session_id, frame_id)`;
- binary media stays in object storage;
- purpose-specific indexes are required for time-range replay and high-frequency telemetry.

The schema is not merely storage. It encodes the cross-service contract: what can be replayed, which service writes which records, and how frame/timeline identity survives across systems.

---

# 8. Main End-to-End Flows

## 8.1 Startup / service bootstrap

1. Android or Tauri contacts Node/Express over HTTPS.
2. Node authenticates the caller or validates device provisioning.
3. Node returns token/credential and service descriptor.
4. The descriptor contains the **Vision Service Address**, not a second Node-hosted Vision endpoint.
5. Client establishes direct gRPC connection to FastAPI Vision when needed.

## 8.2 Live inference and display

1. Android captures a frame.
2. Android assigns `(session_id, frame_id, capture_timestamp_ns)`.
3. Android sends inference payload to FastAPI.
4. FastAPI preprocesses and performs GPU inference.
5. FastAPI post-processes, estimates distance/risk and creates detection output.
6. Detection output is sent to Tauri immediately.
7. Persistence data is enqueued without waiting for DB commit.
8. Tauri joins detection output with the independently received Android frame by exact frame identity.

## 8.3 Vision-event persistence

1. Every selected/inferred frame may create `frame_inference` metadata according to the configured retention/sampling policy.
2. A risk-significant detection creates `detection_event`.
3. A snapshot may be uploaded to object storage and referenced by `event_image`.
4. A danger-level or policy-triggered event may create a vision-origin `alert`.
5. Persistence worker batches commits where safe.
6. Critical event records receive higher persistence priority than ordinary frame telemetry.

## 8.4 Vehicle telemetry and route deviation

1. Android sends GPS telemetry through Node control API.
2. Node stores `vehicle_position` as PostGIS geography.
3. Node loads the active trip/current route.
4. PostGIS computes point-to-route distance.
5. If threshold is exceeded, create `route_deviation` and an alert.
6. Invoke OSRM/A* routing as configured.
7. Save a new route version and switch `is_current` transactionally.
8. Tauri refreshes the route/business state through Node.

## 8.5 Recording and replay

1. Android encodes local H.264 continuously/segment-wise.
2. Android uploads media to object storage.
3. Android sends `trip_video` metadata and `video_time_anchor` values to Node.
4. Node persists replay metadata.
5. Tauri requests a bounded replay window.
6. Node returns media authorization plus time-window metadata.
7. Tauri Range-GETs media directly from object storage.
8. Tauri aligns playback using `video_pts_us ↔ capture_timestamp_ns` and overlays corresponding GPS/detection/event records.

---

# 9. API and Protocol Contracts

## 9.1 Node public REST

Representative groups:

```text
/auth/*
/bootstrap/*
/vehicles/*
/drivers/*
/trips/*
/routes/*
/telemetry/*
/alerts/*
/object-classes/*
/transport-goals/*
/history/*
/replay/*
/statistics/*
```

Node should generate OpenAPI from Zod schemas so runtime validation and documentation do not drift.

## 9.2 Node internal API

FastAPI requires low-rate context, not per-frame synchronous lookups. A representative internal contract:

```text
GET /internal/vehicles/{vehicleId}/vision-context
```

Response can include:
- camera calibration;
- active trip id;
- object-class thresholds/policy version;
- relevant configuration version timestamps.

FastAPI caches the result and refreshes by TTL or explicit invalidation.

## 9.3 Vision gRPC

The protobuf contract should explicitly version messages and carry canonical identity. Representative payload concepts:

```text
FrameEnvelope
- protocol_version
- session_id
- frame_id
- capture_timestamp_ns
- vehicle_id
- encoded_image or tensor-compatible bytes
- source dimensions
- optional instantaneous telemetry

DetectionFrame
- protocol_version
- session_id
- frame_id
- capture_timestamp_ns
- vehicle_id
- model_version
- inference_latency_ms
- repeated Detection

Detection
- class_id / class_name
- confidence
- bbox
- optional track_id
- estimated_distance_m
- risk_level
```

Do not couple the gRPC contract to a specific YOLO library's internal tensor format.

---

# 10. Security Model

## 10.1 Trust boundaries

- Node is the authentication authority.
- FastAPI validates Node-issued credentials locally where possible.
- Tauri never receives database credentials.
- Android never receives database credentials.
- Object-storage access uses scoped upload credentials or presigned URLs.
- Internal Node↔FastAPI traffic must be network-restricted and authenticated.

## 10.2 Token strategy

Use separate audiences/scopes for:
- operator dashboard;
- Android device;
- Vision inference;
- internal service calls;
- object-storage upload/download authorization.

Service routing information should be returned in bootstrap/service descriptors rather than embedded permanently in JWT claims.

## 10.3 Media security

- Object keys should not expose secrets.
- Presigned replay URLs must expire.
- Upload permissions should be limited to the intended bucket/prefix.
- Event images and recordings should have defined retention and access audit rules.

---

# 11. Observability

A distributed system like this becomes difficult to debug unless every component shares correlation identifiers.

## 11.1 Correlation keys

Log when applicable:
- request id;
- vehicle id;
- trip id;
- session id;
- frame id;
- model version;
- route id/version;
- alert/event id.

## 11.2 Key metrics

### Android
- capture FPS;
- inference-send FPS;
- live-preview FPS;
- encoder FPS;
- dropped frames by branch;
- upload backlog.

### FastAPI
- gRPC requests/sec;
- preprocess/inference/postprocess latency;
- GPU utilization/VRAM;
- active streams;
- context-cache hit/age;
- persistence queue depth;
- persistence drop count;
- DB batch latency;
- event-image upload latency.

### Node
- REST latency/error rate;
- auth failures;
- telemetry writes/sec;
- route-deviation query latency;
- replay query latency;
- PostGIS slow queries;
- active trips/vehicles;
- alert creation/ack latency.

### Tauri
- frame/detection join success ratio;
- unmatched/stale buffer count;
- display latency;
- replay buffering;
- sync error diagnostics.

---

# 12. Repository and Delivery Structure

A practical structure may use multiple repositories or a monorepo, but contracts must be versioned independently. A logical layout is:

```text
vehicle-platform/
├── docs/
│   ├── architecture/
│   ├── erd/
│   ├── api/
│   └── adr/
├── contracts/
│   ├── proto/
│   └── openapi/
├── android-vehicle/
├── tauri-dashboard/
├── backend-control-node/
├── backend-vision-fastapi/
├── ai-vision/
│   ├── datasets/
│   ├── training/
│   ├── evaluation/
│   └── export/
└── deploy/
    ├── compose/
    ├── postgres/
    ├── object-storage/
    └── observability/
```

If separate repositories are used, keep `proto` and OpenAPI contracts in a small versioned contract package/repository so Android, Tauri and both backends can pin compatible versions.

---

# 13. Testing Strategy

## 13.1 Unit tests
- domain services;
- validation schemas;
- route-deviation decisions;
- risk evaluation;
- frame-buffer/join logic;
- time-anchor interpolation/search.

## 13.2 Integration tests
- Node + PostgreSQL/PostGIS;
- FastAPI DB writer + test PostgreSQL;
- object-storage upload/download;
- gRPC client/server compatibility;
- auth token verification between Node and FastAPI.

## 13.3 Contract tests
- protobuf backward compatibility;
- OpenAPI schema validation;
- Prisma migration vs FastAPI SQL/SQLAlchemy writer drift;
- class-map/model manifest compatibility.

## 13.4 Recorded-video system tests
A curated set of recorded trips is essential. Feed deterministic frame sequences through the inference service and verify:
- detection events;
- persisted frame IDs;
- alert generation;
- event images;
- replay sync;
- dashboard overlay accuracy.

## 13.5 Load tests
Test the system under independent stresses:
- high inference FPS;
- slow PostgreSQL;
- object-storage upload delay;
- many Tauri live viewers if supported;
- long trip replay windows;
- high GPS write frequency.

The correct behavior under overload is bounded degradation, not unbounded memory growth.

---

# 14. Implementation Roadmap

## Phase 0 — Freeze contracts and architecture

Deliverables:
- v16 ERD approved;
- architecture SVG approved;
- protobuf v1;
- Node OpenAPI baseline;
- service ownership ADR;
- local development topology.

Exit criterion: all components agree on identifiers and service boundaries.

## Phase 1 — Database and Node foundation

- PostgreSQL/PostGIS environment.
- Prisma schema/migrations for all 15 tables.
- seed/reference data.
- Node layered skeleton.
- auth/RBAC basics.
- vehicle/driver/trip CRUD.
- object-class policy.
- health/docs endpoints.

Exit criterion: control backend can create a vehicle/trip and expose stable APIs.

## Phase 2 — Android capture identity and bootstrap

- CameraX capture.
- session/frame/timestamp generation.
- Node device bootstrap.
- mock direct frame outputs.
- H.264 recording prototype.

Exit criterion: a recorded session has stable frame identity and timestamps.

## Phase 3 — FastAPI Vision transport before real AI

- FastAPI HTTP lifecycle.
- gRPC server.
- Node-issued token validation.
- mock/deterministic inference handler.
- Tauri detection client.
- context-cache API integration.

Exit criterion: Android frame reaches FastAPI and matching mock detection reaches Tauri.

## Phase 4 — Tauri live view

- Android direct frame receiver.
- detection receiver.
- exact frame join buffer.
- basic overlay.
- latency display/logging.

Exit criterion: stable live preview with synchronized mock detections.

## Phase 5 — AI model integration

- training/evaluation baseline.
- model manifest/export.
- GPU model loader.
- preprocessing/post-processing.
- distance/risk policy.
- model-version output.

Exit criterion: real detections appear correctly in Tauri and meet baseline latency/accuracy targets.

## Phase 6 — Vision persistence

- `frame_inference` writer.
- bounded persistence queue.
- `detection_event` transaction.
- vision-origin alert.
- event-image object storage.
- persistence metrics.

Exit criterion: DB slowdown does not block inference and critical events are durable.

## Phase 7 — GPS and route control

- telemetry ingestion.
- PostGIS position writes.
- route creation/versioning.
- route-deviation query.
- alert + reroute workflow.
- Tauri map integration.

Exit criterion: route deviation creates auditable spatial records and dashboard updates.

## Phase 8 — Recording and replay

- segmented upload.
- `trip_video` metadata.
- `video_time_anchor` persistence.
- Node replay window API.
- presigned Range GET.
- Tauri playback + GPS/detection overlay.

Exit criterion: selecting an event seeks to the correct recorded moment and overlay.

## Phase 9 — Operational hardening

- structured logging/metrics.
- retry/backpressure policies.
- DB/object-storage failure drills.
- token/key rotation.
- backup/restore.
- performance tests.

## Phase 10 — Demo and acceptance package

- deterministic demo trip/scenario.
- model/evaluation report.
- API docs.
- ERD + architecture docs.
- operational runbook.
- known-limitations document.

## Phase 11 — Optional enhancements

- LLM trip summary.
- advanced statistics/heatmaps.
- additional spatial search.
- multi-camera vehicle support.
- more sophisticated tracking/risk prediction.
- fleet planning/dispatch optimization as a separate future scope.

---

# 15. Acceptance Criteria

The baseline is ready for an integrated demo when all of the following are true:

1. Android receives bootstrap information from Node and connects to the actual FastAPI Vision endpoint.
2. Live frames travel Android→Tauri without being relayed by either backend.
3. Inference frames travel Android→FastAPI and detections travel FastAPI→Tauri.
4. Tauri joins live frames and detections by `(session_id, frame_id)`.
5. FastAPI continues inference while DB persistence occurs asynchronously.
6. Critical risk events and alerts can be queried later through Node.
7. GPS positions are stored in PostGIS and rendered on the dashboard.
8. Route deviation is computed spatially and produces a route-deviation record/alert.
9. Android recording is stored in object storage.
10. Replay uses time anchors and reproduces synchronized video, inference and GPS.
11. Tauri never accesses PostgreSQL directly.
12. Node does not pretend to host the Vision gRPC endpoint; it only provides its service address.
13. Prisma Migrate remains the only schema migration authority.
14. The model version and key inference diagnostics are traceable for persisted events.
15. Failure of one secondary path (DB/image upload/replay upload) does not cause unbounded memory growth or silently redefine synchronization semantics.

---

# 16. Definition of Done for the Whole Project Baseline

The project should be considered technically coherent when the architecture diagram, protobuf/OpenAPI contracts, Prisma schema, FastAPI writers, Node ownership rules, Tauri join logic, Android frame identity and replay timing all tell the same story. Any future feature should be evaluated first against those contracts before adding another transport, service, table, or cache.
