# Virtual Routing & Dispatch — Overview Plan

**Basis:** `poc-optimal-path_20260919.zip` and `p4_integrated_backend_20260919.zip`, reviewed 2026-09-19. **Status:** finalized implementation plan (dispatch, road-state and per-vehicle follow-toggle decisions confirmed); no application code changed.

## 1. Goal

Add an authenticated, dedicated **Virtual Routing & Dispatch** workspace to the integrated ITS application. An operator selects a specific available virtual vehicle, origin and destination, previews an optimal road-network route under that vehicle’s profile, and generates a simulated driver assignment request for that same vehicle. Manual acceptance or the operator-configured automatic-acceptance deadline starts the vehicle driving immediately. At any point an operator can insert ordered waypoints and mark scenario-local regions as **HEAVY_PENALTY** (traffic congestion) or **BLOCKED** (construction/disaster). A BLOCKED region cannot be activated when any virtual vehicle in the same scenario currently occupies an affected physical road segment. For a road-state change, each virtual vehicle independently applies its own follow setting: auto-follow ON recalculates affected remaining routes and adopts a valid replacement; auto-follow OFF leaves the assigned route and motion unchanged under congestion, while a closure causes a stop before the first blocked edge. Changing one vehicle from OFF to ON also triggers an immediate fresh calculation from **that vehicle’s current position**, through its remaining ordered waypoints, to its existing trip destination, even if there was no road-state change. Operators may explicitly apply a compatible candidate route. Normal live video/telemetry and recorded-video playback remain unaffected.

This is a **virtual simulation**, not an Android publisher, BIMS vehicle, media stream, or recorded-trip replay.

## 2. Existing source baseline and changes

| Source | Observed in supplied ZIP | Planned change |
|---|---|---|
| `services/routing-tracking/graph_backend.py` | Two graph implementations, `OsmnxGraph` and `PurePythonGraph`; `route(start_id, goal_id, truck_class)`; `TRUCK_PROFILES`; OSM, government/manual restrictions and turn restrictions. Returns `RouteResult(coords, distance_m, time_s)`. | Extract shared routing contract, add directed edge itinerary/geometry and scenario-scoped dynamic edge exclusion **and nonnegative congestion cost overlay**; correct incoming-edge-sensitive turn handling where needed. |
| `services/routing-tracking/main.py` | `POST /api/route`, `POST /api/nearest`, graph loaded once at startup. | Add versioned internal graph route/snap/road-restriction APIs; preserve original demo endpoints. |
| `services/routing-tracking/static/index.html` | Existing separate Leaflet POC frontend. | Use as interaction/reference only; build feature in integrated `operator-web`, not as a second app. |
| `node/prisma/schema.prisma` | `Vehicle`, `Driver`, `Trip`, `Route`, `VehiclePosition`; `Trip.vehicleId` required; `Route` has `routeVersion`, `routeType`, `routeSource`, `routeGeojson`, `isCurrent`. | Add virtual source/state, dispatch requests, scenario road restrictions (blocked vs penalized)/waypoints, simulation checkpoints, route activation metadata, and operator events in an atomic schema+ERD change. |
| `node/src/modules/tracking/tracking.client.ts` | Existing routing/tracking client currently exposes GET snapshot and individual vehicle lookup. | Add dedicated typed internal routing/simulation client, with auth, timeouts, and error mapping. |
| `node/src/modules/tracking/tracking.service.ts` | Current snapshot merges BIMS and device telemetry; read can persist BIMS observations. | Keep this normal-mode path unchanged. Fetch virtual mode from separate endpoint/store; never synthesize a virtual vehicle as BIMS or device telemetry. |
| `operator-web/app.js`, `index.html`, `live-map.js` | One dashboard with live-map, trip-create and recording controls; `demoMode` means a read-only auth fallback. | Add separate `workspaceMode = NORMAL | VIRTUAL_DISPATCH`, own handlers, map layers, per-mode poll/stream lifecycle and controls. Do not repurpose `demoMode`. |

