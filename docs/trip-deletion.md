# Trip row actions

Each trip row has a **⋮** menu for admins and operators:

- READY, IN_PROGRESS or PAUSED: **운행 취소**.
- COMPLETED or CANCELLED: **운행 삭제**.

Viewers cannot perform either action. Cancel an active trip before deleting it.
Cancellation keeps its history and recordings.

Deletion first loads the finalized recording snapshot. Confirmation names the
Trip ID, recording count and data that will be removed. The dashboard deletes
those recordings through the existing bounded recording-deletion API, then
calls `DELETE /api/v1/trips/:tripId` to remove the entry. Recording failures stop
the workflow; the trip stays available for a retry. New uploads are excluded
from the confirmed snapshot and block entry deletion if their metadata arrives
before the database transaction. This does not purge unregistered relay spool
files or uploads that have not yet registered with Node.

The entry API locks the trip row, requires a terminal state, and refuses to
delete a trip that still has managed recording metadata. It removes routes,
deviations, their alerts, trip completion alerts, replay detection samples and
the trip in one transaction. GPS positions, object detections (and their images
and alerts), vehicles, replay dataset previews and transport goals are retained;
their optional trip links are cleared. Failed legacy video references can be
removed with the entry; external legacy files are not managed or deleted here.
Trip/deviation alerts are deleted rather than detached because the database
requires each alert to retain exactly one cause.

The dashboard refreshes the trip list and recording picker after an action.
Deleting the displayed trip clears its playback and route. Confirmation is
required in the UI; recording and trip deletion controls prevent overlapping
deletions while the operation runs.

## Deployment and checks

No migration, dependency change or additional network port is needed. Dev
`p4-node` runs `tsx watch src/server.ts` and mounts `node/src` and `operator-web`
as directories. Update the checkout and reload the dashboard; no image rebuild
or container recreation is needed. The individually mounted tsconfig and
entrypoint are unchanged.

Verify the effective code on the deployment host before claiming it is active:

```bash
docker compose -f docker-compose.dev.yml exec -T p4-node node --input-type=module -e "const doc = await (await fetch('http://127.0.0.1:3000/openapi.json')).json(); if (!doc.paths['/api/v1/trips/{tripId}']?.delete) throw new Error('Trip deletion API missing'); console.log('Trip deletion API active');"
docker compose -f docker-compose.dev.yml exec -T p4-node node -e "const fs=require('node:fs'); if (!fs.readFileSync('/workspace/operator-web/app.js','utf8').includes('createTripActions') || !fs.existsSync('/workspace/operator-web/trip-actions.js')) throw new Error('Trip menu missing'); console.log('Trip menu files present');"
```

Tests cover role restrictions, active/missing trip rejection, recording
dependency checks, trip-scoped cleanup and history preservation, transaction
failure propagation, confirmation cancellation and recording cleanup order.
Database operations are mocked. The local test database is unavailable, so real
PostgreSQL transaction/FK behavior has not been executed here. The TypeScript
build and JavaScript syntax checks pass; visual and live deployment verification
remain outstanding because no browser is available.
