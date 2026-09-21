# ITS Platform

This repository integrates the existing control backend, BIMS routing/tracking, and Android/WebRTC/YOLO prototypes as independently runnable services. Node owns persistent business data; Python routing/tracking owns transient telemetry and route calculations; the existing media stack remains behavior-frozen.

## Layout

- `node/` — Express, Prisma, PostgreSQL/PostGIS control API and operator facade
- `operator-web/` — integration-owned Leaflet dashboard, served at `/operator/`
- `services/routing-tracking/` — canonical BIMS/A* runtime (the duplicate POC was not imported)
- `services/vision/` — existing Python live-view and inference service
- `services/media-relay/` — existing Go/Pion relay
- `android/` — existing Android publisher

## HTTPS startup

Docker Compose runs Node, routing, vision, relay, PostgreSQL, MinIO, Nginx,
and Coturn. Copy [deploy/env.local.example](deploy/env.local.example) to the
untracked `deploy/env.local`, configure the public address, credentials, model
mount, and GPU settings, then run:

```bash
./scripts/run-linux-stack.sh all
```

Use `P4_COMPOSE_DEV=true` to add explicit host source mounts and Node/Python
reload commands. Only Nginx ports `39001-39003` (the third when recording is
enabled) and Coturn ports `39004-39007` are exposed on the host. Node, Vision,
routing, relay, PostgreSQL, and MinIO use the private Compose network. See the
[Docker Linux runbook](docs/integration/LINUX_STARTUP_RUNBOOK.md) and
[Nginx ingress guide](deploy/nginx/README.md) for the complete procedure.

## Android GPS/IMU telemetry

With `ANDROID_TELEMETRY_ENABLED=true` (relay and Node), Android's `telemetry-events` DataChannel feeds the live map and Live View: the Go relay binds each batch to the Node-validated trip/vehicle/recording session, persists every GPS fix through `POST /internal/telemetry/gps` (`vehicle_position`, see [docs/v18_its_integrated_erd.md](docs/v18_its_integrated_erd.md)), forwards GPS/IMU to Vision for source-time matching against the displayed video, and publishes current device positions that routing/tracking merges with BIMS. Vision's Live View shows the telemetry of the presented frame and posts it to the operator page, where it moves the selected vehicle's marker; the 3-second fleet poll still drives all other markers. See [docs/pipeline_architecture_control_vision_v6_notes.md](docs/pipeline_architecture_control_vision_v6_notes.md) for the flows.

GPU-dependent vision tests and Android device streaming require their original environment and are not part of CPU-only verification. No SUMO, Tauri, route reassignment, or multi-stream media routing is included.
