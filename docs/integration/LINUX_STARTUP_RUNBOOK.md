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
curl, and Git. The Compose file exposes all host NVIDIA GPUs to Vision. Its
entrypoint selects the last visible GPU and sets it as `cuda:0` inside the
application, so the host can have any number of GPUs.

```bash
docker --version
docker compose version
nvidia-smi
docker run --rm --gpus all nvidia/cuda:13.0.0-runtime-ubuntu24.04 nvidia-smi
```

The Node image installs the private Git dependency through BuildKit SSH
forwarding. Start an SSH agent with a key that can read the dependency before
building, or replace that dependency with an accessible package source.

## Defaults and optional overrides

Run Compose from the checkout containing `docker-compose.yml`. Host source and
model mounts in `docker-compose.dev.yml` are relative paths (`./node`,
`./services/vision`, and so on); no `*_SOURCE_PATH` variables are needed.
The model mapping is read-only. The custom Ultralytics implementation is copied
from `services/vision/.ultralytics-custom` during the image build and mounted
from that same relative directory for development reloads.

The default public address is `10.174.96.119`. Override it for a different host
without creating an env file:

```bash
TLS_PUBLIC_ADDRESS=192.0.2.10 docker compose up -d
```

Persistent data defaults to the sibling directory
`../p4_integrated_backend_data`. Each Compose `source:` entry maps one volume
to a visible subdirectory there: `pgdata`, `minio_data`, `jwt`, `tls`,
`relay_feed`, `recording_spool`, and `nginx_logs`. Development dependencies use
`node_modules` in the same root. To use a different disk, edit the relevant
`source:` entry in `docker-compose.yml` or `docker-compose.dev.yml`:

| Host directory | Service(s) | Container path |
|---|---|---|
| `../p4_integrated_backend_data/pgdata` | PostgreSQL | `/var/lib/postgresql/data` |
| `../p4_integrated_backend_data/minio_data` | MinIO | `/data` |
| `../p4_integrated_backend_data/jwt` | Node and migrations | `/run/secrets/jwt` |
| `../p4_integrated_backend_data/tls` | Nginx | `/etc/nginx/tls` |
| `../p4_integrated_backend_data/relay_feed` | Relay and Vision | `/run/p4/relay` |
| `../p4_integrated_backend_data/recording_spool` | Relay | `/var/tmp/p4-recordings` |
| `../p4_integrated_backend_data/nginx_logs` | Nginx | `/var/log/nginx` |
| `../p4_integrated_backend_data/node_modules` (dev only) | Node | `/workspace/node/node_modules` |

```yaml
services:
  db:
    volumes:
      - type: bind
        source: /fast/postgres
        target: /var/lib/postgresql/data
```

Compose creates missing bind-mount directories. A host symlink can be used as
the `source:` path when the target storage is on another disk. JWT keys and
the self-signed Nginx certificate are stored in the `jwt` and `tls` directories
and persist across `docker compose down`; remove those directories manually
when rotating them.

## Start the production image stack

The first command builds images, starts PostgreSQL, and applies Prisma
migrations and seed data. Compose performs the JWT/TLS volume initialization
automatically; it does not require `.runtime/compose.env`.

```bash
docker compose up -d
docker compose ps
```

The public URLs are:

- `https://<PUBLIC_ADDRESS>:39001/operator/`
- `https://<PUBLIC_ADDRESS>:39002/`

## Development hot reload

Use the explicit source bind mounts and reload commands when editing Node or
Python code:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f node
```

The override mounts source directories individually; it never mounts the whole
repository into a service container. Node uses `tsx watch`, routing uses
Uvicorn reload, and Vision uses Uvicorn reload. The relay remains an
image-built Go binary.

## Recording and replay

Set `RECORDING_ENABLED=true` and configure independent MinIO root, relay, and
Node credentials in the Compose invocation. The recording profile starts
MinIO and publishes the replay proxy; no repository-local env file is needed.
For a one-off shell session, keep the values in a command-scoped environment:

```bash
RECORDING_ENABLED=true \
NODE_INTERNAL_SERVICE_TOKEN="$(openssl rand -hex 32)" \
MINIO_ROOT_USER=p4-minio-root \
MINIO_ROOT_PASSWORD="replace-with-a-random-secret" \
MINIO_ACCESS_KEY=p4-relay \
MINIO_SECRET_KEY="replace-with-an-independent-random-secret" \
MINIO_NODE_ACCESS_KEY=p4-node \
MINIO_NODE_SECRET_KEY="replace-with-an-independent-random-secret" \
docker compose -f docker-compose.yml -f docker-compose.recording.yml \
  --profile recording up -d --build
```

The enabled profile starts `minio` and runs the one-shot `minio-bootstrap`
service after MinIO is ready. If bootstrap must be repeated, rerun the same
command-scoped variables with `docker compose --profile recording run --rm
--no-deps minio-bootstrap`; values exported in a prior shell command are not
assumed.

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
docker compose logs -f
docker compose logs -f relay
docker compose restart vision
docker compose stop
docker compose down
```

The optional `scripts/run-linux-stack.sh` wrapper delegates to Compose and
accepts the same optional shell overrides. Use `docker compose ps` and
`docker compose logs <service>` for direct diagnostics. `down` preserves the
host data directories.
