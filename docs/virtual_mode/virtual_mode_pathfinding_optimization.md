# Virtual Mode Pathfinding Optimization Analysis

## 1. Executive Summary

The current virtual-mode routing pipeline is fundamentally sound, but several project-specific inefficiencies are increasing route calculation time unnecessarily.

The most important conclusion is:

> **Optimize the current A\* implementation and virtual rerouting workflow before replacing the routing algorithm.**

The project currently uses a custom edge-state A\* implementation so that OSM turn restrictions can be respected. This is appropriate, but the search currently carries turn-state information across the entire graph even though turn restrictions exist at only a very small fraction of junctions.

The supplied graph contains approximately:

| Item | Count |
|---|---:|
| Graph vertices | 79,518 |
| Directed edges | 197,912 |
| Turn restrictions | 890 |
| Junctions involved in turn restrictions | 362 |

A prototype optimization preserving the same route costs on tested routes reduced aggregate search time from approximately:

```text
1580.6 ms -> 534.9 ms
```

This is approximately:

```text
2.96x faster
```

The largest opportunities are:

1. Recalculate routes only for vehicles actually affected by a road-state change.
2. Carry incoming-road state only at turn-restricted junctions.
3. Precompute static edge eligibility and traversal costs.
4. Use a stronger A\* heuristic such as ALT landmarks.
5. Use process-level parallelism rather than Python threads for multiple simultaneous reroutes.
6. Remove smaller repeated calculations in the route-building pipeline.
7. Consider D* Lite later if repeated dynamic rerouting remains expensive.
8. Consider CCH only if the project eventually requires very high routing throughput.

---

# 2. Current Routing Architecture

The virtual-routing request path is approximately:

```text
virtual.service.ts
        |
        v
routing-internal.client.ts
        |
        v
FastAPI main.py
        |
        v
graph_backend.py
        |
        v
custom A* search
```

The routing implementation is not a simple node-only NetworkX shortest-path call.

Instead, the project uses an edge-aware A\* state so that OSM turn restrictions can be enforced.

Conceptually, search states look like:

```text
(node, incoming_way)
```

This is necessary at junctions where a turn restriction depends on the road from which the vehicle arrived.

For example:

```text
Road A ----\
            Junction ---- Road C
Road B ----/
```

The state:

```text
(Junction, Road A)
```

may allow Road C while:

```text
(Junction, Road B)
```

may not.

Therefore completely removing incoming-edge state would break turn-restriction correctness.

However, the current implementation keeps this additional state throughout the whole graph, which is unnecessary.

---

# 3. Main Optimization Opportunities

## Priority Summary

| Priority | Optimization | Expected Benefit | Complexity |
|---|---|---|---|
| 1 | Reroute only affected vehicles | Very large with multiple vehicles | Low-Medium |
| 2 | Restrict turn-state tracking to relevant junctions | Large | Low-Medium |
| 3 | Precompute edge eligibility and traversal time | Medium | Low |
| 4 | Add ALT landmark heuristic | Potentially very large on long routes | Medium |
| 5 | Use process parallelism | Large for simultaneous reroutes | Low-Medium |
| 6 | Remove repeated route-building work | Small-Medium | Very low |
| 7 | D* Lite incremental routing | Potentially excellent for Virtual Mode | High |
| 8 | Customizable Contraction Hierarchies | Extremely fast at scale | Very high |

---

# 4. Optimization 1: Reroute Only Vehicles Affected by a Road Change

## Current Behavior

When a road restriction changes, the backend calls logic similar to:

```text
refreshFollowingTrips(scenarioId)
```

The current workflow can recalculate routes for essentially every virtual vehicle that is in follow-optimal mode.

For example:

```text
20 virtual vehicles
1 blocked road
2 vehicles actually use the blocked road
```

The current architecture may perform:

```text
20 A* searches
```

when only:

```text
2 A* searches
```

