# Linux startup runbook

This is the operator procedure for starting the integrated ITS stack on a Linux
server with an RTX 3090. Run each long-lived service in its own shell (or put
the same commands in systemd units after the procedure is proven). Stop at the
first failed prerequisite or health check; the system is not considered up
until every required check below passes.

## Components and ports

| Component | Directory | Runtime | Internal listener | Health check |
| --- | --- | --- | --- | --- |
| PostgreSQL/PostGIS | repository root | Docker | `127.0.0.1:5432` | `pg_isready` |
| MinIO object storage (optional recording profile) | repository root | Docker | `127.0.0.1:9000` API, `127.0.0.1:9001` console | `/minio/health/ready` |
| Node control API + operator files | `node/` | Node/npm | `127.0.0.1:3000` | `/health/live`, `/health/ready` |
| Route/tracking + A* | `services/routing-tracking/` | Python/uv | `127.0.0.1:8000` | `/health/live`, `/health/ready` |
| Go media relay | `services/media-relay/` | Go | `127.0.0.1:39012` | `/healthz`, `/internal/status` |
| Vision live-view/inference | `services/vision/` | Python/uv + CUDA | `127.0.0.1:39011` | `/health/live` |
| Operator HTTPS ingress | `deploy/nginx/` | Nginx | `:39001` | HTTPS curl checks |
| Vision/WSS/signaling HTTPS ingress | `deploy/nginx/` | Nginx | `:39002` | HTTPS curl checks |
| MinIO signed playback ingress (optional recording profile) | `deploy/nginx/` | Nginx | `:39003` | signed GET / Range GET |
| MinIO Console HTTPS ingress (optional recording profile) | `deploy/nginx/` | Nginx | `:39004` | HTTPS browser / curl check |

Terminology: Vision is the Python WebRTC/YOLO server. Route/tracking is the
second Python service. There is no separate fourth Python server in this
repository; the other backend process is the Node control API.

## One-command path

After copying and editing the central environment file described below, the
entire setup and startup sequence can be run with:

```bash
cd /home/user/p4_integrated_backend
chmod +x scripts/run-linux-stack.sh
./scripts/run-linux-stack.sh all
```

The command does not report success until PostgreSQL, Node, route/tracking, the
Go relay, Vision/CUDA, Nginx, and both public HTTPS origins pass their checks.
When `RECORDING_ENABLED=true`, it also starts MinIO, checks readiness, and runs
the bucket and service-user bootstrap to completion.
Useful lifecycle commands are:

```bash
./scripts/run-linux-stack.sh status
./scripts/run-linux-stack.sh stop
./scripts/run-linux-stack.sh start
./scripts/run-linux-stack.sh down
```

Individual components can be started, stopped, restarted, or checked without
touching the other services:

```bash
./scripts/run-linux-stack.sh start node
./scripts/run-linux-stack.sh restart routing
./scripts/run-linux-stack.sh restart relay
./scripts/run-linux-stack.sh restart vision
./scripts/run-linux-stack.sh restart nginx
./scripts/run-linux-stack.sh stop node
./scripts/run-linux-stack.sh status vision
```

The component names are `node`, `routing`, `relay`, `vision`, and `nginx`.
Run `setup` once before starting the relay or Vision so dependencies and the
relay binary are available. Restarting Nginx only validates and reloads its
project-local configuration.

Logs and PID files are kept under the ignored `.runtime/` directory. `stop`
leaves PostgreSQL and MinIO running; `down` stops them when recording is enabled.
Nginx uses only the unprivileged HTTPS ports 39001 and 39002, plus 39003 and
39004 when recording is enabled, and runs under the current user.

## 0. One-time host prerequisites

Install and verify Docker Engine/Compose, `uv`, Go, OpenSSL, and `curl`. Node
may be installed directly or managed by `nvm`. The one-command script discovers
the current user's `~/.nvm/nvm.sh` even when NVM was not loaded in the launching
terminal, then selects or installs `NODE_VERSION`. Set `NVM_DIR` in
`deploy/env.local` only when NVM uses a custom location. Vision requires Python
3.12; route/tracking supports Python 3.10 or newer. Run the TensorRT smoke test
and overload benchmark only on this Linux RTX 3090 deployment host, as
described in [BENCHMARK_YOLO.md](../../services/vision/BENCHMARK_YOLO.md).

