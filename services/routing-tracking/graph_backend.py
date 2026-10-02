"""
Loads a road-network graph from a .osm.pbf file and exposes a uniform
interface for nearest-node lookup and A* routing.

Uses osmnx/networkx if installed (recommended - handles the full graph,
turn restrictions via simplify=True, etc). Falls back to the bundled
pure-Python parser (pbf_parser.py) if osmnx isn't available, so this
also works in network-restricted environments.
"""
import math
import os


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _polyline_distance_sq_m(lat, lon, points):
    """Approximate point-to-line distance in metres for nearby road geometry."""
    scale_x = 111320.0 * math.cos(math.radians(lat))
    scale_y = 110540.0
    best = float("inf")
    for first, second in zip(points, points[1:]):
        x1, y1 = (first[1] - lon) * scale_x, (first[0] - lat) * scale_y
        x2, y2 = (second[1] - lon) * scale_x, (second[0] - lat) * scale_y
        dx, dy = x2 - x1, y2 - y1
        length_sq = dx * dx + dy * dy
        fraction = 0.0 if length_sq == 0 else max(0.0, min(1.0, -(x1 * dx + y1 * dy) / length_sq))
        nearest_x, nearest_y = x1 + fraction * dx, y1 + fraction * dy
        best = min(best, nearest_x * nearest_x + nearest_y * nearest_y)
    return best


# Road-edge geometry comes from two different adapters.  OSMnx/pyrosm may
# return a LineString whose coordinate order is opposite to the directed
# graph arc, while the pure-Python parser already reverses geometry for a
# reverse arc.  Keep the stitching rule in one place so a backend-specific
# orientation never creates a visible backtrack or loop at a junction.
EDGE_GEOMETRY_MATCH_TOLERANCE_M = 2.0
EDGE_GEOMETRY_POINT_TOLERANCE_M = 0.01


def _normalise_edge_geometry(points, start, end):
    """Return edge shape points oriented from ``start`` to ``end``.

    ``points``, ``start`` and ``end`` use the internal ``[lat, lon]`` form.
    OSM geometry endpoints can differ from graph-node coordinates by a few
    centimetres due to parser rounding, so orientation is chosen by endpoint
    distance rather than exact list equality.  The graph endpoints are then
    made explicit and consecutive duplicates are removed; this guarantees
    that the next directed edge starts exactly where the previous one ended.
    """
    try:
        raw_points = [
            [float(point[0]), float(point[1])]
            for point in points
            if isinstance(point, (list, tuple)) and len(point) >= 2
        ]
    except (TypeError, ValueError):
        raw_points = []
    if len(raw_points) < 2:
        return [[float(start[0]), float(start[1])], [float(end[0]), float(end[1])]]

    forward_error = haversine_m(raw_points[0][0], raw_points[0][1], start[0], start[1]) \
        + haversine_m(raw_points[-1][0], raw_points[-1][1], end[0], end[1])
    reverse_error = haversine_m(raw_points[-1][0], raw_points[-1][1], start[0], start[1]) \
        + haversine_m(raw_points[0][0], raw_points[0][1], end[0], end[1])
    if reverse_error + EDGE_GEOMETRY_MATCH_TOLERANCE_M < forward_error:
        raw_points.reverse()

    normalised = []

    def append(point):
        candidate = [float(point[0]), float(point[1])]
        if not normalised or haversine_m(
            normalised[-1][0], normalised[-1][1], candidate[0], candidate[1]
        ) > EDGE_GEOMETRY_POINT_TOLERANCE_M:
            normalised.append(candidate)

    append(start)
    for point in raw_points:
        append(point)
    append(end)
    return normalised


def _append_edge_geometry(route_points, points, start, end):
    """Append one directed edge shape to a route without a seam duplicate."""
    normalised = _normalise_edge_geometry(points, start, end)
    if route_points and haversine_m(
        route_points[-1][0], route_points[-1][1], normalised[0][0], normalised[0][1]
    ) <= EDGE_GEOMETRY_POINT_TOLERANCE_M:
        route_points.extend(normalised[1:])
    else:
        # A malformed/stale graph edge should not silently create a diagonal
        # jump.  Preserve the directed endpoints and let the caller see a
        # short connector instead of a geometry that runs backwards.
        route_points.extend(normalised)


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
    def __init__(self, coords, distance_m, time_s, edge_ids=None, edge_lengths=None, edge_times=None, physical_ids=None,
                 final_incoming_ways=None):
        self.coords = coords          # [[lat, lon], ...]
        self.distance_m = distance_m
        self.time_s = time_s
        self.edge_ids = edge_ids or []
        self.edge_lengths = edge_lengths or []
        self.edge_times = edge_times or []
        self.physical_ids = physical_ids or []
        # Way id(s) of the last edge, or the leg's initial incoming ways when
        # the leg has no edges. The next waypoint leg starts from these so a
        # turn restriction at the waypoint still knows the arrival road.
        self.final_incoming_ways = final_incoming_ways


