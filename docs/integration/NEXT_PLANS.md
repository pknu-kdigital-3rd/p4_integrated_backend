# Next plans

After the integration baseline is verified in its deployment environment, implement `TRUCK_ROUTING_PLAN.md`. Optional follow-ups are a custom truck recording/import plan and, only if requirements change, a separate multi-stream media plan.

Android GPS/IMU telemetry follow-ups (v18 server integration is implemented):

- Run the end-to-end, multi-footage isolation, reconnect, and QR-loss scenarios on the deployment host with the Android replay build.
- Move BIMS position persistence out of `GET /api/v1/tracking/vehicles` into an ingest path (device GPS already persists independently of polling).
- Feed authoritative device GPS into route-deviation checks against the trip's current `OPTIMAL_PATH` route.
- Real Android sensors (`mode=LIVE`) reuse the same contract; historical IMU replay would need a dedicated time-series store, not `vehicle_position`.
