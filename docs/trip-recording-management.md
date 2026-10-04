# Trip recording management

In the operator dashboard, open **운행 영상 → 저장된 녹화 → 운행별 녹화 관리**.
The library lists trips that have recording metadata, newest trip ID first,
with vehicle, destination, trip status, segment count, duration, storage size,
and stored recording status counts. Older trips load in pages of 50. Totals
describe registered metadata, not pending relay uploads or live recording state.

Choose **녹화 보기** to list finalized segments. **운행 재생** opens the existing
trip timeline and detection overlay. Each segment has a **다운로드** button that
generates a fresh, short-lived MP4 attachment URL. Downloads are individual
segments; no merged video is generated.

Admins and operators can choose **운행 녹화 전체 삭제** and confirm the exact
number of finalized segments. Viewers can browse, play and download but cannot
delete. This removes the confirmed segment objects and their replay detections,
while retaining the trip, GPS history and later uploads. Deletion runs in batches
of at most 50 selected IDs. Partial failures remain visible; refresh and retry
the remaining segments. Failed/legacy metadata is shown in status counts but is
not eligible for playback or finalized-segment deletion.

## API

- `GET /api/v1/recording-trips?beforeTripId=<cursor>`: trip summaries and
  `nextBeforeTripId` (null at the end).
- `POST /api/v1/trip-videos/:tripVideoId/download-url`: attachment URL using
  the configured playback expiration.
- `DELETE /api/v1/trips/:tripId/videos`: body
  `{"tripVideoIds":["11","12"]}`. All IDs must belong to this trip and be
  finalized before any deletion begins. Returns `deletedTripVideoIds` and
  per-segment `failures`. Newly registered segments are never implicitly selected.

## Development deployment

No database migration or dependency update is needed. Dev `p4-node` runs
`tsx watch src/server.ts` with directory binds for `node/src` and `operator-web`;
these edits are read from the checkout. Its individually mounted tsconfig and
entrypoint are unchanged. For a clean restart after updating the checkout:

```bash
docker compose -f docker-compose.dev.yml up -d --no-deps --force-recreate p4-node
docker compose -f docker-compose.dev.yml exec -T p4-node node --input-type=module -e "const doc = await (await fetch('http://127.0.0.1:3000/openapi.json')).json(); if (!doc.paths['/api/v1/recording-trips'] || !doc.paths['/api/v1/trips/{tripId}/videos']?.delete || !doc.paths['/api/v1/trip-videos/{tripVideoId}/download-url']) throw new Error('Recording management routes missing'); console.log('Recording management routes active');"
docker compose -f docker-compose.dev.yml exec -T p4-node node -e "const fs=require('node:fs'); if (!fs.readFileSync('/workspace/operator-web/app.js','utf8').includes('mountRecordingManagement')) throw new Error('Dashboard code missing'); if (!fs.existsSync('/workspace/operator-web/recording-management.js')) throw new Error('Recording library missing'); console.log('Dashboard files present');"
```

Reload the dashboard page after verification. These commands must run on the
deployment host; this change has not been verified in the running deployment.

## Validation

Targeted tests cover pagination and status totals, exact bigint storage totals,
trip-scoped deletion preflight, partial failures, MP4/detection cleanup, download
disposition, role enforcement and deletion snapshots across batches/new uploads.
Database and MinIO operations are mocked in those tests. The TypeScript build
and JavaScript syntax checks pass. No browser was available for visual or live
playback/download checks; test those against the deployed database and MinIO.
