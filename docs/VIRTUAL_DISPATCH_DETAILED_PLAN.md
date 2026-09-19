# Virtual Routing & Dispatch — Detailed Implementation Plan

**Status:** finalized product, road-state and per-vehicle follow-toggle decisions (2026-09-19). **Inputs:** `poc-optimal-path_20260919.zip`, `p4_integrated_backend_20260919.zip`. **Implementation target:** existing integrated monorepo; no new independent web app and no change to Android/Go/vision media flow. **Document date:** 2026-09-19.

## 0. Source-code audit / non-negotiable constraints

**Confirmed current paths:**

- `services/routing-tracking/graph_backend.py` implements `OsmnxGraph` and `PurePythonGraph`, each exposing `nearest_node`, `nearest_coords` and `route(start_id, goal_id, truck_class=None)`. POC `RouteResult` only carries `[lat, lon]` coordinates, distance and estimated time. Graph startup lives in `services/routing-tracking/main.py`. The current `POST /api/route` does not carry edge IDs, waypoints, or per-request dynamic exclusions.
- POC restriction loading includes `gov_restrictions.json`, `manual_restrictions.json`, `turn_restrictions.json`; `busan-roads_osm.pbf` and `busan_width_restrictions.csv` are present. **Verify whether/how width CSV is used by the government restriction generator and graph ingestion before claiming every CSV record is actively enforced.** OSM data coverage is incomplete; retain provenance and warn instead of treating unspecified limits as guaranteed safe.
- Existing A* uses a per-node `g_score`/visited set and only one best-known incoming way per node, despite checking turn restrictions. This can exclude a valid path or miss a truly optimal turn-aware path. **Correct with an incoming-edge/way-aware search state** if the product requires "optimal" under turn restrictions. Also fix cross-leg waypoint junction transitions.
- `node/prisma/schema.prisma` v18 has `Vehicle.vehicleSource` CHECK `CUSTOM|BIMS`, `Trip.vehicleId NOT NULL`, `Trip.tripStatus`, `Route.routeVersion`/`isCurrent` and `Route.routeSource` CHECK `BIMS_LINE|OPTIMAL_PATH`, `VehiclePosition.telemetrySource` BIMS/DEVICE values. These DB CHECKs need explicit SQL migrations, not just Prisma changes.
- Node already provides `/api/v1/vehicles`, `/api/v1/trips` and `/api/v1/tracking/*` with JWT/roles. `tracking.client.ts` only supports GET snapshot/get-vehicle; add a **separate typed routing/virtual client** for new POST operations. Existing `tracking.service.ts` merges BIMS and Android device observations and can persist BIMS observations in a read path: **do not inject virtual vehicles into that feed.**
- `operator-web/app.js` has a single Leaflet map and substantial live/replay handling; existing `demoMode` denotes read-only public/auth fallback and is **not** the desired virtual-mode flag. Extract an independent UI controller instead of augmenting the existing monolith with more global state.
- Graph cached with `.graph_cache.pkl`; dynamic operator blockage/penalty must be a **scenario-scoped overlay**, never `G.remove_edge()`/mutation of cached network or rewriting static restriction files.
- `docs/v18_its_integrated_erd.md` and `docs/integration/plan/*` document the current schema/ownership. All migrations, schema, ERD, typed SQL, API docs and relevant architecture docs must change in the same PR.

### Out-of-scope for first release

No virtual camera, synthetic video, QR timestamp, MinIO recording, Android virtual publisher, SUMO, BIMS route modification, physics-based vehicle model, traffic prediction, collision avoidance or road-safety certification. The simulation uses the road-network itinerary and modeled speeds; its ETA is a routing estimate, not a live-traffic forecast.

## 1. Business rules / user stories

**Workspace and route preview**

1. Authenticated operator switches `NORMAL` -> `VIRTUAL_DISPATCH` using explicit tab/route. Virtual mode has a separate vehicle list, map interaction toolbar, route/waypoint layers, assignment inbox and simulation controls. Closing/switching tabs must not stop backend simulation.
2. Choose an AVAILABLE virtual vehicle first, then origin and destination; the backend derives its truck profile (small/semi/special or validated vehicle-specific fields), optional ordered waypoints. Clicking the map uses mode-specific point picker, not normal trip-create or live-view selection. Coordinate entry and drag markers also supported. `Preview route` computes a **draft** and shows path, estimated duration, distance, selected restrictions, snapped points and violations/errors. A preview never reserves a vehicle or creates an `IN_PROGRESS` trip.
3. Show a visible draft/scenario revision badge; if any blockage or congestion penalty changes before dispatch, preview/revalidate at acceptance.

**Dispatch request**

4. `Generate driver request` creates a *simulated* driver assignment request for the **specific AVAILABLE virtual vehicle selected by the operator**. The action MUST NOT create, pick from a pool, or substitute a vehicle. A separate inventory/setup flow can create demo vehicles in advance, outside dispatch. Request enters `PENDING` with `acceptAt = createdAt + autoAcceptAfterSeconds` when auto-accept enabled. The operator can `ACCEPT`/`REJECT` before deadline. In manual-only policy it stays pending until decision or optional expiry. No real notification/Android driver integration.
5. `ACCEPT` (human or timer) must be exactly-once and transactional: compare status `PENDING`, lock/reserve vehicle, atomically create Trip (required vehicle ID), create Route v1, bind Driver, initialize VirtualVehicleState and audit decision. Duplicate clicks and timer races return the same accepted result (idempotency key); conflicting requests cannot share one active virtual vehicle.
6. **Required** start policy: acceptance immediately transitions the selected virtual vehicle to `DRIVING`; there is no manual-start/READY branch in initial dispatch. Reject does not reserve/start vehicle. The timer worker checks **persistent** due requests; do not use a request-local or per-web-process `setTimeout` as the only scheduler.

**In-motion operations**

7. Motion follows a directed-edge itinerary, obeys speeds/speed factor and stops at future waypoints/destination as configured. A server timestamped, sequenced snapshot drives client rendering; client interpolation must never become routing input.
8. Operators choose `HEAVY_PENALTY` (congestion; passable) or `BLOCKED` (construction/disaster; impassable), preview the region's full affected road segments, then commit. **Reject the entire BLOCKED activation with `409 ROAD_OCCUPIED`** if any same-scenario virtual vehicle with an authoritative current position occupies any affected physical road segment **or any directed edge the blocker would exclude** (including opposite directed traversal of the same physical segment and driving/paused/waiting/parked vehicles). Revalidate against authoritative occupancy **at commit**, not only preview. The operator can redraw or wait until the road becomes empty; no silent relocation/partial blocker. A HEAVY_PENALTY region may cover an occupied road.
9. On **either** kind of road-state change, identify active trips whose **remaining** route intersects changed directed edges; per-vehicle action depends on route policy. With `FOLLOW_OPTIMAL`, recalculate immediately from legal forward continuation through remaining waypoints and adopt a valid new optimal route (even if identical geometry remains optimal). With `MANUAL_HOLD`, a congestion penalty **does not** switch routes, change its existing speed/cost snapshot, or stop motion. With `MANUAL_HOLD`, a closure stages a candidate only; the vehicle advances along valid assigned edges and stops **before the first blocked edge**, entering `BLOCKED_AWAITING_OPERATOR` pending explicit action. No alternative after closure: stop before prohibited entry regardless of policy. Never let a worker enter a blocked edge during asynchronous reroute.
10. Add/reorder/remove a waypoint before dispatch or *future* waypoint while driving. Never reorder or silently delete `REACHED` waypoints. Route replacement starts from the current progress anchor, visits every remaining waypoint in explicit sequence, then reaches the original destination. If new waypoint is unreachable under restrictions, return an error and **retain last valid route** (except safety stop for active blocked edge).
11. `autoFollowEnabled=false` means **manual route activation**, not ignoring closures. Operator may `Apply candidate` or enable auto-follow on **that vehicle**; an explicit waypoint edit may stage a candidate but cannot silently replace an active route. Congestion alone must not yield `BLOCKED_AWAITING_OPERATOR`. Do not let "manual" bypass static physical limits or currently invalid roads.
12. Both road-region types are shared by all same-scenario vehicles, but **automatic following is a persistent setting on each individual virtual vehicle**. Vehicle A may be ON and B OFF; a toggle for A must not change B's setting, route, or motion. Each trip retains its own assigned-route snapshot and ordered waypoints. Every road-state change generates an audit event with actor, restriction kind and reason.
13. **OFF → ON triggers immediate fresh routing**, not merely subscription to future road-state changes. At the toggle, obtain the target vehicle's authoritative **current edge/offset**, graph/restriction revision and remaining waypoints; calculate an optimal route from its current forward-legal position through remaining waypoints to the **unchanged destination of its active trip** under the latest restrictions. Atomically activate a feasible route without resetting to the original start, even when no restriction changed. A vehicle stopped waiting at a blockage automatically resumes when the valid new route is applied; an explicitly PAUSED vehicle stays paused. If no legal path exists, remain safely stopped with follow ON and report `NO_ROUTE` (retry on relevant road changes). ON → OFF updates only that vehicle's setting and leaves its current active route intact.

