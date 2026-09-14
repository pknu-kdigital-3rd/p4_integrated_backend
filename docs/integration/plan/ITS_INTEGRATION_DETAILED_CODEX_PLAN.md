# Intelligent Transportation System — Detailed Codex Integration Plan

## 0. How to Use This Document

This is the executable companion to `ITS_INTEGRATION_OVERVIEW_PLAN.md`.

Run the phases **in order**. Each phase should normally be handled by a fresh Codex agent/session with the previous phase committed and a short handoff note available.

Do not ask one agent to "integrate everything" in a single pass.

### Global rules for every Codex agent

1. Read this document, `ITS_INTEGRATION_OVERVIEW_PLAN.md`, and the current phase's relevant source files before editing.
2. Run the phase's baseline tests before modifying code.
3. Do not implement future phases early unless required to make the current phase compile/test.
4. Do not perform unrelated refactors.
5. Do not replace package managers or frameworks during integration.
6. Preserve current WebRTC/inference behavior and current browser live-view page as-is.
7. Do not introduce Tauri or any desktop-wrapper layer.
8. Do not add SUMO.
9. Do not add operator route reassignment/rerouting.
10. Do not create per-truck live stream/session routing.
11. Treat schema + migration + ERD + related docs as an atomic task.
12. Prefer compatibility adapters before deleting old endpoints.
13. At the end of every phase:
    - run tests,
    - record changed files,
    - record commands used,
    - record known issues,
    - stop before the next phase.

Recommended integration branch:

```text
integration/its-unification
```

Recommended work log:

```text
docs/integration/INTEGRATION_WORKLOG.md
```

Each phase appends a section containing:

```text
Phase:
Commit:
Tests run:
Result:
Behavior changes:
Known issues:
Next-phase notes:
```

---

# 1. Source Repositories and Canonical Inputs

The source snapshots are:

```text
p4_backend_20260914/
bus_realtime_collected_display_20260914/
poc-optimal-path_20260914/
poc-server-webrtc_20260914/
```

Use `p4_backend_20260914` as the integration root.

For routing/tracking, use the BIMS-integrated copy under:

```text
bus_realtime_collected_display_20260914/poc-optimal-pth-20260911/
```

as the canonical code extraction source because it contains the shared A* implementation plus the newer BIMS route-cache work.

Use `poc-optimal-path_20260914` only as a reference/data source where it contains files not already represented in the canonical extraction. Do not import a second routing runtime.

Use `poc-server-webrtc_20260914` as the source of:

- Android publisher,
- Go/Pion relay,
- Python vision/live-view server,
- current live-view browser page and media documentation.

---

# 2. Target Repository Layout

Converge toward:

```text
its-platform/
├── node/
│   ├── prisma/
│   ├── src/
│   └── tests/
├── operator-web/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── services/
│   ├── routing-tracking/
│   │   ├── app/
│   │   ├── data/
│   │   ├── tests/
│   │   ├── pyproject.toml
│   │   └── uv.lock
│   ├── vision/
│   │   ├── app/
│   │   ├── tests/
│   │   ├── pyproject.toml
│   │   └── uv.lock
│   └── media-relay/
│       ├── internal/
│       ├── go.mod
│       └── go.sum
├── android/
├── data/
│   ├── routing/
│   └── demo/
├── docs/
│   ├── integration/
│   ├── v17_its_integrated_erd.md
│   └── ...
├── docker-compose.yml
├── ITS_INTEGRATION_OVERVIEW_PLAN.md
└── ITS_INTEGRATION_DETAILED_CODEX_PLAN.md
```

A phase may temporarily preserve old filenames while moving code. Do not combine both Python services into one environment merely because they are both Python.

---

# 3. Shared Contracts to Establish Early

Use generic names in new integration code.

## 3.1 Vehicle source

Initial values:

```text
CUSTOM
BIMS
```

## 3.2 Route source

Initial values:

```text
BIMS_LINE
OPTIMAL_PATH
```

The integration plan only stores/transports these values. Detailed selection/generation rules are deferred to the truck-routing plan.

## 3.3 Telemetry source

Initial values:

```text
BIMS_LIVE
BIMS_REPLAY
DEVICE_GPS
RECORDED_GPS
```

Do not store every browser interpolation frame as a database observation.

