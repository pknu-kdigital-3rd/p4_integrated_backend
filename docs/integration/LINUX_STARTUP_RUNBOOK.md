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
| Node control API + operator files | `node/` | Node/npm | `127.0.0.1:3000` | `/health/live`, `/health/ready` |
| Route/tracking + A* | `services/routing-tracking/` | Python/uv | `127.0.0.1:8000` | `/health/live`, `/health/ready` |
| Go media relay | `services/media-relay/` | Go | `127.0.0.1:39012` | `/healthz`, `/internal/status` |
| Vision live-view/inference | `services/vision/` | Python/uv + CUDA | `127.0.0.1:39011` | `/health/live` |
| Operator HTTPS ingress | `deploy/nginx/` | Nginx | `:39001` | HTTPS curl checks |
| Vision/WSS/signaling HTTPS ingress | `deploy/nginx/` | Nginx | `:39002` | HTTPS curl checks |

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
Useful lifecycle commands are:

```bash
./scripts/run-linux-stack.sh status
./scripts/run-linux-stack.sh stop
./scripts/run-linux-stack.sh start
./scripts/run-linux-stack.sh down
```

Logs and PID files are kept under the ignored `.runtime/` directory. `stop`
leaves PostgreSQL running; `down` stops it too. The script may prompt for
`sudo` when validating, starting, reloading, or stopping Nginx.

## 0. One-time host prerequisites

Install and verify Docker Engine/Compose, `uv`, Node/npm, Go, OpenSSL, and
`curl`. Python must be 3.10 or newer. Do not run the GPU test suite on a host
that is not the original test environment; the CUDA check below is only a
runtime prerequisite check.

```bash
docker --version
docker compose version
uv --version
node --version
npm --version
go version
openssl version
curl --version
nvidia-smi
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

Set `P4_ROOT` to the real checkout path. If the server address is not
`10.174.96.95`, change `PUBLIC_OPERATOR_URL`, `VISION_PUBLIC_BASE_URL`,
`LIVE_VIEW_URL`, the `server_name` in `deploy/nginx/nginx.conf`, `TURN_URL`,
and the certificate SAN together. For a local smoke test without BIMS, leave
`TELEMETRY_MODE=playback`. For live BIMS, set
`TELEMETRY_MODE=live` and add `BUSAN_BIMS_SERVICE_KEY`.

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

## 3. Start the Node control API

Use a new shell, source the same environment file, and run:

```bash
cd "$P4_ROOT"
set -a; source deploy/env.local; set +a
cd node
npm ci
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
that is expected. A failed health check is not expected.

## 6. Start Vision (Python WebRTC/YOLO service)

Start the relay before Vision so the initial relay-status query succeeds. Use
another shell:

```bash
cd "$P4_ROOT"
set -a; source deploy/env.local; set +a
cd services/vision
uv sync
uv run python -c 'import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0)); print(torch.cuda.get_arch_list())'
uv run python run.py --no-tls
```

`uv sync` installs the CUDA PyTorch wheels declared by this service. The
runtime check must print the RTX 3090 and the process must log
`YOLO inference device: cuda:0`. The first model load may download
`yolo26s-seg.pt`; allow that download to finish.

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
sudo nginx -p "$P4_ROOT/deploy/nginx/" -t -c nginx.conf
sudo nginx -p "$P4_ROOT/deploy/nginx/" -c nginx.conf
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
in [COTURN_SETUP.md](../../services/vision/COTURN_SETUP.md). Do not put TURN or
BIMS secrets in Git.

## Definition of done

The stack is up only when all of these succeed from a separate shell:

```bash
curl --fail --cacert "$P4_ROOT/secrets/tls/development-ca.crt" https://10.174.96.95:39001/health/live
curl --fail --cacert "$P4_ROOT/secrets/tls/development-ca.crt" https://10.174.96.95:39002/
curl --fail --cacert "$P4_ROOT/secrets/tls/development-ca.crt" https://10.174.96.95:39001/operator/
curl --fail http://127.0.0.1:"$ROUTING_PORT"/health/ready
curl --fail http://127.0.0.1:39012/healthz
```

Also confirm the Vision log uses `cuda:0`, the route service reports the
selected telemetry mode, and Nginx exposes no raw application port to the LAN.
GPU-dependent vision tests and Android device-streaming tests are intentionally
not part of this runbook.