are actually required.

This becomes increasingly expensive as the number of virtual vehicles grows.

---

## Recommended Approach

Store or derive the remaining directed edge IDs of each vehicle's active route.

When a road state changes:

```text
changed_edge_ids
        INTERSECT
remaining_route_edge_ids
```

If the intersection is empty, the vehicle does not need immediate rerouting.

Conceptually:

```python
if changed_edges.intersection(vehicle.remaining_route_edges):
    reroute(vehicle)
```

---

## Important Difference Between Cost Increase and Cost Decrease

This optimization behaves differently depending on the type of road-state change.

### Case A: Road Becomes Blocked

If the current route does not contain the newly blocked edge, the current route is still valid.

Therefore no reroute is required.

### Case B: Penalty Increases

If the current route does not contain the penalized road, its cost did not increase.

Other routes became equal or worse.

Therefore the current route is still optimal.

Again, no reroute is required.

### Case C: Blockage Removed

A newly reopened road could create a better route even if the current route does not use it.

If strict optimality must be maintained immediately, more vehicles may need recalculation.

### Case D: Penalty Decreases

The same issue applies.

A newly cheaper road might produce a better path.

---

## Suggested Policy

```text
BLOCK road:
    reroute only affected vehicles

INCREASE penalty:
    reroute only affected vehicles

UNBLOCK road:
    current route remains valid
    optionally recalculate all FOLLOW_OPTIMAL vehicles

DECREASE penalty:
    current route remains valid
    optionally recalculate all FOLLOW_OPTIMAL vehicles
```

For road improvements, recalculation could also be done gradually rather than immediately.

---

## Pros

- Potentially the largest Virtual Mode optimization.
- Scales well as the number of virtual vehicles increases.
- No routing algorithm replacement.
- Exact correctness is preserved for blockages and cost increases.
- Reduces Node -> FastAPI traffic.
- Reduces Python CPU usage.
- Reduces contention during large scenario updates.

## Cons

- Road reopening and penalty reduction require separate handling.
- Requires reliable tracking of each vehicle's remaining route edges.
- Route revisions need to remain synchronized with vehicle progress.

---

# 5. Optimization 2: Track Incoming Road Only at Turn-Restricted Junctions

## Current Problem

The current A\* implementation essentially enables edge-state search whenever any turn restriction exists:

```python
track_turn_state = bool(self.turn_restrictions)
```

The state then becomes:

```python
(node, incoming_way)
```

across the entire graph.

However, the graph contains:

```text
79,518 nodes
```

while only:

```text
362 junctions
```

are involved in turn restrictions.

This means additional state is being maintained for more than 99% of nodes where it is unnecessary.

---

## Recommended State Representation

At ordinary junctions:

```text
(node, None)
```

At turn-restricted junctions:

```text
(node, incoming_way)
```

Conceptually:

```python
if neighbor in restricted_via_nodes:
    next_state = (neighbor, outgoing_way)
else:
    next_state = (neighbor, None)
```

Also build a pre-indexed turn-restriction lookup:

```python
turns_by_via = {
    via_node: {
        (incoming_way, outgoing_way),
        ...
    }
}
```

Then the hot-loop check becomes:

```python
restricted_turns = turns_by_via.get(current_node)

if restricted_turns is not None:
    if (incoming_way, outgoing_way) in restricted_turns:
        continue
```

---

## Why This Matters

The current design can create multiple versions of the same physical node:

```text
(node_100, way_1)
(node_100, way_2)
(node_100, way_3)
...
```

even when node 100 has no turn restrictions.

These duplicated states increase:

- heap size
- dictionary size
- `g_score` entries
- `came_from` entries
- state comparisons
- duplicate expansions
- Python object allocation

Compressing normal junctions back into node-only states reduces all of those costs.

---

## Observed Effect

In prototype testing against the supplied graph, this state-space reduction produced a substantial improvement.

