# Linux Docker Compose startup runbook

This is the deployment procedure for the integrated stack on a Linux host with
NVIDIA Container Toolkit. Every application service runs in Docker. Nginx and
Coturn are the only services that use public host ports.

## Services and ports

| Service | Compose address | Host exposure |
|---|---|---|
| PostgreSQL/PostGIS | `db:5432` | none |
| Node API | `node:3000` | through Nginx `39001` |
| Routing/tracking | `routing:8000` | none |
| Vision | `vision:39011` | through Nginx `39002` |
| Go relay | `relay:39012` | through Nginx `39002` |
| MinIO S3 API | `minio:9000` | through Nginx `39003` when recording is enabled |
| MinIO Console | `minio:9001` | none |
| Coturn | host network | `39004` UDP/TCP, `39005` TCP, `39006-39007` UDP |

The container-to-container ports are private to the `p4-internal` network. The
MinIO Console is not required for replay and is intentionally not published.

## Prerequisites

Install and verify Docker Engine/Compose, NVIDIA Container Toolkit, OpenSSL,
curl, and Git. The vision service exposes physical GPU 3 only; inside the
container it is addressed as `cuda:0`.

```bash
docker --version
docker compose version
nvidia-smi
docker run --rm --gpus '"device=3"' nvidia/cuda:13.0.0-runtime-ubuntu24.04 nvidia-smi
```

The Node image installs the private Git dependency through BuildKit SSH
forwarding. Start an SSH agent with a key that can read the dependency before
building, or replace that dependency with an accessible package source.

## Environment and host paths

```bash
cd /home/user/p4_integrated_backend
cp deploy/env.local.example deploy/env.local
$EDITOR deploy/env.local
chmod +x scripts/run-linux-stack.sh
```

Set `P4_ROOT` to the checkout. Set the public address and certificate SAN
together. Configure the host paths used by the development override:

```bash
export NODE_SOURCE_PATH="$P4_ROOT/node"
export OPERATOR_WEB_SOURCE_PATH="$P4_ROOT/operator-web"
export ROUTING_SOURCE_PATH="$P4_ROOT/services/routing-tracking"
export VISION_SOURCE_PATH="$P4_ROOT/services/vision"
export VISION_MODEL_HOST_PATH="$P4_ROOT/services/vision/models"
export VISION_ULTRALYTICS_HOST_PATH="$P4_ROOT/services/vision/.ultralytics-custom"
export VISION_ULTRALYTICS_CONTEXT="$VISION_ULTRALYTICS_HOST_PATH"
export YOLO_MODEL_CONTAINER=/models/a4_best.engine
export YOLO_DEVICE_CONTAINER=cuda:0
```

The model mapping is read-only. The custom Ultralytics path is a named BuildKit
context for production builds and a read-only bind mount in development, so a
Windows checkout and a Linux checkout can use different host paths.

## Start the production image stack

The first command generates JWT/TLS material, builds images, starts PostgreSQL,
and applies Prisma migrations and seed data. It writes the generated container
environment to the ignored `.runtime/compose.env` file.

```bash
./scripts/run-linux-stack.sh setup
./scripts/run-linux-stack.sh start
./scripts/run-linux-stack.sh status
```

The public URLs are:

- `https://<PUBLIC_ADDRESS>:39001/operator/`
- `https://<PUBLIC_ADDRESS>:39002/`

## Development hot reload

Use the explicit source bind mounts and reload commands when editing Node or
Python code:

```bash
P4_COMPOSE_DEV=true ./scripts/run-linux-stack.sh start
P4_COMPOSE_DEV=true ./scripts/run-linux-stack.sh logs node
```

The override mounts source directories individually; it never mounts the whole
repository over `/app`. Node uses `tsx watch`, routing uses Uvicorn reload, and
Vision uses Uvicorn reload. The relay remains an image-built Go binary.

## Recording and replay

Set `RECORDING_ENABLED=true` and configure independent MinIO root, relay, and
Node credentials. Then run:

```bash
./scripts/run-linux-stack.sh setup
./scripts/run-linux-stack.sh recording-bootstrap
./scripts/run-linux-stack.sh start
```

The recording override publishes `39003/tcp`, and replay uses Node-issued
presigned MinIO URLs with HTTP range requests. MinIO API port `9000`, Console
port `9001`, and PostgreSQL `5432` remain private.

## Coturn

Compose runs Coturn with host networking so ICE candidates and relay ports are
unambiguous:

```text
TURN listener: UDP/TCP 39004
TURN TLS:      TCP 39005
Relay range:  UDP 39006-39007
TURN URL:     turn:<PUBLIC_ADDRESS>:39004?transport=udp
```

Allow the same ports in the host firewall and any upstream NAT/security group.
Set `TURN_URL=""` only when Android and the relay host are directly reachable.

## Lifecycle and logs

```bash
./scripts/run-linux-stack.sh logs
./scripts/run-linux-stack.sh logs relay
./scripts/run-linux-stack.sh restart vision
./scripts/run-linux-stack.sh stop
./scripts/run-linux-stack.sh down
```

The wrapper delegates to Compose. Use `docker compose ps` and `docker compose
logs <service>` for direct diagnostics. `down` preserves named volumes unless
the volumes are explicitly removed.
