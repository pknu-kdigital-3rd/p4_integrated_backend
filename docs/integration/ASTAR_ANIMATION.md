# Virtual route search replay

In the virtual workspace, select an available vehicle and set the origin,
waypoints, and destination. After the draft is ready, press **A* 탐색 보기**.
The server recalculates that draft with tracing enabled, then the browser
replays discovered roads (amber), expanded roads (blue), and the final route
(green). Pause, replay, stop, and 0.5×/1×/2× controls affect playback only.
Reduced-motion users see the result immediately.

The button is for undispatched drafts. Changing the route points, vehicle,
scenario, road restrictions, or workspace cancels the animation. Stop restores
the normal preview line. No draft, trip, or vehicle state is written by tracing.

## API and limits

`POST /api/v1/virtual/scenarios/:scenarioId/routes/search-trace` requires an
ADMIN or OPERATOR token and `{draftId, expectedRestrictionRevision}`. The
response uses the normal `{data: ...}` envelope and contains the recalculated
route, draft ID, restriction revision, and `searchTrace`.

The internal route request accepts optional `includeSearchTrace` (default
false). Trace events are ordered successful frontier updates (`discovered`)
and non-stale heap expansions (`expanded`), including the destination.
Each event includes its edge-state ID, zero-based waypoint-leg index, edge
reference, and `g`/`h` travel-time costs in seconds. State IDs preserve incoming
OSM ways so restricted turns do not collapse into a node-only search.
`edges` maps references to directed road geometry in `[longitude, latitude]`
order. Counts cover the whole search, including events omitted by the budget.

Collection stops at 5,000 events or 20,000 geometry vertices across all legs,
but A* continues to completion. `truncated` marks a partial exploration replay;
the final route remains complete. Normal routing does not collect traces.
`ROUTE_NOT_FOUND` includes the partial trace in error details. Obsolete graph
versions, restriction revisions, expired drafts, and dispatched drafts are
rejected before playback.

## Production rollout

Node includes the dashboard assets and compiled API in its image. Routing
includes its Python source in its image. Their production bind mounts contain
JWT material and routing state, respectively; they do not mount application
source. Rebuild both images. Nginx has an individual configuration-file bind
mount and static service upstreams; recreate it after the application
containers to refresh those upstream addresses. Its image inputs are unchanged.

Run from the repository root with the existing production env file:

```bash
docker compose --env-file /path/to/prod.env -f docker-compose.prod.yml up -d --no-deps --build --force-recreate p4-node p4-routing
docker compose --env-file /path/to/prod.env -f docker-compose.prod.yml up -d --no-deps --no-build --force-recreate p4-nginx
docker exec p4-node node -e "const fs=require('fs'); console.log(fs.readFileSync('/workspace/operator-web/astar-animation.js','utf8').includes('installSearchAnimation'))"
docker exec p4-routing python -c "from main import InternalRouteRequest; print('includeSearchTrace' in InternalRouteRequest.model_fields)"
docker exec p4-nginx nginx -T
```

The two file checks must print `true` and `True`. Hard-refresh the dashboard,
create a virtual draft, and verify the trace request returns 200 and the two
animation stages appear. Check `/var/log/nginx/its-access.log` for that request
and confirm its upstream IP belongs to the running `p4-node` container, on port
3000. These runtime checks are required before calling deployment active.
No database migration or Vision dependency change is required.
