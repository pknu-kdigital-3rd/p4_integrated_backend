"""
FastAPI backend for interactive A* routing over an OSM PBF road network.

Run:
    pip install fastapi uvicorn osmnx networkx   # osmnx optional (see graph_backend.py)
    uvicorn main:app --reload

Then open http://127.0.0.1:8000
"""
import hashlib
import os
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from graph_backend import load_graph, TRUCK_PROFILES, get_override_locations
from hybrid_bus import HybridBusService, load_route_ids
from telemetry import (
    BimsLiveSource,
    BimsPlaybackSource,
    CompositeTelemetrySource,
    DeviceRelaySource,
    VehicleTracker,
)

PROJECT_DIR = Path(__file__).resolve().parent
PBF_PATH = "busan-roads_osm.pbf"  # <-- point this at your .pbf file
ROUTING_SERVICE_TOKEN = os.environ.get("ROUTING_TRACKING_SERVICE_TOKEN", "").strip()


def _first_existing_path(*paths: Path) -> Path:
    for path in paths:
        if path.exists():
            return path
    return paths[0]


# Prefer the sibling collector's completed history, then its raw observations,
# while retaining local defaults for deployments that copy only this project.
COLLECTOR_DATA_DIR = PROJECT_DIR.parent / "busan-bus-collector" / "data"
LOCAL_DATA_DIR = PROJECT_DIR / "data"
BUS_HISTORY_PATH = Path(os.environ.get(
    "BUSAN_BUS_HISTORY_PATH",
    str(_first_existing_path(
        COLLECTOR_DATA_DIR / "busan_bus_history.csv",
        LOCAL_DATA_DIR / "busan_bus_history.csv",
        COLLECTOR_DATA_DIR / "busan_bus_gps.csv",
        LOCAL_DATA_DIR / "busan_bus_gps.csv",
    )),
))
BUS_ROUTE_METADATA_PATH = Path(os.environ.get(
    "BUSAN_BUS_ROUTES_PATH",
    str(_first_existing_path(
        COLLECTOR_DATA_DIR / "busan_bus_routes.json",
        LOCAL_DATA_DIR / "busan_bus_routes.json",
    )),
))
BUS_HYBRID_PATH = Path(os.environ.get(
    "BUSAN_BUS_HYBRID_PATH",
    str(LOCAL_DATA_DIR / "busan_bus_hybrid.csv"),
))
BUS_RAW_PATH = Path(os.environ.get(
    "BUSAN_BUS_RAW_PATH",
    str(LOCAL_DATA_DIR / "busan_bus_live.csv"),
))
# Android/device GPS current state comes from the media relay; it is merged
# with the BIMS source and never replaces it.
MEDIA_RELAY_INTERNAL_BASE_URL = os.environ.get("MEDIA_RELAY_INTERNAL_BASE_URL", "http://127.0.0.1:39012")
DEVICE_TELEMETRY_TIMEOUT_S = float(os.environ.get("DEVICE_TELEMETRY_TIMEOUT_S", "1.0"))

app = FastAPI(title="A* Route API")

# Graph and override-location list are computed once at startup and kept
# in memory for all requests
graph = None
override_locations = []
hybrid_bus_service: HybridBusService | None = None
vehicle_tracker: VehicleTracker | None = None


@app.get("/health/live")
def health_live():
    return {"status": "ok"}


@app.get("/health/ready")
def health_ready():
    if graph is None or vehicle_tracker is None:
        raise HTTPException(status_code=503, detail="Routing/tracking service is not ready")
    return {"status": "ready", "graph": "ok", "telemetry": "ok"}