## 2. State machines and command semantics

**Dispatch**: `PENDING -> ACCEPTED | REJECTED | EXPIRED`; no reverse transition. Reject and expiry release any provisional reservation. Human and timer both invoke *the same* acceptance service.

**Simulation**: `ACCEPTED -> DRIVING <-> PAUSED`; `DRIVING/PAUSED/BLOCKED_AWAITING_OPERATOR -> REROUTING -> DRIVING/PAUSED`, or `BLOCKED_AWAITING_OPERATOR/NO_ROUTE`, or `COMPLETED/CANCELLED`; terminal states never move again. `REROUTING` can be a short-lived internal state while current valid itinerary continues until atomic switch, unless upcoming blocked edge requires a stop.

**Per-vehicle route policy**: `VirtualVehicleSettings.autoFollowEnabled` is the sole persisted source (`true = FOLLOW_OPTIMAL`, `false = MANUAL_HOLD`) keyed by **virtual `vehicleId`**, not by scenario ID, browser mode, or trip ID. The trip service resolves the active trip from the targeted vehicle and keeps route snapshots versioned per trip; the setting persists across dashboard switching and consecutive trips. A congestion cost update cannot stop or replace the active itinerary for the one vehicle whose setting is OFF. On either policy, a newly prohibited upcoming edge causes a stop before entry unless a valid replacement route is already applied. Initial setting defaults to ON as an implementation default and may be configured for the selected vehicle before dispatch.

**Transition semantics**: ON → OFF only changes the targeted vehicle's setting (and version), retaining its active route, motion and explicit PAUSE. **Every OFF → ON of a vehicle with an active trip starts a new optimal calculation immediately** from its authoritative position to its existing trip destination via remaining waypoints, even without any restriction update; a successful switch commits a new active route and the ON setting consistently. This is not the same as `RESUME` or `APPLY_ROUTE_CANDIDATE`. For a vehicle without an active trip, save its setting for future dispatch without routing. If the route is impossible, keep ON, expose `NO_ROUTE` and stop safely; if solver is temporarily unavailable, report a retryable error and retain the last valid itinerary under the closure guard. Never unpause an explicitly PAUSED trip simply because follow mode was enabled.

**Commands**: `PAUSE`, `RESUME`, `SET_SPEED_FACTOR`, `SET_AUTO_FOLLOW`, `APPLY_ROUTE_CANDIDATE`, `ADD_WAYPOINT`, `MOVE_WAYPOINT`, `DELETE_WAYPOINT`, `CANCEL_TRIP`, `PREVIEW_ROAD_RESTRICTION`, `ACTIVATE_ROAD_RESTRICTION`, `UPDATE_ROAD_RESTRICTION`, `DEACTIVATE_ROAD_RESTRICTION`. Every state-changing request has idempotency key or expected revision, actor and auditable result. Browser must not write vehicle coordinates directly.

## 3. API design (Node public facade; Python internal)

Use `/api/v1/virtual/*` for authenticated operator APIs; leave existing `/api/v1/tracking/*`, `/api/v1/trips`, `/api/v1/demo/*` untouched. The paths below are **proposed** contracts, not existing endpoints. Express Zod validates payload; service validates permissions, assignment uniqueness and state transitions.

| Method | Public endpoint | Purpose / important inputs |
|---|---|---|
| `POST` | `/api/v1/virtual/scenarios` | Create scenario; name and operator-configurable `autoAcceptAfterSeconds` (null means manual approval only); movement always starts on acceptance. |
| `GET` | `/api/v1/virtual/scenarios/:id` | Scenario config, restriction revision, active vehicles/request counts. |
| `POST` | `/api/v1/virtual/scenarios/:id/routes/preview` | Origin/destination coordinates, ordered waypoints, **required selectedVehicleId** (profile derived on server), `expectedRestrictionRevision`; returns draft ID + edge itinerary summary + renderable geometry. |
| `POST` | `/api/v1/virtual/scenarios/:id/dispatch-requests` | Saved draft ID, **required selectedVehicleId matching the draft**, generated simulated driver request; idempotency key and effective operator-configured auto-accept policy. Reject vehicle substitution. |
| `GET` | `/api/v1/virtual/scenarios/:id/dispatch-requests` | Pending inbox and countdown based on server deadline. |
| `POST` | `/api/v1/virtual/dispatch-requests/:id/accept` | Atomically accept/create trip/route/state. |
| `POST` | `/api/v1/virtual/dispatch-requests/:id/reject` | Reject pending request. |
| `GET` | `/api/v1/virtual/scenarios/:id/vehicles` | Virtual-only snapshots, trip progress, active route version, **each vehicle's own** `autoFollowEnabled`/`policyVersion`, status. |
| `PUT` | `/api/v1/virtual/vehicles/:vehicleId/following` | **Canonical per-vehicle toggle.** Body `{ "enabled": true|false, "expectedPolicyVersion": N, "expectedTripCommandVersion": N? }`; validate scenario/vehicle authorization and use an idempotency key. OFF → ON immediately initiates current-position-to-destination routing through remaining waypoints (if trip active); ON → OFF retains the active itinerary. Return the targeted vehicle's new policy/state, current route or in-progress reroute ID; do not mutate other vehicles. |
| `GET` | `/api/v1/virtual/trips/:id` | Current route, waypoints, checkpoint and pending candidate. |
| `POST` | `/api/v1/virtual/trips/:id/commands` | Version-checked motion/apply commands; route-follow toggle uses the **vehicle-specific** endpoint above rather than a scenario-wide or trip-global switch. |
| `PUT` | `/api/v1/virtual/trips/:id/waypoints` | Atomically replace ordered future waypoint list with `expectedTripRevision`; replan or stage. |
| `POST` | `/api/v1/virtual/scenarios/:id/road-restrictions/preview` | Preview polygon plus `kind=BLOCKED|HEAVY_PENALTY`; resolve **physical and directed** edges, affected trips and occupied physical segments. For BLOCKED show occupants and prevent confirmation; preview is advisory only. |
| `POST` | `/api/v1/virtual/scenarios/:id/road-restrictions` | Atomically validate kind/polygon/penaltyFactor, recheck occupancy and restriction revision, activate only if allowed; otherwise `409 ROAD_OCCUPIED` (entire operation rejected), with affected edge/vehicle IDs and no revision increment. |
| `PATCH` | `/api/v1/virtual/road-restrictions/:id` | Update/disable/expire region; any update **creating or expanding BLOCKED coverage** must perform the same atomic occupied-road check. Recalculate affected routes/revision. |
| `GET` | `/api/v1/virtual/scenarios/:id/events` | Replayable audit/event feed after event ID. |
| `GET` | `/api/v1/virtual/scenarios/:id/stream` | Optional SSE stream (or authenticated WS if existing infrastructure is selected). Snapshot + incremental events with monotonically increasing sequence. |

