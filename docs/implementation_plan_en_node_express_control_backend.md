
> Historical v15 plan. The current integrated schema and architecture are documented in `v17_its_integrated_erd.md` and the repository root `README.md`.

# Node / Express Control & Business Backend
## Detailed Implementation Plan — v15 Architecture Baseline

**Role:** control plane, business authority, service discovery, spatial route-control backend, history/replay API  
**Primary stack:** TypeScript + Node.js + Express 5 + Prisma 7 + PostgreSQL/PostGIS + TypedSQL + Zod/OpenAPI  
**Not the role:** Vision gRPC server, GPU inference service, live-video relay  
**Migration authority:** Prisma Migrate  

---

# 1. Mission

The Node/Express backend is the authoritative application backend for the vehicle platform. It owns identities, permissions, business entities, spatial trip/route state, operational alerts, historical queries, replay metadata, and service discovery. It coordinates the system without becoming a high-frequency media proxy.

The most important architectural distinction is:

> Node returns the **Vision Service Address** during bootstrap; it does not host or proxy the actual Vision gRPC endpoint.

FastAPI and Android can therefore communicate directly for inference, and Android/Tauri communicate directly for live media, while Node remains the source of truth for business/control state.

---

# 2. Responsibility Boundary

## 2.1 Node owns

- `system_user` authentication.
- RBAC and operator permissions.
- JWT/access/refresh token issuance strategy.
- Android device bootstrap/provisioning policy.
- Service discovery descriptors.
- Vehicle configuration and camera calibration.
- Driver records.
- Trip lifecycle.
- Trip start/end and optional AI summary persistence.
- Routes and route versions.
- GPS/vehicle-position writes and reads.
- Route-deviation logic.
- Reroute orchestration with OSRM/A* provider.
- Object-class policy management (`warning_distance_m`, display labels, etc.).
- Alert read/update/acknowledgement/operator notes.
- Node-origin alerts (route deviation, trip completion).
- History/statistics.
- `trip_video` metadata.
- `video_time_anchor` persistence/read.
- Replay-window query composition.
- Presigned object-storage authorization.
- Schema migration and seed/reference data.
- Internal vision-context API for FastAPI.

## 2.2 Node does not own

- GPU model loading.
- per-frame image inference.
- FastAPI's gRPC inference endpoint.
- FastAPI→Tauri live detections.
- Android→Tauri direct live frames.
- frame-by-frame media relaying.
- direct manipulation of FastAPI's in-memory inference queue.

Node may read vision-generated records for history/replay/statistics, but reading them does not make Node the writer of those records.

---

# 3. Technology Baseline

Recommended baseline:

- Node.js 24.x for a new deployment, while maintaining the Prisma-supported Node engine range as configured.
- TypeScript, ESM.
- Express 5.x.
- Prisma ORM 7.x.
- `@prisma/adapter-pg` + `pg`.
- PostgreSQL with PostGIS.
- Prisma TypedSQL for fixed spatial SQL.
- Zod 4.x for request/response/config validation.
- `@asteasolutions/zod-to-openapi` or equivalent for OpenAPI generation.
- Swagger UI `/docs` and ReDoc `/redoc` from the same OpenAPI source.
- Pino/pino-http for structured logging.
- Vitest + Supertest for tests.
- Optional `ws`/SSE for low-rate business notifications if required; live video/detections remain outside Node.
- S3-compatible client for presigned URL/credential generation.

---

# 4. Layered Architecture

```text
HTTP Request
    ↓
Express Router
    ↓
Auth / RBAC middleware
    ↓
Zod validation
    ↓
Controller
    ↓
Application Service
    ├── Domain policy / transaction orchestration
    ├── Optional routing provider client
    └── Optional business notification publisher
    ↓
Repository
    ├── Prisma Client ───── ordinary scalar CRUD
    └── Prisma TypedSQL ─── PostGIS / complex fixed SQL
    ↓
PostgreSQL + PostGIS
```

OpenAPI should be generated from the same Zod contract definitions used at runtime. Avoid maintaining separate handwritten documentation schemas that can drift.

---

# 5. Suggested Repository Structure

