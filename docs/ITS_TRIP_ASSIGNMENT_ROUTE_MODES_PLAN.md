# Trip assignment and route display modes

## User flow

The operator selects a vehicle and a route mode in Settings before creating a trip. The mode is saved on the trip. Android fetches the vehicle's assigned trip and exposes Start Trip and Stop Trip separately from Start Streaming and Stop Streaming. A stream without an active trip remains live-only.

| Mode | Destination | Map | Progress |
| --- | --- | --- | --- |
| Optimal + Android replay (default) | Operator-chosen point | Optimal route and labeled replay path together | Fresh real GPS on the optimal route; replay never counts as real progress |
| Android replay only | Exact final GPS record in the selected Android dataset | Replay path only | Distance through the prerecorded path, labeled GPS replay |

Android uploads a bounded GPS path preview when a dataset is selected. The preview contains a dataset fingerprint, exact first and final fixes, timestamps, cumulative distance, and simplified display points. CSV and IMU data remain on the device. Replay-only assignment requires a preview, pins it to the trip, and requires the same dataset when Android starts that trip. Changing the Settings selection affects only later trips.
Dual mode follows the latest preview for the vehicle, so a later Android dataset selection updates the orange replay path without changing the optimal destination.

## Implementation

- Persist route mode and optional replay preview on trips. Create an optimal route with the routing service for dual mode. Derive replay-only origin and destination on the server from the pinned preview. Reject routing failure or a second ready/running/paused assignment for the same vehicle.
- Add Android-facing endpoints for preview upload, current assignment lookup, and READY → IN_PROGRESS → COMPLETED transitions. Keep the requested saved manual Trip ID fallback. Add authenticated operator cancellation for an incorrect assignment.
- Add the route-mode selector to operator Settings and reflect it in the assignment form. Show the pinned preview and destination before replay-only assignment. Keep the actual BIMS marker distinct from the replay cursor; never reroute from prerecorded GPS.
- Add Android trip controls and upload the preview on dataset selection. Reconcile stream recording context when a trip starts, completes, or is cancelled while streaming; video streaming itself remains independent.

## Acceptance

- Dual mode accepts an arbitrary destination and displays both differing paths without treating replay GPS as real progress.
- Replay-only mode derives the destination from the final GPS sample, draws no optimal route, and displays labeled replay progress.
- A missing preview blocks replay-only assignment. Switching datasets after assignment blocks trip start. Completing early does not force 100% progress.
- Assignment conflicts, operator cancellation, and manual ID fallback work with and without an active stream.

Device calls use the saved Vehicle ID alone, as requested. A client that knows that ID and can reach the device API can change its trip state.

## Rollout

For the development Compose stack, rebuild `p4-node` and `p4-nginx`, run the existing `p4-node-migrate` service to apply the new table and trip columns, and install the rebuilt Android app. The routing service does not need a code rebuild for this feature.