## 3.4 Normalized current-vehicle DTO

The exact field naming should follow the project's API conventions, but the contract must carry the equivalent of:

```json
{
  "vehicleId": "...",
  "vehicleCode": "...",
  "vehicleSource": "BIMS",
  "externalId": "...",
  "telemetrySource": "BIMS_LIVE",
  "latitude": 35.0,
  "longitude": 129.0,
  "speedKmh": 32.0,
  "headingDeg": 90.0,
  "recordedAt": "...",
  "trackingState": "live",
  "routeProgressPct": 42.1
}
```

Source-specific diagnostics may live under a metadata/diagnostics object instead of polluting the stable top-level contract.

## 3.5 Planned-route DTO

The common contract must carry the equivalent of:

```json
{
  "routeId": "...",
  "tripId": "...",
  "routeSource": "BIMS_LINE",
  "origin": {"name": "...", "latitude": 0, "longitude": 0},
  "destination": {"name": "...", "latitude": 0, "longitude": 0},
  "geometry": {},
  "distanceM": null,
  "durationSec": null,
  "sourceMetadata": {}
}
```

The dashboard must use the term **Planned Route** rather than assuming every route is A* generated.

---

# 4. Phase 0 — Baseline, Inventory, and Repository Protection

## Goal

Prove that every input subsystem is understood and has a recorded baseline before any integration movement.

## Agent scope

Read-only except for new integration documentation/worklog files.

## Tasks

1. Create the integration branch.
2. Copy these two plan documents into the integration root.
3. Create `docs/integration/INTEGRATION_WORKLOG.md`.
4. Inventory startup commands, ports, environment variables, and tests for:
   - Node backend,
   - PostGIS compose service,
   - routing/BIMS FastAPI,
   - Go relay,
   - vision FastAPI,
   - Android build.
5. Run all feasible tests without modifying behavior.
6. Record failures that already exist; do not "fix while inventorying" unless a test cannot even start because of a trivial path issue.
7. Record the current database table count and current schema/doc version mismatch if present.
8. Record the current live-view URL/startup path and WebRTC ports.
9. Record the canonical routing/tracking source decision and duplicated files found in the separate optimal-path snapshot.

## Suggested commands

Node:

```bash
cd node
npm ci
npm test
npm run build
```

Routing/tracking source:

```bash
uv sync
uv run python -m unittest discover -s tests -v
```

Vision:

```bash
uv sync
uv run pytest
```

Go relay:

```bash
go test ./...
go build ./...
```

Android:

```bash
./gradlew test
```

Adapt commands to the OS/environment; record deviations.

## Acceptance criteria

- No functional behavior changed.
- Baseline commands and results are in the worklog.
- Each component's ports/config are known.
- Duplicate routing source is explicitly identified.

## Codex prompt

```text
Execute Phase 0 of ITS_INTEGRATION_DETAILED_CODEX_PLAN.md only. Inspect all four source snapshots, run the current tests/builds where feasible, and write docs/integration/INTEGRATION_WORKLOG.md. Do not refactor application code. Stop after recording the baseline and source-of-truth decisions.
```

---

# 5. Phase 1 — Create the Integrated Repository Skeleton

## Goal

Create one repository without changing runtime behavior.

## Tasks

1. Start from the `p4_backend` root.
2. Create `services/`, `operator-web/`, `data/`, and `docs/integration/` as needed.
3. Import the canonical routing/tracking project to `services/routing-tracking/`.
4. Import WebRTC components:
   - `poc-server-webrtc/server` -> `services/vision/`,
   - `poc-server-webrtc/relay-go` -> `services/media-relay/`,
   - `poc-server-webrtc/android` -> `android/`.
5. Preserve component-local lockfiles.
6. Do not import the duplicate A* runtime from `poc-optimal-path`.
7. Move/copy required PBF/restriction/demo data into clearly documented locations. Avoid committing a second identical PBF if one canonical copy can be referenced safely.
8. Add a root `README.md` describing component locations and startup order.
9. Add root `.gitignore` coverage for all component build artifacts and local secrets.
10. Fix only paths/imports that break because of the move; do not rename APIs yet.
11. Re-run the Phase 0 tests from their new locations.

## Important constraints