**Example route preview input (Node)**

```json
{
  "selectedVehicleId": "selected-virtual-vehicle-id",
  "origin": { "lat": 35.105, "lon": 129.040 },
  "destination": { "lat": 35.125, "lon": 129.065 },
  "waypoints": [
    { "clientId": "stop-1", "lat": 35.112, "lon": 129.050 }
  ],
  "expectedRestrictionRevision": 3
}
```

**Example response shape** (illustrative, not hard-coded road IDs):

```json
{
  "draftId": "opaque-draft-id",
  "scenarioId": "1",
  "restrictionRevision": 3,
  "graphVersion": "osm-and-static-restriction-fingerprint",
  "optimization": "TRAVEL_TIME",
  "distanceM": 4352,
  "durationSec": 612,
  "routeGeojson": { "type": "LineString", "coordinates": [[129.040,35.105],[129.050,35.112]] },
  "directedItinerary": [{ "edgeId": "opaque-directed-edge-id", "fromNodeId": "...", "toNodeId": "...", "lengthM": 122.3, "cumulativeStartM": 0.0, "geometryRef": "..." }],
  "snappedStops": [{ "clientId": "stop-1", "edgeId": "...", "offsetM": 35.7 }],
  "warnings": []
}
```

Large edge geometries can remain internal; public response can return condensed itinerary metadata while storing full itinerary in a draft/route snapshot. **OSM way ID alone is not a safe directed-edge key:** one way can contain multiple segments, be simplified, and have parallel/opposite-direction edges. Use stable graph-edge IDs based on graph version + directed `(u,v,key)` (or deterministic per-segment ID in the fallback parser).

**Python internal, private/authenticated** (behind service network + service-token check): `POST /internal/routing/snap`, `POST /internal/routing/route`, `POST /internal/routing/road-restrictions/resolve`, `GET /internal/routing/graph-version`; `POST /internal/virtual/sessions`/`.../commands`/`.../restore` if Python hosts the transient motion worker. Never expose unrestricted graph/session mutation through existing unauthenticated `/api/route` demo endpoint. Node sends known scenario blocked edge IDs/revision and a single authoritative command version. Return clear `ROUTE_NOT_FOUND`, `POINT_TOO_FAR_FROM_ROAD`, `UNREACHABLE_WAYPOINT`, `ROAD_OCCUPIED`, `STALE_REVISION`, `GRAPH_VERSION_MISMATCH`, `ROUTING_UNAVAILABLE` error codes.

**Selected-vehicle contract:** `selectedVehicleId` is mandatory in both route preview and dispatch request. The preview binds the route draft to a vehicle-specific profile. Request creation must reject a vehicle mismatch; acceptance revalidates vehicle availability and current scenario restrictions. `autoAcceptAfterSeconds` is operator-configurable and stored on the request with immutable `acceptAt` derived from database time; manual acceptance overrides the timer by winning the same locked transition.

### Road-restriction payload and conflict response

The preview/commit payload contains `{ "kind": "BLOCKED" | "HEAVY_PENALTY", "geometry": <GeoJSON Polygon/MultiPolygon>, "reason": "...", "penaltyFactor": <number only for HEAVY_PENALTY>, "expectedRestrictionRevision": <integer> }`. `penaltyFactor` is a bounded multiplier on routing **travel-time cost** (illustrative default `5.0`; validate `>1` and enforce a server-configured maximum). `BLOCKED` ignores/rejects `penaltyFactor`. Use one normalized `RoadRestriction` resource for both kinds, including `graphVersion`, `affectedDirectedEdgeIds`, and `affectedPhysicalSegmentIds`; migrate any pre-existing experimental `RoadBlockage` name consistently if it exists.

For a conflicting BLOCKED preview, show `canActivate=false`, `occupiedPhysicalSegmentIds`, `occupiedDirectedEdgeIds`, and `occupyingVirtualVehicleIds` (authorized scenario users only). At commit return HTTP `409` with `{ "code": "ROAD_OCCUPIED", "occupiedPhysicalSegmentIds": [...], "occupyingVirtualVehicleIds": [...] }`; **do not** create/activate any part of the polygon and **do not** increment the restriction revision. A valid preview never guarantees a later successful commit because a vehicle may move into the area; `STALE_REVISION` is a separate 409 conflict. A HEAVY_PENALTY commit may overlap occupied roads and triggers recalculation for FOLLOW_OPTIMAL trips whose remaining itinerary uses changed edges.

## 4. Graph / A* modifications

### 4.1 Directed graph model and stable IDs

1. Add a `DirectedRoadEdge` representation: `graphVersion`, `edgeId`, from/to vertex, underlying original OSM way IDs, forward geometry, length, base/effective speed, highway type, static restriction fields, turn-restriction identifiers. Maintain a lookup `(edgeId -> edge)` and spatial index of its **full geometry**. Ensure both `OsmnxGraph` (parallel edges `u,v,key`) and `PurePythonGraph` (current adjacency tuples) conform to the same adapter interface.
2. Refactor A* to return a `RouteResult` containing `directedItinerary` plus POC-compatible `coords`, `distance_m`, `time_s`. Do not change existing `/api/route` response fields; expose richer itinerary only in new internal API.
3. Stable IDs must account for graph/data version; do not persist fragile in-memory node object IDs alone. Include PBF/static restriction fingerprints and service build version in `graphVersion`. On mismatch, re-resolve blockages and recalculate active routes before resuming simulated motion.
4. Preserve proper curve coordinates and direction: osmnx `LineString` can need reversal relative to `(u,v)`; fallback edge geometry must also be normalized. Maintain geographic computations in meters (local projected metric CRS or geodesic distances) rather than degree-based Euclidean distances.
5. Graph adapter must preserve multiple parallel arcs. Its edge filtering must apply **per arc**, before selecting a minimum-cost parallel arc, so a restricted faster arc is never accidentally chosen.

### 4.2 Exact turn-aware state

Current POC tracks one best incoming way per node. Replace `(node)` search state with `(node, incomingDirectedEdgeId)` or at least `(node, incomingOSMWayContext)` if turn constraints are expressed at the way level. The state determines allowed outgoing turns; use Dijkstra/A* relaxation per full state and reconstruct the chosen edges. For an osmnx-simplified arc containing multiple original ways, preserve the **entry and exit** way context at junctions or perform search on an appropriately unsimplified turn graph. Validate no/only-turn semantics against actual parsed restriction representation; do not claim exact correctness for unsupported relation types. Heuristic `greatCircleDistance / maxPossibleSpeedForProfile` remains a lower bound when optimizing travel time with nonnegative edge costs.

Waypoint legs must carry the previous incoming edge/turn state into the next leg, or solve a single augmented search state `(node, incomingEdge, nextWaypointIndex)`; do not concatenate independently computed legs that introduce an illegal turn or instant U-turn at waypoint nodes. Prefer augmented search for correctness; staged legs with junction-aware constrained first moves are acceptable when tested.

### 4.3 Scenario-local closures, congestion cost overlay and occupied-road guard

