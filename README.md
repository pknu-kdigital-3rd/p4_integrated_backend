# ITS Platform

This repository integrates the existing control backend, BIMS routing/tracking, and Android/WebRTC/YOLO prototypes as independently runnable services. Node owns persistent business data; Python routing/tracking owns transient telemetry and route calculations; the existing media stack remains behavior-frozen.

## Layout

- `node/` — Express, Prisma, PostgreSQL/PostGIS control API and operator facade
- `operator-web/` — integration-owned Leaflet dashboard, served at `/operator/`
- `services/routing-tracking/` — canonical BIMS/A* runtime (the duplicate POC was not imported)
- `services/vision/` — existing Python live-view and inference service
- `services/media-relay/` — existing Go/Pion relay
- `android/` — existing Android publisher

## Startup

1. Copy `node/dot_env_example` to the environment file used by Node and configure JWT keys.
2. Start PostGIS: `docker compose up -d db`.
3. In `node/`, run `npm ci`, deploy migrations, seed, then `npm run dev:once`.
4. In `services/routing-tracking/`, run `uv sync` then `uv run uvicorn main:app --port 8000`. Set `TELEMETRY_MODE=playback` for CSV-only operation; playback makes no BIMS position calls.
5. Start the media relay and vision service using their component READMEs/current commands.
6. Open `http://localhost:3000/operator/`. Development sets `OPERATOR_DEMO_PUBLIC=true`, allowing read-only dashboard access without an interactive login; all normal auth/JWT/RBAC routes remain available and unchanged. If demo mode is disabled, the dashboard temporarily attempts `admin` / `admin1234` automatically and falls back to the login form. Live View appears inline. For browser clients on other machines, loopback hostnames in `LIVE_VIEW_URL` are translated to the dashboard hostname.

GPU-dependent vision tests and Android device streaming require their original environment and are not part of CPU-only verification. No SUMO, Tauri, route reassignment, or multi-stream media routing is included.