```text
backend-control-node/
├── package.json
├── tsconfig.json
├── prisma.config.ts
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   ├── seed.ts
│   └── sql/
│       ├── insertVehiclePosition.sql
│       ├── getLatestVehiclePosition.sql
│       ├── getTripPositionTrack.sql
│       ├── createTrip.sql
│       ├── saveRouteFromGeoJson.sql
│       ├── insertRouteDeviationIfExceeded.sql
│       ├── getRouteDeviations.sql
│       ├── getReplayWindow.sql
│       └── reporting/
├── src/
│   ├── server.ts
│   ├── app.ts
│   ├── config/
│   ├── core/
│   │   ├── errors/
│   │   ├── logging/
│   │   ├── auth/
│   │   └── http/
│   ├── db/
│   │   ├── prisma.ts
│   │   └── transactions.ts
│   ├── modules/
│   │   ├── auth/
│   │   ├── bootstrap/
│   │   ├── users/
│   │   ├── vehicles/
│   │   ├── drivers/
│   │   ├── trips/
│   │   ├── telemetry/
│   │   ├── routes/
│   │   ├── deviations/
│   │   ├── alerts/
│   │   ├── object-classes/
│   │   ├── videos/
│   │   ├── replay/
│   │   ├── transport-goals/
│   │   └── statistics/
│   ├── internal/
│   │   └── vision-context/
│   ├── integrations/
│   │   ├── routing/
│   │   ├── object-storage/
│   │   └── llm-summary/
│   └── openapi/
├── tests/
│   ├── unit/
│   ├── api/
│   ├── integration/
│   └── contract/
└── deploy/
```

Each module should own its router/controller/service/repository/schema files rather than creating one huge global controllers/services directory.

---

# 6. Database Ownership and Access Strategy

## 6.1 Schema authority

`schema.prisma` declares all 15 baseline tables and Prisma Migrate is the only schema migration authority. FastAPI is a runtime writer against the same schema but does not run migrations.

CI must:
- apply migrations to a clean PostgreSQL/PostGIS instance;
- generate Prisma client/TypedSQL;
- run Node integration tests;
- run FastAPI schema-contract tests against that migrated DB.

## 6.2 Prisma Client vs TypedSQL

Use Prisma Client for ordinary scalar CRUD/relations where it is natural. Use TypedSQL for PostGIS and complex fixed queries.

Typical Prisma Client areas:
- `system_user`;
- `driver`;
- most scalar vehicle config;
- object-class policy management;
- alert acknowledgement/operator note;
- trip-video metadata;
- simple statistics/entities.

Typical TypedSQL/PostGIS areas:
- vehicle position insert/read;
- trip origin/destination geography writes;
- route LineString creation;
- route deviation distance;
- detection-event spatial reads;
- map/reporting queries involving geography;
- bounded replay queries where one purpose-built SQL query is clearer/faster.

Do not use `$queryRawUnsafe` to concatenate user input. Typed parameters remain mandatory.

---

# 7. Module Plan

# 7.1 Authentication and RBAC

### Goals
- operator login;
- hashed password verification;
- active/disabled user checks;
- role/permission mapping;
- access token and refresh flow as required;
- audit-friendly user identity propagation.

### Middleware chain

```text
request
 → parse bearer token
 → verify signature/issuer/audience/expiry
 → attach principal
 → authorize role/permission
 → controller
```

### FastAPI relationship
Node signs the tokens FastAPI validates. Use an asymmetric signing strategy or equivalent distribution method so FastAPI can validate locally without calling Node for every inference frame.

---

# 7.2 Bootstrap and service discovery

Bootstrap answers: “Who am I allowed to act as, and where are the services I need?”

Representative response:

```json
{
  "accessToken": "...",
  "expiresAt": "...",
  "services": {
    "visionGrpc": "vision.internal.example:55051",
    "dashboardApi": "https://control.example/api"
  },
  "objectStorage": {
    "upload": {"mode": "presigned-or-scoped-credential"}
  }
}
```

The `visionGrpc` field is a **service address/descriptor**. The actual socket/server is FastAPI Vision.