@app.on_event("startup")
def startup():
    global graph, override_locations, hybrid_bus_service, vehicle_tracker
    print(f"Loading graph from {PBF_PATH} ...")
    graph = load_graph(PBF_PATH)
    override_locations = get_override_locations(PBF_PATH)
    route_ids = load_route_ids(BUS_ROUTE_METADATA_PATH)
    hybrid_bus_service = HybridBusService.from_environment(
        service_key=os.environ.get("BUSAN_BIMS_SERVICE_KEY"),
        history_path=BUS_HISTORY_PATH,
        output_path=BUS_HYBRID_PATH,
        raw_path=BUS_RAW_PATH,
        line_ids=route_ids,
        line_ids_json=os.environ.get("BUSAN_BUS_LINE_IDS", ""),
    )
    hybrid_bus_service.start()
    if os.environ.get("TELEMETRY_MODE", "live").lower() == "playback":
        hybrid_bus_service.stop()
        bims_source = BimsPlaybackSource(BUS_HISTORY_PATH)
    else:
        bims_source = BimsLiveSource(hybrid_bus_service)
    vehicle_tracker = VehicleTracker(CompositeTelemetrySource(
        bims_source,
        DeviceRelaySource(MEDIA_RELAY_INTERNAL_BASE_URL, timeout=DEVICE_TELEMETRY_TIMEOUT_S),
    ))
    print(f"Graph loaded and ready. {len(override_locations)} manual override location(s) found.")


@app.on_event("shutdown")
def shutdown():
    if hybrid_bus_service is not None:
        hybrid_bus_service.stop()


class RouteRequest(BaseModel):
    start_lat: float
    start_lon: float
    end_lat: float
    end_lon: float
    truck_class: str | None = None  # None/"car" = unrestricted; else "small"/"semi"


class NearestRequest(BaseModel):
    lat: float
    lon: float


class InternalCoordinate(BaseModel):
    lat: float
    lon: float


class InternalWaypoint(InternalCoordinate):
    clientId: str | None = None


class InternalRouteRequest(BaseModel):
    origin: InternalCoordinate
    destination: InternalCoordinate
    waypoints: list[InternalWaypoint] = []
    vehicleProfile: str = "car"
    blockedEdgeIds: list[str] = []
    penaltyEdgeFactors: dict[str, float] = {}


class RestrictionResolveRequest(BaseModel):
    geometry: dict
    penaltyFactor: float | None = None


class SnapRequest(InternalCoordinate):
    vehicleProfile: str = "car"


def require_internal_token(authorization: str | None = Header(default=None)):
    """Keep the internal routing facade private when a service token is set.

    Local development intentionally leaves the variable empty, which preserves
    the existing single-host setup while production deployments can put this
    endpoint behind the same shared-secret boundary as the Node service.
    """
    if ROUTING_SERVICE_TOKEN and authorization != f"Bearer {ROUTING_SERVICE_TOKEN}":
        raise HTTPException(status_code=401, detail="Invalid routing service token")


def _graph_version() -> str:
    """Return a stable fingerprint for the graph and static restriction files."""
    candidates = [Path(PBF_PATH), PROJECT_DIR / "gov_restrictions.json", PROJECT_DIR / "manual_restrictions.json", PROJECT_DIR / "turn_restrictions.json"]
    digest = hashlib.sha256()
    for path in candidates:
        try:
            stat = path.stat()
            digest.update(str(path.resolve()).encode())
            digest.update(str(stat.st_size).encode())
            digest.update(str(stat.st_mtime_ns).encode())
        except FileNotFoundError:
            digest.update(str(path).encode())
    return digest.hexdigest()[:32]