Combined with edge preprocessing improvements, aggregate runtime on the tested routes changed from approximately:

```text
1580.6 ms
```

to:

```text
534.9 ms
```

or approximately:

```text
2.96x faster
```

while preserving the same route costs for the tested paths.

---

## Waypoint Correctness Issue

While modifying this logic, waypoint routing should also be reviewed.

Currently each waypoint leg may start a completely new search:

```text
leg 1:
A -> waypoint

leg 2:
waypoint -> B
```

If the second search starts with:

```text
incoming_way = None
```

a turn restriction exactly at the waypoint can lose information about the road from which the vehicle arrived.

A better design is to carry the final incoming edge/way of the previous leg into the next leg where required.

---

## Pros

- Large search-space reduction.
- Keeps existing A\* architecture.
- Maintains turn-restriction correctness.
- Low algorithmic risk.
- Applies to both Python and OSMnx graph backends.

## Cons

- Requires careful testing with OSM simplified edges.
- Parallel edges must be handled correctly.
- Waypoints require special attention.
- Regression tests are required for `only_*` and `no_*` OSM turn restrictions.

---

# 6. Optimization 3: Precompute Vehicle Eligibility and Edge Traversal Time

## Current Problem

The A\* inner loop repeatedly evaluates logic similar to:

```python
edge_allowed(...)
```

for every explored edge.

The project currently has a small fixed set of vehicle profiles, for example:

```text
car / unrestricted
small
semi
```

Most vehicle restrictions are static OSM attributes.

Examples include:

- road width
- height
- weight limit
- vehicle class
- access restrictions

These values do not change for each A\* request.

Therefore repeatedly evaluating them during every search wastes CPU.

---

## Recommended Edge Representation

Precompute eligibility when loading the graph.

For example:

```text
allowed_mask
```

where bits represent vehicle types:

```text
001 = car
010 = small
100 = semi
```

Then checking vehicle compatibility becomes:

```python
if not edge.allowed_mask & profile_mask:
    continue
```

rather than repeatedly comparing OSM metadata.

Traversal times should also be precomputed.

For example:

```text
edge.time_car
edge.time_small
edge.time_semi
```

or, if all compatible profiles use the same speed:

```text
edge.base_travel_time
```

with profile-specific modifiers only where necessary.

---

## Desired Search Loop

Instead of:

```python
for edge in neighbors:
    if edge_allowed(edge, vehicle):
        speed = calculate_speed(edge, vehicle)
        time = edge.distance / speed
```

use:

```python
for edge in adjacency[current]:
    if not edge.allowed_mask & vehicle_mask:
        continue

    cost = edge.profile_time
```

Dynamic penalties can then be applied separately:

```python
cost *= penalty_multiplier.get(edge.id, 1.0)
```

---

## Pros

- Very low-risk optimization.
- Reduces Python function calls.
- Reduces dictionary/tag access.
- Especially useful for failed route searches.
- Improves CPU cache behavior.
- Simple to benchmark.

## Cons

- Slight increase in graph memory.
- Graph preprocessing takes a little longer.
- Multiple profile times may duplicate some values.

---

# 7. Optimization 4: Use ALT Landmarks for a Stronger A* Heuristic

## Current Heuristic

The current heuristic is approximately:

```text
straight-line distance to destination
-------------------------------------
maximum possible vehicle speed
```

This is admissible, but often weak.

Busan is especially likely to produce poor straight-line estimates because routing can be affected by:

- coastline
- rivers
- bridges
- mountains
- tunnels
- restricted roads
- one-way roads
- truck limitations

Two locations may be geographically close but require a much longer road path.

---

## Example

```text
A -------- B
 \        /
  \ WATER/
   \    /
    bridge far away
```

The great-circle distance from A to B may be short.

However, the legal driving route could require traveling a long distance to reach a bridge.

A weak heuristic causes A\* to explore many unnecessary nodes.