Maintain descriptor versioning if fields are expected to evolve.

---

# 7.3 Vehicle module

Own:
- vehicle identity/code/status;
- camera calibration fields;
- current configuration required by FastAPI;
- optional model/feature flags at the vehicle level if later required.

Calibration updates should invalidate or version the FastAPI vision-context cache. A simple baseline can expose `updatedAt`/configuration version so FastAPI refreshes safely.

---

# 7.4 Driver module

Standard business CRUD with constraints and trip relationships. Keep driver data out of vision messages unless there is a real inference requirement.

---

# 7.5 Trip module

Trip is the main operational aggregate tying together:
- vehicle;
- driver;
- route history;
- position history;
- detections;
- deviations;
- recordings;
- alerts;
- optional transport goal;
- optional AI summary.

### State transitions
Define legal transitions rather than allowing arbitrary status strings through generic PATCH:

```text
PLANNED → ACTIVE → COMPLETED
               ↘ CANCELLED (if allowed)
```

Exact status set follows the v15 schema checks.

On start:
- assign vehicle/driver;
- origin location/time;
- create/activate initial route;
- make active trip visible to FastAPI context.

On completion:
- destination/time;
- close current route state if required;
- generate `TRIP_COMPLETED` alert/event semantics as designed;
- optionally queue AI summary generation after structured records are finalized.

---

# 7.6 Telemetry / vehicle position module

Android sends bounded telemetry payloads through the control plane.

Representative API:

```text
POST /api/v1/vehicles/{vehicleId}/positions
```

Request:

```json
{
  "tripId": 991,
  "longitude": 129.0756,
  "latitude": 35.1796,
  "speedKmh": 42.3,
  "headingDeg": 91.4,
  "recordedAt": "2026-08-30T08:00:00Z"
}
```

Repository converts WGS84 lon/lat into:

```sql
ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
```

Remember `ST_MakePoint(longitude, latitude)` — longitude first.

High-frequency ingestion should keep request payloads small and indexing intentional. If network efficiency later requires batching, introduce a batch endpoint while preserving per-sample timestamps.

---

# 7.7 Route module

A trip can have multiple route versions but one current route.

Store:
- route version/type;
- distance/duration;
- display representation (encoded polyline/GeoJSON);
- `route_line geography(LineString, 4326)` for spatial operations;
- `is_current`.

Switching route versions should be transactional:

```text
old current route -> is_current = false
new route         -> insert/is_current = true
```

Do not let two current routes survive for one trip because of partial failure.

---

# 7.8 Route deviation module

Core query:

```text
current vehicle position geography(Point)
            +
current route geography(LineString)
            ↓
ST_Distance(...)
            ↓
distance >= configured threshold ?
```

The fixed TypedSQL should return zero rows when below threshold and the new deviation row when exceeded. Application service then coordinates:

1. create `route_deviation`;
2. create Node-origin alert;
3. request reroute from OSRM/A* provider;
4. persist new route version;
5. notify/refresh dashboard state.

### Idempotency / duplicate suppression
GPS can remain outside the route threshold for many samples. Avoid creating an alert every sample. Add a policy around active deviation episode, cooldown, distance recovery, or deduplication key.

---

# 7.9 Routing integration

Abstract the provider:

```ts
interface RoutingProvider {
  route(input: RouteRequest): Promise<RouteCandidate>;
}
```

Implement OSRM first if appropriate. A custom A* road-graph implementation can satisfy the same interface later. Persist the provider output into the route domain rather than letting provider-specific JSON leak across the API.

Validate GeoJSON geometry before passing to PostGIS. `ST_GeomFromGeoJSON` expects a geometry fragment, not an arbitrary FeatureCollection.

---

# 7.10 Object-class policy module

Node owns reference/policy data such as:
- class name;
- display name;
- warning distance;
- active status;
- policy/version metadata if added.

FastAPI consumes a cached read representation. Node admin updates should be infrequent and auditable.

---

# 7.11 Alert module

Alerts can originate from different causes:
- FastAPI Vision: linked to `detection_event`;
- Node route control: linked to `route_deviation`;
- Node trip completion: linked to `trip`.

