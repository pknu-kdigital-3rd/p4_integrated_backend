"""
Loads a road-network graph from a .osm.pbf file and exposes a uniform
interface for nearest-node lookup and A* routing.

Uses osmnx/networkx if installed (recommended - handles the full graph,
turn restrictions via simplify=True, etc). Falls back to the bundled
pure-Python parser (pbf_parser.py) if osmnx isn't available, so this
also works in network-restricted environments.
"""
import math


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def load_manual_overrides(path="manual_restrictions.json"):
    """Loads hand-investigated restriction data keyed by OSM way id, to fill
    gaps in sparse/missing OSM tags. Real-world clearance/weight limits at
    tunnels, underpasses, and narrow streets are very often physically real
    even when nobody has ever tagged them in OSM - this lets you record
    what you find by checking Kakao/Naver Roadview or the physical sign
    at the site, without touching the parser or graph-building code.

    File format: {"<way_id>": {"maxheight": "3.2", ...other fields...}, ...}
    Only maxheight/maxweight/maxwidth/maxlength/hgv/access are applied to
    routing; other keys (name, note, roadview) are documentation for you
    and ignored here. A null value means "not yet verified" and has no effect.
    """
    import json
    import os
    RESTRICTION_KEYS = {"maxheight", "maxweight", "maxwidth", "maxlength", "hgv", "access"}
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    overrides = {}
    for k, v in raw.items():
        if k == "_readme" or not k.isdigit():
            continue
        restriction_fields = {rk: rv for rk, rv in v.items() if rk in RESTRICTION_KEYS and rv is not None}
        if restriction_fields:
            overrides[int(k)] = restriction_fields
    return overrides


def load_overrides():
    """Merges gov_restrictions.json (bulk, auto-matched from official MOLIT/
    Busan facility-spec datasets - see fetch_gov_restrictions.py) with
    manual_restrictions.json (small, hand-verified via Roadview or a posted
    sign) into one way_id -> restriction-fields dict. Manual entries win on
    conflict, since they represent an actual human check of that specific
    site rather than a nearest-way geospatial match against government
    facility coordinates."""
    merged = dict(load_manual_overrides("gov_restrictions.json"))
    merged.update(load_manual_overrides("manual_restrictions.json"))
    return merged


def load_turn_restrictions(path="turn_restrictions.json"):
    """Loads (from_way, via_node, to_way) banned-transition triples generated
    by extract_turn_restrictions.py from OSM turn-restriction relations
    (busan-roads_osm.pbf itself carries zero OSM relations - this data can
    only come from a separate full-country extract, processed offline).
    Returns an empty set if the file doesn't exist, so routing degrades
    gracefully (no turn enforcement) rather than failing to start."""
    import json
    import os

    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    return {
        (r["from_way"], r["via_node"], r["to_way"])
        for r in raw.get("restrictions", [])
    }