---

## ALT

ALT means:

```text
A*
Landmarks
Triangle inequality
```

Choose a small number of landmark nodes around the routing area.

For example:

```text
8-16 landmarks
```

Possible landmark placement strategies include:

- geographic extremes
- farthest-point selection
- major highway endpoints
- graph-diameter approximations

Precompute:

```text
landmark -> every node
every node -> landmark
```

Then use triangle inequalities to compute a stronger admissible lower bound.

---

## Why ALT Fits This Project

Dynamic road operations mainly perform:

```text
BLOCK edge
INCREASE edge cost
```

If landmarks are calculated on the relaxed/base network, those runtime changes only make actual routes more expensive.

Therefore the original landmark distances remain valid lower bounds.

Similarly, vehicle restrictions remove available edges.

Removing options cannot produce a route shorter than the relaxed base graph.

This makes ALT particularly suitable for the current architecture.

---

## Expected Benefit

The biggest improvement should come from reducing:

```text
nodes popped from priority queue
```

For example, if a normal route changes from:

```text
40,000 expanded states
```

to:

```text
5,000 expanded states
```

the benefit is much more meaningful than micro-optimizing Python code.

---

## Pros

- Keeps exact shortest-path results.
- Significantly stronger heuristic.
- Works with dynamic blockages.
- Works with penalty increases.
- Works with vehicle restrictions when preprocessing uses a relaxed graph.
- Much smaller architectural change than CH/CCH.

## Cons

- Requires preprocessing.
- Requires extra memory.
- Directed graphs need forward and reverse landmark distances.
- Landmark selection affects performance.

---

# 8. Optimization 5: Use Processes Instead of Python Threads

## Current Behavior

Node can launch multiple reroutes concurrently.

For example:

```text
VIRTUAL_REROUTE_CONCURRENCY = 4
```

FastAPI executes CPU-bound routing work through a thread pool.

However, the main A\* implementation is mostly Python:

```text
heapq
dict
tuple
set
Python loops
```

Because of CPython's Global Interpreter Lock, multiple threads do not execute this Python CPU work fully in parallel.

---

## Observed Behavior

A simple test using four searches showed approximately:

```text
Sequential:
0.823 s

4 Python threads:
0.794 s
```

This is only about:

```text
1.04x improvement
```

not 4x.

---

## Recommended Approach

Use multiple FastAPI/Uvicorn worker processes.

For example:

```bash
uvicorn main:app \
    --host 0.0.0.0 \
    --port 8000 \
    --workers 4
```

Then separate requests can run on separate CPU cores.

Conceptually:

```text
Node
 |
 +-- route 1 -> Python process 1 -> CPU core 1
 |
 +-- route 2 -> Python process 2 -> CPU core 2
 |
 +-- route 3 -> Python process 3 -> CPU core 3
 |
 +-- route 4 -> Python process 4 -> CPU core 4
```

---

## Pros

- Real multicore parallelism.
- Minimal application redesign.
- Useful when multiple vehicles reroute simultaneously.
- Easy to benchmark.

## Cons

- Every worker may load its own graph.
- Memory usage increases.
- Startup time increases.
- Per-process caches are not automatically shared.
- Too many workers may make latency worse due to contention.

---

## Recommendation

Do not simply increase:

```text
VIRTUAL_REROUTE_CONCURRENCY
```

without measuring.

First make individual route searches faster.

Then select the worker count using real concurrency benchmarks.

---

# 9. Optimization 6: Remove Smaller Repeated Calculations

Several smaller inefficiencies are also present.

These are not the primary bottleneck, but they are simple to remove.

---

## 9.1 Snap Every Stop Only Once

A route with multiple stops may perform nearest-node lookup repeatedly.

Instead of:

```python
current = nearest_node(stop_1)
next = nearest_node(stop_2)

current = nearest_node(stop_2)
next = nearest_node(stop_3)
```