### Road-data scope

Use the **existing loaded OSM graph** (`busan-roads_osm.pbf`), `busan_width_restrictions.csv` where already incorporated by the POC data pipeline, `gov_restrictions.json`, `manual_restrictions.json`, and `turn_restrictions.json`. Verify actual graph ingestion of every source before claiming a restriction is enforced. Continue honoring physical limitations (height, gross weight, width, length), HGV/access limits, road direction, and prohibited turns. The illustrative truck profiles are demonstration profiles, not a substitute for validated real-world routing or permit decisions.

## 3. Confirmed operating rules

1. **Vehicle first:** operator selects a specific AVAILABLE virtual vehicle in the active scenario; route preview uses its own vehicle dimensions/profile. Changing vehicle invalidates/recalculates draft and requires a new request. Never silently reassign another vehicle.
2. **Request for that vehicle:** request records `selectedVehicleId` immutably and creates only a simulated driver request. It is not a real-driver notification and does not create another virtual vehicle.
3. **Operator-configured timer:** scenario setting is a duration in seconds, with a supported manual-only (`null`) option; show actual server-side deadline and permit manual accept/reject while pending. Acceptance is exactly once even under timer/manual race.
4. **Start on acceptance:** successful acceptance atomically establishes trip/route/state and immediately starts simulation. No separate Start button or READY state is required for initial dispatch.
5. **Two region types:** `HEAVY_PENALTY` increases routing cost but keeps roads passable; `BLOCKED` excludes affected directed edges. Congestion is not a reason to stop a vehicle. Both types are scenario-local and support preview before activation.
6. **Occupied-road prohibition for closures:** reject the **entire** `BLOCKED` creation/activation (HTTP 409) when any virtual vehicle in the scenario currently occupies an affected physical road segment **or directed graph edge that the operation would exclude**, whether moving, paused, waiting, or parked at a known location. Recheck atomically at commit against authoritative simulation occupancy; no partial blockade or silent relocation. Congestion may be applied to occupied roads.
7. **Road changes with FOLLOW_OPTIMAL:** recalculate affected remaining routes on **either** penalty or blockage changes and activate a feasible new route without teleporting; if a closure leaves no feasible path, stop before its first prohibited edge. The computed result may retain the same geometry if it remains optimal.
8. **Road changes with MANUAL_HOLD:** a penalty does **not** change the assigned route or interrupt movement; a closure does **not** activate a candidate route and causes the vehicle to stop before the first blocked edge pending explicit operator action.
9. **Scenario-shared restrictions, vehicle-specific follow mode:** both penalties and closures apply to all vehicles in the same scenario; each virtual vehicle has its **own persisted** `autoFollowEnabled` value (`FOLLOW_OPTIMAL` when true, `MANUAL_HOLD` when false). Updating A never updates B, any other vehicle, or normal-mode vehicles. Other scenarios and NORMAL mode are unaffected.
10. **OFF → ON is an immediate route-planning command:** enabling auto-follow on a particular active vehicle immediately starts an A* calculation from its **authoritative current on-road position** (forward-legal remainder of the current directed edge), through only its remaining ordered waypoints, to its **existing trip destination** under the latest scenario restrictions. This happens even when the old route has not been affected by a recent road change. Commit a feasible result as the vehicle's new active route and proceed without teleporting; a vehicle stopped solely awaiting operator intervention may automatically resume after a valid route is activated. Explicit operator PAUSE remains in effect.
11. **OFF → ON failure and ON → OFF:** if no legal route exists, keep auto-follow ON but safely stop/hold the vehicle and expose `NO_ROUTE`; never enter a blocked edge. If the routing service is unavailable, retain the last valid route subject to its closure guard and report a retryable failure. Changing ON → OFF only updates that vehicle's persisted setting and keeps its currently assigned route; it does not calculate a replacement or unpause a vehicle.

