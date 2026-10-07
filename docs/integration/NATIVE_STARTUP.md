# Native server playback and Jupyter startup

Run the existing Vision, routing and Node services as ordinary user processes.
This mode needs no Docker daemon, Nginx, Android client, Go relay, Coturn or MinIO.
The inference pipeline and dependency locks are unchanged. A small Node gateway
provides HTTPS, map tile proxies and both application WebSockets on one port:

- `https://localhost:39001/operator/`: operator-web.
- `https://localhost:39001/live/`: server video, GPS/IMU and inference controls.

The Docker deployment remains available separately.

## Requirements

Use Linux with Python 3.10+ for the launcher, Node.js 22+, npm and `uv` on PATH.
`uv` creates separate Python 3.12 virtual environments under each service; it
does not replace packages in the Jupyter kernel. The Vision environment uses
`uv sync --frozen`, including the custom `.ultralytics-custom` checkout. Restore
that checkout and the model files before setup.

Vision's current lock targets Python 3.12, PyTorch 2.12.1+cu130,
torchvision 0.27.1+cu130 and xFormers 0.0.35 from the PyTorch CUDA 13.0 index.
TensorRT is 11.3.0.99 (`tensorrt-cu13`) from PyPI. Do not substitute a generic
PyPI xFormers wheel or the notebook's preinstalled Torch. Linux x86_64 Torch
and torchvision wheels require glibc 2.28+. The existing TensorRT engine must
also be compatible with the GPU and TensorRT runtime in this environment;
use the matching checkpoint/export workflow if it is not.

The Jupyter environment must already expose a compatible NVIDIA GPU and driver.
Docker access is unnecessary, but Python cannot grant access to a GPU hidden by
the notebook provider. `UNIDEPTH_COMPILE=true` also needs a C/C++ compiler and
Python 3.12 development headers, as the Vision Dockerfile installs. Routing's
locked `osmnx` extra may require native build tools. If these are unavailable,
ask the provider to supply them or use a suitable user-space environment.