def _turn_restriction_index(graph):
    """Return {via_node: {(from_way, to_way), ...}} for graph.turn_restrictions.

    A* only needs the arrival way at a via node of some turn restriction;
    everywhere else the legal continuations do not depend on it.  Indexing
    by via node lets the search keep node-only states at the other >99% of
    junctions instead of one state per (node, incoming way).  Built lazily
    and rebuilt if the restriction set object is replaced.
    """
    source = graph.turn_restrictions
    cached = getattr(graph, "_turn_index_cache", None)
    if cached is not None and cached[0] is source and cached[1] == len(source):
        return cached[2]
    index = {}
    for from_way, via_node, to_way in source:
        index.setdefault(via_node, set()).add((from_way, to_way))
    graph._turn_index_cache = (source, len(source), index)
    return index


def _overlay_match(raw_id, supplied_ids):
    """Match raw adapter IDs against graph-version-prefixed public IDs."""
    if not supplied_ids:
        return None
    for supplied in supplied_ids:
        if supplied == raw_id or supplied.endswith(f":{raw_id}"):
            return supplied
    return None


def _raw_overlay_id(value):
    """Return the adapter edge ID from a graph-version-prefixed ID.

    Dynamic restrictions are persisted with the routing graph fingerprint in
    front of the raw adapter ID.  The old matcher walked the complete list of
    restriction IDs for every edge visited by A*, which made a large polygon
    closure turn routing into an O(edges * blocked-ids) operation.  The graph
    fingerprint is a 32-character SHA-256 prefix, so it can be stripped once
    while preparing an O(1) lookup table.
    """
    value = str(value)
    prefix, separator, raw = value.partition(":")
    if separator and len(prefix) == 32 and all(character in "0123456789abcdefABCDEF" for character in prefix):
        return raw
    return value


def _initial_reverse_nodes(value):
    """Return the (from, to) nodes of the opposite direction of an edge."""
    raw = _raw_overlay_id(value)
    parts = str(raw).split(":")
    if len(parts) < 3:
        return None
    return parts[1], parts[0]


def _prepare_overlay_ids(values):
    lookup = set()
    for value in values or ():
        string_value = str(value)
        lookup.add(string_value)
        lookup.add(_raw_overlay_id(string_value))
    return lookup


def _prepare_overlay_values(values):
    lookup = {}
    for key, value in (values or {}).items():
        string_key = str(key)
        lookup[string_key] = value
        lookup[_raw_overlay_id(string_key)] = value
    return lookup


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


def edge_allowed(restrictions, profile, respect_access=True):
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
    if respect_access and _tag_is(restrictions.get("access"), "no", "private"):
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
# Precomputed routing edges. Vehicle eligibility and traversal time depend
# only on static OSM tags and the small fixed set of profiles, so both are
# computed once per edge instead of on every A* relaxation:
#   - allowed_mask: bit i = profile ROUTING_PROFILES[i] may use the edge
#     with access restrictions respected; bit i + len(ROUTING_PROFILES) =
#     the same with access ignored (the road matching graph).
#   - times: traversal seconds per profile, indexed like ROUTING_PROFILES.
# Dynamic closures and penalties stay per-request overlays keyed by the
# precomputed raw edge id.
# ---------------------------------------------------------------------------
ROUTING_PROFILES = (None, *TRUCK_PROFILES)  # index 0 = unrestricted car
_PROFILE_INDEX = {name: index for index, name in enumerate(ROUTING_PROFILES)}
_PROFILE_SPEED_CAPS = tuple(
    TRUCK_PROFILES[name]["max_speed_kmh"] if name else GLOBAL_MAX_SPEED_KMH
    for name in ROUTING_PROFILES
)


def _profile_mask_bit(truck_class, respect_access):
    index = _PROFILE_INDEX.get(truck_class, 0)
    return 1 << (index if respect_access else index + len(ROUTING_PROFILES))


