# Testing virtual routing with AIStor

Use this focused local setup to test virtual routes and road restrictions with
AIStor object storage, without starting Nginx, Vision, the media relay, or
Coturn. It needs PostgreSQL, routing, Node, and AIStor.

This uses the development Compose settings and credentials. Do not use them in
production.

## Prerequisites

- Docker Desktop with Linux containers enabled.
- The local Busan routing graph at
  `services/routing-tracking/busan-roads_osm.pbf`.
- The offline map assets at `data/map/`. If they are missing, prepare them with
  `scripts/prepare-offline-map.ps1` first.
- An AIStor Free single-node license saved as `data/minio.license`. See the
  [Docker operations guide](DOCKER_OPERATIONS.md) for license details.
- Docker Desktop can reach Quay to pull the pinned AIStor images.

No host npm installation is needed. Docker builds the Node image and its
dependencies.

Run the commands below in PowerShell from the repository root.

Confirm the license file is present before starting AIStor:

```powershell
Test-Path -PathType Leaf data/minio.license
```

This must print `True`. The bootstrap container installs the license before
creating the recording bucket.

## Start the required services

Start PostgreSQL, routing, and AIStor. This does not start Vision, the relay,
Coturn, or the web proxy:

```powershell
docker compose -f docker-compose.dev.yml up -d --build p4-db p4-routing p4-minio
```

Apply database migrations and seed the local development data. Docker builds
the Node image as needed:

```powershell
docker compose -f docker-compose.dev.yml run --build --rm p4-node-migrate
```

Create the recording bucket and service accounts in AIStor:

```powershell
docker compose -f docker-compose.dev.yml run --rm p4-minio-bootstrap
```

Run the Node API and dashboard on localhost:

```powershell
docker compose -f docker-compose.dev.yml run -d `
  --name p4-node-virtual-test `
  -p 3000:3000 `
  p4-node
```

Open `http://localhost:3000/operator/?workspace=virtual`.

## Exercise the restriction workflow

1. Open **Virtual Routing & Dispatch** and select or create a scenario.
2. Choose **Select roads** and left click visible road lines to add individual
   segments. Keep left clicking to add more; click a selected segment again to
   remove it. Right drag to pan the map while selecting.
3. To select a larger zone, choose **Draw area**, click at least three points
   around the area, then click **Finish area**. Road clicks and areas can be
   combined in one selection.
4. Click **Preview affected roads**. The page should report affected physical
   segments and directed routing edges, and highlight the affected roads.
5. Preview both **Blocked** and **Heavy penalty**. A blocked restriction that
   conflicts with an occupied virtual road should be unavailable; penalty
   roads use the dashed penalty color.
6. Activate a nonempty, activatable preview. Confirm it appears in **Active
   regions** and its roads stay highlighted. Remove the restriction afterward.

If preview returns zero routing segments, adjust the selection to overlap the
loaded routing graph. If the map has no roads or labels, check that `data/map/`
contains the prepared assets.

## Logs and cleanup

```powershell
docker compose -f docker-compose.dev.yml logs --tail 100 p4-db p4-routing p4-minio
docker logs --tail 100 p4-node-virtual-test
```

Stop and remove the temporary Node container, then stop the test services:

```powershell
docker rm -f p4-node-virtual-test
docker compose -f docker-compose.dev.yml stop p4-db p4-routing p4-minio
```

The test uses the development database and AIStor data volumes. Scenarios and
objects remain until removed through the app or the local data is reset.