- Do not merge the two Python `uv.lock` files.
- Do not rewrite WebRTC internals.
- Do not rename BIMS classes in this phase.
- Do not implement new route behavior.

## Acceptance criteria

- All components live in one repository.
- The routing implementation exists only once.
- Existing subsystem tests/builds pass at baseline level from new paths.
- Root README documents how to start each subsystem independently.

## Codex prompt

```text
Execute Phase 1 only. Build the integrated repository skeleton from p4_backend. Import the canonical BIMS-integrated routing/tracking source once, and import the current WebRTC Android/Go/Python components without changing their behavior. Preserve each runtime's package manager and lockfile. Fix move-related paths only. Re-run baseline tests and stop.
```

---

# 6. Phase 2 — Database Integration Migration + Documentation Sync

## Goal

Upgrade the domain schema before building new integration APIs, while keeping documentation synchronized in the same commit.

## Required schema changes

### `Vehicle`

Add:

```text
vehicle_source
external_id
```

Use the project's existing VARCHAR + CHECK-constraint pattern unless there is a strong reason to change the whole schema style.

Initial vehicle-source values:

```text
CUSTOM
BIMS
```

### `Route`

Add:

```text
route_source
source_metadata JSONB/Json
```

Initial route-source values:

```text
BIMS_LINE
OPTIMAL_PATH
```

Do not remove `route_type` in this phase.

### `VehiclePosition`

Add:

```text
telemetry_source
```

Initial values:

```text
BIMS_LIVE
BIMS_REPLAY
DEVICE_GPS
RECORDED_GPS
```

### Migration behavior

For existing rows, choose safe explicit defaults that preserve old data meaning. Document the chosen backfill. Do not leave production migration behavior implicit.

## Code surfaces to audit/update

At minimum inspect and update as necessary:

```text
node/prisma/schema.prisma
node/prisma/migrations/
node/prisma/seed.ts
node/prisma/sql/insertVehiclePosition.sql
node/prisma/sql/saveRouteFromGeoJson.sql
node/src/modules/vehicle/*
node/src/common/schema/*
node/src/docs/*
node/tests/*
```

Search the repository for every hard-coded vehicle/route/position shape rather than assuming the list above is complete.

## Documentation must be updated in the same phase

Create:

```text
docs/v17_its_integrated_erd.md
```

Use the current ERD as a basis but update it to the integrated architecture and actual schema.

Also audit/update current documentation that describes these entities, including at least:

```text
docs/implementation_plan_en_node_express_control_backend.md
docs/implementation_plan_ko_node_express_control_backend.md
docs/implementation_plan_en_whole_project.md
docs/implementation_plan_ko_whole_project.md
node/README_node.md
```

For versioned historical docs, preserve the historical file. If an old document is no longer current, add an explicit superseded/current-doc pointer instead of silently changing historical claims.

Audit architecture/pipeline docs that still describe obsolete frontend/media topology. Do not rewrite the current WebRTC implementation; make the docs accurately distinguish historical design from the integrated current design.

Update stale schema header comments/table counts in `schema.prisma` as part of this phase.

## Tests

Add/adjust tests for:

- create/read/update vehicle source and external ID,
- route source + source metadata persistence,
- vehicle-position telemetry source persistence,
- migration against a clean test database,
- existing auth/vehicle integration tests.

## Acceptance criteria

- Migration applies cleanly to test DB.
- Prisma generation/build succeeds.
- TypedSQL/raw SQL still works.
- OpenAPI reflects changed public fields where applicable.
- `v17_its_integrated_erd.md` matches the actual schema.
- EN/KO current docs no longer describe the old schema as current.
- Old ERD versions remain available as history.

## Codex prompt

```text
Execute Phase 2 only. Add the integration fields to Vehicle, Route, and VehiclePosition using the existing Prisma/PostGIS conventions. Create and test the migration, update all affected SQL/API/schema/seed/tests, and update the documentation atomically. Create docs/v17_its_integrated_erd.md and audit the related EN/KO backend/project docs. Do not implement routing algorithms or frontend work. Stop only when code, migration, OpenAPI, ERD, and docs agree.
```

---

# 7. Phase 3 — Generalize BIMS Tracking into Vehicle Telemetry

## Goal

Remove bus-specific assumptions from the reusable tracking core without changing BIMS behavior.

## Strategy