def _allowed_mask(restrictions):
    mask = 0
    for index, name in enumerate(ROUTING_PROFILES):
        profile = TRUCK_PROFILES.get(name) if name else None
        if edge_allowed(restrictions, profile, True):
            mask |= 1 << index
        if edge_allowed(restrictions, profile, False):
            mask |= 1 << (index + len(ROUTING_PROFILES))
    return mask


def _profile_times(length_m, base_speed_kmh):
    return tuple(length_m / (min(base_speed_kmh, cap) * 1000 / 3600) for cap in _PROFILE_SPEED_CAPS)


# Number of nearest graph nodes considered when the closest one cannot be
# used by a vehicle (see _routable_node_set).
NEAREST_NODE_CANDIDATES = 32


def _routable_node_set(graph):
    """Nodes with at least one access-permitted edge, in either direction.

    Snapping to the plain nearest node could pick a node that only touches
    access=no/private roads (for example a busway). Every route to or from it
    is then impossible, and a route request between two ordinary points
    failed with ROUTE_NOT_FOUND after searching the whole network. Either
    direction is enough: the ends of one-way roads are valid origins or
    destinations. Built from
    the routing adjacency (both backends store allowed_mask at index 3 and the
    neighbour at index 0); bit 0 is the unrestricted car with access respected.
    """
    adjacency = graph._routing_adjacency()
    cached = getattr(graph, "_routable_nodes_cache", None)
    if cached is not None and cached[0] is adjacency:
        return cached[1]
    routable = set()
    for current, entries in adjacency.items():
        for entry in entries:
            if entry[3] & 1:
                routable.add(current)
                routable.add(entry[0])
    graph._routable_nodes_cache = (adjacency, routable)
    return routable


def _osmnx_edge_restrictions(data):
    return {
        "max_height_m": _parse_float_tag(data.get("maxheight")),
        "max_weight_t": _parse_float_tag(data.get("maxweight")),
        "max_width_m": _parse_float_tag(data.get("maxwidth")),
        "max_length_m": _parse_float_tag(data.get("maxlength")),
        "hgv": data.get("hgv"),
        "access": data.get("access"),
    }