- Keep static graph immutable. Model `RoadRestriction.kind = BLOCKED | HEAVY_PENALTY` as scenario-local overlays stored in PostGIS with polygon, version, activation/expiry. `BLOCKED` excludes edges. `HEAVY_PENALTY` keeps them traversable and multiplies their **routing cost** (travel time) by a bounded, finite factor > 1. Do **not** treat a penalty as an edge removal, a stop command, or an automatic change in motion speed. For overlapping congestion regions, use a documented deterministic bounded combination (recommended **maximum** factor per directed edge, not unbounded multiplication); any active BLOCKED rule takes precedence. Do not scale the A* heuristic by the penalty: the existing lower bound stays admissible with costs only increasing.
- On polygon preview/commit: validate GeoJSON polygon/multipolygon or rectangle, reject oversized/degenerate/malformed shapes, bound to map coverage and cap area/edge count. Query spatial index candidate directed edges by bounding box, then test full road `LineString` intersection; endpoints-only/center-only checks miss crossed segments. Define a metric boundary-touch tolerance. Default affected coverage is the **whole** directed graph edge on meaningful intersection (not a one-point boundary touch); display affected physical road segments and directed edges in preview.
- Maintain a stable mapping `(graphVersion, physicalSegmentId) -> directedEdgeIds`. A physical segment means the road segment under the marker, irrespective of direction. With the initial **whole-directed-edge exclusion** model, also guard the entire directed edge currently carrying a vehicle, even if its polygon intersection is farther along that edge; this is intentionally conservative. For finer precision, split long graph arcs into independently routable physical segments **before** allowing partial closures. Do not mark geometrically nearby parallel roads occupied just because their bounding boxes overlap. Do not rely on OSM way ID alone or a geometrically nearby parallel road. A driving/paused/waiting/parked virtual vehicle with a known position occupies its **current** physical segment and directed edge; retain occupancy while parked at a boundary/node according to a documented deterministic anchor rule.
- **Occupied-road BLOCKED guard:** before committing/activating a new or expanded BLOCKED polygon, intersect both its affected physical segments **and affected directed edges** with the authoritative current occupancy set of **every same-scenario virtual vehicle with a known current position**. If nonempty, reject the **entire** operation as `409 ROAD_OCCUPIED` with conflicting segment/vehicle IDs; no overlay, version increment or partial edge exclusion. Penalty regions are allowed to overlap occupied roads. Preview flags an obvious conflict, but the occupancy check must run again at commit. Do not apply an invalidity update to already active regions without the same check; deactivation and reducing BLOCKED coverage need no occupied-road rejection.
- **Atomicity across movement and commit:** use a single per-scenario authoritative motion/road-state barrier (e.g. scenario serialized command queue/lease with a fenced worker + DB-serialized restriction commit and occupancy checkpoint). Freeze new segment entry briefly while evaluating/committing BLOCKED against the **latest** occupied physical segments and directed edges, publish the new revision and blocked-edge guard to the worker before movement may enter affected segments. A simple DB read followed by an uncoordinated Python simulation tick is insufficient. Use the same control barrier across replicas; on timeout or uncertainty reject/defer activation rather than allow occupied-road blockade. Revalidate `expectedRestrictionRevision` and graph version as part of the transaction.
- Persist affected **physical and directed** edge IDs with `graphVersion` and polygon/revision. On graph version change, re-resolve both. Combine union of active BLOCKED directed edges + deterministic HEAVY_PENALTY costs + static constraints on each route call; no cross-scenario globals or cached graph mutation. Preserve a per-active-route cost/speed snapshot so MANUAL_HOLD can continue its original assigned plan when congestion changes.
- Compare changed restriction edge sets with **remaining** route edges (including current forward remainder) to identify affected trips. For FOLLOW_OPTIMAL, evaluate either kind of effective road-state change (activation/update/deactivation), even if the old route remains geometrically best; update ETA/cost and publish a route/cost revision only when material values change. For MANUAL_HOLD, congestion changes do not alter active itinerary, cost/speed snapshot, or motion; closure triggers the stop guard before first prohibited edge and may stage a candidate. Reopening a closed road can offer a refreshed candidate; retain current valid route unless operator explicitly applies it in MANUAL_HOLD.
- Serialize scenario restrictions/occupancy at commit; calculate alternative routes **outside** long-held DB transactions, then atomically activate candidates with scenario and trip compare-and-swap. Newly committed closure applies to movement **before** asynchronous route solves complete; congestion never imposes the closure stop barrier.

### 4.4 Accurate snap / mid-edge reroute

The existing `/api/nearest` snaps to a **node**; this is acceptable for simple pre-trip preview but insufficient for an active vehicle mid-edge. Add `snapToDirectedEdge(point, profile, blockedEdges, heading?, maxSnapDistanceM)` with projected point, edge ID, offset along edge in meters, legal travel direction and distance from request. Reject off-network points beyond bound; choose a plausible accessible arc, not merely geometrically nearest inaccessible one.

At reroute time, take the authoritative simulation checkpoint `(edgeId, offsetM, heading, routeVersion)` and split the current edge at its current offset. Retain/finish the legal **forward remainder** (if currently occupied) before finding the new path; because a new BLOCKED region may not exclude a vehicle's currently occupied physical segment **or directed graph edge**, a freshly committed closure must affect a **future** segment, not the vehicle's current edge. Stop before the next prohibited segment if needed. For HEAVY_PENALTY on the current segment, preserve forward position and apply the revised routing cost only to the new candidate, not an automatic speed change. The itinerary is `remainingCurrentEdge + reroutedEdgesThroughPendingWaypoints + destination`. Never reset to initial trip origin and never visually teleport to the nearest vertex behind the vehicle.

Handle edge cases: vehicle exactly at node, on very short edge, in current closed edge, direct waypoint behind vehicle, isolated waypoint, zero-length leg, start/end on opposing one-way direction, no legal alternate route, duplicate shape points, and geometry reversal.

### 4.5 Routing API tests

Unit/integration test both graph adapters with a synthetic directed network: blocked one-way arc, penalty-only passable edge, high penalty selecting an alternate route, penalty and blockage overlap (blockage wins), two scenarios with disjoint overlays, polygon crossing middle of polyline, occupied-road physical segment with opposite directions, height/width/weight/access constraints, parallel arcs, prohibited turns, waypoint junction turn, mid-edge progress preservation, graph-version reload, no available route. Cross-check chosen itinerary length/ETA against returned geometry and speed model.

## 5. Persistence / schema migration

**Migrate in one atomic change set:** `node/prisma/schema.prisma` + SQL migrations + generated Prisma client/TypedSQL + `docs/v19_virtual_dispatch_erd.md` (new canonical ERD or next sequential version) + Zod/OpenAPI + architectural docs + tests. Do not silently modify v18 historic ERD; supersede it explicitly. Keep migrations additive and supply backfill/defaults where needed.

Suggested minimal additive schema (physical names illustrative):