def get_override_locations(pbf_path):
    """Returns every override entry - government-sourced and manual, verified
    or not - with its real map coordinates resolved from the PBF, so the
    frontend can plot markers distinguishing official facility specs from
    locations still awaiting on-site/Roadview verification."""
    import json
    import os
    from pbf_parser import parse_pbf

    RESTRICTION_KEYS = {"maxheight", "maxweight", "maxwidth", "maxlength", "hgv", "access"}
    # manual first: if the same way_id appears in both files, the manual
    # (human-checked) entry is what should be shown
    SOURCES = [("manual_restrictions.json", "manual"), ("gov_restrictions.json", "government")]

    raw_by_source = {}
    all_way_ids = set()
    for path, source in SOURCES:
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        raw_by_source[source] = raw
        all_way_ids.update(int(k) for k in raw if k != "_readme" and k.isdigit())

    if not all_way_ids:
        return []

    nodes, ways = parse_pbf(pbf_path)

    locations = []
    for wid, refs, tags in ways:
        if wid not in all_way_ids:
            continue
        pts = [nodes[r][:2] for r in refs if r in nodes]
        if not pts:
            continue
        mid = pts[len(pts) // 2]

        entry = source = None
        for path, src in SOURCES:
            raw = raw_by_source.get(src)
            if raw and str(wid) in raw:
                entry, source = raw[str(wid)], src
                break
        if entry is None:
            continue

        restrictions = {rk: rv for rk, rv in entry.items() if rk in RESTRICTION_KEYS}
        verified = any(v is not None for v in restrictions.values())
        locations.append({
            "way_id": wid,
            "name": entry.get("name", ""),
            "note": entry.get("note", ""),
            "roadview": entry.get("roadview", ""),
            "lat": mid[0], "lon": mid[1],
            "verified": verified,
            "source": source,
            "restrictions": restrictions,
        })
    return locations


class RouteResult:
    def __init__(self, coords, distance_m, time_s):
        self.coords = coords          # [[lat, lon], ...]
        self.distance_m = distance_m
        self.time_s = time_s


# ---------------------------------------------------------------------------
# Truck size classes. These are illustrative typical dimensions, not the
# official regulatory limits of any specific country - tune to match your
# actual fleet if this feeds a real routing decision.
#
# Two classes, deliberately far apart in size so restrictions in this
# dataset (which skews toward height/weight tags - see pbf_parser output)
# actually produce visibly different routes rather than both classes
# passing everything:
#   - "small": a compact delivery/box truck
#   - "semi": a semi-trailer (articulated tractor + container chassis) -
#     the vehicle that hauls a shipping container, very common in Busan
#     given the port; also called an articulated lorry or 18-wheeler
#
# max_speed_kmh is a class-level speed cap (heavier/larger trucks are
# commonly limited below the posted road speed by regulation/practice) -
# it changes edge cost AND tightens the A* heuristic per class, since the
# heuristic's "fastest possible speed" bound is specific to what that
# class could ever actually achieve, not one global number.
# ---------------------------------------------------------------------------
TRUCK_PROFILES = {
    "small": {
        "label": "Small truck",
        "height_m": 2.5, "weight_t": 3.5, "width_m": 1.9, "length_m": 5.0,
        "max_speed_kmh": 100,
    },
    "semi": {
        "label": "Semi-trailer (container)",
        # weight_t = 40.0 (not a fully-loaded 40ft container's physical max
        # of ~44t) because that's Korea's actual legal gross vehicle weight
        # cap for ordinary road use without a special overweight permit
        # (도로법) - it's deliberately a bit below the ~43.2t allowable
        # capacity of the common "DB-24" bridge design class, so a real,
        # legally-loaded truck is expected to cross those bridges fine.
        # Using the physical 44t max here would incorrectly route this
        # profile around every DB-24 bridge in the gov-sourced restriction
        # data even though a legal truck never needs to.
        "height_m": 4.0, "weight_t": 40.0, "width_m": 2.5, "length_m": 18.0,
        "max_speed_kmh": 80,
    },
    "special": {
        "label": "Special cargo (oversized, 4+ axle)",
        # width_m = 3.0, Korea's exact 도로법 threshold above which a vehicle
        # needs a 운행허가 (travel permit) to use public roads at all - i.e.
        # this profile models the vehicle class the width data itself is
        # about (data.go.kr 3047694, "roads eligible for oversize travel
        # permits"). Deliberately the *minimum* permit-triggering width, not
        # a wider illustrative number: every value in that dataset is >=3.0m
        # (it only lists roads verified wide enough to grant a permit for),
        # so anything narrower here would never be blocked by any of the
        # 6,714 maxwidth entries, and anything much wider (e.g. 3.3m, the
        # single most common tagged value - 5,381 of 6,714 ways) would be
        # blocked by nearly all of them, making this profile impractically
        # unroutable. 3.0m blocks the narrowest-permitted 1,015 ways while
        # passing the rest - a real, visible effect without being absurd.
        "height_m": 4.5, "weight_t": 40.0, "width_m": 3.0, "length_m": 20.0,
        "max_speed_kmh": 70,
    },
}
GLOBAL_MAX_SPEED_KMH = 100  # used for the unrestricted/"car" heuristic

# Typical speed by OSM highway class - shared by both backends as the
# fallback when a road has no explicit posted speed limit tag.
ROAD_SPEED_KMH = {
    "motorway": 100, "motorway_link": 60, "trunk": 80, "trunk_link": 50,
    "primary": 60, "primary_link": 40, "secondary": 50, "secondary_link": 35,
    "tertiary": 40, "tertiary_link": 30, "unclassified": 30, "residential": 25,
    "living_street": 15, "service": 15, "track": 15,
}


def _tag_is(val, *targets):
    """True if a string-valued OSM tag (hgv, access) equals/contains any of
    `targets`. When ox.simplify_graph() merges original ways with different
    values for the same tag, the value becomes a LIST (e.g. access=['no',
    nan]) - same failure mode as _parse_float_tag's list handling above, and
    a plain `val in targets`/`val == x` would silently miss it for a merged
    edge. The most restrictive constituent segment is the binding
    constraint, so this matches if ANY element of a list matches."""
    if isinstance(val, list):
        return any(v in targets for v in val)
    return val in targets


def edge_allowed(restrictions, profile):
    """True if a vehicle matching `profile` (or no profile = unrestricted)
    is legally allowed to use an edge carrying the given restriction tags.
    Missing/untagged limits are treated as unrestricted for that dimension -
    OSM coverage is sparse, so "untagged" must mean "assume passable", not
    "assume blocked", or almost the whole network would vanish.

    A vehicle sitting exactly AT the posted limit is blocked too (>=, not
    just >) - confirmed against map.naver.com's real 화물차 routing for
    광안대교 (maxweight=40): a 40.0t vehicle is refused there, so a Korean
    "총중량 40톤" sign means "40t or more prohibited", not "over 40t".

    access=no/private blocks ANY vehicle, including unrestricted "Car" mode -
    unlike the dimension checks below (whether THIS vehicle physically/
    legally fits), a private/closed road is off-limits to through traffic
    regardless of vehicle type, so this runs before the profile-is-None
    short-circuit. access=destination is left passable - it means "local
    traffic only", not "closed", and hard-blocking it risks making a
    start/end point that happens to sit on one unreachable."""
    if _tag_is(restrictions.get("access"), "no", "private"):
        return False
    if profile is None:
        return True
    if restrictions.get("max_height_m") is not None and profile["height_m"] >= restrictions["max_height_m"]:
        return False
    if restrictions.get("max_weight_t") is not None and profile["weight_t"] >= restrictions["max_weight_t"]:
        return False
    if restrictions.get("max_width_m") is not None and profile["width_m"] >= restrictions["max_width_m"]:
        return False
    if restrictions.get("max_length_m") is not None and profile["length_m"] >= restrictions["max_length_m"]:
        return False
    if _tag_is(restrictions.get("hgv"), "no"):
        return False
    return True


def _parse_float_tag(val):
    """OSM numeric tags sometimes carry units ('4.4' vs '4.4 m') or ranges -
    keep this forgiving rather than dropping the restriction entirely.
    pyrosm (used by OsmnxGraph to read the .pbf) represents a missing tag as
    float('nan') rather than an absent key, unlike a plain dict - treat that
    the same as None rather than let a real NaN leak into `restrictions`.

    When ox.simplify_graph() merges several original ways with DIFFERENT
    values for the same tag into one edge, the merged attribute becomes a
    LIST (e.g. maxweight=['40', nan]), the same way `osmid` does - str()'ing
    a list and trying to float() it always raised, so this used to silently
    return None (no restriction) for any such edge. Confirmed as a real bug:
    a merged 광안대교 (Gwangan Bridge) edge with maxweight=['40', nan] let a
    40t "semi" profile cross a bridge it should have been blocked from.
    Parse every element and take the MIN of whatever parses - the most
    restrictive constituent segment is the binding constraint for the whole
    merged edge, since a vehicle has to satisfy every segment it's made of."""
    if isinstance(val, list):
        parsed = [p for p in (_parse_float_tag(v) for v in val) if p is not None]
        return min(parsed) if parsed else None
    if val is None or (isinstance(val, float) and val != val):  # val != val is the NaN check
        return None
    try:
        return float(str(val).split()[0].replace("m", "").replace("t", "").strip())
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Backend 1: osmnx / networkx (preferred - use this when osmnx is installed)
# ---------------------------------------------------------------------------
class OsmnxGraph:
    CACHE_SUFFIX = ".graph_cache.pkl"

    def __init__(self, pbf_path):
        import osmnx as ox
        import networkx as nx
        self.ox = ox
        self.nx = nx
        # loaded fresh every time, independent of the graph cache below -
        # turn_restrictions.json isn't baked into self.G, so updating it
        # doesn't require paying the (expensive) graph rebuild cost
        self.turn_restrictions = load_turn_restrictions()
        if self.turn_restrictions:
            print(f"Loaded {len(self.turn_restrictions)} turn restriction(s)")

        cache_path = pbf_path + self.CACHE_SUFFIX
        if self._load_from_cache(cache_path, pbf_path):
            return

        from pyrosm import OSM

        # osmnx's own graph_from_xml() only reads OSM XML (.osm/.osm.bz2),
        # not the binary protobuf .pbf format this project actually uses -
        # feeding it a .pbf directly fails trying to parse the binary as
        # text. pyrosm parses .pbf natively and its to_graph() output uses
        # the same node/edge attribute conventions as osmnx (x/y on nodes,
        # osmid/highway/length/geometry on edges), so the rest of this
        # class - and route() below - can stay unchanged.
        osm = OSM(pbf_path)
        nodes, edges = osm.get_network(
            network_type="driving",
            nodes=True,
            extra_attributes=["maxheight", "maxweight", "maxwidth", "maxlength", "hgv"],
        )
        self.G = ox.simplify_graph(osm.to_graph(nodes, edges, graph_type="networkx"))

        manual_overrides = load_overrides()
        if manual_overrides:
            print(f"Loaded {len(manual_overrides)} restriction override(s) (government + manual)")
            applied = 0
            for u, v, k, data in self.G.edges(keys=True, data=True):
                # osmid is a single id, or a list if simplify=True merged
                # several original ways into this one edge - match on any
                osmids = data["osmid"] if isinstance(data.get("osmid"), list) else [data.get("osmid")]
                for wid in osmids:
                    if wid in manual_overrides:
                        data.update(manual_overrides[wid])
                        applied += 1
                        break
            print(f"Applied to {applied} edge(s)")

        self._save_to_cache(cache_path)

    def _cache_dependency_paths(self, pbf_path):
        # anything that, if it changes, should invalidate the cached graph -
        # the source data itself plus both override files (already merged
        # into self.G by the time it's cached, so a newer override file
        # means the cache is stale even if the .pbf hasn't changed)
        return [pbf_path, "gov_restrictions.json", "manual_restrictions.json"]

    def _load_from_cache(self, cache_path, pbf_path):
        import os
        import pickle

        if not os.path.exists(cache_path):
            return False
        cache_mtime = os.path.getmtime(cache_path)
        stale = any(
            os.path.exists(p) and os.path.getmtime(p) > cache_mtime
            for p in self._cache_dependency_paths(pbf_path)
        )
        if stale:
            print(f"{cache_path} is older than its source data - rebuilding")
            return False
        try:
            with open(cache_path, "rb") as f:
                self.G = pickle.load(f)
        except Exception as e:
            # a pickle can fail to load after a networkx/osmnx/pyrosm/shapely
            # version change even though the file itself is fine - just
            # rebuild rather than crash the whole app over a stale cache
            print(f"Failed to load {cache_path} ({e}) - rebuilding")
            return False
        print(f"Loaded cached graph from {cache_path} (delete this file to force a full rebuild)")
        return True

    def _save_to_cache(self, cache_path):
        import pickle

        print(f"Caching built graph to {cache_path} for faster startup next time...")
        with open(cache_path, "wb") as f:
            pickle.dump(self.G, f, protocol=pickle.HIGHEST_PROTOCOL)

    def nearest_node(self, lat, lon):
        return self.ox.distance.nearest_nodes(self.G, X=lon, Y=lat)

    def nearest_coords(self, lat, lon):
        """Returns [lat, lon] of the graph vertex nearest to the given point -
        used to snap a dragged marker onto the actual road network."""
        nid = self.nearest_node(lat, lon)
        return [self.G.nodes[nid]["y"], self.G.nodes[nid]["x"]]

    def route(self, start_id, goal_id, truck_class=None):
        # Hand-rolled A* instead of nx.astar_path - turn-restriction
        # enforcement needs to know which way produced the edge a node was
        # reached by (to check (from_way, via_node, to_way) triples), and a
        # plain nx.astar_path heuristic/weight callable has no path-history
        # hook to hang that on. This mirrors PurePythonGraph.route()'s own
        # hand-rolled A* structure/simplifications (see its comments for the
        # full reasoning - same admissible-heuristic and same "only checks
        # the single best-known approach to a node, not every way that
        # could reach it" simplification, not a full edge-based search).
        import heapq

        G, ox = self.G, self.ox

        profile = TRUCK_PROFILES.get(truck_class) if truck_class else None
        max_speed_kmh = profile["max_speed_kmh"] if profile else GLOBAL_MAX_SPEED_KMH
        max_speed_mps = max_speed_kmh * 1000 / 3600

        def edge_restrictions(data):
            return {
                "max_height_m": _parse_float_tag(data.get("maxheight")),
                "max_weight_t": _parse_float_tag(data.get("maxweight")),
                "max_width_m": _parse_float_tag(data.get("maxwidth")),
                "max_length_m": _parse_float_tag(data.get("maxlength")),
                "hgv": data.get("hgv"),
                "access": data.get("access"),
            }

        def _osmids(data):
            # osmid is a single id, or a list if simplify_graph() merged
            # several original ways into this one edge - turn restrictions
            # reference a specific original way id, so treat both forms
            # uniformly as a list to check membership against
            oid = data.get("osmid")
            return oid if isinstance(oid, list) else [oid]

        def _edge_time_from_data(data):
            highway = data.get("highway", "residential")
            if isinstance(highway, list):
                highway = highway[0]
            base_speed = ROAD_SPEED_KMH.get(highway, 30)
            effective_speed = min(base_speed, max_speed_kmh)
            return data.get("length", 0) / (effective_speed * 1000 / 3600)

        def h(n):
            y1, x1 = G.nodes[n]["y"], G.nodes[n]["x"]
            y2, x2 = G.nodes[goal_id]["y"], G.nodes[goal_id]["x"]
            return ox.distance.great_circle(y1, x1, y2, x2) / max_speed_mps

        open_set = [(h(start_id), 0.0, start_id)]
        # came_from[node] = (prev_node, dist_m, edge_data, osmids_of_this_edge)
        came_from = {}
        g_score = {start_id: 0.0}
        visited = set()

        while open_set:
            f, g, current = heapq.heappop(open_set)
            if current in visited:
                continue
            visited.add(current)
            if current == goal_id:
                break
            incoming_osmids = came_from[current][3] if current in came_from else None
            for neighbor, parallel in G.adj.get(current, {}).items():
                # pick the fastest allowed parallel edge - same min-over-
                # parallel-edges idea the old edge_weight() used, now also
                # doing the edge_allowed() filtering inline (subgraph_view
                # isn't used anymore now that this loop is hand-rolled)
                best_attr, best_time = None, None
                for attrs in parallel.values():
                    if not edge_allowed(edge_restrictions(attrs), profile):
                        continue
                    t = _edge_time_from_data(attrs)
                    if best_time is None or t < best_time:
                        best_time, best_attr = t, attrs
                if best_attr is None:
                    continue
                out_osmids = _osmids(best_attr)
                if incoming_osmids is not None and self.turn_restrictions and any(
                    (fw, current, tw) in self.turn_restrictions
                    for fw in incoming_osmids for tw in out_osmids
                ):
                    continue  # illegal turn (from incoming way, via current, onto this way)
                tentative = g + best_time
                if tentative < g_score.get(neighbor, float("inf")):
                    g_score[neighbor] = tentative
                    came_from[neighbor] = (current, best_attr.get("length", 0), best_attr, out_osmids)
                    heapq.heappush(open_set, (tentative + h(neighbor), tentative, neighbor))

        if goal_id not in g_score:
            return None  # no path exists under this profile's constraints (or at all)

        # walk back through came_from, collecting each edge's (distance, edge_data, arrival_node)
        edges = []
        n = goal_id
        while n != start_id:
            prev, dist_m, edge_data, osmids = came_from[n]
            edges.append((dist_m, edge_data, n))
            n = prev
        edges.reverse()  # now in start -> goal order

        # Stitch the real road curve, not straight chords between nodes.
        # osmnx keeps the original shape points as a shapely `geometry` on
        # each edge when simplify=True collapsed intermediate nodes; use it
        # when present, otherwise fall back to a straight line for that edge.
        coords = [[G.nodes[start_id]["y"], G.nodes[start_id]["x"]]]
        distance_m = 0.0
        time_s = 0.0
        for dist_m, edge_data, v in edges:
            distance_m += dist_m
            time_s += _edge_time_from_data(edge_data)
            geom = edge_data.get("geometry")
            if geom is not None:
                # shapely LineString coords are (x, y) i.e. (lon, lat) - flip to [lat, lon]
                pts = [[lat, lon] for lon, lat in geom.coords]
                # first point duplicates the previous edge's endpoint
                coords.extend(pts[1:] if pts[0] == coords[-1] else pts)
            else:
                coords.append([G.nodes[v]["y"], G.nodes[v]["x"]])
        return RouteResult(coords, distance_m, time_s)


# ---------------------------------------------------------------------------
# Backend 2: pure-Python fallback (no external deps, works offline)
# ---------------------------------------------------------------------------
class PurePythonGraph:
    SPEED_KMH = ROAD_SPEED_KMH  # shared table, see module level above
    ROUTABLE = set(SPEED_KMH.keys())

    def __init__(self, pbf_path):
        from collections import Counter, defaultdict
        from pbf_parser import parse_pbf

        nodes, ways = parse_pbf(pbf_path)
        manual_overrides = load_overrides()
        if manual_overrides:
            print(f"Loaded {len(manual_overrides)} restriction override(s) (government + manual)")
            merged_ways = []
            for wid, refs, tags in ways:
                if wid in manual_overrides:
                    tags = {**tags, **manual_overrides[wid]}  # override wins on key conflicts
                merged_ways.append((wid, refs, tags))
            ways = merged_ways

        routable = [(wid, refs, tags) for wid, refs, tags in ways
                    if tags.get("highway") in self.ROUTABLE]

        ref_count = Counter()
        for _, refs, _ in routable:
            for r in refs:
                ref_count[r] += 1

        vertex_ids = set()
        for _, refs, _ in routable:
            if not refs:
                continue
            vertex_ids.add(refs[0])
            vertex_ids.add(refs[-1])
            for r in refs[1:-1]:
                if ref_count[r] >= 2:
                    vertex_ids.add(r)

        adjacency = defaultdict(list)
        restricted_edge_count = 0
        for wid, refs, tags in routable:
            oneway = tags.get("oneway") in ("yes", "true", "1")
            base_speed = self.SPEED_KMH.get(tags.get("highway"), 30)

            # capture any truck-relevant restriction tags on this way, once,
            # to attach to every edge segment it produces below
            restrictions = {
                "max_height_m": _parse_float_tag(tags.get("maxheight")),
                "max_weight_t": _parse_float_tag(tags.get("maxweight")),
                "max_width_m": _parse_float_tag(tags.get("maxwidth")),
                "max_length_m": _parse_float_tag(tags.get("maxlength")),
                "hgv": tags.get("hgv"),
                "access": tags.get("access"),
            }
            if any(v is not None for v in restrictions.values()):
                restricted_edge_count += 1

            seg_start_idx = 0
            seg_dist = 0.0
            seg_geom = []  # intermediate [lat, lon] points for this sub-segment's real curve
            prev = None
            for i, nid in enumerate(refs):
                if nid not in nodes:
                    continue
                lat, lon, _ = nodes[nid]
                if prev is not None:
                    seg_dist += haversine_m(prev[0], prev[1], lat, lon)
                prev = (lat, lon)
                seg_geom.append([lat, lon])
                if nid in vertex_ids and i != seg_start_idx:
                    s = refs[seg_start_idx]
                    if s in nodes:
                        # edge tuple: (neighbor, dist_m, base_speed_kmh, geom, restrictions, way_id)
                        # travel time is no longer baked in here - it's computed
                        # per-request in route(), since it depends on which
                        # truck profile (if any) is asking. way_id is needed
                        # to check turn restrictions ((from_way, via_node,
                        # to_way) triples) during search - see route() below.
                        adjacency[s].append((nid, seg_dist, base_speed, list(seg_geom), restrictions, wid))
                        if not oneway:
                            adjacency[nid].append((s, seg_dist, base_speed, list(reversed(seg_geom)), restrictions, wid))
                    seg_start_idx = i
                    seg_dist = 0.0
                    seg_geom = [[lat, lon]]  # new segment starts where this one ended

        self.coords = {v: nodes[v][:2] for v in vertex_ids if v in nodes}
        self.adjacency = adjacency
        self.turn_restrictions = load_turn_restrictions()
        if self.turn_restrictions:
            print(f"Loaded {len(self.turn_restrictions)} turn restriction(s)")
        print(f"Ways carrying truck restriction tags: {restricted_edge_count} / {len(routable)}")
        # simple grid index for fast nearest-node lookup
        self.grid_size = 0.01
        self.grid = defaultdict(list)
        for vid, (lat, lon) in self.coords.items():
            key = (int(lat / self.grid_size), int(lon / self.grid_size))
            self.grid[key].append(vid)

    def nearest_node(self, lat, lon):
        best, best_d = None, float("inf")
        gx, gy = int(lat / self.grid_size), int(lon / self.grid_size)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for vid in self.grid.get((gx + dx, gy + dy), []):
                    vlat, vlon = self.coords[vid]
                    d = (vlat - lat) ** 2 + (vlon - lon) ** 2
                    if d < best_d:
                        best_d, best = d, vid
        return best

    def nearest_coords(self, lat, lon):
        """Returns [lat, lon] of the graph vertex nearest to the given point -
        used to snap a dragged marker onto the actual road network."""
        nid = self.nearest_node(lat, lon)
        if nid is None:
            return None
        return list(self.coords[nid])

    def route(self, start_id, goal_id, truck_class=None):
        import heapq
        coords = self.coords

        profile = TRUCK_PROFILES.get(truck_class) if truck_class else None
        max_speed_kmh = profile["max_speed_kmh"] if profile else GLOBAL_MAX_SPEED_KMH
        max_speed_mps = max_speed_kmh * 1000 / 3600

        def h(n):
            # admissible lower-bound time estimate: straight-line distance
            # divided by the FASTEST this specific profile could ever go -
            # tighter (and still valid) per truck class, since a capped-speed
            # truck can never beat its own cap even on an open motorway
            lat1, lon1 = coords[n]
            lat2, lon2 = coords[goal_id]
            return haversine_m(lat1, lon1, lat2, lon2) / max_speed_mps

        def edge_time_s(dist_m, base_speed_kmh):
            effective_kmh = min(base_speed_kmh, max_speed_kmh)
            return dist_m / (effective_kmh * 1000 / 3600)

        open_set = [(h(start_id), 0.0, start_id)]
        # came_from stores (previous_vertex, dist_m, geometry_of_this_edge,
        # way_id_of_this_edge) so we can stitch the real road curve + true
        # distance back together, and know which way we arrived via for
        # turn-restriction checks on the NEXT hop
        came_from = {}
        g_score = {start_id: 0.0}
        visited = set()

        while open_set:
            f, g, current = heapq.heappop(open_set)
            if current in visited:
                continue
            visited.add(current)
            if current == goal_id:
                break
            # the way used to reach `current` - None at the start node,
            # where no turn restriction can apply yet. This is a simplified,
            # not fully turn-restriction-correct, model: it only checks the
            # single best-known approach to a node, not every way that could
            # reach it (that would need an edge-based/line-graph search
            # state instead of a plain per-node one) - a deliberate
            # simplification, see the Phase 3 plan notes.
            incoming_way = came_from[current][3] if current in came_from else None
            for neighbor, dist_m, base_speed, geom, restrictions, wid in self.adjacency.get(current, []):
                if not edge_allowed(restrictions, profile):
                    continue  # this truck class physically/legally cannot use this road
                if incoming_way is not None and (incoming_way, current, wid) in self.turn_restrictions:
                    continue  # illegal turn (from incoming_way, via current, onto wid)
                w = edge_time_s(dist_m, base_speed)
                tentative = g + w
                if tentative < g_score.get(neighbor, float("inf")):
                    g_score[neighbor] = tentative
                    came_from[neighbor] = (current, dist_m, geom, wid)
                    heapq.heappush(open_set, (tentative + h(neighbor), tentative, neighbor))

        if goal_id not in g_score:
            return None  # no path exists under this profile's constraints (or at all)

        # walk back through came_from, collecting each edge's (distance, real-curve geometry)
        edges = []
        n = goal_id
        while n != start_id:
            prev, dist_m, geom, wid = came_from[n]
            edges.append((dist_m, geom))
            n = prev
        edges.reverse()  # now in start -> goal order

        coords_out = [list(coords[start_id])]
        distance_m = 0.0
        for dist_m, geom in edges:
            distance_m += dist_m
            # geom[0] duplicates the previous edge's endpoint - skip it to avoid a repeated point
            coords_out.extend(geom[1:])

        return RouteResult(coords_out, distance_m, g_score[goal_id])


def load_graph(pbf_path):
    try:
        import osmnx  # noqa: F401
        import pyrosm  # noqa: F401 - actually reads the .pbf; osmnx alone can't
        print("Using osmnx (via pyrosm) backend")
        return OsmnxGraph(pbf_path)
    except ImportError as e:
        print(f"{e.name} not found - using bundled pure-Python fallback")
        return PurePythonGraph(pbf_path)