Do not start with a large rename of every file. First introduce generic interfaces/adapters around the working code, then migrate internals incrementally.

## Target abstractions

Create equivalents of:

```text
TelemetryObservation
TelemetrySource
VehicleTrackingState
VehicleTracker
```

Initial source implementations:

```text
BimsLiveSource
BimsPlaybackSource
```

Reserve interfaces/contracts for:

```text
DeviceGpsSource
RecordedGpsSource
```

but do not implement IMU fusion or custom-recording ingestion unless trivial fixtures are needed for contract tests.

## Tasks

1. Read the existing:
   - `bims_client.py`,
   - `hybrid_bus.py`,
   - BIMS route-cache builder,
   - tracking tests,
   - playback sections of the existing BIMS implementation plan.
2. Extract/introduce generic DTOs and source interfaces.
3. Wrap current BIMS polling behind `BimsLiveSource`.
4. Wrap current recorded CSV playback behind `BimsPlaybackSource`.
5. Keep the same route-constrained progress/interpolation behavior.
6. Ensure playback mode performs zero BIMS position calls while active.
7. Create a generic current-vehicle snapshot API for internal integration, while keeping existing `/api/buses*` endpoints temporarily for compatibility.
8. New generic API naming may be internal-only initially, for example:

```text
GET /internal/vehicles
GET /internal/vehicles/{external_id}
GET /internal/telemetry/status
```

9. Carry `telemetrySource` and stable external identity through the DTO.
10. Do not persist to PostgreSQL from this service in this phase.
11. Keep existing A* `/api/route` behavior intact.

## Tests

- existing BIMS tests,
- source isolation live vs playback,
- normalized DTO shape,
- stable identity mapping,
- playback seek/speed behavior if already implemented,
- no A* regression.

## Acceptance criteria

- Tracking core can talk about `Vehicle`/`TelemetryObservation` without requiring `Bus` semantics.
- BIMS live behavior still works.
- BIMS playback still works.
- Existing A* routing still works.
- Compatibility endpoints remain available until Node integration is complete.

## Codex prompt

```text
Execute Phase 3 only. Generalize the BIMS tracking core into generic vehicle telemetry using adapter/interfaces, while preserving current BIMS live/playback behavior and current A* behavior. Add a generic internal vehicle snapshot contract but keep legacy bus endpoints for compatibility. Do not add PostgreSQL ownership to Python and do not implement the separate truck-routing feature.
```

---

# 8. Phase 4 — Node Service Clients and Integration Facade

## Goal

Make Node the operator-facing control/facade API while keeping calculations/tracking in Python.

## New infrastructure

Add a small internal HTTP client abstraction for the routing/tracking service. Use Node-native `fetch` unless an existing dependency clearly justifies another client.

Add environment configuration such as:

```text
ROUTING_TRACKING_BASE_URL
LIVE_VIEW_URL
```

Keep existing vision configuration if still required; do not overload one variable with multiple meanings.

## Bootstrap

Extend the authenticated bootstrap response so the frontend can discover the shared live view, e.g. conceptually:

```json
{
  "services": {
    "vision": {"baseUrl": "..."},
    "liveView": {"url": "..."}
  }
}
```

Exact naming should match the project's schema conventions.

## New Node modules

Prefer small layered modules consistent with the existing repository/service/controller/router structure.

Potential modules:

```text
src/modules/tracking/
src/modules/route/
```

### Tracking facade responsibilities

- fetch generic current snapshots from routing/tracking service,
- map external BIMS identity to Node `Vehicle`,
- return operator-facing generic vehicle DTOs,
- optionally persist authoritative observations at a controlled cadence or through an explicit ingestion path,
- never persist browser render interpolation frames.

### Route facade responsibilities in this integration phase

- expose persisted planned-route data,
- expose a service-client boundary for route calculation,
- transport generic route-source metadata,
- do **not** implement detailed BIMS-line/A* route selection policy yet.

Recommended public API shapes can be refined by existing conventions, for example:

```text
GET /api/v1/tracking/vehicles
GET /api/v1/vehicles/:vehicleId/tracking
GET /api/v1/trips/:tripId/route
```

If adding a route calculation endpoint as a compatibility bridge, keep it thin and clearly mark detailed policy as deferred.

## BIMS vehicle identity