```text
vehicle: vehicle_source CHECK extends CUSTOM|BIMS|VIRTUAL
         virtual profile fields / max gross weight if needed (max_load_kg is payload, not gross weight)

driver: driver_kind REAL|VIRTUAL (or nullable source with default REAL)
trip: trip_kind REAL|VIRTUAL default REAL; existing trip_status retained

virtual_scenario: scenario_id PK, name, created_by FK,
  restriction_revision INT, auto_accept_after_sec NULLABLE,
  state, created_at, updated_at -- always start immediately on acceptance

virtual_route_draft: draft_id PK, scenario_id FK, requested_profile JSONB,
  selected_vehicle_id FK NOT NULL, origin/destination geography point, ordered waypoint JSONB or draft waypoint rows,
  route_geojson JSONB, directed_itinerary JSONB, graph_version, restriction_revision,
  distance_m, duration_sec, expires_at, created_at

dispatch_request: request_id PK, scenario_id FK, draft_id FK, virtual_vehicle_id FK NOT NULL -- immutable operator-selected vehicle,
  virtual_driver_id FK, state, accept_at NULLABLE, expires_at NULLABLE,
  accepted_trip_id UNIQUE NULLABLE, requested_at, decided_at, decided_by FK NULLABLE,
  idempotency_key UNIQUE, revision INT

virtual_vehicle_settings: vehicle_id PK/FK, auto_follow_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  policy_version INT NOT NULL, updated_at -- persisted per vehicle, including while idle;
  -- NEVER put the authoritative follow value on virtual_scenario or make it shared per trip

virtual_vehicle_state: vehicle_id PK/FK, scenario_id FK, trip_id UNIQUE FK,
  driver_id FK, sim_status, active_route_id FK,
  route_version, command_version, event_sequence, graph_version,
  current_edge_id, offset_m, speed_kmh, speed_factor, sim_elapsed_ms,
  last_checkpoint_at, last_position geography point, blocked_reason NULLABLE

road_restriction: restriction_id PK, scenario_id FK, kind CHECK(BLOCKED|HEAVY_PENALTY),
  polygon geometry(MultiPolygon,4326), geojson JSONB,
  affected_directed_edges JSONB, affected_physical_segments JSONB, graph_version,
  penalty_factor DOUBLE PRECISION NULLABLE, revision, is_active,
  expires_at NULLABLE, created_by FK, reason, created_at,
  CHECK(kind=BLOCKED AND penalty_factor IS NULL OR
        kind=HEAVY_PENALTY AND penalty_factor > 1 AND penalty_factor <= configured_max)

scenario_occupancy_checkpoint: scenario_id, fencing_token, occupancy_revision,
  committed_worker_position_sequence, updated_at
  -- or equivalent transactional motion-barrier contract; DB row alone cannot freeze worker movement

trip_waypoint: waypoint_id PK, trip_id FK NULLABLE, draft_id FK NULLABLE,
  sequence INT, original_point geography point, snapped_edge_id,
  snapped_offset_m, status, reached_at NULLABLE, client_id, unique order per trip/draft

route: existing PK/route_version/route_geojson/is_current + reason,
  restriction_revision, graph_version, directed_itinerary JSONB,
  activated_at, activation_edge_id, activation_offset_m,
  created_by FK NULLABLE

virtual_operator_event: event_id PK, scenario_id FK, trip_id NULLABLE,
  actor_id NULLABLE, event_type, request_id NULLABLE, payload JSONB, created_at
```

If `Trip` creation requires a virtual `Vehicle`, register/select the virtual vehicle and create its persistent `virtual_vehicle_settings` row in a **separate pre-dispatch inventory flow**, and generate a simulated driver/request when requested. The setting is keyed by `vehicle_id`, independent of `virtual_vehicle_state.trip_id`; retiring or replacing a trip must not silently reset the vehicle's setting. The dispatch flow must never create or choose a replacement vehicle. Reserve the operator-selected vehicle only on acceptance. A request can reference the selected available vehicle without assigning it to a trip; reject concurrent acceptance of two requests for that vehicle. Prefer separate virtual-state table with `UNIQUE(trip_id)` and a **partial unique index** for one active trip per virtual vehicle, or explicit row lock over `vehicle`/reservation. A given virtual vehicle can have successive completed trips, so do not use unconditional `UNIQUE(vehicle_id)` on historical trip rows.

`Route.isCurrent` should have a partial unique index per trip (`WHERE is_current`) and route version unique `(trip_id, route_version)`. A replacement transaction marks old current false, inserts new vN, switches virtual-state `active_route_id`, updates `commandVersion` and writes audit/outbox event; serialize by trip row lock or optimistic expected-version update. External Python graph calls occur **before**, not inside, long-held DB transactions.

Use PostGIS GIST indexes for road-restriction geometry and position if persistence/queries need them; Prisma `Unsupported(geography/geometry...)` requires TypedSQL or parameterized SQL. Ensure `ST_SetSRID(ST_MakePoint(lon,lat),4326)` coordinate order. Use DB clock for dispatch deadlines. If retaining `routeLine`, maintain it alongside GeoJSON and itinerary, in the same route transaction. Store full route snapshot/graphVersion needed to recover after a worker restart. Add bounded indexes on scenario+status, due-acceptance deadline, and virtual snapshots.

**Avoid telemetry contamination:** simplest v1 is virtual positions in `virtual_vehicle_state` and a dedicated `virtual_position_sample` (optional history). If later writing into `vehicle_position`, update all `telemetry_source` CHECKs, existing BIMS/device filtering, latest-observation semantics and recording correlation tests first; a synthetic location is not an observed GPS fix.

## 6. Node modules and transaction responsibilities

Proposed file structure (retain current router/controller/service/repository boundaries):

```text
node/src/modules/virtual/
  virtual.router.ts / virtual.controller.ts / virtual.schema.ts / virtual.openapi.ts
  virtual-scenario.service.ts / virtual-scenario.repository.ts
  virtual-vehicle-settings.service.ts / virtual-vehicle-settings.repository.ts
  dispatch.service.ts / dispatch.repository.ts / dispatch-deadline.worker.ts
  virtual-trip.service.ts / virtual-trip.repository.ts
  virtual-road-restriction.service.ts / virtual-road-restriction.repository.ts
  virtual-event.service.ts / virtual-event.repository.ts
  routing-internal.client.ts / simulation-internal.client.ts
node/prisma/migrations/<new>_virtual_dispatch/migration.sql
node/prisma/sql/<new typed SQL for geography, route activation, scenario queries>
operator-web/virtual-dispatch.js / virtual-map.js / virtual-api.js / virtual-state.js
services/routing-tracking/virtual_routing.py / road_restriction_index.py / virtual_simulation.py
services/routing-tracking/tests/test_virtual_*.py
```

Responsibilities:

- Router: `authenticate`, `requireRole` (`ADMIN|OPERATOR` for writes, `VIEWER` read only), Zod body/param validation, request-size/rate limits. Do not allow untrusted actor/user IDs in request body.
- Controller: stable HTTP serialization; BigInt IDs to strings; no direct graph/Prisma logic.
- Scenario/road-restriction service: verify ownership/operator visibility, validate restriction kinds/cost factors and graph version, preview occupancy, atomically reject BLOCKED regions intersecting authoritative occupied physical segments, publish revisions through motion barrier, and record all road-state events.
- Dispatch service: validate draft/profiles/vehicle availability, revalidate draft against live restrictions, accept and timer path with exactly-once DB transaction. Handle timeout races via row locks/status compare; worker scans persistent deadlines with `FOR UPDATE SKIP LOCKED` if multiple workers and is recoverable after process restart.
- Trip service: enforce command/state machine, **lookup of policy by virtual `vehicleId`**, monotonic `commandVersion`, pending waypoints and active-route CAS. Implement the vehicle-targeted OFF → ON transition as an **immediate reroute request**, independent of road-state change detection; ensure queued route results for an earlier revision are discarded and recalculated/retried against fresh state. Never change another vehicle’s setting or route as a side effect of a toggle.
- Routing internal client: service token, connection pool, request-scoped deadline, bounded concurrent solves and explicit graph errors; do not call routing from browser directly.
- Outbox/events: publish **after commit**, and provide snapshot/replay by event ID. Do not send an SSE/WS `routeActivated` before route+vehicle pointer are durably switched.

## 7. Motion engine and route activation

**Where motion runs:** in `services/routing-tracking/virtual_simulation.py` as a transient, bounded simulation worker using edge itineraries delivered by Node. Node/Postgres remains the durable authority for active route, command policy and committed checkpoint; do not create a second independent Trip/Route database in Python. The Python worker never self-approves a dispatch and never updates real telemetry/BIMS endpoints. Require one worker owner (lease/fencing token) per scenario or trip to avoid double advancement across replicas.

