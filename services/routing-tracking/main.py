"""
FastAPI backend for interactive A* routing over an OSM PBF road network.

Run:
    pip install fastapi uvicorn osmnx networkx   # osmnx optional (see graph_backend.py)
    uvicorn main:app --reload

Then open http://127.0.0.1:8000
"""
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from graph_backend import load_graph, TRUCK_PROFILES, get_override_locations
from hybrid_bus import HybridBusService, load_route_ids
from telemetry import BimsLiveSource, BimsPlaybackSource, VehicleTracker

PROJECT_DIR = Path(__file__).resolve().parent
PBF_PATH = "busan-roads_osm.pbf"  # <-- point this at your .pbf file


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

app = FastAPI(title="A* Route API")

# Graph and override-location list are computed once at startup and kept
# in memory for all requests
graph = None
override_locations = []
hybrid_bus_service: HybridBusService | None = None
vehicle_tracker: VehicleTracker | None = None


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
        vehicle_tracker = VehicleTracker(BimsPlaybackSource(BUS_HISTORY_PATH))
    else:
        vehicle_tracker = VehicleTracker(BimsLiveSource(hybrid_bus_service))
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


# Serve the frontend (index.html + any static assets)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