Use Node `Vehicle` records for integrated display. Define a deterministic mapping using:

```text
vehicleSource = BIMS
externalId = stable BIMS-derived identifier
```

Do not use line number alone as the only persistent vehicle identity if the available BIMS data exposes a stable vehicle/car identifier. If the current feed only exposes one selected vehicle per line for the demo, document the temporary identity rule explicitly.

## Tests

Mock the Python service for Node integration tests.

Cover:

- unavailable tracking service,
- successful vehicle snapshot,
- source fields preserved,
- bootstrap live-view URL,
- auth/RBAC on operator-facing endpoints,
- JSON BigInt serialization.

## Acceptance criteria

- Operator clients can get integrated tracking data through Node.
- Python remains a calculation/tracking service, not business authority.
- Shared live-view URL is discoverable through Node configuration/bootstrap.
- Existing auth and vehicle endpoints remain green.

## Codex prompt

```text
Execute Phase 4 only. Add a Node internal client for the routing/tracking service and expose authenticated operator-facing tracking/route facade endpoints using the existing layered architecture. Extend bootstrap with a separate shared LIVE_VIEW_URL. Keep Python as the tracking/calculation service and Node as business/database authority. Do not implement detailed truck-routing policy or per-truck media sessions.
```

---

# 9. Phase 5 — Build the Integrated Operator Dashboard

## Goal

Turn the current Leaflet POC into a generic ITS operator dashboard connected primarily to Node.

## Source

Use the existing BIMS/A* `static/index.html` as the visual/behavior reference, but create an integration-owned frontend instead of continuing to edit the POC page in place.

Target:

```text
operator-web/index.html
operator-web/app.js
operator-web/styles.css
```

No React migration is required.

## Dashboard layout

At minimum:

```text
+---------------------------------------------------------------+
| ITS Dashboard                                                 |
+--------------------------------------+------------------------+
|                                      | Selected Vehicle       |
|                 MAP                  | source/status          |
|                                      | speed / timestamp      |
|       multiple vehicle markers       | planned route source   |
|       planned route polyline         |                        |
|                                      | [ Live View ]          |
|                                      | [ Route Details ]      |
+--------------------------------------+------------------------+
```

## Tasks

1. Authenticate with the existing Node auth flow or provide a minimal integration login screen if needed.
2. Fetch bootstrap from Node.
3. Fetch generic live vehicle snapshots from Node.
4. Replace bus-specific marker/domain names in the integration frontend with vehicle terminology.
5. Keep source status useful for diagnostics:
   - BIMS live,
   - BIMS replay,
   - recorded/custom where available.
6. Preserve smooth map rendering. Continue using `requestAnimationFrame` or equivalent browser interpolation; do not write render frames to DB.
7. Add selected vehicle state.
8. Render the persisted/planned route returned by Node when available.
9. Label it `Planned Route` and show `routeSource` rather than labeling everything "optimal".
10. Add a Live View action that reads the bootstrap `LIVE_VIEW_URL`.
11. Do not add per-vehicle stream lookup.
12. Keep BIMS live/playback controls only if they remain useful for the demo; expose them through an integration-safe control path rather than making the frontend call BIMS directly.

## Serving strategy

Choose one simple strategy and document it:

- Node serves `operator-web` as static assets, **or**
- a small static web server serves it separately.

Prefer same-origin Node serving if it does not complicate the existing API/test setup.

## Acceptance criteria

- Generic vehicles move on the map.
- No user-facing "bus" terminology is required to understand the integrated dashboard.
- Planned route can be drawn from generic route data.
- Live View button uses shared configured URL.
- Browser does not call BIMS APIs directly.

## Codex prompt

```text
Execute Phase 5 only. Build operator-web from the current Leaflet POC but make it a generic ITS dashboard that talks to Node's authenticated integration APIs. Show generic vehicle markers, selected-vehicle details, planned route, route source, and a Live View action using bootstrap LIVE_VIEW_URL. Preserve smooth browser animation. Do not implement truck-routing policy or WebRTC internals.
```

---

# 10. Phase 6 — Integrate the Existing WebRTC Live View as a Black Box

## Goal

Make live view reachable from the integrated product without changing its media/inference behavior.

## Tasks