# ---------------------------------------------------------------------------
# Backend 1: osmnx / networkx (preferred - use this when osmnx is installed)
# ---------------------------------------------------------------------------
class OsmnxGraph:
    CACHE_SUFFIX = ".graph_cache.pkl"
    # Routing refuses access=no/private roads for every vehicle; the road
    # matching graph turns this off, since a recording can be on such a road.
    ignore_access_restrictions = False

    def __init__(self, pbf_path, network_type="driving", exclude_highways=(), cache_name=None,
                 ignore_access_restrictions=False):
        import osmnx as ox
        import networkx as nx
        self.network_type = network_type
        self.ignore_access_restrictions = ignore_access_restrictions
        self.ox = ox
        self.nx = nx
        # loaded fresh every time, independent of the graph cache below -
        # turn_restrictions.json isn't baked into self.G, so updating it
        # doesn't require paying the (expensive) graph rebuild cost
        self.turn_restrictions = load_turn_restrictions()
        if self.turn_restrictions:
            print(f"Loaded {len(self.turn_restrictions)} turn restriction(s)")

        # Each pyrosm network type is a different graph, so each gets its own
        # cache; the routing graph keeps its original cache file name.
        name = cache_name or ("" if network_type == "driving" else network_type.replace("+", "_"))
        suffix = f".{name}{self.CACHE_SUFFIX}" if name else self.CACHE_SUFFIX
        cache_path = pbf_path + suffix
        if self._load_from_cache(cache_path, pbf_path):
            self._prepare_edge_metadata()
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
            network_type=network_type,
            nodes=True,
            extra_attributes=["maxheight", "maxweight", "maxwidth", "maxlength", "hgv"],
        )
        if exclude_highways:
            # pyrosm has no custom network filter, so a broad network type is
            # narrowed here by dropping the listed (walking-only) highway types.
            edges = edges[~edges["highway"].isin(set(exclude_highways))]
        # pyrosm makes every edge of a walking or "all" network two-way; a vehicle
        # graph must honour oneway whatever roads it includes, or road matching
        # drives against the traffic on a one-way carriageway. The direction rule
        # is the only thing to_graph's network_type changes.
        self.G = ox.simplify_graph(osm.to_graph(nodes, edges, graph_type="networkx", network_type="driving"))

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

        self._prepare_edge_metadata()
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

    def _prepare_edge_metadata(self):
        """Build the precomputed routing adjacency and node coords at load."""
        self._routing_adjacency()
        self._node_coords = {n: (float(data["y"]), float(data["x"])) for n, data in self.G.nodes(data=True)}
        # Build once at graph load; dragging performs many nearest-node queries.
        import numpy as np
        from sklearn.neighbors import BallTree
        self._nearest_node_ids = list(self._node_coords)
        self._nearest_node_tree = BallTree(np.radians(list(self._node_coords.values())), metric="haversine")
        _routable_node_set(self)

    def _routing_adjacency(self):
        """Return {node: [(neighbor, edge_key, attrs, allowed_mask, times,
        way_ids, raw_edge_id), ...]} for self.G, built once per graph.

        Parallel edges stay separate entries in the graph's own order, so
        turn legality is still evaluated per edge and A* tie-breaking is
        unchanged. way_ids is the edge's osmid as a tuple (a list when
        simplify_graph() merged several ways), matching turn restrictions.
        """
        G = self.G
        cached = getattr(self, "_routing_adjacency_cache", None)
        if cached is not None and cached[0] is G:
            return cached[1]
        adjacency = {}
        for current, neighbors in G.adj.items():
            entries = []
            for neighbor, parallel in neighbors.items():
                for edge_key, data in parallel.items():
                    highway = data.get("highway", "residential")
                    if isinstance(highway, list):
                        highway = highway[0]
                    osmid = data.get("osmid")
                    entries.append((
                        neighbor,
                        edge_key,
                        data,
                        _allowed_mask(_osmnx_edge_restrictions(data)),
                        _profile_times(data.get("length", 0), ROAD_SPEED_KMH.get(highway, 30)),
                        tuple(osmid) if isinstance(osmid, list) else (osmid,),
                        f"{current}:{neighbor}:{edge_key}",
                    ))
            if entries:
                adjacency[current] = entries
        self._routing_adjacency_cache = (G, adjacency)
        return adjacency

    def nearest_node(self, lat, lon):
        """Nearest node a vehicle can use; see _routable_node_set.

        The road-matching graph ignores access restrictions, so it keeps the
        plain nearest node. If none of the nearest candidates is routable,
        the nearest node is returned as before.
        """
        point = [[math.radians(lat), math.radians(lon)]]
        if getattr(self, "ignore_access_restrictions", False):
            _distances, indices = self._nearest_node_tree.query(point, k=1)
            return self._nearest_node_ids[int(indices[0][0])]
        k = min(NEAREST_NODE_CANDIDATES, len(self._nearest_node_ids))
        _distances, indices = self._nearest_node_tree.query(point, k=k)
        candidates = [self._nearest_node_ids[int(index)] for index in indices[0]]
        routable = _routable_node_set(self)
        return next((node for node in candidates if node in routable), candidates[0])

    def nearest_coords(self, lat, lon):
        """Returns [lat, lon] of the graph vertex nearest to the given point -
        used to snap a dragged marker onto the actual road network."""
        nid = self.nearest_node(lat, lon)
        return [self.G.nodes[nid]["y"], self.G.nodes[nid]["x"]]

    def nearest_road_geometry(self, lat, lon):
        node_id = self.nearest_node(lat, lon)
        if node_id is None:
            return None
        graph = self.G
        edges = list(graph.edges(node_id, keys=True, data=True))
        edges.extend(graph.in_edges(node_id, keys=True, data=True))
        candidates = []
        seen = set()
        for start_id, end_id, key, data in edges:
            identity = (start_id, end_id, key)
            if identity in seen:
                continue
            seen.add(identity)
            start = [float(graph.nodes[start_id]["y"]), float(graph.nodes[start_id]["x"])]
            end = [float(graph.nodes[end_id]["y"]), float(graph.nodes[end_id]["x"])]
            geometry = data.get("geometry")
            points = [[float(y), float(x)] for x, y in geometry.coords] if geometry is not None else [start, end]
            points = _normalise_edge_geometry(points, start, end)
            candidates.append((_polyline_distance_sq_m(lat, lon, points), points))
        if not candidates:
            return None
        points = min(candidates, key=lambda candidate: candidate[0])[1]
        return {"type": "LineString", "coordinates": [[point[1], point[0]] for point in points]}

    def route(self, start_id, goal_id, truck_class=None, blocked_edge_ids=None, penalty_edge_factors=None, avoid_initial_reverse_of_edge_id=None, cancel_event=None,
              initial_incoming_ways=None, stats=None):
        # Hand-rolled edge-state A* instead of nx.astar_path. A node-only
        # search can discard a longer arrival at a junction even though its
        # incoming way permits a turn that the shorter arrival forbids. Keep
        # the incoming way(s) in the search state so a dynamic closure cannot
        # turn an otherwise reachable destination into a false no-route.
        # Only via nodes of a turn restriction need that context; every
        # other node keeps a single (node, None) state.
        import heapq
        from itertools import count

        G = self.G
        blocked_lookup = _prepare_overlay_ids(blocked_edge_ids)
        penalty_lookup = _prepare_overlay_values(penalty_edge_factors)
        reverse_from, reverse_to = _initial_reverse_nodes(avoid_initial_reverse_of_edge_id) or (None, None)
        turns_by_via = _turn_restriction_index(self)
        adjacency = self._routing_adjacency()

        respect_access = not getattr(self, "ignore_access_restrictions", False)
        profile_index = _PROFILE_INDEX.get(truck_class, 0)
        profile_bit = _profile_mask_bit(truck_class, respect_access)
        max_speed_mps = _PROFILE_SPEED_CAPS[profile_index] * 1000 / 3600
        has_overlay = bool(blocked_lookup or penalty_lookup)

        _node_coords = getattr(self, '_node_coords', None)
        if _node_coords is None:
            _node_coords = {n: (float(d["y"]), float(d["x"])) for n, d in G.nodes.items()}
        goal_lat, goal_lon = _node_coords[goal_id]

        def h(n):
            y1, x1 = _node_coords[n]
            return haversine_m(y1, x1, goal_lat, goal_lon) / max_speed_mps

        start_ways = tuple(initial_incoming_ways) if initial_incoming_ways and start_id in turns_by_via else None
        start_state = (start_id, start_ways)
        push_order = count()
        open_set = [(h(start_id), 0.0, next(push_order), start_state)]
        # came_from[state] = (previous_state, dist_m, edge_data,
        #                     way_ids_of_this_edge, edge_key, edge_time)
        came_from = {}
        g_score = {start_state: 0.0}
        goal_state = None
        # Search counters for timing logs; local ints keep the loop cheap.
        expanded = stale_pops = pushes = blocked_hits = 0

        def record_stats():
            if stats is not None:
                stats.update(expanded=expanded, stalePops=stale_pops, heapPushes=pushes,
                             blockedEdgeHits=blocked_hits, found=goal_state is not None)

        while open_set:
            if cancel_event is not None and cancel_event.is_set():
                record_stats()
                return None
            _f, g, _order, state = heapq.heappop(open_set)
            current, incoming_osmids = state
            if g > g_score.get(state, float("inf")):
                stale_pops += 1
                continue
            if current == goal_id:
                goal_state = state
                break
            expanded += 1
            # Incoming ways are kept only at via nodes, so a non-None value
            # always has a turn table.
            turn_table = turns_by_via[current] if incoming_osmids is not None else None
            avoid_reverse = state == start_state and reverse_from is not None and str(current) == reverse_from
            # Parallel edges are separate entries: evaluate turn legality per
            # edge. Selecting the fastest edge before this check can discard
            # a slower edge whose way is the only legal continuation.
            for neighbor, edge_key, attrs, allowed_mask, times, way_ids, raw_edge_id in adjacency.get(current, ()):
                if not allowed_mask & profile_bit:
                    continue
                if avoid_reverse and str(neighbor) == reverse_to:
                    continue
                if has_overlay:
                    if raw_edge_id in blocked_lookup:
                        blocked_hits += 1
                        continue
                    penalty = max(1.0, float(penalty_lookup.get(raw_edge_id, 1.0)))
                else:
                    penalty = 1.0
                if turn_table is not None and any(
                    (fw, tw) in turn_table
                    for fw in incoming_osmids for tw in way_ids
                ):
                    continue  # illegal turn (from incoming way, via current, onto this way)
                edge_time = times[profile_index] * penalty
                tentative = g + edge_time
                next_state = (neighbor, way_ids if neighbor in turns_by_via else None)
                if tentative < g_score.get(next_state, float("inf")):
                    g_score[next_state] = tentative
                    came_from[next_state] = (state, attrs.get("length", 0), attrs, way_ids, edge_key, edge_time)
                    heapq.heappush(open_set, (tentative + h(neighbor), tentative, next(push_order), next_state))
                    pushes += 1

        record_stats()
        if goal_state is None:
            return None  # no path exists under this profile's constraints (or at all)

        # Walk back through state transitions, collecting each edge's
        # (distance, edge_data, arrival_node, departure_node).
        edges = []
        state = goal_state
        while state != start_state:
            prev_state, dist_m, edge_data, way_ids, edge_key, edge_time = came_from[state]
            edges.append((dist_m, edge_data, state[0], prev_state[0], edge_key, edge_time, way_ids))
            state = prev_state
        edges.reverse()  # now in start -> goal order
        final_incoming_ways = edges[-1][6] if edges else start_ways

        # Stitch the real road curve, not straight chords between nodes.
        # osmnx keeps the original shape points as a shapely `geometry` on
        # each edge when simplify=True collapsed intermediate nodes; use it
        # when present, otherwise fall back to a straight line for that edge.
        coords = [list(_node_coords[start_id])]
        distance_m = 0.0
        time_s = 0.0
        edge_ids, edge_lengths, edge_times, physical_ids = [], [], [], []
        for dist_m, edge_data, to_node, from_node, edge_key, edge_time, _way_ids in edges:
            distance_m += dist_m
            time_s += edge_time
            edge_ids.append(f"{from_node}:{to_node}:{edge_key}")
            osmids = edge_data.get("osmid", edge_key)
            physical_ids.append(str(osmids[0] if isinstance(osmids, list) and osmids else osmids))
            edge_lengths.append(dist_m)
            edge_times.append(edge_time)
            geom = edge_data.get("geometry")
            if geom is not None:
                # shapely LineString coords are (x, y) i.e. (lon, lat) - flip to [lat, lon]
                pts = [[lat, lon] for lon, lat in geom.coords]
                _append_edge_geometry(
                    coords,
                    pts,
                    list(_node_coords[from_node]),
                    list(_node_coords[to_node]),
                )
            else:
                _append_edge_geometry(
                    coords,
                    [],
                    list(_node_coords[from_node]),
                    list(_node_coords[to_node]),
                )
        return RouteResult(coords, distance_m, time_s, edge_ids, edge_lengths, edge_times, physical_ids,
                           final_incoming_ways)


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
        self._routing_adjacency()
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

    def _routing_adjacency(self):
        """Return {node: [(neighbor, dist_m, geom, allowed_mask, times,
        way_ids, raw_edge_id), ...]} for self.adjacency, built once."""
        source = self.adjacency
        cached = getattr(self, "_routing_adjacency_cache", None)
        if cached is not None and cached[0] is source:
            return cached[1]
        adjacency = {}
        for current, edges in source.items():
            entries = [
                (neighbor, dist_m, geom, _allowed_mask(restrictions), _profile_times(dist_m, base_speed),
                 (wid,), f"{current}:{neighbor}:{wid}")
                for neighbor, dist_m, base_speed, geom, restrictions, wid in edges
            ]
            if entries:
                adjacency[current] = entries
        self._routing_adjacency_cache = (source, adjacency)
        return adjacency

    def nearest_node(self, lat, lon):
        """Nearest node a vehicle can use (see _routable_node_set), else the
        nearest node; the road-matching graph ignores access and keeps the
        plain nearest node."""
        routable = None if getattr(self, "ignore_access_restrictions", False) else _routable_node_set(self)
        best, best_d = None, float("inf")
        best_routable, best_routable_d = None, float("inf")
        gx, gy = int(lat / self.grid_size), int(lon / self.grid_size)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for vid in self.grid.get((gx + dx, gy + dy), []):
                    vlat, vlon = self.coords[vid]
                    d = (vlat - lat) ** 2 + (vlon - lon) ** 2
                    if d < best_d:
                        best_d, best = d, vid
                    if routable is not None and vid in routable and d < best_routable_d:
                        best_routable_d, best_routable = d, vid
        return best_routable if best_routable is not None else best

    def nearest_coords(self, lat, lon):
        """Returns [lat, lon] of the graph vertex nearest to the given point -
        used to snap a dragged marker onto the actual road network."""
        nid = self.nearest_node(lat, lon)
        if nid is None:
            return None
        return list(self.coords[nid])

    def nearest_road_geometry(self, lat, lon):
        node_id = self.nearest_node(lat, lon)
        if node_id is None:
            return None
        candidates = []
        for neighbor, _distance, _speed, geometry, _restrictions, _way_id in self.adjacency.get(node_id, []):
            points = geometry or [self.coords[node_id], self.coords[neighbor]]
            candidates.append((_polyline_distance_sq_m(lat, lon, points), points))
        if not candidates:
            return None
        points = min(candidates, key=lambda candidate: candidate[0])[1]
        return {"type": "LineString", "coordinates": [[point[1], point[0]] for point in points]}

    def route(self, start_id, goal_id, truck_class=None, blocked_edge_ids=None, penalty_edge_factors=None, avoid_initial_reverse_of_edge_id=None, cancel_event=None,
              initial_incoming_ways=None, stats=None):
        import heapq
        from itertools import count
        coords = self.coords
        blocked_lookup = _prepare_overlay_ids(blocked_edge_ids)
        penalty_lookup = _prepare_overlay_values(penalty_edge_factors)
        reverse_from, reverse_to = _initial_reverse_nodes(avoid_initial_reverse_of_edge_id) or (None, None)
        # The incoming way is part of the search state only at via nodes of
        # a turn restriction; see _turn_restriction_index.
        turns_by_via = _turn_restriction_index(self)
        adjacency = self._routing_adjacency()

        respect_access = not getattr(self, "ignore_access_restrictions", False)
        profile_index = _PROFILE_INDEX.get(truck_class, 0)
        profile_bit = _profile_mask_bit(truck_class, respect_access)
        max_speed_mps = _PROFILE_SPEED_CAPS[profile_index] * 1000 / 3600
        has_overlay = bool(blocked_lookup or penalty_lookup)

        def h(n):
            # admissible lower-bound time estimate: straight-line distance
            # divided by the FASTEST this specific profile could ever go -
            # tighter (and still valid) per truck class, since a capped-speed
            # truck can never beat its own cap even on an open motorway
            lat1, lon1 = coords[n]
            lat2, lon2 = coords[goal_id]
            return haversine_m(lat1, lon1, lat2, lon2) / max_speed_mps

        start_ways = tuple(initial_incoming_ways) if initial_incoming_ways and start_id in turns_by_via else None
        start_state = (start_id, start_ways)
        push_order = count()
        open_set = [(h(start_id), 0.0, next(push_order), start_state)]
        # came_from[state] stores (previous_state, dist_m,
        # geometry_of_this_edge, way_id_of_this_edge, edge_time) so we can
        # stitch the real road curve and preserve turn context.
        came_from = {}
        g_score = {start_state: 0.0}
        goal_state = None
        # Search counters for timing logs; local ints keep the loop cheap.
        expanded = stale_pops = pushes = blocked_hits = 0

        def record_stats():
            if stats is not None:
                stats.update(expanded=expanded, stalePops=stale_pops, heapPushes=pushes,
                             blockedEdgeHits=blocked_hits, found=goal_state is not None)

        while open_set:
            if cancel_event is not None and cancel_event.is_set():
                record_stats()
                return None
            _f, g, _order, state = heapq.heappop(open_set)
            current, incoming_ways = state
            if g > g_score.get(state, float("inf")):
                stale_pops += 1
                continue
            if current == goal_id:
                goal_state = state
                break
            expanded += 1
            turn_table = turns_by_via[current] if incoming_ways is not None else None
            avoid_reverse = state == start_state and reverse_from is not None and str(current) == reverse_from
            for neighbor, dist_m, geom, allowed_mask, times, way_ids, raw_edge_id in adjacency.get(current, ()):
                if not allowed_mask & profile_bit:
                    continue  # this truck class physically/legally cannot use this road
                if avoid_reverse and str(neighbor) == reverse_to:
                    continue
                wid = way_ids[0]
                if turn_table is not None and any((fw, wid) in turn_table for fw in incoming_ways):
                    continue  # illegal turn (from the incoming way, via current, onto wid)
                if has_overlay:
                    if raw_edge_id in blocked_lookup:
                        blocked_hits += 1
                        continue
                    penalty = max(1.0, float(penalty_lookup.get(raw_edge_id, 1.0)))
                else:
                    penalty = 1.0
                edge_time = times[profile_index] * penalty
                tentative = g + edge_time
                next_state = (neighbor, way_ids if neighbor in turns_by_via else None)
                if tentative < g_score.get(next_state, float("inf")):
                    g_score[next_state] = tentative
                    came_from[next_state] = (state, dist_m, geom, wid, edge_time)
                    heapq.heappush(open_set, (tentative + h(neighbor), tentative, next(push_order), next_state))
                    pushes += 1

        record_stats()
        if goal_state is None:
            return None  # no path exists under this profile's constraints (or at all)

        # Walk back through state transitions, collecting each edge's
        # (distance, real-curve geometry).
        edges = []
        state = goal_state
        while state != start_state:
            prev_state, dist_m, geom, wid, edge_time = came_from[state]
            edges.append((dist_m, geom, prev_state[0], state[0], wid, edge_time))
            state = prev_state
        edges.reverse()  # now in start -> goal order
        final_incoming_ways = (edges[-1][4],) if edges else start_ways

        coords_out = [list(coords[start_id])]
        distance_m = 0.0
        edge_ids, edge_lengths, edge_times, physical_ids = [], [], [], []
        for dist_m, geom, prev, current, wid, edge_time in edges:
            distance_m += dist_m
            edge_ids.append(f"{prev}:{current}:{wid}")
            physical_ids.append(str(wid))
            edge_lengths.append(dist_m)
            edge_times.append(edge_time)
            _append_edge_geometry(coords_out, geom, coords[prev], coords[current])

        return RouteResult(coords_out, distance_m, g_score[goal_state], edge_ids, edge_lengths, edge_times, physical_ids,
                           final_incoming_ways)


