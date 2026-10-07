# Virtual route search replay

In the virtual workspace, select an available vehicle and set the origin,
waypoints, and destination. After the draft is ready, choose **A***, **Dijkstra**,
or **Greedy best-first**, then press **탐색 보기**.
The server recalculates that draft with the selected algorithm and tracing enabled, then the browser
replays discovered roads (amber), expanded roads (blue), and the final route
(green). Choose 0.1×/0.25×/0.5×/1×/2× speed before starting or during playback.
At 1×, exploration takes about 20 seconds and the final route takes 5 seconds.
Pause, replay, stop, and speed controls affect playback only. Reduced-motion
users initially see the result immediately; pressing replay explicitly starts
the animation from the beginning at the selected speed.

During zoom transitions, playback pauses and the canvas briefly hides, then
redraws at the new zoom level. Panning, resizing, and zooming also update paused
and completed overlays without restarting the search.

Exploration uses persistent discovered/expanded canvas caches. Each frame paints
only newly discovered or expanded roads, then composites the caches beneath the
final route. Map view changes rebuild the caches; normal playback does not
redraw the entire exploration history. Road geometry is projected on demand
and reused until the zoom changes.

The button is for undispatched drafts. Changing the route points, vehicle,
scenario, road restrictions, or workspace cancels the animation. Stop restores
the normal preview line. Changing the algorithm cancels the current animation
and requires a new trace. No draft, trip, or vehicle state is written by tracing.

A* prioritizes `g + h`, Dijkstra prioritizes `g`, and greedy best-first prioritizes
`h` and does not reopen expanded states. All use directed roads, travel-time
costs, vehicle profiles, closures, penalties, and incoming-way turn context.
Greedy may produce a longer route. These are comparison animations; dispatch
continues to use the saved A* preview.

## API and limits

`POST /api/v1/virtual/scenarios/:scenarioId/routes/search-trace` requires an
ADMIN or OPERATOR token and `{draftId, expectedRestrictionRevision, algorithm?}`.
`algorithm` accepts `astar` (default), `dijkstra`, or `greedy`. The
response uses the normal `{data: ...}` envelope and contains the recalculated
route, draft ID, restriction revision, and `searchTrace`.

The internal route request accepts optional `includeSearchTrace` (default
false) and `searchAlgorithm` (default `astar`, applied only to trace requests).
Trace metadata includes `algorithm`. Animation requests allow up to 60 seconds
for routing. Trace events are ordered successful frontier updates (`discovered`)
and non-stale heap expansions (`expanded`), including the destination.
Each event includes its edge-state ID, zero-based waypoint-leg index, edge
reference, and `g`/`h` travel-time costs in seconds. State IDs preserve incoming
OSM ways so restricted turns do not collapse into a node-only search.
`edges` maps references to directed road geometry in `[longitude, latitude]`
order. Counts cover the whole search, including events omitted by the budget.

Collection stops at 100,000 events or 400,000 geometry vertices across all legs,
but the selected search continues to completion. `truncated` marks a partial exploration replay;
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