```bash
docker --version
docker compose version
uv --version
go version
openssl version
curl --version
nvidia-smi
```

For a manual `nvm` check after creating `deploy/env.local`:

```bash
set -a; source deploy/env.local; set +a
source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
nvm use "$NODE_VERSION"
node --version
npm --version
```

If any command is missing or `nvidia-smi` cannot see the RTX 3090, stop and fix
the host before starting services.

## 1. Create the single runtime environment

All service variables belong in one untracked file. Do not maintain separate
shell-specific copies.

```bash
cd /home/user/p4_integrated_backend
cp deploy/env.local.example deploy/env.local
$EDITOR deploy/env.local
set -a
source deploy/env.local
set +a
```

Set `P4_ROOT` to the real checkout path. Set `NVM_DIR` only if NVM is not under
the current user's `~/.nvm`. If the server address is not
`10.174.96.95`, change `PUBLIC_OPERATOR_URL`, `VISION_PUBLIC_BASE_URL`,
`LIVE_VIEW_URL`, `MINIO_PUBLIC_ENDPOINT`, `MINIO_BROWSER_REDIRECT_URL`, the
`server_name` in `deploy/nginx/nginx.conf`, `TURN_URL`, and the certificate SAN
together. For a local smoke test without BIMS, leave
`TELEMETRY_MODE=playback`. For live BIMS, set
`TELEMETRY_MODE=live` and add `BUSAN_BIMS_SERVICE_KEY`.

For recording, set `RECORDING_ENABLED=true` and replace the example Node token,
MinIO root password, relay secret, and Node read secret with independent values.
Keep `MINIO_ENDPOINT` on loopback for the Go relay and set
`MINIO_PUBLIC_ENDPOINT` to the HTTPS address on port `39003` that browsers will
use. Set `MINIO_BROWSER_REDIRECT_URL` to
`https://${TLS_PUBLIC_ADDRESS}:39004` for the HTTPS MinIO Console. Bootstrap
uses the root credentials to provision MinIO; use `MINIO_ROOT_USER` and
`MINIO_ROOT_PASSWORD` to sign in to the Console. Keep the relay and Node
credentials bucket-scoped and dedicated to those services. The console backend
stays on loopback port `9001`; Nginx exposes it at
`https://${TLS_PUBLIC_ADDRESS}:39004`.
The one-command setup starts MinIO after PostgreSQL is ready, waits for its
readiness endpoint, and runs `minio-bootstrap` synchronously so a policy or
credential failure stops setup.

Generate Node signing keys if they do not already exist:

```bash
mkdir -p "$P4_ROOT/secrets/jwt"
if [[ ! -f "$JWT_PRIVATE_KEY_PATH" ]]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$JWT_PRIVATE_KEY_PATH"
  chmod 600 "$JWT_PRIVATE_KEY_PATH"
fi
if [[ ! -f "$JWT_PUBLIC_KEY_PATH" ]]; then
  openssl rsa -pubout -in "$JWT_PRIVATE_KEY_PATH" -out "$JWT_PUBLIC_KEY_PATH"
fi
```

Verify that the paths and required values resolve before starting anything:

```bash
test -f "$JWT_PRIVATE_KEY_PATH"
test -f "$JWT_PUBLIC_KEY_PATH"
test -f "$P4_ROOT/services/routing-tracking/busan-roads_osm.pbf"
printf 'P4_ROOT=%s\nNODE=%s:%s\nROUTING=%s:%s\nVISION=%s:%s\nRELAY=%s\n' \
  "$P4_ROOT" "$HOST" "$NODE_PORT" "$HOST" "$ROUTING_PORT" \
  "$HOST" "$VISION_PORT" "$RELAY_LISTEN_ADDR"
```

## 2. Start PostgreSQL/PostGIS

From the repository root:

```bash
cd "$P4_ROOT"
docker compose up -d db
docker compose ps db
docker compose exec -T db pg_isready -U app -d vehicle_platform
```

The final command must report that PostgreSQL is accepting connections. If it
fails, inspect `docker compose logs db` and do not continue.

When enabling the services manually, start MinIO and complete its bootstrap
before starting the Go relay:

```bash
if [[ "$RECORDING_ENABLED" == true ]]; then
  docker compose --profile recording up -d minio
  curl --fail http://127.0.0.1:9000/minio/health/ready
  docker compose --profile recording run --rm --no-deps minio-bootstrap
fi
```

