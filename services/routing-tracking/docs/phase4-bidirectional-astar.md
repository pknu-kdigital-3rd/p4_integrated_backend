# Phase 4: Bidirectional A* for Real-Time Rerouting

## Status: Planned (Phases 1–3 already committed on `optimal_path`)

## Why

When a `HEAVY_PENALTY` restriction (up to 100×) or a `BLOCKED` closure forces a detour, the
admissible heuristic `h(n) = haversine_distance / max_speed` becomes very loose: the optimal path
is far more expensive than the straight-line lower bound predicts, so A* expands many nodes before
it converges. Bidirectional A* runs simultaneous forward (start→goal) and backward (goal→start)
frontiers that meet in the middle, reducing the worst-case expanded nodes from **O(b^d)** to
**O(b^(d/2))** — roughly halving search time independently of how loose the heuristic is.

This is the largest remaining algorithmic gain. Phases 1–3 reduced per-edge overhead and
eliminated redundant DB queries; Phase 4 reduces *how many edges are examined at all*.

---

## Background: Current Architecture

Both backends implement edge-state A* with the state `(node_id, incoming_way_ids)` to enforce
turn restrictions correctly. The search state is a heap entry:

```python
(f_score, g_score, push_order, (node_id, incoming_osmids_or_way_id))
```

`came_from` maps each state to `(prev_state, dist_m, edge_data, osmids, edge_key, penalty)`.

Turn restrictions are `(from_way, via_node, to_way)` triples checked in the forward direction.

---

## Design

### Termination Criterion

The standard bidirectional A* termination is:

> Stop when a node `u` has been **settled** (popped from the heap) by **both** frontiers.
> The optimal path passes through some meeting node `m` where `g_fwd(m) + g_bwd(m)` is
> minimised across all nodes settled by either frontier so far.

Formally: maintain `mu = inf`. After each pop in either direction, update
`mu = min(mu, g_fwd(u) + g_bwd(u))` for every neighbour `u` of the just-settled node that
has a g-score in the other frontier. Terminate when the smaller of the two frontier top
f-scores exceeds `mu`.

### Turn Restrictions in Bidirectional Search

The forward search checks `(from_way, via_node, to_way)` triples. The backward search traverses
edges in **reverse** and must check `(to_way, via_node, from_way)` — the same triple read
backwards. Precompute a `reversed_turn_restrictions` set at load time:

```python
self.reversed_turn_restrictions = {(tw, via, fw) for fw, via, tw in self.turn_restrictions}
```

The backward search uses `reversed_turn_restrictions` exactly as the forward search uses
`turn_restrictions`.

### Penalty and Blockage Overlays

Penalties and blockages are keyed by directed edge ID `"from:to:key"`. In the backward search,
edges are traversed in reverse (`to → from`), so the raw edge ID remains the same physical edge
— the same `raw_edge_id` is used for both lookups. No change needed to the overlay format.

### Path Reconstruction

Once the optimal meeting node `m` is found:
1. Walk `came_from_fwd` backward from `m` to `start` → reverse to get `start → m` edges.
2. Walk `came_from_bwd` backward from `m` to `goal` → this gives `goal → m` edges; reverse to
   get `m → goal` edges.
3. Concatenate the two edge lists and stitch geometry as the current `route()` does.

Edge IDs, lengths, times, and physical IDs are collected in the same format as today so
`RouteResult` is unchanged.

---

## Implementation Plan

### Step 1 — OsmnxGraph: build reversed turn-restriction set at init

**File**: `graph_backend.py` — `OsmnxGraph.__init__()` after `load_turn_restrictions()` call

```python
self.turn_restrictions = load_turn_restrictions()
self.reversed_turn_restrictions = {(tw, via, fw) for fw, via, tw in self.turn_restrictions}
```

Same for `PurePythonGraph.__init__()`.

### Step 2 — PurePythonGraph: build `reverse_adjacency` at init

The pure-Python backend uses `self.adjacency` (forward). Add `self.reverse_adjacency` built at
the same time as `self.adjacency` in `__init__()`.

