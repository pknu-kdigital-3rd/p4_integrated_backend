# ITS Platform

This repository integrates the existing control backend, BIMS routing/tracking, and server video/YOLO processing as independently runnable services. Node owns persistent business data; Python routing/tracking owns transient telemetry and route calculations; Vision reads video and matching GPS/IMU directly from server files by default.

## Layout

- `node/` — Express, Prisma, PostgreSQL/PostGIS control API and operator facade
- `operator-web/` — integration-owned Leaflet dashboard, served at `/operator/`
- `services/routing-tracking/` — canonical BIMS/A* runtime (the duplicate POC was not imported)
- `services/vision/` — existing Python live-view and inference service
- `services/media-relay/` — existing Go/Pion relay
- `android/` — existing Android publisher

Optional [private TURN administration](services/turn-admin/README.md) shows real
allocations and ICE state and manually releases selected UDP allocations. It is
disabled by default and independent of demo mode.

## BIMS history compensation

In the operator dashboard, open **설정 → 데이터 소스** to enable
**실시간 GPS 중단 시 기록 경로로 위치 보정**, then apply the settings.
This option is off by default, including when an older settings file contains
only the telemetry mode. The choice is persisted with the telemetry source.
When disabled, BIMS vehicles keep their last received GPS position and show
**GPS 지연** after the freshness threshold (15 seconds by default). Their original
observation timestamp is retained. Recorded-route interpolation runs only after
an operator enables compensation. This setting applies to live BIMS; selecting
the playback source still explicitly displays recorded GPS data.

## HTTPS startup

For Jupyter or a server without Docker access, see the
[native startup guide](docs/integration/NATIVE_STARTUP.md). It launches the
existing services as user processes and serves operator-web and live preview
through one HTTPS port. PostgreSQL/PostGIS can run inside the same existing
Jupyter container; preview-only mode works without a database.

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

## Server video inference

Vision runs without an Android publisher. Set `SERVER_DATASET_DIR` to the host
folder containing the recording. Compose mounts it read-only at
`/data/vision-dataset`. For a direct Python process, the same variable is the
local directory path. The file names are independently configurable:

```dotenv
VISION_SOURCE=server
SERVER_DATASET_DIR=/srv/recordings/my-drive
SERVER_VIDEO_FILE=video.mp4
SERVER_GPS_FILE=gps.csv
SERVER_IMU_FILE=imu.csv
# Optional: the timestamp_ns corresponding exactly to video time zero.
# When omitted, the first GPS sample is treated as time zero.
SERVER_SOURCE_START_NS=123456789000000
# Optional transport identity; no fleet vehicle selection is required.
SERVER_VEHICLE_ID=server
```

The video can use any codec readable by the installed PyAV/FFmpeg build and
must have a known duration and frame presentation timestamps. Vision decodes
it on the server and encodes baseline H.264 for the browser; audio is omitted.
GPS and IMU use the Android CSV schema, including optional columns:

```csv
timestamp_ns,utc_epoch_ms,latitude,longitude,altitude_m,speed_mps,bearing_deg,horizontal_accuracy_m
```

```csv
timestamp_ns,pitch_deg,roll_deg,yaw_deg,accuracy
```

Nanoseconds stay integers throughout synchronization. Set
`SERVER_SOURCE_START_NS` if video zero differs from the first GPS timestamp;
this explicit offset replaces the Android QR clock anchor. GPS interpolation
and IMU matching use the existing source-time rules. Missing or distant samples
show a stale state. Seeking and looping can revisit the full recorded telemetry.

Open the inference page and press **Start**. Use the timeline slider, **Seek**,
or **−10 s / +10 s**. Enter loop start/end seconds or mark the current frame,
then choose **Set loop**. **Clear loop** restores normal playback. In the
operator's embedded video, **Video controls** opens the same controls.
Seeking starts a fresh video/overlay epoch. Loop endpoints exclude the end
frame; playback restarts after the last frame in the interval is presented.

In the operator dashboard, open **실시간 영상** without selecting a fleet vehicle.
The recording appears as **서버 영상 · GPS** in the normal-monitoring vehicle
list and dropdown, with its own map marker created at the first valid presented
GPS fix. Playback opens automatically when the live-footage tab is active. The
marker follows the CSV positions, including backward seeks and loops. Fleet
polling and planned trip routes do not control it. If GPS is missing, playback
stops, or the preview closes, normal monitoring retains the last valid GPS
position. No map position is invented before the first GPS fix. `SERVER_VEHICLE_ID` is only a transport identity shared between
Node and Vision; it does not associate playback with a fleet vehicle or choose
its location. The default `server` is sufficient. Playback does not create a
trip or persist interpolated GPS or detections as a real recording session.
The historical Android client and relay remain available through
`VISION_SOURCE=relay` for existing live-stream deployments.

GPU inference and the real dataset require validation on the deployment host.
