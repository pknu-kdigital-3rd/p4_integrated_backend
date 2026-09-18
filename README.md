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

1. Copy `node/.env.example` to `node/.env.dev` and configure JWT keys. Browser-visible URLs must use HTTPS in production.
2. Start PostGIS: `docker compose up -d db`.
3. In `node/`, run `npm ci`, deploy migrations, seed, then `npm run dev:once`.
4. In `services/routing-tracking/`, run `uv sync` then `uv run uvicorn main:app --host 127.0.0.1 --port 8000`. Set `TELEMETRY_MODE=playback` for CSV-only operation; playback makes no BIMS position calls.
5. Start Vision internally with `uv run python run.py --no-tls` (`127.0.0.1:39011`) and start the Go relay on `127.0.0.1:39012`.
6. Issue a trusted LAN development certificate with `scripts/new-development-ca.ps1`, install its CA certificate on every client, then start the Nginx configuration in `deploy/nginx/`.
7. Open `https://10.174.96.95:39001/operator/`. Development sets `OPERATOR_DEMO_PUBLIC=true`, allowing read-only dashboard access without an interactive login; all normal auth/JWT/RBAC routes remain available and unchanged. Live View appears inline from the secure Vision origin at `https://10.174.96.95:39002/`.

Public HTTP redirects to HTTPS. Node, Vision, routing/tracking, and relay HTTP listeners are internal-only. See [deploy/nginx/README.md](deploy/nginx/README.md) for certificate, proxy, WebSocket, and firewall details.

For a Linux host, use the single-environment, health-checked startup procedure in [docs/integration/LINUX_STARTUP_RUNBOOK.md](docs/integration/LINUX_STARTUP_RUNBOOK.md) and copy [deploy/env.local.example](deploy/env.local.example) to the untracked `deploy/env.local`.
After editing that file, `scripts/run-linux-stack.sh all` performs setup, startup, and health verification in one command.

## Android GPS/IMU telemetry

With `ANDROID_TELEMETRY_ENABLED=true` (relay and Node), Android's `telemetry-events` DataChannel feeds the live map and Live View: the Go relay binds each batch to the Node-validated trip/vehicle/recording session, persists every GPS fix through `POST /internal/telemetry/gps` (`vehicle_position`, see [docs/v18_its_integrated_erd.md](docs/v18_its_integrated_erd.md)), forwards GPS/IMU to Vision for source-time matching against the displayed video, and publishes current device positions that routing/tracking merges with BIMS. Vision's Live View shows the telemetry of the presented frame and posts it to the operator page, where it moves the selected vehicle's marker; the 3-second fleet poll still drives all other markers. See [docs/pipeline_architecture_control_vision_v6_notes.md](docs/pipeline_architecture_control_vision_v6_notes.md) for the flows.

GPU-dependent vision tests and Android device streaming require their original environment and are not part of CPU-only verification. No SUMO, Tauri, route reassignment, or multi-stream media routing is included.