The complete dashboard can run PostgreSQL 17 and PostGIS directly inside the
same existing Jupyter container. No Docker socket, nested containers or external
database are required. Set `NATIVE_LOCAL_DB=true` (the example's default).
`db-setup` installs matching PostgreSQL/PostGIS packages from conda-forge into
`.runtime/native/postgres-env` using an available conda, mamba or micromamba.
It does not change the notebook's base environment. If none is available,
install micromamba in your user environment first.

PostgreSQL must run as a non-root OS user. With an ordinary Jupyter user it
runs as that user. If Jupyter runs as root, `db-setup` creates a system
`postgres` account if missing and `useradd` is available; the launcher uses
`runuser` for PostgreSQL only. Override that account with `NATIVE_PG_RUN_AS`.
The checkout and PostgreSQL binaries must be accessible to that account;
a checkout under a private `/root` directory will need to be moved to an
accessible directory. Node and Vision continue as the Jupyter user.

The database listens on loopback with SCRAM password authentication. Data
persists in `.runtime/native/pgdata`, or the `NATIVE_PGDATA` path you specify.
Use a persistent Jupyter volume if it must survive container replacement.
Choose `NATIVE_PG_PORT` if 5432 is occupied. The launcher verifies the running
server's data directory before provisioning, so it does not use an unrelated
cluster on that port. Existing clusters are reused and never erased or
reinitialized; changing `POSTGRES_PASSWORD` later does not update their password.

For an already installed PostgreSQL/PostGIS distribution, set
`NATIVE_POSTGRES_BIN` to its bin directory and skip `db-setup`. The launcher
checks that distribution's `postgis.control` file. To use an external database
instead, set `NATIVE_LOCAL_DB=false` and provide `DATABASE_URL`; the
Docker-internal `p4-db` hostname is not reachable from a separate notebook.

The routing files, including `services/routing-tracking/busan-roads_osm.pbf`,
must be present. The BIMS key and AI assistant are optional; an existing
assistant can be configured with `ASSISTANT_BASE_URL`. This launcher does not
start the external LLM/embedding/MongoDB/Qdrant infrastructure.

## Setup and launch

From the project root:

```bash
cp deploy/native.env.example .env.native
# Edit .env.native: local database password, dataset and visible GPU indices.
python scripts/run-native-stack.py db-setup --env-file .env.native
python scripts/run-native-stack.py setup --env-file .env.native
python scripts/run-native-stack.py db-check --env-file .env.native
python scripts/run-native-stack.py db-init --env-file .env.native
python scripts/run-native-stack.py vision-check --env-file .env.native
python scripts/run-native-stack.py run --env-file .env.native
```

In local database mode, `db-check` and `db-init` temporarily start the cluster
if it is stopped. On the first start, the launcher initializes the cluster,
creates the selected database, enables PostGIS and verifies a geography query.
They stop their own temporary server afterward; a server already running for
this same data directory is left running. For external databases, `db-check`
only tests authentication and PostGIS. `db-init` applies the existing migrations
and seed data; it does not erase the database. `run` starts local PostgreSQL
before the application services and shuts it down with the stack.
The seed creates the existing development administrator (`admin` / `admin1234`)
if missing. Only run it against the database intended for this project.
`vision-check` validates both CSV files, decodes the actual video and executes
one frame through the configured YOLO/UniDepth models. Successful package
installation alone does not verify GPU inference.

Existing `env.local` files with `export KEY=value` are also accepted. Values
are read without executing shell code; variable substitutions and shell
commands are not evaluated. Later assignments win. The launcher disables
recording and Android ingestion, replaces Docker service addresses and maps
model paths beginning with `/workspace/` to this checkout. Set
`NATIVE_PUBLIC_URL` instead of the Docker public URL variables. In local database
mode, `DATABASE_URL` is constructed from `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB` and `NATIVE_PG_PORT` automatically.

JWT and self-signed HTTPS keys persist in `.runtime/native/`; logs are in
`.runtime/native/logs/`. Backend services bind to loopback. Press Ctrl+C to stop
the supervisor and all its children. If a child exits, the other children stop
and the launcher reports which log to inspect. Model startup may take time:

```bash
curl -k https://localhost:39001/health/vision
curl -k https://localhost:39001/health/routing
curl -k https://localhost:39001/health/ready
tail -n 100 .runtime/native/logs/vision.log
```

The gateway generates a self-signed certificate for its public hostname,
localhost and 127.0.0.1. Trust it on your browser computer or accept its warning
when opening the local page directly. If the public hostname changes, use a
matching certificate; restart after configuring the new origin.

## Preview without database access

```bash
python scripts/run-native-stack.py setup --env-file .env.native --vision-only
python scripts/run-native-stack.py vision-check --env-file .env.native
python scripts/run-native-stack.py run --env-file .env.native --vision-only
```

This starts Vision and the gateway only. `/live/` works; operator-web and the
fleet map require the full stack. This mode does not install or start PostgreSQL.

## Jupyter

Use a terminal in Jupyter for setup, or run the same commands from notebook
cells. Change to the checkout first. To launch without blocking a notebook cell:

```python
import subprocess
import sys
from pathlib import Path

project = Path('/home/kdt/p4_integrated_backend')  # your notebook's checkout
launcher = project / 'scripts/run-native-stack.py'
supervisor_log = (project / 'native-launcher.log').open('ab')
stack = subprocess.Popen(
    [sys.executable, str(launcher), 'run', '--env-file', str(project / '.env.native')],
    cwd=project, stdout=supervisor_log, stderr=subprocess.STDOUT,
)
supervisor_log.close()
print('Launcher PID:', stack.pid)
```

Check `stack.poll()` (`None` means the supervisor is still running), the log
files and the health URLs. Stop from a later cell:

```python
stack.terminate()
stack.wait(timeout=90)
```

Processes can be terminated by the Jupyter provider when the session stops.
This is a foreground supervisor, not a replacement for a persistent host
service manager.

## One ngrok URL for both pages

Set `NATIVE_PUBLIC_URL=https://YOUR-ASSIGNED-NGROK-DOMAIN` in `.env.native` and
restart the native launcher. Both preview and parent-origin checks use that
same URL automatically. Run ngrok in the same environment as the gateway:

```bash
ngrok http https://localhost:39001 --upstream-tls-verify=false
```

Open `https://YOUR-ASSIGNED-NGROK-DOMAIN/operator/` or `/live/`. No second ngrok
domain or tunnel is needed. Ngrok's free browser interstitial and transfer
limits still apply. The agent accepts the local self-signed certificate;
browsers receive ngrok's publicly trusted HTTPS certificate.

Alternatively set `NATIVE_TLS=false`, keep the HTTPS ngrok public URL, and use
`ngrok http http://localhost:39001`. Plain HTTP is then only between ngrok and
the loopback gateway. Remote WebCodecs still uses the public HTTPS URL.

For SSH access without changing the public URLs, use a SOCKS tunnel. For an
SSH local port forward, set `NATIVE_PUBLIC_URL=https://localhost:39001` and
forward just that one port to the gateway.

## Validation limits

The native gateway is tested with real HTTP, HTTPS and binary upgraded
connections. Database configuration, initialization/reuse, password handling,
port-conflict protection and service lifecycle have focused tests. Actual
Linux PostgreSQL/PostGIS package installation and spatial queries must still
pass `db-check` in the deployment environment. It must also pass `vision-check`:
Linux dependency installation and GPU inference cannot be inferred from
Windows tests or a successful import.
