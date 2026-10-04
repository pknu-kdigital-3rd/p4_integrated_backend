# Trip recording deletion

In the operator dashboard, open **운행 영상 → 저장된 녹화**, select a trip,
then expand **녹화 관리**. **운행 녹화 전체 삭제** sits beside **구간 삭제**.
Trip replay and range deletion use the existing timeline. There is no separate
trip recording library or download action.

Admins and operators can delete all loaded finalized recordings after confirming
the exact segment count. Viewers cannot delete. Whole-trip deletion includes
finalized segments without a usable playback duration. It removes the selected
segment objects and their replay detections while retaining the trip, GPS
history and later uploads. Failed/legacy metadata is not eligible for finalized
segment deletion.

Deletion runs in batches of at most 50 confirmed IDs. Partial failures remain
visible; the remaining recordings reload so they can be retried. Deletion
controls are disabled while a deletion is in progress. If the operator switches
trips during deletion, completion does not reload the old trip over the new one.

## API

`DELETE /api/v1/trips/:tripId/videos` accepts
`{"tripVideoIds":["11","12"]}`. All IDs must belong to the trip and be finalized
before any deletion begins. It returns `deletedTripVideoIds` and per-segment
`failures`. Newly registered segments are never implicitly selected. Existing
playback URLs and single-segment deletion remain supported.

## Development deployment

No database migration, dependency update or image rebuild is needed. Dev
`p4-node` runs `tsx watch src/server.ts` with directory binds for `node/src` and
`operator-web`; the changed files are loaded from the checkout. Update the
checkout and reload the dashboard page. Its individually mounted tsconfig and
entrypoint are unchanged. Recreating `p4-node` is optional for a clean restart.

Verify the effective files and route on the deployment host:

```bash
docker compose -f docker-compose.dev.yml exec -T p4-node node --input-type=module -e "const doc = await (await fetch('http://127.0.0.1:3000/openapi.json')).json(); if (!doc.paths['/api/v1/trips/{tripId}/videos']?.delete) throw new Error('Trip deletion route missing'); if (doc.paths['/api/v1/recording-trips'] || doc.paths['/api/v1/trip-videos/{tripVideoId}/download-url']) throw new Error('Removed routes still active'); console.log('Recording deletion routes active');"
docker compose -f docker-compose.dev.yml exec -T p4-node node -e "const fs=require('node:fs'); const html=fs.readFileSync('/workspace/operator-web/index.html','utf8'); if (!html.includes('recording-delete-trip') || html.includes('recording-trip-management')) throw new Error('Dashboard update missing'); console.log('Dashboard files present');"
```

This change has not been verified in the running deployment. Tests mock
database and MinIO operations and cover trip-scoped deletion preflight, partial
failures, MP4/detection cleanup, role enforcement, bounded deletion snapshots
and exclusion of later uploads. The TypeScript build and JavaScript syntax
checks pass. A browser was unavailable for visual or live playback checks.