def _internal_route(req: InternalRouteRequest):
    if graph is None:
        raise HTTPException(status_code=503, detail="Routing graph is not ready")
    profile = None if req.vehicleProfile in ("", "car", "unrestricted") else req.vehicleProfile
    if profile is not None and profile not in TRUCK_PROFILES:
        raise HTTPException(status_code=422, detail=f"Unknown vehicle profile: {profile}")
    stops = [req.origin, *req.waypoints, req.destination]
    route_coords: list[list[float]] = []
    directed_itinerary: list[dict] = []
    distance_m = 0.0
    duration_s = 0.0
    snapped_stops: list[dict] = []
    graph_version = _graph_version()
    for index, stop in enumerate(stops):
        node_id = graph.nearest_node(stop.lat, stop.lon)
        if node_id is None:
            raise HTTPException(status_code=422, detail={"code": "POINT_TOO_FAR_FROM_ROAD", "stopIndex": index})
        snapped = graph.nearest_coords(stop.lat, stop.lon)
        snapped_stops.append({
            "clientId": getattr(stop, "clientId", None),
            "lat": snapped[0] if snapped else stop.lat,
            "lon": snapped[1] if snapped else stop.lon,
            "nodeId": str(node_id),
        })
        if index == 0:
            continue
        previous = stops[index - 1]
        previous_node = graph.nearest_node(previous.lat, previous.lon)
        result = graph.route(
            previous_node,
            node_id,
            truck_class=profile,
            blocked_edge_ids=req.blockedEdgeIds,
            penalty_edge_factors=req.penaltyEdgeFactors,
        )
        if result is None:
            raise HTTPException(status_code=422, detail={"code": "ROUTE_NOT_FOUND", "stopIndex": index})
        coords = result.coords
        if route_coords and coords:
            route_coords.extend(coords[1:])
        else:
            route_coords.extend(coords)
        distance_m += result.distance_m
        duration_s += result.time_s
        # Adapter edge IDs are graph-version scoped at this boundary so a
        # route snapshot cannot accidentally be applied to a rebuilt graph.
        for edge_index, raw_edge_id in enumerate(getattr(result, "edge_ids", [])):
            edge_id = f"{graph_version}:{raw_edge_id}"
            directed_itinerary.append({
                "edgeId": edge_id,
                "physicalSegmentId": f"{graph_version}:{(result.physical_ids[edge_index] if edge_index < len(result.physical_ids) else raw_edge_id.rsplit(':', 1)[-1])}",
                "fromNodeId": None,
                "toNodeId": None,
                "lengthM": (result.edge_lengths[edge_index] if edge_index < len(result.edge_lengths) else 0.0),
                "cumulativeStartM": distance_m - result.distance_m + sum(result.edge_lengths[:edge_index]),
            })
    if not route_coords:
        route_coords = [[req.origin.lon, req.origin.lat], [req.destination.lon, req.destination.lat]]
    # GeoJSON is [lon, lat], while the legacy graph adapters return [lat, lon].
    geojson_coords = [[point[1], point[0]] for point in route_coords]
    warnings = []
    if (req.blockedEdgeIds or req.penaltyEdgeFactors) and not directed_itinerary:
        warnings.append("Dynamic road-state overlay could not match an edge in this graph build")
    return {
        "graphVersion": graph_version,
        "routeGeojson": {"type": "LineString", "coordinates": geojson_coords},
        "directedItinerary": directed_itinerary,
        "snappedStops": snapped_stops,
        "distanceM": distance_m,
        "durationSec": duration_s,
        "warnings": warnings,
    }


def _geometry_vertices(geometry: dict) -> list[tuple[float, float]]:
    coordinates = geometry.get("coordinates", [])
    if geometry.get("type") == "Polygon":
        rings = coordinates[:1]
    elif geometry.get("type") == "MultiPolygon":
        rings = [ring for polygon in coordinates for ring in polygon[:1]]
    else:
        raise HTTPException(status_code=422, detail="Restriction geometry must be Polygon or MultiPolygon")
    vertices = []
    for ring in rings:
        for pair in ring:
            if isinstance(pair, list) and len(pair) >= 2:
                vertices.append((float(pair[0]), float(pair[1])))
    if len(vertices) < 3:
        raise HTTPException(status_code=422, detail="Restriction polygon is degenerate")
    return vertices