The schema intentionally supports these cause paths. Node owns the public alert lifecycle after creation:
- list/filter;
- detail;
- acknowledge;
- acknowledged_by/at;
- operator note;
- status transitions.

Do not rewrite the underlying detection/deviation record when an operator acknowledges an alert.

---

# 7.12 Vision-record read model

Node reads but generally does not create:
- `frame_inference`;
- `detection_event`;
- `event_image`;
- vision-origin alert creation path.

Build purpose-specific queries for:
- trip event timeline;
- event detail;
- class/severity counts;
- replay window;
- latency/model-version diagnostics;
- spatial event map/cluster if later required.

Avoid giant nested Prisma includes over long/high-frequency histories.

---

# 7.13 Video metadata and replay

## Recording metadata
Node owns:
- `trip_video` registration;
- object key/path;
- start/end metadata;
- codec/container information as represented by schema;
- `video_time_anchor` rows.

Android can upload video bytes directly, then register metadata with Node.

## Time anchors
Persist:

```text
capture_timestamp_ns ↔ video_pts_us
```

Anchors must remain associated with the correct trip video/session.

## Replay API
Use bounded windows:

```text
GET /api/v1/trips/{tripId}/replay?from=...&to=...
```

Response can contain:
- trip/video metadata;
- presigned media URL or request to obtain one;
- relevant time anchors;
- GPS positions;
- frame inference/detection events;
- alerts/event markers;
- route context if needed.

For long trips, never return the entire high-frequency history by default. Require time windows/pagination/levels of detail.

---

# 7.14 Transport goal/statistics

Keep `transport_goal` deliberately small. It supports metrics such as:
- total goals;
- completed/in-progress/delayed;
- completion percentage;
- association with vehicle/trip.

Do not evolve this module into a hidden dispatch-planning engine without a new schema/design phase.

---

# 7.15 Optional trip AI summary integration

Node is the correct place to orchestrate summary generation because it owns the completed trip and its structured history.

Recommended workflow:

```text
trip completed
   ↓
collect bounded structured summary input
   ↓
background job / LLM call
   ↓
validate nonempty/bounded output
   ↓
trip.ai_summary + ai_summary_generated_at
```

Do not put LLM generation inside the trip-completion transaction. Completion must succeed even if the LLM is unavailable.

---

# 8. Internal Vision Context API

FastAPI should not query Node/PostgreSQL per frame. Expose an internal read endpoint designed for cache refresh.

```text
GET /internal/v1/vehicles/{vehicleId}/vision-context
```

Response fields:
- vehicle ID/status;
- calibration;
- active trip ID;
- object-class policy/version;
- context version/timestamp.

Protect internal routes separately from public operator APIs. Network allow-list/service identity plus a dedicated service token is preferable.

Consider an ETag/version so FastAPI can issue conditional refreshes.

---

# 9. Public API Design

## 9.1 Versioning

Use `/api/v1` for public business APIs. Keep internal APIs under `/internal/v1` and do not expose them through public documentation unless intended.

## 9.2 Error envelope

A consistent error response:

```json
{
  "error": {
    "code": "ROUTE_NOT_ACTIVE",
    "message": "No current route exists for the active trip.",
    "requestId": "...",
    "details": null
  }
}
```

Map errors centrally in final Express error middleware.

## 9.3 Validation

Use Zod for:
- params;
- query;
- body;
- response where valuable;
- env/config.

Generate OpenAPI from those same schemas.

---

# 10. Object Storage Authorization

Node should not proxy large recordings through Express. Instead:

### Upload
- Android obtains scoped upload authorization during bootstrap or from a dedicated endpoint.
- Authorization is limited by prefix, object size/type, and expiry as practical.

### Replay
- Tauri asks Node for permission to view a trip/video.
- Node validates RBAC/trip access.
- Node returns a short-lived presigned URL.
- Tauri Range-GETs media directly from object storage.

This preserves business authorization without making Node a media bandwidth bottleneck.

---

# 11. Security

## 11.1 Passwords
- strong adaptive hash (Argon2id/bcrypt policy);
- never log password or hash;
- account disabled/locked state as required.