## 4. Product workflow

1. Operator opens **Virtual Routing & Dispatch** workspace; normal live/replay view is not displayed or controlled by virtual state.
2. Operator picks origin and destination, selects an **available virtual vehicle** (required; derive its validated routing profile), and optionally adds **ordered waypoints** before route calculation. Backend snaps inputs to usable *directed road edges*, applies current truck/static/scenario closures and congestion costs and returns a route **preview** with length, ETA, restrictions/scenario revisions and ordered edges. Drawing the preview does not start a trip.
3. Operator clicks **Request virtual driver**. Backend generates a simulated driver assignment request **for the operator-selected vehicle**; it MUST NOT select, create or substitute another vehicle as part of request generation. A pending request references the chosen vehicle and saved route draft. An explicit **Accept** wins over the auto-accept timer; **Reject** or expiry cancels the request. The operator configures `autoAcceptAfterSeconds` per scenario (optional per-request override within allowed bounds); null disables automatic acceptance. Manual acceptance may occur before the deadline; rejection cancels the timer.
4. Acceptance atomically reserves the vehicle, creates `Trip`, writes initial `Route` v1, binds the virtual driver, and **starts virtual movement automatically immediately after acceptance** (there is no READY/manual-start choice in the dispatch workflow). Show vehicle position, direction, speed, route, waypoint targets, distance remaining and ETA.
5. Operator selects **Heavy congestion** (`HEAVY_PENALTY`, configurable nonnegative travel-time cost factor) or **Complete blockage** (`BLOCKED`), draws a polygon/rectangle, reviews affected directed road edges and confirms. A blockage preview highlights occupied roads and disables confirmation; the backend **rejects the entire blocker** with `409 ROAD_OCCUPIED` if any same-scenario virtual vehicle currently occupies any affected physical road segment or affected directed edge that would be excluded, even if the vehicle moves into it after preview. A congestion region **may** cover an occupied road. Activation changes only this scenario's restriction revision.
6. For an affected vehicle with **FOLLOW_OPTIMAL**, a cost increase **or** closure triggers a new remaining-trip route calculation from its legal forward continuation through outstanding waypoints. If feasible, atomically activate it only against current vehicle and scenario revisions; broadcast the update without teleporting. The new optimal itinerary may be geometrically identical to the old one. If there is no viable alternative to a closure, stop before the first prohibited edge; congestion alone never causes a blockage stop.
7. For **MANUAL_HOLD**, a **penalty** leaves the active route, its cost/speed snapshot and vehicle movement unchanged: continue on the previously assigned path. A **closure** stages a candidate without applying it, and movement continues only along valid existing edges until **before the first blocked edge**, then transitions to `BLOCKED_AWAITING_OPERATOR`. Manual action can Apply Candidate or Resume Auto-follow. No mode permits entering a blocked edge.
8. Operator can add, reorder, move, or remove waypoints before dispatch and insert **future** waypoints during a trip. Recalculate from the current position with completed waypoints preserved, then activate or stage according to **that vehicle's** follow setting.
9. Selecting vehicle A exposes **A's own** follow switch. Switching A from OFF → ON immediately starts a new A* calculation from A's authoritative current edge/offset through A's remaining waypoints to A's existing destination, using the latest restrictions, **regardless of whether a road change occurred**. Atomically apply a valid resulting route (without returning to the trip origin); if A was stopped for a blockage it may resume upon activation, but an explicit PAUSE remains in effect. B and all other vehicles keep their existing follow switches, routes, and state unless independently affected by road restrictions.
10. Switching A from ON → OFF leaves A on its currently active route and disables automatic adoption of subsequent route candidates. If OFF → ON finds no legal path, keep A safely stopped with follow ON and `NO_ROUTE`; do not resume through a closure. Allow pause/resume, simulation speed selection, cancel/finish, disable/edit restrictions, and a **per-vehicle** follow toggle. Returning to normal mode leaves backend simulation running unless explicitly paused; hide virtual objects from normal live/replay workspace.