def _graph_edge_records():
    """Yield (raw directed id, physical id, [(lat, lon), ...]) records."""
    if graph is None:
        return
    if hasattr(graph, "G"):
        for u, v, key, data in graph.G.edges(keys=True, data=True):
            geometry = data.get("geometry")
            if geometry is not None:
                coords = [(float(lat), float(lon)) for lon, lat in geometry.coords]
            else:
                coords = [(float(graph.G.nodes[u]["y"]), float(graph.G.nodes[u]["x"])), (float(graph.G.nodes[v]["y"]), float(graph.G.nodes[v]["x"]))]
            osmid = data.get("osmid", key)
            physical = str(osmid[0] if isinstance(osmid, list) and osmid else osmid)
            yield f"{u}:{v}:{key}", physical, coords
        return
    for source, edges in getattr(graph, "adjacency", {}).items():
        for target, _distance, _speed, geometry, _restrictions, way_id in edges:
            yield f"{source}:{target}:{way_id}", str(way_id), [(float(point[0]), float(point[1])) for point in geometry]


def _edge_intersects_polygon(coords, geometry):
    try:
        from shapely.geometry import LineString, shape
        return LineString([(lon, lat) for lat, lon in coords]).intersects(shape(geometry))
    except (ImportError, ValueError, TypeError):
        vertices = _geometry_vertices(geometry)
        min_lon = min(point[0] for point in vertices)
        max_lon = max(point[0] for point in vertices)
        min_lat = min(point[1] for point in vertices)
        max_lat = max(point[1] for point in vertices)
        return any(min_lat <= lat <= max_lat and min_lon <= lon <= max_lon for lat, lon in coords)


@app.get("/api/buses/info")
def get_bus_feed_info():
    """Return BIMS configuration, history readiness, and health."""
    if hybrid_bus_service is None:
        return {"available": False, "lines": [], "sample_count": 0}
    return hybrid_bus_service.info()


@app.get("/api/buses")
def get_buses():
    """Return the current one-bus-per-line live/interpolated snapshot."""
    if hybrid_bus_service is None:
        return {"generated_at_utc": None, "vehicles": [], "warnings": []}
    return hybrid_bus_service.snapshot()


@app.get("/internal/vehicles")
def get_vehicles():
    """Normalized source-neutral snapshot used by the Node control facade."""
    if vehicle_tracker is None:
        return {"generated_at_utc": None, "vehicles": [], "warnings": []}
    return vehicle_tracker.snapshot()


@app.get("/internal/vehicles/{external_id}")
def get_vehicle(external_id: str):
    snapshot = get_vehicles()
    vehicle = next((item for item in snapshot["vehicles"] if item["external_id"] == external_id), None)
    if vehicle is None:
        raise HTTPException(status_code=404, detail="Vehicle telemetry not found")
    return vehicle


@app.get("/internal/telemetry/status")
def telemetry_status():
    return {"mode": os.environ.get("TELEMETRY_MODE", "live").lower(), "available": vehicle_tracker is not None}


@app.get("/api/truck-classes")
def get_truck_classes():
    """Lets the frontend build its toggle UI from the same source of truth
    the backend routes against, instead of duplicating the numbers in JS."""
    return {
        "car": {"label": "Car (no restrictions)"},
        **{k: {"label": v["label"]} for k, v in TRUCK_PROFILES.items()},
    }


@app.get("/api/override-locations")
def get_override_locations_endpoint(
    min_lat: float | None = None,
    max_lat: float | None = None,
    min_lon: float | None = None,
    max_lon: float | None = None,
    limit: int = 500,
):
    """Locations from gov_restrictions.json/manual_restrictions.json with
    their real map coordinates resolved, plus verification status - for the
    frontend to plot as markers so you can see at a glance which candidate
    locations still need someone to go check Roadview and fill in a real
    measured value.

    There are thousands of these (6,700+ after the government width-data
    ingestion), so the frontend only ever calls this when the user
    explicitly turns markers on, scoped to the current map viewport via the
    bbox params - a single request should never have to carry the whole
    dataset. `limit` is a second safety net on top of that (still plenty of
    markers even at a zoomed-out viewport) so one request can't return an
    unbounded number of markers regardless of how big the bbox is. Bbox
    omitted -> no spatial filtering (kept for scripts/tools that want
    everything, not used by the map UI itself)."""
    locations = override_locations
    if None not in (min_lat, max_lat, min_lon, max_lon):
        locations = [
            loc for loc in locations
            if min_lat <= loc["lat"] <= max_lat and min_lon <= loc["lon"] <= max_lon
        ]
    return locations[:limit]