For each edge `(neighbor, dist_m, base_speed, geom, restrictions, wid)` added to
`adjacency[source]`, add the reversed edge to `reverse_adjacency[neighbor]`:

```python
reverse_adjacency[neighbor].append(
    (source, dist_m, base_speed, list(reversed(geom)), restrictions, wid)
)
```

Note: one-way edges appear only in `adjacency[source]` in the forward direction but the backward
search needs to traverse them in reverse (`neighbor → source`). Add them to `reverse_adjacency`
unconditionally — the forward search already enforces one-way via the original `oneway` tag.

**File**: `graph_backend.py` — `PurePythonGraph.__init__()`, immediately after the adjacency
construction loop, before `self.adjacency = adjacency`.

### Step 3 — Add `route_bidir()` to OsmnxGraph

```python
def route_bidir(self, start_id, goal_id, truck_class=None,
                blocked_edge_ids=None, penalty_edge_factors=None,
                avoid_initial_reverse_of_edge_id=None):
```

Structure mirrors `route()` but maintains two parallel search states:

```python
# Forward state (start → goal)
g_fwd   = {start_state: 0.0}
open_fwd = [(h_fwd(start_id), 0.0, next(order), start_state)]

# Backward state (goal → start, using G.predecessors + reversed turn restrictions)
g_bwd   = {goal_state: 0.0}
open_bwd = [(h_bwd(goal_id), 0.0, next(order), goal_state)]

mu = float("inf")  # best known meeting cost
meeting_state_fwd = meeting_state_bwd = None
```

Each iteration: pop the frontier with the **smaller top f-score** and expand it. After expanding
node `u` from the forward frontier, check all its neighbours that already have a `g_bwd` entry:

```python
combined = g_fwd_u + edge_cost + g_bwd.get(next_bwd_state, inf)
if combined < mu:
    mu = combined
    meeting_state_fwd = next_fwd_state
    meeting_state_bwd = corresponding_bwd_state
```

Terminate when `min(open_fwd[0][1], open_bwd[0][1]) >= mu` (both frontier minima exceed best
known path).

**Backward adjacency for OsmnxGraph**: use `G.predecessors(current)` and
`G.in_edges(current, keys=True, data=True)` to iterate reverse edges. The reverse heuristic
`h_bwd(n)` is the same haversine lower-bound but toward `start_id`.

**File**: `graph_backend.py` — new method on `OsmnxGraph`, ~150 lines.

### Step 4 — Add `route_bidir()` to PurePythonGraph

Same structure as Step 3 but uses `self.reverse_adjacency` for the backward frontier and
`self.reversed_turn_restrictions` for backward turn checking.

**File**: `graph_backend.py` — new method on `PurePythonGraph`, ~120 lines.

### Step 5 — Wire into `_internal_route()` in main.py

Replace `graph.route(...)` with `graph.route_bidir(...)`. Keep `route()` as an internal fallback
for unit tests and for the case where `start_id == goal_id`.

**File**: `services/routing-tracking/main.py` — `_internal_route()` line ~266.

---

## Key Edge Cases to Handle

| Case | Forward | Backward | Handling |
|------|---------|----------|----------|
| `start_id == goal_id` | trivial | trivial | Return empty `RouteResult` immediately before search |
| No path exists | `open_fwd` empties | or `open_bwd` empties | Return `None` (same as `route()`) |
| `avoid_initial_reverse_of_edge_id` | skip reverse of start edge | not applicable | Same check as in `route()`, forward only |
| One-way streets | forward only in adjacency | backward uses `reverse_adjacency` which includes reversed one-ways | Correct by construction |
| Turn restrictions at meeting node | forward state carries `incoming_osmids` | backward state carries `incoming_way` | Must check both when stitching path at meeting node |
| Blockage on meeting edge | `raw_edge_id in blocked_lookup` check | same check on reverse edge | Same `blocked_lookup` set — directed edge IDs are identical |
| Heavy penalty on path | `penalty_lookup.get(raw_edge_id)` | same lookup, same key | `mu` accumulates penalised cost correctly |

---

## Path Reconstruction Detail

After termination with `meeting_state_fwd` and `meeting_state_bwd`:

```python
# Forward half: start → meeting_node
fwd_edges = []
state = meeting_state_fwd
while state != start_state:
    prev, dist_m, edge_data, osmids, edge_key, penalty = came_from_fwd[state]
    fwd_edges.append((dist_m, edge_data, state[0], prev[0], edge_key, penalty))
    state = prev
fwd_edges.reverse()

# Backward half: meeting_node → goal
# came_from_bwd[state] was built traversing goal→meeting in reverse graph,
# so walking it backward gives us meeting→goal edges in forward order.
bwd_edges = []
state = meeting_state_bwd
while state != goal_state:
    prev, dist_m, edge_data, osmids, edge_key, penalty = came_from_bwd[state]
    # edge_data is the original forward edge (same physical edge, just traversed backward)
    # Geometry coords need reversing so they run in the forward travel direction.
    bwd_edges.append((dist_m, edge_data, prev[0], state[0], edge_key, penalty, reverse_geom=True))
    state = prev
# bwd_edges is already in meeting→goal order

all_edges = fwd_edges + bwd_edges
# Stitch geometry exactly as route() does, reversing geom where reverse_geom=True
```

---

## Files to Change

| File | Change |
|------|--------|
| `graph_backend.py` | `OsmnxGraph.__init__`: add `reversed_turn_restrictions` |
| `graph_backend.py` | `OsmnxGraph`: add `route_bidir()` method (~150 lines) |
| `graph_backend.py` | `PurePythonGraph.__init__`: add `reverse_adjacency` + `reversed_turn_restrictions` |
| `graph_backend.py` | `PurePythonGraph`: add `route_bidir()` method (~120 lines) |
| `main.py` | `_internal_route()`: call `graph.route_bidir()` instead of `graph.route()` |
| `tests/test_virtual_restrictions.py` | Add bidirectional equivalents of existing route tests |

---

## Verification

1. **Correctness — identical routes**: For 50 random (start, goal, profile) pairs on the real
   `busan-roads_osm.pbf`, assert `route_bidir().distance_m == route().distance_m` (within 0.1 m
   floating-point tolerance) and that `edge_ids` lists match.

2. **Correctness — blocked edges**: Add a blockage on the optimal direct path; assert both
   `route()` and `route_bidir()` produce the same detour.

3. **Correctness — heavy penalty**: Apply 50× penalty to a bridge on the direct route; assert
   both methods either avoid it (if a reasonable alternate exists) or include it with the same
   total penalised cost.

4. **Correctness — turn restrictions**: Use the existing
   `test_osmnx_turn_restriction_keeps_alternate_arrival_state` test graph; assert
   `route_bidir()` takes the same legal path.

5. **Performance benchmark** (`cProfile` or `time.perf_counter`):
   - Route 20 cross-city pairs (> 10 km) with no restrictions → compare nodes expanded
   - Route same 20 pairs with a 100× penalty corridor blocking the direct path
   - Target: ≥ 30% reduction in nodes expanded vs `route()` on penalised queries

6. **Edge case**: `start_id == goal_id` returns empty `RouteResult` without error.

7. **Edge case**: unreachable goal (graph disconnected) returns `None` from both methods.

---

## Complexity Notes

- **Memory**: both `g_fwd` and `g_bwd` dicts hold up to O(|settled_nodes|) entries. In the worst
  case this is the same as `route()`. In practice it's roughly half.
- **Startup cost**: `reversed_turn_restrictions` is a one-time set comprehension at load. For the
  busan dataset (~3,000 restrictions) this is negligible. `reverse_adjacency` (PurePythonGraph) is
  an extra pass over all edges — same order as building `adjacency`.
- **OsmnxGraph backward traversal**: `G.predecessors()` and `G.in_edges()` are O(in-degree) per
  node — same as forward `G.adj[node]`. No extra data structure needed.
- **Turn restriction correctness at meeting node**: the current edge-state model guarantees that
  the approach direction is tracked in the state tuple. At the meeting node the forward state
  carries `incoming_osmids` and the backward state carries its own `incoming_way`. The path
  stitching step must verify the join edge is legal from both sides — add a check when computing
  `mu` that the meeting edge does not violate a turn restriction from either direction.