## 11.2 JWT
- asymmetric signing preferred for FastAPI local verification;
- issuer/audience/expiry validation;
- short-lived access tokens;
- refresh rotation/revocation strategy if refresh tokens are implemented.

## 11.3 RBAC
Representative roles may include:
- admin;
- operator;
- viewer.

Permissions should be checked in application/middleware, not only hidden in UI.

## 11.4 SQL
- TypedSQL parameters only;
- never concatenate coordinates/IDs into SQL;
- use database constraints as final integrity enforcement.

## 11.5 Internal endpoints
- separate service credentials;
- private network exposure;
- explicit rate limits where relevant.

---

# 12. Transactions and Consistency

Use transactions where a business state transition must be atomic.

Examples:
- trip start with initial route references where applicable;
- current route switch;
- deviation + Node-origin alert if the schema/business rule requires all-or-nothing;
- alert acknowledgement metadata;
- metadata registration that must match video ownership.

Do not hold DB transactions open across slow external routing or LLM calls. A common pattern:

1. read/validate state;
2. call external provider;
3. begin short DB transaction to persist the result;
4. commit;
5. publish notification.

---

# 13. Realtime Business Updates

The v15 baseline requires HTTPS REST for Tauri business/control access. If the dashboard needs push for low-rate business events, Node can add WebSocket or SSE for:
- alert created/updated;
- trip status changes;
- route changed;
- vehicle status changes.

Do **not** use that channel for video frames or per-frame detection streams. Those already have direct gRPC paths.

A useful event envelope:

```json
{
  "type": "alert.created",
  "occurredAt": "...",
  "entityId": "...",
  "tripId": "...",
  "version": 1
}
```

Clients should still refresh canonical state through REST after reconnect.

---

# 14. Observability

## 14.1 Logging

Use structured JSON logs with:
- requestId;
- principal/userId;
- vehicleId;
- tripId;
- routeId;
- positionId;
- alertId;
- operation/query name;
- durationMs.

Never log JWTs, passwords, presigned URLs, or full sensitive payloads.

## 14.2 Metrics

```text
http_request_duration
http_errors_total
auth_failure_total
vehicle_positions_written_total
vehicle_position_write_latency_ms
route_deviation_query_latency_ms
route_deviations_created_total
reroute_duration_ms
alerts_created_total
alerts_acknowledged_total
replay_query_latency_ms
presigned_url_issued_total
postgres_pool_usage
postgres_query_duration
```

## 14.3 Database query diagnostics

For high-frequency queries, record query name and timing rather than dumping raw SQL with parameters.

---

# 15. Testing Strategy

## 15.1 Unit tests
- services/domain transition rules;
- RBAC;
- Zod schemas;
- route-deviation orchestration;
- dedup/cooldown logic;
- replay window validation;
- AI summary input assembly.

## 15.2 API tests
Using Supertest:
- login/auth failures;
- permissions;
- vehicle/trip CRUD;
- position ingestion;
- route endpoints;
- alerts;
- replay authorization.

## 15.3 PostGIS integration
Against real PostgreSQL/PostGIS:
- WGS84 insertion;
- `ST_X/ST_Y` extraction;
- route LineString storage;
- `ST_Distance` threshold behavior;
- GiST index presence where required;
- replay spatial/history queries.

Do not mock PostGIS for the tests that are specifically verifying GIS semantics.

## 15.4 Migration tests
- empty DB → latest migration;
- seed;
- expected constraints/indexes;
- migration deployment in containerized CI.

## 15.5 Cross-service contract tests
- Node-issued JWT accepted by FastAPI;
- vision-context shape compatible with FastAPI parser;
- FastAPI-inserted detection rows can be read by Node history/replay queries;
- object keys produced by FastAPI can be authorized/read by Node/Tauri flow.

---

# 16. Performance and Data-Volume Strategy

## Vehicle positions
Use `(vehicle_id, recorded_at DESC)` index for recent/latest track queries. Apply bounded time windows.

## Frame inference
Node history/debug queries should always be bounded by trip/time/frame range. Do not load an entire long trip's frame-level records into memory for a normal dashboard page.