The bucket is private. Port `9000` is loopback-only for the relay; Nginx
provides signed object GETs and byte-range requests through HTTPS port `39003`.
Port `9001` remains loopback-only. The MinIO Console is available through Nginx
at `https://10.174.96.95:39004/`; sign in with the MinIO root credentials from
`deploy/env.local`. Verify the public S3 endpoint only after a segment has been
recorded and Node has registered it.

## 3. Start the Node control API

Use a new shell, source the same environment file, and run:

```bash
cd "$P4_ROOT"
set -a; source deploy/env.local; set +a
cd node
NODE_ENV=development npm ci --include=dev
npx prisma migrate deploy
npx tsx prisma/seed.ts
npm run build
export PORT="$NODE_PORT"
npx tsx src/server.ts
```

Keep this shell running. In another shell, source the environment and verify:

```bash
set -a; source /home/user/p4_integrated_backend/deploy/env.local; set +a
curl --fail http://127.0.0.1:"$NODE_PORT"/health/live
curl --fail http://127.0.0.1:"$NODE_PORT"/health/ready
curl --fail http://127.0.0.1:"$NODE_PORT"/api/v1/demo/bootstrap
```

The seed creates the temporary `admin` / `admin1234` account and demo custom
trucks. Do not expose `OPERATOR_DEMO_PUBLIC=true` outside a trusted network.

## 4. Start route/tracking (Python service)

Use another shell:

```bash
cd "$P4_ROOT"
set -a; source deploy/env.local; set +a
cd services/routing-tracking
uv sync
uv run uvicorn main:app --host "$HOST" --port "$ROUTING_PORT"
```

The first start loads `busan-roads_osm.pbf`; wait for the graph-loaded message.
Verify from another shell:

```bash
set -a; source /home/user/p4_integrated_backend/deploy/env.local; set +a
curl --fail http://127.0.0.1:"$ROUTING_PORT"/health/live
curl --fail http://127.0.0.1:"$ROUTING_PORT"/health/ready
curl --fail http://127.0.0.1:"$ROUTING_PORT"/internal/telemetry/status
curl --fail http://127.0.0.1:"$ROUTING_PORT"/internal/vehicles
```

Playback mode must report `"mode":"playback"` and must not call BIMS. Live
mode requires a valid data.go.kr key and may also require a line-ID mapping.

## 5. Start the Go media relay

Use another shell:

```bash
cd "$P4_ROOT"
set -a; source deploy/env.local; set +a
cd services/media-relay
go mod download
go run .
```

Verify the relay boundary:

```bash
set -a; source /home/user/p4_integrated_backend/deploy/env.local; set +a
curl --fail http://127.0.0.1:39012/healthz
curl --fail http://127.0.0.1:39012/internal/status
```

`/internal/status` may report `live:false` until the Android publisher connects;
that is expected. It also reports a non-secret `recording` status. A failed
health check is not expected.

## 6. Start Vision (Python WebRTC/YOLO service)

Start the relay before Vision so the initial relay-status query succeeds. Use
another shell:

```bash
cd "$P4_ROOT"
set -a; source deploy/env.local; set +a
cd services/vision
if [ ! -e .ultralytics-custom ]; then
  ln -s /home/user/yolo_custom/yolo_carafe_aspp .ultralytics-custom
fi
test -f .ultralytics-custom/ultralytics/__init__.py
uv sync --locked
uv run python -c 'import ultralytics; print(ultralytics.__file__)'
uv run python -c 'import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0)); print(torch.cuda.get_arch_list())'
uv run python run.py --no-tls
```

`uv sync --locked` selects the Python 3.12 lock and installs the CUDA PyTorch
wheels declared by this service. The Ultralytics path must resolve to the
configured editable checkout, not a PyPI copy. Set `YOLO_MODEL` to the deployed
`.engine` file in `deploy/env.local`; its loader intentionally skips `.to()` and
`.fuse()`. The CUDA check must print the RTX 3090 and Vision must log
`YOLO inference device: cuda:0`. Run the smoke test and 10-minute overload test
in [BENCHMARK_YOLO.md](../../services/vision/BENCHMARK_YOLO.md) before accepting
the deployment.

Verify:

```bash
set -a; source /home/user/p4_integrated_backend/deploy/env.local; set +a
curl --fail http://127.0.0.1:"$VISION_PORT"/health/live
curl --fail http://127.0.0.1:"$VISION_PORT"/
```

Vision is intentionally HTTP on loopback. Nginx terminates TLS; do not expose
port `39011` directly to the LAN.

## 7. Enable HTTPS ingress for the browser Live View

The dashboard and Vision iframe must share a trusted HTTPS ancestor. Generate a
development CA and server certificate on the Linux host (or install a trusted
organization certificate) with a SAN matching the public address:

```bash
cd "$P4_ROOT"
mkdir -p secrets/tls
export ITS_TLS_SAN="IP:10.174.96.95"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out secrets/tls/development-ca.key
openssl req -x509 -new -sha256 -days 825 \
  -key secrets/tls/development-ca.key \
  -config scripts/openssl-development.cnf -section req \
  -subj "/CN=ITS Development CA" -extensions ca_ext \
  -out secrets/tls/development-ca.crt
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out secrets/tls/server.key
openssl req -new -sha256 -key secrets/tls/server.key \
  -config scripts/openssl-development.cnf -section req \
  -out secrets/tls/server.csr
openssl x509 -req -sha256 -days 397 -in secrets/tls/server.csr \
  -CA secrets/tls/development-ca.crt -CAkey secrets/tls/development-ca.key \
  -CAcreateserial -copy_extensions copy -out secrets/tls/server.crt
rm -f secrets/tls/server.csr secrets/tls/development-ca.srl
openssl verify -CAfile secrets/tls/development-ca.crt secrets/tls/server.crt
```

Install `development-ca.crt` into every operator browser and Android device
that will connect. Install Nginx, then validate and start the checked-in
configuration:

```bash
nginx -p "$P4_ROOT/deploy/nginx/" -t -c nginx.conf
nginx -p "$P4_ROOT/deploy/nginx/" -c nginx.conf
curl --fail --cacert "$P4_ROOT/secrets/tls/development-ca.crt" \
  https://10.174.96.95:39001/health/live
curl --fail --cacert "$P4_ROOT/secrets/tls/development-ca.crt" \
  https://10.174.96.95:39002/
curl --fail --cacert "$P4_ROOT/secrets/tls/development-ca.crt" \
  https://10.174.96.95:39001/operator/
```

The expected browser URL is `https://10.174.96.95:39001/operator/`. Live View is
embedded in the dashboard in the same tab from the HTTPS Vision origin on port
`39002`. A video stream will remain empty
until an Android publisher is connected to the relay; the backend health checks
can still pass before that publisher is present.

## 8. Optional live BIMS and Android publisher

For live buses, edit the one env file, change `TELEMETRY_MODE=live`, add the
BIMS service key, then restart route/tracking. For Android, configure the APK's
`relay.url` to the HTTPS ingress URL and configure TURN credentials as described
in [COTURN_SETUP.md](../../services/vision/COTURN_SETUP.md). When recording is
enabled, configure both Trip ID and Vehicle ID in the Android publisher; Node
validates that the trip is active for that vehicle before the relay records.
Without valid context, live streaming continues and the relay reports recording
inactive. Do not put TURN, BIMS, or recording secrets in Git.

## Definition of done

The stack is up only when all of these succeed from a separate shell:

```bash
curl --fail --cacert "$P4_ROOT/secrets/tls/development-ca.crt" https://10.174.96.95:39001/health/live
curl --fail --cacert "$P4_ROOT/secrets/tls/development-ca.crt" https://10.174.96.95:39002/
curl --fail --cacert "$P4_ROOT/secrets/tls/development-ca.crt" https://10.174.96.95:39001/operator/
if [[ "${RECORDING_ENABLED:-false}" == true ]]; then
  curl --fail --cacert "$P4_ROOT/secrets/tls/development-ca.crt" https://10.174.96.95:39004/
fi
curl --fail http://127.0.0.1:"$ROUTING_PORT"/health/ready
curl --fail http://127.0.0.1:39012/healthz
```

Also confirm the Vision log uses `cuda:0`, the route service reports the
selected telemetry mode, and Nginx exposes no raw application port to the LAN.
GPU-dependent vision tests and Android device-streaming tests are intentionally
not part of this runbook.
