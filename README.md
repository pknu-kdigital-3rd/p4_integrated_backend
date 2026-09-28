# ITS Platform

This repository integrates the existing control backend, BIMS routing/tracking, and Android/WebRTC/YOLO prototypes as independently runnable services. Node owns persistent business data; Python routing/tracking owns transient telemetry and route calculations; the existing media stack remains behavior-frozen.

## Layout

- `node/` — Express, Prisma, PostgreSQL/PostGIS control API and operator facade
- `operator-web/` — integration-owned Leaflet dashboard, served at `/operator/`
- `services/routing-tracking/` — canonical BIMS/A* runtime (the duplicate POC was not imported)
- `services/vision/` — existing Python live-view and inference service
- `services/media-relay/` — existing Go/Pion relay
- `android/` — existing Android publisher

## Offline operator map preview

The operator page uses a local vector basemap. To prepare its Busan tiles, fonts,
and sprites once on Windows, start Docker Desktop and run from the repository root:

```powershell
./scripts/prepare-offline-map.ps1
```

The source download and Planetiler build require internet access and several GB
of free disk space. Generated assets are kept in ignored `data/map/`; subsequent
preview sessions use no internet or real-time services. Install the frontend
dependencies once, then launch the visual preview:

```powershell
cd operator-web
npm ci
npm run preview:offline
```

Open `http://127.0.0.1:5173/operator/?preview=1`. Both dashboard tabs use
read-only sample states. Selection and layout controls work; backend actions
are disabled. Edit `operator-web/map-style.json` for road, land, water, and
label colors; `operator-web/map-colors.js` for markers and routes; and the
variables near the top of `operator-web/styles.css` for the main UI colors.
Vite reloads the preview as files change.

The production Node image builds the frontend and serves the same map package
from `data/map/`, mounted by both Compose files. The package must be prepared
on the deployment host before starting the dashboard. Map data attribution is
displayed from the style source. Source data comes from Geofabrik/OpenStreetMap;
the font and sprite assets come from OpenFreeMap.
The development Compose file bind-mounts `operator-web/`, so run `npm run build`
in that directory after source edits when viewing the page through Compose.

## HTTPS startup

Docker Compose runs Node, routing, vision, relay, PostgreSQL, MinIO, Nginx,
and Coturn. The Compose files use the repository layout directly, so no
`env.local` file or host-path variables are required for the default stack.
From the directory containing `docker-compose.yml`, run:

```bash
docker compose up -d
```

Use the standalone development Compose file when editing source files:

```bash
docker compose -f docker-compose.dev.yml up -d
```

Optional shell variables can override public ports, routing, TURN, or GPU
policy. JWT and MinIO settings are fixed in each Compose file. The default
persistent-data directory is `./data`; each `source:` entry in Compose names
its subdirectory explicitly, including `routing_state` for the selected BIMS
source. Recording is always enabled, so Nginx ports `39001-39003` and
Coturn ports `39004-39007` are exposed on the host. Node, Vision, routing,
relay, PostgreSQL, and MinIO use the private Compose network. See the [Docker
Linux runbook](docs/integration/LINUX_STARTUP_RUNBOOK.md) and [Nginx ingress
guide](deploy/nginx/README.md) for the complete procedure.

For the complete Windows-first test procedure, required variables, reload
commands, and deployment gotchas, see the [Docker operations guide](docs/integration/DOCKER_OPERATIONS.md).

The operator dashboard's **Bus telemetry source** control switches between the
live BIMS feed and the replay dataset without restarting Compose. The selected
source is persisted in `data/routing_state/`; the routing container only needs
to be restarted after code or container configuration changes.

## Android GPS/IMU telemetry

With `ANDROID_TELEMETRY_ENABLED=true` (relay and Node), Android's `telemetry-events` DataChannel feeds the live map and Live View: the Go relay binds each batch to the Node-validated trip/vehicle/recording session, persists every GPS fix through `POST /internal/telemetry/gps` (`vehicle_position`, see [docs/v18_its_integrated_erd.md](docs/v18_its_integrated_erd.md)), forwards GPS/IMU to Vision for source-time matching against the displayed video, and publishes current device positions that routing/tracking merges with BIMS. Vision's Live View shows the telemetry of the presented frame and posts it to the operator page, where it moves the selected vehicle's marker; the 3-second fleet poll still drives all other markers. See [docs/pipeline_architecture_control_vision_v6_notes.md](docs/pipeline_architecture_control_vision_v6_notes.md) for the flows.

GPU-dependent vision tests and Android device streaming require their original environment and are not part of CPU-only verification. No SUMO, Tauri, route reassignment, or multi-stream media routing is included.