@app.post("/api/nearest")
def get_nearest(req: NearestRequest):
    """Returns the road-network vertex closest to a clicked/dragged point,
    so the frontend can snap the marker onto the actual road."""
    coords = graph.nearest_coords(req.lat, req.lon)
    if coords is None:
        raise HTTPException(status_code=404, detail="No road network found near this point")
    return {"lat": coords[0], "lon": coords[1]}


@app.post("/api/route")
def get_route(req: RouteRequest):
    start_id = graph.nearest_node(req.start_lat, req.start_lon)
    goal_id = graph.nearest_node(req.end_lat, req.end_lon)
    if start_id is None or goal_id is None:
        raise HTTPException(status_code=404, detail="No road network found near the clicked points")

    truck_class = req.truck_class if req.truck_class and req.truck_class != "car" else None
    result = graph.route(start_id, goal_id, truck_class=truck_class)
    if result is None:
        detail = (
            f"No route exists for a {TRUCK_PROFILES[truck_class]['label'].lower()} "
            "between these points (height/weight/width/length restrictions block every path)"
            if truck_class else
            "No path exists between these points"
        )
        raise HTTPException(status_code=404, detail=detail)

    return {
        "coords": result.coords,          # [[lat, lon], ...] for drawing the polyline
        "distance_km": round(result.distance_m / 1000, 3),
        "time_min": round(result.time_s / 60, 2),
        "num_nodes": len(result.coords),
        "truck_class": truck_class or "car",
    }


@app.get("/internal/routing/graph-version", dependencies=[Depends(require_internal_token)])
def internal_graph_version():
    return {"graphVersion": _graph_version()}


@app.post("/internal/routing/snap", dependencies=[Depends(require_internal_token)])
def internal_snap(req: SnapRequest):
    if graph is None:
        raise HTTPException(status_code=503, detail="Routing graph is not ready")
    node_id = graph.nearest_node(req.lat, req.lon)
    coords = graph.nearest_coords(req.lat, req.lon) if node_id is not None else None
    if node_id is None or coords is None:
        raise HTTPException(status_code=422, detail={"code": "POINT_TOO_FAR_FROM_ROAD"})
    return {"graphVersion": _graph_version(), "nodeId": str(node_id), "lat": coords[0], "lon": coords[1], "distanceM": 0.0}


@app.post("/internal/routing/route", dependencies=[Depends(require_internal_token)])
def internal_route(req: InternalRouteRequest):
    return _internal_route(req)


@app.post("/internal/routing/road-restrictions/resolve", dependencies=[Depends(require_internal_token)])
def internal_resolve_restriction(req: RestrictionResolveRequest):
    """Resolve full directed graph arcs touched by a scenario polygon."""
    _geometry_vertices(req.geometry)
    graph_version = _graph_version()
    directed, physical = [], []
    for raw_id, physical_id, coords in _graph_edge_records():
        if _edge_intersects_polygon(coords, req.geometry):
            directed.append(f"{graph_version}:{raw_id}")
            physical.append(f"{graph_version}:{physical_id}")
    # Stable de-duplication keeps payloads small for OSM ways containing many
    # parallel arcs while retaining every directed traversal.
    directed = list(dict.fromkeys(directed))
    physical = list(dict.fromkeys(physical))
    return {
        "graphVersion": graph_version,
        "affectedDirectedEdgeIds": directed,
        "affectedPhysicalSegmentIds": physical,
        "occupiedCandidateEdges": [],
    }


# Serve the frontend (index.html + any static assets)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