1. Verify the imported Go relay, Python vision service, and Android app still run exactly as in the baseline.
2. Configure `LIVE_VIEW_URL` to the current vision/browser live-view page.
3. From the operator dashboard, make the **Live View** action open/switch to the existing browser live-view page through `LIVE_VIEW_URL`.
4. Use that live-view page as-is; do not iframe/rebuild its player, move its media logic into the dashboard, or introduce Tauri.
5. Do not add vehicle ID to the media handshake merely for integration.
6. Do not add stream manager/multi-publisher logic.
7. Do not alter the current inference queue/synchronization semantics.
8. Preserve secure-context requirements for WebCodecs/HTTPS.
9. Document certificate/browser setup needed for the demo.

## Acceptance criteria

- Android stream reaches the existing live-view page.
- YOLO inference result is visible exactly as before integration.
- Dashboard Live View action opens/reaches that existing browser page without replacing its player.
- No Tauri runtime or desktop wrapper is introduced.
- Selecting different map vehicles does not pretend that a different camera stream exists.
- No media-path regression is introduced.

## Codex prompt

```text
Execute Phase 6 only. Treat the current WebRTC/YOLO live-view stack and its browser page as a black box. Wire the dashboard's Live View action to open the one configured LIVE_VIEW_URL as-is and verify the existing Android -> Go -> Python -> browser behavior still works. Do not iframe/rebuild the player and do not introduce Tauri. Make no queue, synchronization, multi-stream, or per-vehicle-session redesigns.
```

---

# 11. Phase 7 — Demo Vehicle Registration and Telemetry Wiring

## Goal

Make BIMS-derived vehicles and custom-truck placeholders coexist under one integrated Node domain.

## BIMS-derived vehicles

1. Define a deterministic registration/seed/import method.
2. Store:
   - `vehicleSource = BIMS`,
   - `externalId`,
   - display code/name suitable for the operator UI.
3. Keep BIMS line information as route/provider metadata, not as a substitute for vehicle identity unless that is explicitly the temporary demo rule.
4. Connect normalized BIMS snapshots to these Node vehicle records.
5. Verify live and replay modes both resolve to the same vehicle identities.

## Custom trucks

Create one to three `CUSTOM` vehicle records with real dimensions available for the later truck-routing plan.

Do not fabricate final GPS/video/IMU ingestion if recordings are not yet available. Create fixtures/contracts only.

## Route placeholders

Allow demo data to associate a planned route with a trip using:

```text
routeSource = BIMS_LINE
```

or:

```text
routeSource = OPTIMAL_PATH
```

without implementing the separate routing policy here.

## Acceptance criteria

- BIMS and CUSTOM vehicles can be returned together from Node.
- Dashboard markers do not care which source produced them.
- Source labels remain inspectable.
- Route display contract accepts both route source types.

## Codex prompt

```text
Execute Phase 7 only. Add deterministic integrated demo registration for BIMS-derived vehicles and 1-3 CUSTOM vehicle placeholders. Wire BIMS live/replay snapshots to stable Node Vehicle records and prove both source types can coexist in the same operator API/dashboard. Use routeSource metadata but do not implement detailed routing policy or custom recording ingestion yet.
```

---

# 12. Phase 8 — Persistence Policy for Position History

## Goal

Persist useful telemetry without turning browser interpolation into database noise.

## Tasks

1. Define the authoritative observation boundary:
   - BIMS API observations,
   - BIMS replay source observations,
   - future device GPS observations,
   - future recorded GPS observations.
2. Define whether every source observation is persisted or whether a configurable cadence/deduplication rule is used.
3. Do not persist every `requestAnimationFrame` position.
4. Use the existing TypedSQL/PostGIS path for `VehiclePosition`.
5. Set `telemetrySource` on every inserted row.
6. Add indexes only when justified by current query paths; preserve current trip/vehicle/time access patterns.
7. Add history retrieval regression tests.
8. Verify current-position UI does not block on database writes.

## Acceptance criteria

- Position history includes provenance.
- Database growth is bounded by source observations/cadence, not render FPS.
- Current tracking remains responsive if DB writes are slow/unavailable according to chosen failure policy.

## Codex prompt

```text
Execute Phase 8 only. Implement the integrated VehiclePosition persistence policy using authoritative telemetry observations and the existing TypedSQL/PostGIS conventions. Always record telemetrySource. Never persist browser animation frames. Add tests for source provenance, history retrieval, and non-blocking current tracking behavior.
```

