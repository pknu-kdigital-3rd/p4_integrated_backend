# A* route explorer (FastAPI + Leaflet)

Click two points on a map of Busan and get a real A*-computed route,
solved server-side in Python.

For a detailed Korean description of the project, system architecture,
data collection/usage flow, limitations, and improvement roadmap, see
[`docs/PROJECT_OVERVIEW_KO.md`](docs/PROJECT_OVERVIEW_KO.md).

## Run it (with uv)

```bash
# base install - uses the pure-Python fallback parser, no compiled deps
uv sync
uv run uvicorn main:app --reload

# OR: install with the osmnx extra for the full graph + real networkx A*
uv sync --extra osmnx
uv run uvicorn main:app --reload
```

`uv sync` creates a `.venv/` and a `uv.lock` lockfile the first time you run
it. After that, `uv run` always uses that locked environment - no need to
activate a venv manually.

Then open http://127.0.0.1:8000 in a browser.

### Without uv (plain pip)

```bash
pip install .            # or: pip install -e ".[osmnx]"
uvicorn main:app --reload
```

## How it works

- **`main.py`** - FastAPI app. Loads the road graph once at startup,
  exposes `POST /api/route` which takes `{start_lat, start_lon, end_lat, end_lon}`
  and returns the A* path as `{coords, distance_km, time_min, num_nodes}`.
  Serves the frontend from `static/`.
- **`graph_backend.py`** - loads `busan-roads_osm.pbf` and builds the routable
  graph. Automatically uses `osmnx`/`networkx` if installed (recommended -
  handles the full unfiltered road network with proper `nx.astar_path`).
  If `osmnx` isn't installed, falls back to the bundled pure-Python PBF
  parser (`pbf_parser.py`) with a hand-rolled A* - no extra dependencies,
  works fully offline.
- **`static/index.html`** - Leaflet map. First click sets the start point,
  second click sets the end point and calls `/api/route`, then draws the
  returned polyline. "Reset" clears both points.
- **`hybrid_bus.py` / `bims_client.py`** - live Busan BIMS positions with
  route-constrained interpolation through the collector's pre-collected
  history.

## Live Busan buses

The map can display one selected bus per public line (`126`, `103`, `3006`,
`1001`, `111-1`, `131`, and `33`). The backend calls Busan's official BIMS
OpenAPI service (`busInfo` and `busInfoByRouteId`) using
`BUSAN_BIMS_SERVICE_KEY`.

By default it looks for the sibling collector's prepared history, then its
raw observations, so the collector can be used while a complete
`busan_bus_history.csv` is still being prepared:

```powershell
$env:BUSAN_BIMS_SERVICE_KEY = "<your data.go.kr service key>"
uv run uvicorn main:app --reload
```

Fresh API fixes are returned as `source: "live"`. When a fix has not changed
for `BUSAN_BUS_STALE_AFTER_S` seconds (15 by default), the service projects
the last live fix onto the matching collected trace and interpolates along
that route. A later live fix is blended back over three seconds and labelled
`reconciling`. The public `line_number` is copied from the collector data and
is never replaced by the internal BIMS `line_id`.

Useful overrides are `BUSAN_BUS_HISTORY_PATH`, `BUSAN_BUS_ROUTES_PATH`,
`BUSAN_BUS_LINES` (comma-separated public line numbers), `BUSAN_BUS_LINE_IDS`
(JSON such as `{"126":"5200126000"}`),
`BUSAN_BUS_STALE_AFTER_S`, `BUSAN_BUS_POLL_INTERVAL_S`, and
`BUSAN_BUS_HYBRID_PATH`. The endpoints are `GET /api/buses/info` and
`GET /api/buses`.

## Build the static BIMS route/stop cache