## Detection events
Events are lower-volume than frame inference and form the primary operator timeline. Index trip/time/severity/class according to measured queries.

## Replay
Return just the time window needed by the UI. Consider separate endpoint/query levels:
- metadata only;
- events only;
- dense frame overlay window.

## Database pooling
Set finite pool sizes. More connections do not fix slow queries; tune indexes/query shapes first.

---

# 17. Failure Handling

## Routing provider unavailable
- preserve current route;
- persist/return deviation if already confirmed;
- alert operator that reroute failed;
- retry according to bounded policy.

## PostgreSQL unavailable
- return explicit service unavailable for business writes;
- avoid pretending telemetry was persisted;
- health/readiness semantics should distinguish DB dependency.

## Object storage unavailable
- metadata operations should report media-unavailable state clearly;
- do not issue unusable presigned links silently.

## FastAPI Vision unavailable
- bootstrap can still succeed but should surface vision service health/address separately;
- Node business functions continue;
- do not make Node emulate the Vision endpoint.

## LLM summary unavailable
- trip completion remains successful;
- summary remains null/pending/failed according to chosen state model.

---

# 18. Implementation Stages

## Stage N0 — Project foundation
- Node/TypeScript/Express setup;
- config validation;
- logger/error middleware;
- PostgreSQL adapter;
- health/docs.

## Stage N1 — Prisma v15 schema
- PostGIS extension migration;
- all 15 tables;
- checks/FKs/indexes;
- seed object classes/admin user/dev data;
- generate client/TypedSQL.

## Stage N2 — Auth/RBAC/bootstrap
- system user login;
- JWT issuance;
- role middleware;
- service descriptor;
- device bootstrap policy.

## Stage N3 — Core business entities
- vehicles + calibration;
- drivers;
- trips;
- object class policy;
- basic alerts.

## Stage N4 — GPS/PostGIS
- position ingestion;
- latest position;
- trip track;
- map-friendly GeoJSON/lon-lat response DTOs.

## Stage N5 — Routes and deviations
- route persistence;
- current route invariant;
- `ST_Distance` deviation query;
- deviation episode/dedup policy;
- reroute provider integration;
- route-deviation alert.

## Stage N6 — Vision integration read side
- internal vision-context API;
- FastAPI service credentials;
- detection-event/frame-inference read queries;
- event detail/history.

## Stage N7 — Recording metadata
- trip video registration;
- time anchor insert/batch endpoint;
- object-storage upload authorization.

## Stage N8 — Replay API
- bounded time-window query;
- presigned Range GET URL;
- GPS + detections/events + anchors;
- operator authorization.

## Stage N9 — Dashboard/statistics
- active fleet summary;
- latest positions;
- current routes;
- unacknowledged alerts;
- trip statistics;
- transport-goal metrics.

## Stage N10 — Hardening
- rate limits/security headers/CORS policy;
- query profiling;
- structured metrics;
- backup/restore;
- migration deployment process;
- load tests.

## Stage N11 — Optional enhancements
- business WebSocket/SSE;
- LLM trip summary orchestration;
- spatial event clustering/heatmap;
- advanced reporting.

---

# 19. Node/Express Definition of Done

The Node backend is ready for the integrated project when:

1. Prisma v15 migrations build the complete 15-table schema with PostGIS.
2. Node is the only migration authority.
3. Login/RBAC works and FastAPI can verify Node-issued credentials.
4. Bootstrap returns a **Vision Service Address**, not a Node-hosted fake Vision endpoint.
5. Vehicle calibration and active-trip context are available through a protected internal API.
6. GPS writes/readback use PostGIS as the single location source.
7. Route versions maintain a single current route.
8. Route deviation uses spatial distance and produces auditable deviation/alert records.
9. Node reads FastAPI-generated inference/events but does not rewrite their origin semantics.
10. Alert acknowledgement/operator notes work through Node.
11. Recording metadata/time anchors are persisted.
12. Replay returns bounded metadata and short-lived authorized media access.
13. Tauri never needs direct DB credentials.
14. Large media does not flow through Express.
15. Unit/API/PostGIS/cross-service contract tests pass in CI.