precompute:

```python
node_ids = [
    graph.nearest_node(stop.lat, stop.lon)
    for stop in stops
]
```

Then:

```python
for start_node, goal_node in pairwise(node_ids):
    route(start_node, goal_node)
```

---

## 9.2 Avoid O(E^2) Cumulative Distance Calculation

Code similar to:

```python
sum(edge_lengths[:edge_index])
```

inside an edge loop causes repeated summation.

For a path with E edges, this becomes approximately:

```text
O(E^2)
```

Use a running accumulator:

```python
cumulative = leg_start

for edge_length in edge_lengths:
    edge.cumulative_start = cumulative
    cumulative += edge_length
```

This becomes:

```text
O(E)
```

---

## 9.3 Reduce Geometry Reconstruction Work

Geometry normalization may repeatedly calculate haversine distances only to decide which endpoint corresponds to a graph node.

If the coordinate system permits, cheaper comparisons may be possible.

This is lower priority because search usually dominates runtime.

---

## Pros

- Very low risk.
- Easy code review.
- Improves route serialization and waypoint handling.
- Reduces unnecessary CPU work.

## Cons

- Limited improvement compared with the major A\* optimizations.

---

# 10. D* Lite for Repeated Virtual Rerouting

D* Lite is especially interesting for Virtual Mode.

A normal route request looks like:

```text
start -> destination
```

and is calculated once.

A virtual vehicle behaves differently:

```text
same destination
moving start position
road costs occasionally change
road becomes blocked
road becomes unblocked
recalculate
recalculate
recalculate
```

This is exactly the type of problem incremental heuristic search algorithms target.

---

## Current Approach

```text
road state changes
        |
        v
discard old A* search
        |
        v
run completely new A*
```

---

## D* Lite Approach

```text
road state changes
        |
        v
update changed edge costs
        |
        v
repair affected part of previous search
```

Instead of solving the complete shortest-path problem again, the planner reuses information from the previous route calculation.

---

## Why It Fits Virtual Mode

A virtual vehicle usually has:

- the same destination
- a slowly changing start point
- relatively few changed roads
- repeated rerouting over time

These are favorable conditions for incremental search.

---

## Why It Should Not Be Implemented First

The existing A\* implementation still contains significant avoidable overhead.

Replacing it immediately would create a much more complex planner before simpler optimizations have been exhausted.

Also, D* Lite would need to support:

- turn restrictions
- vehicle profiles
- road penalties
- road closures
- moving vehicle start state
- waypoints
- persistent planner state per vehicle

This significantly increases complexity.

---

## Pros

- Excellent theoretical match for Virtual Mode.
- Reuses previous search work.
- Efficient when only a small part of the graph changes.
- Well suited to moving vehicles.

## Cons

- More complex implementation.
- Planner state must be stored per virtual vehicle.
- Harder debugging.
- Turn restrictions complicate the state graph.
- Waypoints complicate reuse.
- Less useful for one-off normal routing requests.

---

# 11. Customizable Contraction Hierarchies

If the system eventually needs substantially higher routing throughput, consider Customizable Contraction Hierarchies, or CCH.

Possible future requirements might include:

```text
hundreds of virtual vehicles
thousands of route requests
large regional graph
very low millisecond-level route latency
```

CCH separates routing into:

```text
topology preprocessing
        |
        v
weight customization
        |
        v
very fast route queries
```

This is better suited to dynamic routing weights than ordinary static Contraction Hierarchies.

---

## Pros

- Extremely fast shortest-path queries.
- Designed for road-network routing.
- Supports custom weights better than classic CH.
- Appropriate for large-scale routing services.

## Cons

- Major implementation effort.
- Much more complex than A\*.
- Turn restrictions make preprocessing harder.
- Multiple truck profiles require additional customization.
- Dynamic scenario overlays need careful integration.
- Probably unnecessary for the current ~80k-node graph.

---