**Motion model:** fixed simulation tick (e.g. 100–250 ms), distance-based progress along current edge, local edge effective speed limited by selected truck profile and configurable simulation speed factor. Sample/emit network position at bounded interval (e.g. 2–5 Hz) and optional event-based immediate update at reroute/waypoint; browser interpolates position at display rate between time-stamped server snapshots. Avoid deriving position from array index of coarse route GeoJSON because segments differ in length and curved geometries may be unevenly sampled.

```text
onTick(dt):
  require valid lease, trip DRIVING, current (routeVersion, commandVersion)
  advanceMeters = effectiveEdgeSpeedMps * dt * simulationSpeedFactor
  consume distance across directed edges, honoring legal direction
  if next physical segment/edge is BLOCKED: STOP before entry; report BLOCKED_AWAITING_OPERATOR or NO_ROUTE as policy dictates
  if next edge is HEAVY_PENALTY only: continue assigned itinerary; no automatic stop or speed change
  for each crossed stop: mark waypoint REACHED, emit ordered event
  compute position on edge geometry by cumulative *metric* distance; heading from tangent
  if destination reached: COMPLETED; emit terminal checkpoint
  periodically checkpoint (edge ID, offset, sim-clock, event seq, route version) to Node
```

**Immediate reroute handshake (used for road changes, waypoint edits, and vehicle-specific OFF → ON):**

1. **When triggered by a road change:** a BLOCKED change first passes an authoritative occupied-physical-segment check under the motion/commit barrier, then commits the new revision and installs the prohibited-edge guard **before** advancing simulation. An occupied-road attempt returns `ROAD_OCCUPIED` and changes nothing. A HEAVY_PENALTY change may cover occupied roads and commits a cost-only overlay. Waypoint edits increment `tripRevision`. Evaluate all affected remaining routes in the scenario; congestion does not establish a stop barrier. **When triggered by OFF → ON:** skip the road-change prerequisite and immediately execute the vehicle-targeted checkpoint/solve flow below.
2. Worker provides the **target vehicle’s authoritative current** edge/offset/sequence and optionally freezes at a deterministic handoff boundary. Node asks Python route solver for a forward-legal route from **this point** through its still-pending ordered waypoints to the original trip destination; never route from the original origin. For an OFF → ON toggle this solve starts immediately on the command, even when no road/waypoint change made the old route stale.
3. New route candidate returns `graphVersion`, `restrictionRevision`, `sourceRouteVersion`, `sourceCommandVersion`, `sourcePositionSequence`, anchoring edge and geometry. Check all against current DB/workspace state; if stale retry from new position. A route never activates purely on browser state.
4. **Atomic commit** of route vN, old `isCurrent=false`, active pointer, remaining waypoint snapshot and event/outbox. Worker receives idempotent `SWITCH_ROUTE` with new version and anchor; emits first updated position on new route. Old frames/events rejected by consumers using route/command version and sequence. The vehicle marker preserves real current position and continues forward; only remaining polyline is replaced.
5. If no valid path under a closure: retain previous route revision for history, stop before the first prohibited edge and expose `NO_ROUTE` with offending waypoint/edge/restriction; a manually held trip is `BLOCKED_AWAITING_OPERATOR`. A penalty alone never creates `NO_ROUTE` if the original road itinerary remains traversable. Never fall back to straight-line travel across disconnected components.

**Per-vehicle OFF → ON handshake (required implementation contract):**

1. `PUT /api/v1/virtual/vehicles/:vehicleId/following` identifies **only that vehicle** and serializes its policy change against vehicle/trip commands using `expectedPolicyVersion`, `commandVersion` and an idempotency key. If `enabled=false` or already ON, do not initiate a redundant toggle-driven route solve; ON → OFF retains the currently assigned route. For an idle vehicle, persist ON without routing.
2. For an active vehicle transitioning OFF → ON, **immediately request** an authoritative motion checkpoint `(directedEdgeId, offsetM, heading, positionSequence, tripId, routeVersion)` and start A* from its current **forward-legal** position to its existing destination via **remaining PENDING waypoints** under the latest scenario `restrictionRevision` and graph version. Current-edge forward remainder is preserved; never snap backward, teleport to the old origin, redo reached waypoints, or substitute a new destination. This must run even if there has been **no restriction revision change** or the old itinerary is still passable.
3. Use an ordered handoff barrier/lease and compare-and-swap: mark the **target vehicle alone** as policy-transition/rerouting, bound motion at an authoritative handoff position while solving, reject stale results and resnapshot/recompute when movement, active trip, waypoint order, scenario revision or graph version changed. Prevent other pending/manual route-candidate jobs from activating an earlier route after this command. Persist `auto_follow_enabled=true` on the vehicle and the new route revision/active pointer in one consistent transition when feasible, then publish that vehicle's `followChanged` and `routeActivated` events after commit. If routing must run asynchronously, return `202 REROUTING` immediately and begin solving as part of this command, not on a later event or periodic poll.
4. Once valid route vN is activated, advance automatically if the target vehicle was `DRIVING` or `BLOCKED_AWAITING_OPERATOR` (remove the latter only after verifying the first new edge is permitted); if it had an **explicit operator PAUSE**, keep it `PAUSED`. Every other vehicle in the scenario keeps its own ON/OFF value and route pointer unchanged unless independently affected by a shared restriction.
5. If no legal route exists, persist ON and a safely stopped `NO_ROUTE` condition, retaining the last route for history; never cross a blocked edge. Retry when restrictions change or the operator requests a new calculation. For a temporary solver/worker error, expose retryable status, preserve legal movement only under the normal blocked-edge guard (otherwise hold safely), and do not falsely announce `routeActivated`.

**Restart recovery:** persist checkpoint and command/route versions. On restart worker obtains lease, loads active Node state, validates graph/restriction version, reconstructs exact directed itinerary, restores at last checkpoint and resumes only after revision reconciliation. If database/routing service unavailable or checkpoint ambiguous, freeze the vehicle and show degraded status rather than moving blind. Broadcast full snapshot on client reconnect.

## 8. Browser implementation / isolated map state

Create `VirtualDispatchController` owning its own state/Leaflet layer groups (`start/end/waypoint markers`, `draft`, `active routes by trip`, `blocked polygons`, `highlighted affected edges`, `virtual vehicle markers`). Keep `NormalDashboardController` as current feature. Use explicit workspace navigation, not `demoMode`, to start/stop **frontend subscriptions and handlers**; leaving virtual view does **not** stop backend vehicles.

UI structure:

```text
[Normal monitoring]  [Virtual Routing & Dispatch]
Virtual sidebar:
  Scenario selector | Virtual vehicles | Request inbox
  Plan route: truck profile; select origin; select destination;
              ordered waypoint list [+ insert] [reorder] [remove]; Preview
  Dispatch: Generate request | Accept | Reject | auto-accept countdown
  Map edit: Select | Pick start | Pick end | Add waypoint | Draw road region
            Type: [Heavy congestion / HEAVY_PENALTY] [Complete blockage / BLOCKED]
            Congestion cost factor | Preview occupied segments | Confirm / Edit / Disable
  Selected virtual vehicle: Follow optimal ON/OFF (vehicle-specific; show current setting)
                            OFF -> ON: immediately replan from its CURRENT position to existing destination via pending waypoints
                            show calculating/new-route/no-route status; toggle A never changes B
  Selected virtual trip: Pause/Resume | speed factor | Apply staged candidate
                         remaining distance / ETA / route version
  Events: auto-rerouted / waiting operator / no route / waypoint reached
Map: separate virtual layer group; blocked vs congestion polygons visibly distinct, affected roads and occupied vehicles visible. BLOCKED confirm disabled for occupied road at preview and backend 409 shown if occupancy changes after preview.
```

