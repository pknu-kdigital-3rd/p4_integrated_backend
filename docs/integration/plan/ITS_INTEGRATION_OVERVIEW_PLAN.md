# Intelligent Transportation System — Integration Overview Plan

## 1. Purpose

Integrate the existing project prototypes into one Intelligent Transportation System (ITS) product without redesigning working subsystems during the first integration pass.

The integrated product should let an operator:

- see multiple truck-like vehicles moving on a Busan map,
- inspect the selected vehicle and its planned route,
- use BIMS-derived vehicle data for fleet-scale live/playback visualization,
- support custom trucks whose planned route will later be produced by the truck-aware A* + limitation-data routing feature,
- open the existing Android/WebRTC/YOLO live view from the dashboard,
- keep persistent business state in the Node/Express + PostgreSQL/PostGIS backend.

This document defines the **integration architecture and implementation order**. Detailed truck-routing behavior is intentionally deferred to a separate `TRUCK_ROUTING_PLAN.md`.

---

## 2. Scope Lock for the First Integration

### In scope

- One integrated repository / product.
- Node/Express remains the control/business backend and database owner.
- PostgreSQL + PostGIS remains the persistent system of record.
- The BIMS project is generalized from "bus tracking" to generic vehicle tracking/telemetry.
- Existing BIMS live and playback inputs are retained as telemetry sources.
- Existing A* code is retained behind a routing-service boundary, without redesigning routing rules in this plan.
- Multiple BIMS-derived vehicles can appear on the map.
- One to three custom trucks can later use the truck-aware optimal-path feature.
- Existing WebRTC + inference behavior remains unchanged.
- No Tauri desktop layer is used anywhere in the integrated product.
- The current browser-based live stream/live-view page is used as-is through one configured URL for the single active Android stream.
- Database schema is upgraded for integration and all related documentation is updated atomically, especially the ERD.

### Explicitly out of scope

- SUMO.
- Multi-truck WebRTC stream/session routing.
- Per-vehicle live-view URLs.
- Redesign of the current live inference/playback semantics.
- Operator rerouting/reassignment after a route is already active.
- Detailed BIMS-line-vs-A* routing rules; this belongs to the separate truck-routing plan.
- IMU fusion/dead reckoning implementation.
- Kafka/Redis/event-bus introduction unless later measurements prove it necessary.
- Tauri or any desktop-wrapper integration.
- Frontend-framework rewrite solely for integration.

---

## 3. Existing Projects and Their Final Roles

| Existing project | Integration role |
|---|---|
| `p4_backend_20260914` | **Integration root and control plane**: auth, RBAC, vehicles, trips, routes, positions/history, PostgreSQL/PostGIS, OpenAPI |
| `bus_realtime_collected_display_20260914` | **Primary source for routing/tracking extraction**: BIMS live data, playback, route-constrained tracking, existing A* graph code, route-cache work, Leaflet UI ideas |
| `poc-optimal-path_20260914` | Reference/data source only where needed. Do **not** import a second copy of duplicated routing code. |
| `poc-server-webrtc_20260914` | **Live media + inference subsystem**: Android publisher, Go/Pion relay, Python/FastAPI YOLO service, browser live-view page |

### De-duplication rule

The BIMS-integrated routing copy already contains the same core A* implementation plus newer BIMS cache work. Therefore:

> Import one canonical routing/tracking codebase from the BIMS-integrated project. Do not maintain two copies of `main.py`, `graph_backend.py`, `hybrid_bus.py`, or the A* implementation in the integrated repository.

---

## 4. Target Product Architecture

```text
                              Operator Dashboard
                       Map / Vehicle / Planned Route
                              / Live View
                                    |
                              HTTPS / REST
                                    |
                         Node / Express Control API
                  Auth / RBAC / Vehicles / Trips / Routes
                    Telemetry facade / service bootstrap
                         / PostgreSQL ownership
                          |                 |
                          |                 +--------------------+
                          |                                      |
                          v                                      v
                 PostgreSQL + PostGIS                  Routing / Tracking
                                                       Python Service
                                                       - BIMS live source
                                                       - BIMS playback
                                                       - generic vehicle state
                                                       - route progress
                                                       - existing A* boundary


 Android Camera
      |
      | existing WebRTC H.264 path — unchanged
      v
 Go / Pion Relay ---> Python Vision / YOLO ---> Existing Browser Live View
                                               ^
                                               |
                             one configured LIVE_VIEW_URL
                                               |
                                      Operator Dashboard
```

### Architectural principle

**Integrate services at their boundaries; do not merge all runtimes into one process.**

The final project is one product/monorepo, but Node, routing/tracking Python, Go relay, vision Python, and Android keep separate runtimes and dependency environments.

---

## 5. Proposed Repository Layout