def load_graph(pbf_path):
    requested_backend = os.environ.get("ROUTING_GRAPH_BACKEND", "auto").strip().lower()
    if requested_backend not in {"auto", "osmnx", "pure", "fallback"}:
        raise ValueError("ROUTING_GRAPH_BACKEND must be one of: auto, osmnx, pure")
    if requested_backend in {"pure", "fallback"}:
        print("Using explicitly selected pure-Python routing backend")
        return PurePythonGraph(pbf_path)
    try:
        import osmnx  # noqa: F401
        import pyrosm  # noqa: F401 - actually reads the .pbf; osmnx alone can't
        print("Using osmnx (via pyrosm) backend")
        return OsmnxGraph(pbf_path)
    except ImportError as e:
        if requested_backend == "osmnx":
            raise RuntimeError(
                "ROUTING_GRAPH_BACKEND=osmnx requires the routing extra; "
                "run 'uv sync --extra osmnx'"
            ) from e
        print(f"{e.name} not found - using bundled pure-Python fallback")
        return PurePythonGraph(pbf_path)


# Highway types no vehicle drives on. The road matching graph keeps every
# other way - service roads, parking aisles and private (campus, apartment)
# roads included - so a recording is matched where it actually drove.
NON_DRIVABLE_HIGHWAYS = (
    "footway", "path", "pedestrian", "steps", "cycleway", "bridleway", "corridor",
    "elevator", "escalator", "platform", "proposed", "construction", "abandoned",
    "raceway", "via_ferrata",
)


def load_match_graph(pbf_path):
    """Road graph for GPS road matching, separate from the routing graph.

    pyrosm's "driving" network (the routing graph) drops highway=service
    roads, parking aisles and private roads, so recordings on campus roads or
    in car parks could not be matched. The matching graph takes pyrosm's "all"
    network minus NON_DRIVABLE_HIGHWAYS, and lets its bridging routes use
    access=private roads. The routing graph is unchanged, so truck routes are
    never sent through those roads. The pure-Python backend already keeps
    service and private roads; it gets the same private-access setting.
    """
    requested_backend = os.environ.get("ROUTING_GRAPH_BACKEND", "auto").strip().lower()
    if requested_backend not in {"pure", "fallback"}:
        try:
            import osmnx  # noqa: F401
            import pyrosm  # noqa: F401
            print("Using osmnx (via pyrosm) all-drivable graph for road matching")
            return OsmnxGraph(pbf_path, network_type="all", exclude_highways=NON_DRIVABLE_HIGHWAYS,
                              cache_name="road_match_oneway", ignore_access_restrictions=True)
        except ImportError:
            pass
    print("Using pure-Python graph for road matching")
    graph = PurePythonGraph(pbf_path)
    graph.ignore_access_restrictions = True
    return graph