Use Leaflet polygon/rectangle drawing (plugin or small dedicated polygon interaction), proper GeoJSON `lon,lat` conversion and server-side validation; rectangle alone may be sufficient first, polygon next. Provide preview/confirm/cancel before road-restriction commit, and edit/disable actions with visible impact summary. Preview BLOCKED shows every occupied affected physical segment (including a parked vehicle) and disallows confirmation; even if UI incorrectly allows it or the vehicle moves meanwhile, display the backend `409 ROAD_OCCUPIED` conflict and keep the map/DB unchanged. Preview HEAVY_PENALTY may overlap occupancy. Waypoint insertion order is explicit, not inferred by map distance. Show completed waypoint history read-only. Expose blocked-vehicle warning and candidate-vs-active route with different line styles; user must know whether auto-follow is disabled. Do not allow normal live `selectVehicle()`, `retargetLiveView()` or replay control handlers to run from virtual marker clicks. Hide/disable live-view and recording panels in virtual workspace. On switch, tear down mode-specific event subscriptions/listeners and map layers; normal live/replay state should be preserved or cleanly deactivated according to existing UX, never overwritten with virtual streams. Separate virtual endpoint selection from existing `demoMode` API path rewriting.

## 9. Security, reliability, and limits

- JWT and `ADMIN|OPERATOR` required for all virtual modifications; public demo/viewer read-only. Use internal service credential and private network for routing/worker APIs. CSRF protection if session cookies are ever added; current token auth can remain.
- Bound polygons (vertex count, area), waypoint count, route graph search runtime, active scenarios/vehicles and max total parallel reroutes. Return actionable throttled/degraded status; prioritize safety stops and current-trip reroutes over draft previews.
- Versioning: every preview/candidate/command carries `graphVersion`, `restrictionRevision`, `tripRevision`, `routeVersion` where relevant. A committed blocker must be effective before unblocked old itineraries can advance onto newly excluded edges. Out-of-order WS/SSE delivery and HTTP retry cannot roll the client backward.
- Temporary closure/congestion expiry must run server-side from persisted timestamps and bump restriction revision. A time-based activation or expansion of a previously saved BLOCKED region must pass the same occupied-road check; disabling restrictions and congestion updates need no occupancy prohibition. Avoid one global mutable in-memory blocked-edge set and blanket clear when a UI closes.
- Validate all operator data on server; PostGIS polygon validity and coordinate ranges; consistent coordinate orientation. Sanitize displayed driver names/reasons, store no personal real-driver data for generated users.
- Audit who requested, accepted/rejected, drew/disabled restrictions, added waypoint, toggled policy and applied route. Metrics: route solve ms, affected trips, reroute failures, queue delay, simulation lag, stale command rejections, checkpoint latency, active lease owner.
- Preserve normal-mode behavior and existing replay sync: do not use `recording_session_id`, `source_timestamp_ns` or Android QR clock for virtual trips. Do not call BIMS OpenAPI on behalf of virtual mode.

## 10. Test plan / definition of done

| Area | Must-pass scenarios |
|---|---|
| Existing regression | Current `/api/route`, tracking/BIMS/device integration, JWT, trip creation, existing recording/replay/live-view tests still pass. Virtual dashboard does not cause video/recording network requests. |
| Routing | Different profiles choose legal roads; static limits, one-way/turn restrictions and each directed parallel arc enforced; route geometry length/ETA plausible; consistent POC-compatible output; waypoint order and junction legality. |
| Region types / occupied road | Polygon crossing mid-edge affects full resolved segment; reject creation, activation and expansion of BLOCKED on a segment occupied by a **moving, paused or waiting** virtual vehicle in the same scenario (including opposite direction); rejection is all-or-nothing, no revision bump. Valid preview becoming occupied before commit returns `409 ROAD_OCCUPIED`. Congestion on occupied road is allowed. Another scenario's occupancy does not block this scenario; existing active closures take precedence over congestion. |
| Dispatch | Manual accept, reject, timer accept, auto mode disabled, expired request, timer/manual simultaneous acceptance, duplicate clicks, service restart, two requests for one vehicle, draft invalidated by new restriction. Exactly one trip/initial route. |
| Motion | Marker advances at requested speed factor across unequal curved edges; pause/resume; waypoint reached; completed trip; no movement with browser closed; restore from checkpoint; stale worker fenced out. |
| Active reroute | For either penalty or closure, each **vehicle with follow ON** recalculates every affected remaining route and adopts its feasible new optimal route, or updates cost/ETA if identical geometry; no teleport. Each vehicle with follow OFF keeps its original itinerary, speed/cost snapshot and continuous motion under congestion; under BLOCKED it stages a candidate and stops before prohibited entry. No path after closure implies safe stop; congestion alone does not imply `NO_ROUTE`. Unaffected trips keep route version; stale candidates never activate. |
| Vehicle follow-toggle | With **no restriction change**, A OFF → ON immediately starts routing from A's authoritative **current mid-edge position** through its **remaining** waypoints to the **existing destination**, activates a new route (not old origin), and resumes if A was waiting for a blocker. B remains OFF and keeps its own route even when A and B share a scenario. ON → OFF for A does not trigger a solve or discard A's current route. An explicit PAUSE survives OFF → ON. No-path holds safely with follow ON; solver unavailable produces a retryable error. Simultaneous road change/toggle/waypoint edit cannot commit stale route. Setting persists after browser mode switches, disconnects and across subsequent trips. |
| Waypoint changes | Add at planning time and in trip, insertion order, move/remove pending only, preserve reached history; failed waypoint route leaves last valid plan; route is recalculated through all remaining stops. |
| Concurrency/UX | Two operators editing same scenario/trip, stale expected revision 409, reconnect snapshot, duplicated/reordered events, switch normal/virtual several times, normal live/replay controls remain independent. |

**End-to-end acceptance demo:** create scenario -> plan truck-legal optimal route -> generate selected-vehicle driver request -> accept manually / show auto-accept -> confirm movement -> add waypoint -> try BLOCKED on the occupied current road (preview flags occupant; commit returns `ROAD_OCCUPIED`, no changes) -> add HEAVY_PENALTY on occupied/future road (allowed): FOLLOW_OPTIMAL recalculates and adopts alternative if preferable -> switch to MANUAL_HOLD and add/change congestion on a future assigned road: vehicle continues on existing route without stopping/switching -> add BLOCKED to a **future, unoccupied** road: candidate is staged and vehicle stops before it -> turn OFF → ON for vehicle A while midway on a road **without any further road-state change** and verify an immediate fresh route from A’s current location through pending waypoints to A’s existing destination (not the initial origin); verify vehicle B remains OFF with its original route -> verify another vehicle in the scenario sees same overlays, another scenario does not -> switch normal mode (live/replay unchanged) -> return to virtual (sim state preserved).

## 11. Suggested implementation order / commits

1. **Baseline:** run/store existing Node and Python test results, record current `graphVersion`/restriction behavior and validate source ingestion of width CSV. Agree initial defaults/limits.
2. **Graph adapter + route data:** stable directed IDs, geometry orientation, itinerary output, graph-version fingerprint, turn-aware search, regression tests for POC. Preserve old `/api/route` response.
3. **Dual restriction overlay + occupancy:** polygon-to-physical/directed-edge spatial indexes; BLOCKED exclusions, bounded HEAVY_PENALTY edge-cost factors, scenario isolation, occupied-road guard/worker barrier, mid-edge routing and synthetic tests.
4. **Schema + docs together:** v19 migration/ERD/typed SQL/OpenAPI; virtual vehicle/driver source, scenario, drafts, dispatch requests, state, waypoint, blockage and events.
5. **Node business API:** preview, create requests, manual accept/reject, persistent auto-accept worker, exactly-once transaction, RBAC/idempotency and integration tests.
6. **Python transient motion + Node checkpoint/lease:** command protocol, time/position progression, restart, snapshot/event consistency and tests.
7. **Route revision workflow:** both restriction types, affected-trip detection, waypoint edits, **vehicle-specific policy storage and OFF → ON immediate reroute from current position**, auto-follow recalculation vs manual congestion continuity, candidate CAS, atomic activation and stop before blocked edge.
8. **Virtual dashboard:** dedicated mode/toolbar, layer groups, virtual snapshot stream and controls, dual-type region drawing, occupied-road conflict display and waypoint UI.
9. **Hardening:** two-operator conflict tests, multi-vehicle scenarios, failure injections, security/size limits, performance bounds, replay/live regression and README/runbook.