---

# 13. Phase 9 — End-to-End Startup, Health, and Integration Tests

## Goal

Make the integrated product reproducible for development and demo operation.

## Tasks

1. Define top-level configuration in a documented `.env.example` or component-specific examples without committing secrets.
2. Extend `docker-compose.yml` only where it genuinely helps. PostgreSQL/PostGIS remains required; containerization of every component is not mandatory if it would destabilize the existing WebRTC/GPU setup.
3. Add health/readiness coverage for:
   - Node,
   - database,
   - routing/tracking,
   - vision,
   - media relay if feasible.
4. Add an integration smoke-test script or documented command sequence.
5. Verify two operating scenarios:

### Scenario A — BIMS live

```text
BIMS live -> tracking service -> Node facade -> dashboard map
```

### Scenario B — BIMS playback

```text
recorded BIMS -> playback source -> same tracker -> Node facade -> dashboard map
```

6. Verify Live View independently in the same dashboard session:

```text
Android -> Go relay -> Python/YOLO -> shared live-view URL
```

7. Verify route display from persisted generic route data, without requiring the future routing policy implementation.
8. Test service-unavailable UI states instead of allowing silent failures.

## Acceptance criteria

- Clean documented startup works on a fresh checkout with required external data/secrets supplied.
- Dashboard remains usable if live-view service is unavailable.
- Dashboard reports tracking-service errors clearly.
- BIMS playback does not call live BIMS position endpoints.
- No hidden dependency on SUMO exists.

## Codex prompt

```text
Execute Phase 9 only. Make the integrated system reproducible: environment examples, health/readiness, startup documentation, and end-to-end smoke tests for BIMS live, BIMS playback, generic planned-route display, and the unchanged shared WebRTC live view. Do not expand product scope.
```

---

# 14. Phase 10 — Documentation, ERD Verification, and Cleanup

## Goal

Finish integration with documentation that describes the product that actually exists.

## Tasks

1. Re-open `schema.prisma` and compare every table/field named in `docs/v17_its_integrated_erd.md`.
2. Verify the ERD relationship names, service ownership notes, and table count.
3. Audit current EN/KO project docs for:
   - old Tauri assumptions (remove them from current architecture docs or mark them historical; the integrated product has no Tauri runtime),
   - old service names/paths,
   - old schema fields,
   - old route ownership,
   - duplicated routing service descriptions.
4. Preserve historical docs but mark superseded ones clearly.
5. Update root README with:
   - architecture,
   - repository layout,
   - startup order,
   - environment variables,
   - test commands,
   - demo runbook,
   - known limitations.
6. Add a short `docs/integration/NEXT_PLANS.md` that points to:
   - `TRUCK_ROUTING_PLAN.md` as the next major feature plan,
   - optional custom recording plan,
   - optional future multi-stream media plan.
7. Remove dead compatibility endpoints only if they are no longer used and tests prove removal safe. Otherwise leave a deprecation note.
8. Run the complete test/build suite one final time.

## Acceptance criteria

- No current document claims a schema/topology contradicted by code.
- ERD matches the database.
- Integration worklog has all phases.
- Full test/build matrix is recorded.
- Separate routing work is clearly deferred rather than half-implemented.

## Codex prompt

```text
Execute Phase 10 only. Perform the final integration documentation audit. Verify docs/v17_its_integrated_erd.md field-by-field against schema.prisma and the actual migration, update current EN/KO architecture/backend docs and root README, mark historical docs as superseded where appropriate, record the full test matrix, and stop. Do not begin the separate truck-routing plan.
```

---

# 15. Phase Dependency Graph

```text
Phase 0  Baseline
   |
   v
Phase 1  Repository skeleton
   |
   v
Phase 2  Schema + ERD/docs
   |
   v
Phase 3  Generic routing/tracking contracts
   |
   v
Phase 4  Node facade
   |
   +---------------------+
   |                     |
   v                     v
Phase 5 Dashboard     Phase 7 Demo registration
   |                     |
   v                     v
Phase 6 Live View     Phase 8 Position persistence
   |                     |
   +----------+----------+
              |
              v
        Phase 9 E2E
              |
              v
        Phase 10 Docs audit
              |
              v
     Separate Truck Routing Plan
```