## 5. Ownership and isolation

```text
Virtual Dispatch browser workspace (Leaflet; own UI, layers and sockets)
       |
       v  authenticated API / events
Node Express (operator-facing control plane; authoritatively owns durable business state)
       |                      |
       |                      +--> PostgreSQL/PostGIS: request, scenario, trip, route versions,
       |                           waypoints, dual-type road restrictions, vehicle reservation, checkpoints and audit
       v
Python routing-tracking service (internal API)
       +--> immutable OSM graph + static vehicle/road constraints
       +--> scenario-specific BLOCKED edge exclusions + HEAVY_PENALTY cost overlay
       +--> route solver + directed itinerary
       +--> transient virtual motion worker (controlled/rehydrated by Node)

Normal mode: existing BIMS/device tracking + Android -> Go -> vision -> live view,
             and existing MinIO recording/replay. These paths remain unchanged.
```

**Source of truth:** Node/Postgres owns dispatch decisions, trip lifecycle, effective route version and committed simulation checkpoints. Python owns graph calculations and transient movement between checkpoints, subject to Node-supplied monotonic route/command versions. On worker restart, recover from the last committed checkpoint, not from a new origin. One scenario has one active simulation owner; avoid independent workers emitting competing updates.

**Simulation clock:** server-side monotonic virtual-trip time and speed factor; browser interpolates *display only*. Never depend on the dashboard tab remaining open. Virtual events must carry `scenarioId`, `tripId`, `routeVersion`, `commandVersion`, `sequence` and server timestamp to reject stale updates.

## 6. Proposed entities

- `VirtualScenario`: logical simulation/road-state scope, lifecycle, operator-configurable auto-accept delay, `restrictionRevision`, creator; **all its vehicles share active closures and congestion costs, isolated from other scenarios**.
- `DispatchRequest`: scenario, route draft, **operator-selected virtual vehicle ID**, generated simulated driver request/driver ID, `PENDING | ACCEPTED | REJECTED | EXPIRED`, deadline, decided-by, resulting trip.
- `VirtualVehicleSettings`: one persistent row per virtual vehicle, including `autoFollowEnabled` (initial default ON, configurable for that vehicle before dispatch), policy version and update metadata. This is the **single source of truth**, not a scenario-wide or per-trip global setting.
- `VirtualVehicleState`: one active simulation/vehicle; reference that vehicle’s follow setting rather than duplicating route policy; state (`DRIVING | PAUSED | REROUTING | BLOCKED_AWAITING_OPERATOR | COMPLETED | CANCELLED`), active `routeId`, along-edge offset, speed factor, simulation checkpoint/revision.
- `RoadRestriction` (rename or extend proposed `RoadBlockage`): scenario, `kind = BLOCKED | HEAVY_PENALTY`, GeoJSON/PostGIS polygon, affected **physical and directed** road-edge IDs, bounded `penaltyFactor` for congestion, active/disabled, optional expiry, reason, graph/restriction revision and creator. Any creation/activation/expansion of BLOCKED coverage is rejected for occupied roads; use a backend occupancy and currently occupied directed-edge check.
- `TripWaypoint`: trip/draft, sequence, original and snapped coordinate, graph directed-edge anchor, `PENDING | REACHED | SKIPPED`, reached-at.
- `Route`: reuse existing route history; add dynamic constraint revision, reason, activation point/time, immutable **directed edge itinerary** and cumulative measures; retain GeoJSON as `[longitude, latitude]` for GeoJSON, while the legacy POC response uses `[latitude, longitude]`.
- `VirtualOperatorEvent` or equivalent audit log: assignment decisions, road-state changes, rejected occupied-road attempts, mode-specific commands, waypoint edits and route switches.