## 12. Locked product decisions and remaining implementation defaults

The following requirements are **confirmed** and must not be reinterpreted as optional alternatives:

1. Operator explicitly selects a virtual vehicle; the backend generates a simulated driver assignment request for **that same vehicle**. Vehicle setup/creation is a separate workflow. Route draft must be tied to selected vehicle/profile and revalidated upon acceptance.
2. Operator configures the automatic-acceptance delay (`autoAcceptAfterSeconds`) per scenario, with permitted override only if the UI explicitly offers it. `null` means manual-only; timer and manual actions share one exactly-once acceptance transition. A rejected request must never be auto-accepted later.
3. Acceptance starts movement automatically and immediately. Initial dispatch has no READY/manual Start stage. The start timestamp and first position are stored/published as part of committed acceptance/start behavior.
4. The operator chooses `BLOCKED` or `HEAVY_PENALTY` per region. A **BLOCKED** region cannot be activated/expanded onto a physical road segment currently occupied by **any** virtual vehicle in that scenario; reject the entire attempted change with `ROAD_OCCUPIED` and no state mutation. This rule applies even when a preview was valid but the vehicle has moved before commit. `HEAVY_PENALTY` may cover occupied roads.
5. With auto-follow ON, **both** kinds trigger optimal reroute evaluation on affected remaining roads and automatic adoption when viable. With auto-follow OFF, HEAVY_PENALTY leaves the original active route and motion unchanged, whereas BLOCKED causes a stop **before** the newly prohibited edge and requires explicit operator action. Without an alternative to a closure, stop before entry regardless of policy.
6. Both road-region kinds are shared across **all vehicles in the same scenario**, isolated from other scenarios. **The follow-mode setting is per virtual vehicle**, persisted by vehicle ID (not shared on the scenario or browser); A may be ON while B is OFF in the same scenario. Each affected vehicle is processed independently according to its own setting, progress and waypoints.
7. Changing one active vehicle from **OFF to ON immediately triggers fresh optimal routing from its authoritative current position**, through its remaining ordered waypoints, to its **existing trip destination**, even if the road state did not change. Adopt a feasible route without teleporting; ON → OFF does not cause a new solve or alter the current route. Enabling ON on a blocked-waiting vehicle resumes automatically only after a legal route is committed; an explicit PAUSE remains. No-path holds safely with ON set.

**Implementation defaults, not additional product decisions:** a scenario may have several vehicles; a vehicle has at most one active trip across scenarios; initial speed factor `1.0` and POC travel-time objective; pending waypoints continue without dwell unless operator pauses; polygon blockers remain until disabled unless an optional expiry is set. These values may be adjusted in configuration without changing the confirmed behavior above.

### Final dispatch invariants

- `selectedVehicleId` is required on preview/request, is stored on immutable route draft and request, and must equal the `Trip.vehicleId` after acceptance. Return 409 on vehicle busy/profile mismatch or stale draft; never silently switch to a different vehicle.
- On `PENDING -> ACCEPTED`, transactionally reserve that vehicle, create trip, route v1 and simulation state with `DRIVING`, and persist the acceptance/start event. The motion worker begins advancing upon receiving the committed event; if temporarily unavailable, show `STARTING/DEGRADED` delivery status but do not require an operator Start action.
- Acceptance worker stores/reads persistent `acceptAt` from DB time; operator's configured delay is validated and snapshotted on each request so later settings edits do not silently change existing deadlines. A single row-locked transition prevents double acceptance and competing trips.
- Every **successful road-restriction** change increments scenario revision and evaluates affected trips in that scenario. BLOCKED creation/activation/expansion must reject atomically if an affected physical road segment or excluded directed edge is occupied by a same-scenario virtual vehicle. A failed attempt changes neither region state nor revision. After successful closure, install the movement guard before releasing the motion barrier; stale solves cannot drive through it.
- The canonical follow setting is persisted **per virtual vehicle**. Any OFF → ON on an active vehicle **immediately triggers** a current-position-to-existing-destination route solve through remaining waypoints independently of affected-edge detection. A vehicle-targeted toggle does not change any other vehicle or the scenario; the route and policy transition must be reconciled atomically with current checkpoint/route/restriction revisions.
- For `FOLLOW_OPTIMAL`, cost changes as well as closures recalculate affected remaining itineraries; accept a valid new route even when its geometry remains unchanged (update relevant cost/ETA snapshot without redundant geometry history where possible). For `MANUAL_HOLD`, congestion never changes the active route/cost/speed snapshot or interrupts driving, while closure requires a stop at the last legal point before its blocked edge. Manual `APPLY_ROUTE_CANDIDATE` verifies current restriction revision and vehicle position before resuming; Resume cannot cross a blocked next edge.

### Acceptance tests added by the confirmed decisions

1. Operator selects vehicle A, previews, requests assignment: request and eventual trip both reference A, never automatically generated B. Selecting B invalidates the A-specific preview; busy A produces a visible conflict.
2. Configure delay = 30 s; manual accept at 10 s starts the vehicle once and timer cannot start it again. Manual reject prevents acceptance; manual-only configuration never schedules auto-accept; restarting backend retains the deadline.
3. Upon successful acceptance, initial state is DRIVING and location advances without a Start command or an open browser.
4. Try to block the road currently occupied by vehicle A (moving, paused, waiting, or opposite direction of the selected physical segment): whole creation/expansion is rejected with `ROAD_OCCUPIED`, no revision or route change. Valid preview must be rechecked at commit. A congestion polygon covering A is accepted.
5. On an affected future road, HEAVY_PENALTY with FOLLOW_OPTIMAL causes re-evaluation and adopts the newly optimal remaining itinerary; with MANUAL_HOLD, vehicle continues the **original route** without stopping or automatic switch, including when the penalty is increased again.
6. With MANUAL_HOLD, block a future *unoccupied* road: vehicle stops before the prohibited edge and stays stopped until a valid explicit operator route command; candidate is not auto-applied. With FOLLOW_OPTIMAL and no viable detour, vehicle also stops before the blocked edge.
7. Start A and B in scenario S and C in scenario T, with A's follow ON and B's follow OFF; add congestion or blockage to S. A and B are independently assessed by **their own persisted** setting while C and NORMAL-mode vehicles are unaffected. Toggle B ON without changing road state: B immediately replans from B’s current position to its existing destination through pending waypoints; A’s setting, route and movement remain unchanged. Overlapping closure union and bounded congestion-factor combination are deterministic.
8. Turn A OFF then ON in the middle of an unobstructed trip with no restriction event: the backend computes and activates a route from A's **current** directed edge/offset (not original origin) through only pending waypoints to A's original destination; verify versions, no teleport, no duplicate waypoint visits and no cross-vehicle side effects. ON → OFF leaves existing route unchanged. With A explicitly PAUSED, OFF → ON replans but does not unpause; with A blocked-waiting, successful OFF → ON replans and resumes. No-path prevents illegal driving; race with a new restriction retries or rejects stale results.