`build_bims_route_cache.py` enriches the recorded route metadata with fixed
stop locations from BIMS `busStopList`. It runs with Python 3.10+ and the
standard library; installing FastAPI or loading the OSM graph is unnecessary.
The BIMS service is documented at
[data.go.kr](https://www.data.go.kr/data/15092750/openapi.do).

From `E:\project4\bus_realtime_collected_display`, run in PowerShell:

```powershell
$env:BUSAN_BIMS_SERVICE_KEY = "<your approved BIMS service key>"
python .\poc-optimal-pth-20260911\build_bims_route_cache.py
$LASTEXITCODE
```

Configure the real key locally; it is not stored in the cache. Both encoded
and decoded data.go.kr keys are supported. The default input is the sibling
`busan_bus_gps_data_20260911/data/busan_bus_routes.json`, located relative to
the script, so changing your working directory does not change the defaults.
All seven configured lines are selected. Supply `--routes` for another input,
`--lines 126,103` for a subset, or `--output <path>` for another output location.
The recorded input is preserved, including its stop order metadata, route
directions and turnaround information; this script does not refresh historical
route definitions using today's live routes.

Outputs in this application's `data` directory:

- `bims_stop_catalog.json`: the complete downloaded static stop catalog, reusable
  across all lines. `complete` here means all reported catalog rows were fetched.
- `bims_route_cache.json`: version 1, with `routes` keyed by public line number.
  Stops are sorted numerically by `stop_index`. Added fields are `stop_lat`,
  `stop_lon`, `coordinate_source` (`busStopList`) and `coordinate_match`
  (`ars_number` or `node_id`). Original `latitude`/`longitude` remain historical
  evidence and must not be interpreted as fixed stop coordinates.
- `bims_route_cache_report.json`: matched/total counts and unresolved entries by
  line. Reasons include `not_found`, `ambiguous_match`, `identifier_conflict`,
  and `invalid_static_coordinates`. In the route cache and report, `complete`
  means every selected route stop has a verified static coordinate.

The script preserves leading zeros in ARS numbers, checks node IDs against ARS
matches, and uses exact node ID lookup when ARS is absent. It does not guess
from stop names or substitute moving bus GPS positions. Missing coordinates
stay null. Exit code **0** means complete matching; **2** means useful partial
output was written and the report needs review; **1** means a fatal input,
download, or file error. Invalid command-line syntax also uses argparse's code 2
and displays usage instead of generating output.

A complete saved catalog is reused automatically. To rebuild without a key
or any network requests, or to explicitly download a fresh catalog:

```powershell
python .\poc-optimal-pth-20260911\build_bims_route_cache.py --offline
python .\poc-optimal-pth-20260911\build_bims_route_cache.py --refresh
```

`--offline` and `--refresh` are mutually exclusive. `--stop-cache` and `--report`
override the additional output paths; by default these files sit beside
`--output`. Downloads use pages of 100, a 15-second request timeout, two retries
for transient failures, and 0.25 seconds between pages. Override these with
`--page-size`, `--timeout`, `--retries`, and `--request-interval`. Pagination is
checked against `totalCount`, and inconsistent or truncated downloads fail.
Authentication and daily quota errors stop immediately. Failed downloads never
replace an existing completed catalog or route cache; JSON files are published
atomically. Interrupted downloads restart from page one on the next run.

No authenticated BIMS collection is needed for the fixture-based tests. From
the application directory, run:

```powershell
python -B -m unittest discover -s tests -v
```

The static cache is preparation for the later OSM route-model builder. It does
not itself generate road polylines, record a new GPS stream, or change tracking.

## Android/device vehicles

`GET /internal/vehicles` merges the BIMS source (live or playback) with
current Android/device GPS read from the media relay's
`GET /internal/telemetry/vehicles` (`MEDIA_RELAY_INTERNAL_BASE_URL`, default
`http://127.0.0.1:39012`, timeout `DEVICE_TELEMETRY_TIMEOUT_S`, default 1 s).
Device observations use `telemetry_source` `RECORDED_GPS` (Android replay) or
`DEVICE_GPS` (real sensors) and carry `vehicleId`, `tripId`, and
`recordingSessionId` in `source_metadata`; their `external_id`
(`device:<vehicleId>`) is only a tracking key and is never registered as a BIMS
vehicle. If the relay is unavailable the snapshot still returns BIMS vehicles
with a `device_relay` warning.

## Using your own PBF file

Change `PBF_PATH` at the top of `main.py` to point at a different `.osm.pbf`
file. No other code changes needed.

## Notes

- The pure-Python fallback graph is filtered to standard routable highway
  classes (motorway through residential/service) with speed-based time
  weights - see `SPEED_KMH` in `graph_backend.py` to adjust.
- With `osmnx` installed you get the full unsimplified network and can
  drop in the truck-constraint filtering (`maxheight`/`maxweight`/`hgv`
  tags) discussed earlier by editing the `OsmnxGraph.route()` method.
- If a clicked point is far from any known road (e.g. in the ocean),
  `nearest_node` can return `None` - the API responds with a 404 and the
  frontend shows an error message instead of crashing.