Use `p4_backend` as the starting integration root and converge toward:

```text
its-platform/
├── node/                         # existing Express control backend
├── operator-web/                 # integrated Leaflet operator dashboard
├── services/
│   ├── routing-tracking/         # generalized BIMS + route tracking + existing A*
│   ├── vision/                   # existing WebRTC Python/YOLO server
│   └── media-relay/              # existing Go/Pion relay
├── android/                      # existing Android WebRTC publisher
├── data/
│   ├── routing/
│   └── demo/
├── docs/
│   ├── integration/
│   └── ...existing docs...
├── docker-compose.yml
└── README.md
```

Important: do not force all components to share one package manager. Keep:

- Node: npm/TypeScript/Prisma,
- routing/tracking: uv/Python,
- vision: its current uv/Python environment,
- relay: Go module,
- Android: Gradle.

---

## 6. Service Ownership

### Node/Express owns business state

- `PlatformAccount`
- `Vehicle`
- `Driver`
- `Trip`
- persisted `Route`
- authoritative `VehiclePosition` history
- alerts/events already owned by Node in the current design
- service discovery/bootstrap for the dashboard

Node is also the **operator-facing API facade**. The browser should not need to understand the internal topology of every Python/Go service.

### Routing/Tracking service owns calculations and transient tracking state

- BIMS polling and normalization,
- recorded BIMS playback,
- canonical route progress,
- stale-position/interpolation/reconciliation logic,
- current transient vehicle tracking state,
- existing A* graph calculation boundary,
- route/telemetry source adapters.

It should not become the system-of-record for users, trips, or persisted business state.

### WebRTC/Vision subsystem owns live media and inference

Keep its existing behavior intact during integration:

- Android H.264/WebRTC publishing,
- Go/Pion media ingest/relay,
- Python inference,
- current frame/inference synchronization behavior,
- current browser live-view page.

For the first integration, the dashboard only needs a configured URL to this existing page.

---

## 7. Common Integrated Domain Model

The integration should use generic vehicle terminology even when the source is BIMS.

```text
Vehicle
  |
  +-- source: CUSTOM | BIMS
  |
  +-- Trip
       |
       +-- Route
       |    +-- source: BIMS_LINE | OPTIMAL_PATH
       |    +-- geometry
       |    +-- source metadata
       |
       +-- VehiclePosition
            +-- telemetry source
            +-- location / speed / heading / timestamp
```

### Key distinction

- **Vehicle source**: where the vehicle identity/demo entity comes from.
- **Route source**: how the planned route was produced.
- **Telemetry source**: where a position observation came from.

Do not encode these concepts by vehicle names or frontend conditionals.

---

## 8. Required Database Integration Changes

Make the smallest schema changes required for the integrated domain.

### `Vehicle`

Add:

- `vehicleSource` (`CUSTOM`, `BIMS` initially)
- `externalId` (nullable external provider identifier)

### `Route`

Add:

- `routeSource` (`BIMS_LINE`, `OPTIMAL_PATH` initially)
- `sourceMetadata` JSON/JSONB for provider-specific metadata

Keep `routeType` separate because it describes route lifecycle/version semantics rather than route origin.

### `VehiclePosition`

Add:

- `telemetrySource`

Initial values may include `BIMS_LIVE`, `BIMS_REPLAY`, `DEVICE_GPS`, and `RECORDED_GPS`. Do not persist browser animation frames merely because they were interpolated for display.

### Schema/documentation atomicity rule

A database change is not complete until the same change set also updates:

1. `schema.prisma`,
2. Prisma migration SQL,
3. affected TypedSQL/raw SQL,
4. seeds/tests,
5. Zod/API schemas,
6. OpenAPI,
7. backend README/current architecture docs,
8. **new integrated ERD** (recommended: `docs/v17_its_integrated_erd.md`),
9. any EN/KO project/backend docs that describe the changed model.

Preserve prior versioned ERDs as historical records; do not silently rewrite history.

---

## 9. Route Feature Boundary During Integration

The integration plan must create the route contract but must **not** solve all truck-routing semantics.

All route providers should eventually return a common shape containing at least:

```text
routeId / external key
vehicle or trip association
routeSource
origin
destination
geometry
distance / duration when available
provider metadata
```

The dashboard should render a **Planned Route**, not assume every route is A*-generated.

Detailed behavior is deferred:

- BIMS-derived demo vehicles: BIMS line route, terminal-to-terminal.
- custom recorded trucks: truck-aware A* + limitation data, with recordings intentionally made close to that path.

Those rules belong in `TRUCK_ROUTING_PLAN.md`, executed after the integration baseline is stable.

---

## 10. Telemetry Integration Strategy

Generalize the current BIMS concepts:

```text
Bus / HybridBusService / BIMS-specific frontend assumptions
                    |
                    v
Vehicle / VehicleTracker / TelemetrySource
```

Target source abstraction:

```text
TelemetrySource
├── BimsLiveSource
├── BimsPlaybackSource
├── DeviceGpsSource          # integration contract; detailed implementation may follow
└── RecordedGpsSource        # custom demo data contract
```

The same normalized vehicle-position DTO should flow upward regardless of source.

### Persistence rule

Persist authoritative source observations/history at a controlled cadence. Keep high-frequency render interpolation transient in the tracking/browser layer.

---

## 11. Operator Dashboard Strategy

Use the current Leaflet work as the starting point; do not introduce a frontend-framework migration just to integrate.

The first integrated dashboard should provide:

- Busan map,
- generic vehicle markers instead of "bus" markers,
- source/status diagnostics,
- selected vehicle detail panel,
- planned-route polyline when available,
- route-source label,
- live/playback mode controls for BIMS-derived telemetry where appropriate,
- **Live View** action that opens the existing browser-based WebRTC live-view URL as-is.

Do not embed, rewrite, or wrap the live-view implementation in Tauri. Do not map selected vehicle IDs to separate WebRTC sessions in this version.

---

## 12. High-Level Implementation Order

### Stage 0 — Protect and baseline

Run all current tests and record current startup commands/ports before moving code.

### Stage 1 — Build the integrated repository skeleton

Start from `p4_backend`; import the routing/tracking, WebRTC, relay, and Android components without behavior changes. Remove duplicate routing copy.

### Stage 2 — Upgrade schema + documentation atomically

Apply the three integration schema concepts (`vehicleSource`, `routeSource/sourceMetadata`, `telemetrySource`) and update ERD/API/docs in the same change set.

### Stage 3 — Generalize routing/tracking terminology and contracts

Extract BIMS tracking into a reusable `TelemetrySource` + `VehicleTracker` design while preserving current BIMS behavior and tests. Keep existing A* behavior intact.

### Stage 4 — Add Node integration/facade APIs

Add service clients/adapters so the operator frontend can use one control API for vehicle lists, current telemetry snapshots, planned routes, and bootstrap/live-view configuration.

### Stage 5 — Build the integrated operator dashboard

Refactor the existing Leaflet page into generic vehicle visualization and connect it to Node's integrated API.

### Stage 6 — Connect live view without redesign

Expose the existing single live-view URL through bootstrap/config and open the current browser live-view page as-is. Do not embed it into a new media implementation, wrap it with Tauri, or modify inference/media semantics.

### Stage 7 — Demo data wiring

Register BIMS-derived demo vehicles and custom-truck placeholders in the same domain/API. Verify live and playback telemetry through the generic contract.

### Stage 8 — End-to-end integration and deployment

Add top-level startup/configuration instructions, health checks, Docker Compose coverage where practical, and a deterministic demo runbook.

### Stage 9 — Execute separate truck-routing plan

Only after the integrated baseline is green, implement the detailed route-provider behavior and custom A* + limitation-data demo flow.

---

## 13. First Integration Acceptance Criteria

The integration baseline is complete when all of the following are true:

- One repository can start the Node backend, PostGIS, routing/tracking service, current WebRTC stack, and dashboard using documented commands.
- Existing subsystem tests still pass or have documented intentional changes.
- The dashboard authenticates/boots through Node.
- Multiple BIMS-derived vehicles can appear as generic vehicles on the map.
- BIMS live and playback use the same normalized telemetry contract.
- A selected vehicle can show a planned route returned through the generic route contract.
- The backend schema contains vehicle source, route source/provider metadata, and telemetry source.
- The integrated ERD and related docs match the actual schema.
- The Live View action opens the current browser-based single Android WebRTC+inference view as-is.
- WebRTC/inference behavior has not been redesigned as part of integration.
- No SUMO dependency exists.
- No operator route-reassignment workflow has been added.
- No duplicate A* codebase remains in the integrated repository.

---

## 14. Plans to Write Separately After Integration Baseline

1. `TRUCK_ROUTING_PLAN.md`
   - BIMS line/terminal route semantics,
   - custom truck A* + limitation-data semantics,
   - route compatibility and persistence,
   - route assignment/instruction details for the initial route.

2. Optional `CUSTOM_TRUCK_RECORDING_PLAN.md`
   - video/GPS/IMU capture format,
   - timestamp synchronization,
   - playback/import pipeline,
   - validation against the calculated A* route.

3. Optional future media plan
   - only if multi-truck concurrent live streams become a requirement.

---

## 15. Guiding Rule for Codex Agents

> **Integration first, redesign later.** Preserve working POCs, introduce stable boundaries, remove duplication, unify the domain and database, then improve individual features in separate plans.