# 12. Separate Restriction Update From Route Recalculation

Another important improvement is architectural rather than algorithmic.

The road-state mutation path currently waits for following vehicle routes to be refreshed.

Conceptually:

```text
operator changes road
        |
        v
save restriction
        |
        v
reroute vehicles
        |
        v
return response
```

This means operator-visible latency includes all route calculations.

---

## Recommended Architecture

Use:

```text
1. Commit road-state change
2. Increment/publish restriction revision
3. Identify affected vehicles
4. Queue their reroutes
5. Return road-state update immediately
6. Recalculate routes
7. Atomically activate new route revisions
```

The UI can expose:

```text
Route recalculating...
```

during the short interval.

---

## Safety

The existing simulation worker already checks blocked edges before the vehicle enters them.

Therefore a vehicle can safely stop before a blocked edge even if its replacement route has not finished calculating yet.

This makes asynchronous route replacement practical.

---

## Pros

- Greatly improves perceived responsiveness.
- Restriction API no longer waits for every route.
- Slow or impossible routes do not block the operator.
- Works naturally with route revisions.

## Cons

- Requires explicit rerouting state.
- Route updates become eventually consistent.
- Revision handling must prevent stale route results from replacing newer routes.

---

# 13. Recommended A* Hot Path

After the first optimization stages, the routing inner loop should conceptually resemble:

```python
while queue:
    state = pop_best_state()

    if state.node == target:
        break

    turn_table = restricted_turns.get(state.node)

    for edge in adjacency[state.node]:

        if not edge.allowed_mask & vehicle_mask:
            continue

        if edge.id in blocked_edges:
            continue

        if turn_table is not None:
            if is_prohibited_turn(
                state.incoming_way,
                edge.way_id,
                turn_table,
            ):
                continue

        cost = edge.profile_time

        penalty = penalty_by_edge.get(edge.id)
        if penalty is not None:
            cost *= penalty

        if edge.to_node in restricted_via_nodes:
            next_state = (
                edge.to_node,
                edge.way_id,
            )
        else:
            next_state = (
                edge.to_node,
                None,
            )

        heuristic = alt_heuristic(
            edge.to_node,
            target,
        )

        relax(
            next_state,
            cost,
            heuristic,
        )
```

This keeps the current architecture while substantially reducing work per expanded state.

---

# 14. Recommended Implementation Plan

## Phase 1 — Avoid Unnecessary Reroutes

Implement:

```text
changed road edge IDs
        |
        v
compare with remaining route edge IDs
        |
        v
reroute only affected vehicles
```

### Also Add

- route revision number
- remaining directed edge set
- changed-edge set
- reroute reason

Example:

```text
BLOCKED_EDGE
PENALTY_INCREASE
PENALTY_DECREASE
ROAD_REOPENED
FOLLOW_MODE_ENABLED
```

---

## Phase 2 — Compress A* Turn State

Implement:

```text
ordinary junction:
    state = node

restricted junction:
    state = (node, incoming_way)
```

Also pre-index turn restrictions by `via_node`.

Add regression tests before and after the change.

---

## Phase 3 — Precompute Edge Data

At graph startup calculate:

```text
allowed vehicle mask
travel time
road ID
way ID
dynamic-edge lookup key
```

Avoid repeated parsing of raw OSM metadata inside A\*.

---

## Phase 4 — Add ALT

Add approximately:

```text
8-16 landmarks
```

Precompute forward and reverse distances.

Measure reduction in:

```text
expanded states
```

before focusing purely on wall-clock time.

---

## Phase 5 — Improve Parallelism

After individual routes are fast:

```text
FastAPI workers = 2-4
```

Benchmark with realistic concurrent reroutes.

Do not increase worker count blindly.

---

## Phase 6 — Decide Whether Incremental Routing Is Necessary

Measure actual Virtual Mode behavior.

If frequent dynamic road changes still cause unacceptable routing load, investigate:

```text
D* Lite
```

Otherwise keep optimized A\*.

---

# 15. Benchmarking Requirements

Before and after every optimization, record more than total route time.

Recommended metrics:

```text
solve_ms
snap_ms
search_ms
reconstruction_ms
serialization_ms

nodes_popped
states_created
edges_examined
edges_relaxed
heap_pushes

turn_checks
blocked_edge_hits
penalty_edge_hits

route_distance
route_travel_time
```

---

## Required Test Cases

### Test 1: Normal Route

```text
5-10 km
```

Tests typical operator route creation.

### Test 2: Long Route

```text
20-30 km
```

Tests heuristic efficiency.

### Test 3: No Route

```text
ROUTE_NOT_FOUND
```

This is important because unsuccessful search can explore a very large part of the graph.

### Test 4: Dynamic Road Blockage

Use approximately:

```text
10-30 active virtual vehicles
```

and apply one blockage.

Measure:

```text
number of vehicles rerouted
total routing CPU time
maximum reroute latency
restriction API latency
```

### Test 5: Penalty Region

Apply a congestion region covering several roads.

Measure how many vehicles actually require new routes.

### Test 6: Road Reopening

Verify policy for vehicles whose current routes remain valid but may no longer be optimal.

---

# 16. Key Performance Counters

The most important internal metric is:

```text
nodes_popped
```

or equivalently:

```text
expanded states
```

For example:

```text
Before ALT:
40,000 expanded states

After ALT:
6,000 expanded states
```

This demonstrates an algorithmic improvement.

If runtime changes without a reduction in state expansion, the result may only be a Python implementation optimization.

Both improvements are useful, but they should be measured separately.

---

# 17. Suggested Final Architecture

```text
                    ROAD STATE UPDATE
                           |
                           v
                +----------------------+
                | save blockage/penalty|
                +----------------------+
                           |
                           v
                determine changed edges
                           |
                           v
            +-----------------------------+
            | affected vehicle detection  |
            +-----------------------------+
                           |
            +--------------+--------------+
            |                             |
         unaffected                     affected
            |                             |
            v                             v
      keep current route             enqueue reroute
                                          |
                                          v
                              +-----------------------+
                              | optimized A* / ALT    |
                              +-----------------------+
                                          |
                                          v
                              atomic route revision
```

Inside optimized A\*:

```text
graph loaded
    |
    +-- compact adjacency
    +-- precomputed profile eligibility
    +-- precomputed travel time
    +-- turn restrictions indexed by via node
    +-- restricted-via-node set
    +-- ALT landmark distances

query overlay
    |
    +-- blocked edge set
    +-- penalty lookup
```

---

# 18. Recommended Priority for This Project

For the current graph size and Virtual Mode design, the recommended order is:

```text
1. affected-vehicle rerouting
2. turn-state compression
3. precomputed edge eligibility/time
4. ALT heuristic
5. process-level parallel routing
6. minor route-building optimizations
7. D* Lite only if still needed
8. CCH only for much larger future scale
```

The project should not immediately move to:

```text
OSRM
CCH
D* Lite
Rust rewrite
```

because the current architecture still contains large optimization opportunities.

---

# 19. Expected Result

The combination of:

```text
affected-vehicle filtering
+
turn-state compression
+
precomputed edge metadata
+
stronger A* heuristic
+
actual multicore worker processes
```

should significantly improve Virtual Mode routing without replacing the overall architecture.

The most important distinction is:

```text
Do not only make each A* call faster.

Also reduce how many A* calls are made.
```

For Virtual Mode, avoiding unnecessary route searches can provide a larger system-level gain than optimizing the shortest-path algorithm alone.

The best near-term objective is therefore:

> **Reduce route-search frequency first, reduce A* state space second, and improve the heuristic third.**

Only after measuring those improvements should the project consider a fundamentally different routing algorithm.