Do not store transient UI click/drag state in the database. Keep virtual positions separate from `VehiclePosition` at first, or introduce an explicit `VIRTUAL_SIMULATION` telemetry type and guarantee old ingest/latest-position queries and recording timelines do not confuse these with observed GPS. Recommended initial implementation: dedicated `VirtualVehicleState` plus optional sampled virtual-position history.

## 7. Incremental delivery

| Phase | Deliverable | Exit condition |
|---|---|---|
| 0: Baseline | Existing endpoints, demo, integration tests and schema recorded. | Normal live/replay/BIMS/device behaviors unchanged. |
| 1: Routing foundations | Directed edge route output, constraint-aware snapping, waypoint support, scenario closures **and cost penalties**. | Returned routes respect truck/static limits, turn context, passable congestion and impenetrable closures. |
| 2: Virtual data and dispatch | Schema/migration/ERD/API docs in one change, route preview/draft, generated dispatch requests and auto/manual acceptance. | One vehicle cannot be assigned twice; request acceptance is exactly-once under races/restarts. |
| 3: Simulation | Server-driven motion, checkpoint/restart, virtual snapshots/events and frontend marker. | Trip progresses without a connected browser; no teleport after a route revision. |
| 4: Dynamic control | Dual-type region drawing, **occupied-road blocker rejection**, **per-vehicle** follow toggles, immediate OFF → ON recalculation from current position, per-policy congestion/closure handling, waypoints and atomic reroutes. | Toggling A on starts a fresh remaining-trip route from A’s current edge through pending waypoints to its destination without changing B; congestion does not stop manual vehicles; closures are neither created on occupied roads nor entered by virtual vehicles. |
| 5: Operator UX + hardening | Dedicated normal/virtual mode, concurrency, cleanup, security, load and regression tests. | Virtual mode cannot accidentally trigger live video/recording or modify a real trip. |

## 8. Locked decisions and implementation defaults

1. A newly generated simulated driver request is tied to the **operator-selected virtual vehicle**, not a newly created or automatically selected vehicle, and is not sent to a real driver’s Android app. The operator may manually accept/reject or use a configurable auto-accept delay.
2. `HEAVY_PENALTY` remains passable and modifies **route-search cost only**. With FOLLOW_OPTIMAL, recalculate and apply the optimal remaining route; with MANUAL_HOLD, retain the original active itinerary/cost/speed snapshot and continue driving. A congestion change cannot cause `BLOCKED_AWAITING_OPERATOR`.
3. `BLOCKED` cannot be activated on any physical road segment occupied by any current virtual vehicle in the same scenario; reject the complete operation with a conflict and support redraw. Once validly activated, no virtual vehicle may enter its excluded directed edges; MANUAL_HOLD vehicles stop before them rather than auto-adopting a candidate.
4. Multiple virtual vehicles in one scenario share **both** restriction kinds while other scenarios remain isolated.
5. A new simulation trip **must start automatically upon acceptance**; a separate Start action is not part of initial dispatch.
6. Route geometry/waypoint snapping follows road network direction. Mid-edge starts use a forward-only remainder or a validated, legal maneuver; never snap backward/teleport by default.
7. Default routing metric remains the POC's travel-time-weighted A*; distance is reported but not presumed to be the optimization target.
8. **Auto-follow mode is a persisted per-virtual-vehicle setting**, not per scenario, browser tab, or shared trip-wide switch. Same-scenario vehicles may have different settings; changing one does not change another. Each vehicle's setting continues across UI mode changes and should not silently reset when the vehicle starts its next trip.
9. Every **OFF → ON transition** for a vehicle with an active trip immediately initiates optimal route recalculation from its **current authoritative position** through remaining waypoints to the **existing destination**, even with no newly changed restrictions. A valid route is atomically adopted without teleporting; ON → OFF does not replan. An unavailable path must not allow movement through blocked roads; an explicit PAUSE is not implicitly lifted.

See `VIRTUAL_DISPATCH_DETAILED_PLAN.md` for implementation contracts, files, algorithms, transaction boundaries and acceptance tests.