For simplicity, execute sequentially unless you deliberately use separate Git worktrees and can guarantee no overlapping files. Phase 5/7 can theoretically overlap after Phase 4, but sequential execution is safer for Codex-driven integration.

---

# 16. Files/Areas That Should Not Be Changed Casually

## WebRTC/live-view internals

Treat these as behavior-frozen during integration unless a move breaks them:

```text
services/media-relay/internal/broadcaster/
services/media-relay/internal/yolofeed/
services/vision/app/services/webrtc.py
services/vision/app/services/yolo.py
services/vision/app/api/playback.py
android/ WebRTC publisher internals
```

The exact final paths may differ after Phase 1; apply the rule semantically.

## Routing algorithm internals

Do not redesign truck restrictions/A* heuristics as part of integration. That belongs to `TRUCK_ROUTING_PLAN.md`.

## Historical documentation

Do not rewrite versioned historical ERDs to make them look current. Create v17 and point current docs to it.

---

# 17. Integration Test Matrix

At the end, the following matrix should be green or have explicit documented external prerequisites.

| Area | Test |
|---|---|
| Node auth | login, `/me`, RBAC |
| Vehicle CRUD | CUSTOM + BIMS source fields |
| DB migration | clean apply + test DB deploy |
| Route persistence | route source + metadata |
| Position persistence | telemetry source + PostGIS location |
| Tracking service | BIMS live normalization |
| Playback | zero BIMS location calls while playback active |
| A* baseline | existing route endpoint unchanged |
| Node tracking facade | mock + live service response |
| Dashboard | generic marker rendering + selected vehicle |
| Planned route | generic route geometry rendering |
| Live view | shared URL opens current inference view |
| Vision | existing Python tests |
| Relay | `go test ./...` / build |
| Android | existing build/tests |
| Docs | ERD/schema field-by-field verification |

---

# 18. Demo Runbook Target

The integrated demo should eventually be runnable in this conceptual order:

```text
1. Start PostgreSQL/PostGIS.
2. Start Node control backend.
3. Start routing/tracking service in BIMS live OR playback mode.
4. Start Go media relay.
5. Start Python vision service.
6. Start/open operator dashboard.
7. Optionally start Android camera publisher for Live View.
```

The dashboard should then demonstrate:

```text
many BIMS-derived moving vehicles
        +
one generic planned route per selected vehicle when available
        +
CUSTOM truck records ready for the later A* routing plan
        +
one current Android WebRTC/YOLO live view
```

---

# 19. Master Codex Prompt

Use this only to coordinate the work. Prefer giving each Codex agent the specific phase prompt above.

```text
We are integrating four existing POCs into one Intelligent Transportation System. Follow ITS_INTEGRATION_OVERVIEW_PLAN.md and ITS_INTEGRATION_DETAILED_CODEX_PLAN.md exactly.

Use p4_backend as the integration root. Use the BIMS-integrated routing/tracking copy as the single canonical source of the duplicated A* code. Import the current WebRTC Android/Go/Python stack without changing its behavior.

Important scope rules:
- no SUMO,
- no Tauri or desktop-wrapper layer,
- use the existing browser live-view page as-is,
- no operator route reassignment,
- no per-truck/multi-stream WebRTC redesign,
- keep current live-view inference/playback semantics,
- one configured LIVE_VIEW_URL is enough,
- generalize BIMS tracking to generic vehicle telemetry,
- detailed BIMS-line vs truck-aware A* routing behavior is a separate future plan,
- schema changes and documentation/ERD updates must be atomic.

Implement one numbered phase at a time. Before editing, run that phase's baseline tests. After editing, run the required tests, append a handoff to docs/integration/INTEGRATION_WORKLOG.md, and stop. Do not perform unrelated refactors or start the next phase early.
```

---

# 20. Definition of Integration Complete

Integration is complete when the repository behaves as one ITS product while the major working subsystems remain independently understandable and testable.

The successful first milestone is:

> **BIMS live/playback or future custom telemetry -> generic vehicle tracking -> Node business facade -> integrated map/dashboard, with generic planned-route support and the existing single Android WebRTC/YOLO live view available from the same operator experience.**

Only after this milestone is stable should Codex begin the separate detailed truck-routing implementation plan.
