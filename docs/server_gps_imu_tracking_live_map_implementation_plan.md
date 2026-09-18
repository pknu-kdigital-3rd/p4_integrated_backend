# Server GPS/IMU Vehicle Tracking + Live Map Synchronization Implementation Plan

## 1. Goal

Implement the server side of the Android GPS/IMU telemetry pipeline so that:

1. Android sends simulated or real GPS/IMU telemetry over WebRTC.
2. The Go media relay receives and validates telemetry against the active stream identity.
3. GPS observations become authoritative server-side vehicle positions.
4. GPS observations are persisted to PostGIS without depending on the operator map polling endpoint.
5. The routing/tracking snapshot exposes Android/device-tracked vehicles alongside existing BIMS vehicles.
6. GPS/IMU telemetry is kept in a short source-timestamp timeline for video synchronization.
7. Vision associates telemetry with the source time of the live video.
8. The Vision live-view page shows telemetry beside the video.
9. The operator map updates the selected vehicle from the telemetry associated with the displayed video frame.
10. Existing 3-second fleet polling remains as the coarse fleet-overview path.

This plan assumes the Android implementation sends telemetry events derived from local CSV replay now and will later send the same logical telemetry contract from real Android sensors.

---

# 2. Important Architectural Rule

The server must not know or care that the current Android telemetry originates from local CSV files.

From the server's perspective:

```text
Android
   │
   │ WebRTC
   │
   ├── H.264 RTP
   ├── qr-events
   └── telemetry-events
             │
             ▼
          Go relay
             │
       normal telemetry
```

The only diagnostic distinction is:

```text
mode = REPLAY
```

versus future:

```text
mode = LIVE
```

The server processing contract should otherwise remain the same.

---

# 3. Current Project Findings

The implementation should build on the current project rather than create a parallel tracking system.

## 3.1 Go relay

Current files:

```text
services/media-relay/internal/signaling/handlers.go
services/media-relay/internal/broadcaster/broadcaster.go
services/media-relay/internal/yolofeed/yolofeed.go
services/media-relay/internal/recording/
services/media-relay/internal/config/config.go
services/media-relay/main.go
```

Current relevant behavior:

- Android's SDP offer already carries:
  - `tripId`
  - `vehicleId`
  - `recordingSessionId`
- Go validates this identity through Node when recording support is enabled.
- `Broadcaster.HandleDataChannel()` currently accepts only `qr-events`.
- QR events are paired with H.264 access units.
- Validated recording identity is already propagated into the YOLO/Vision feed.
- Go already has an internal HTTP client path to Node for recording validation and segment registration.

This means telemetry should extend the existing publisher/session identity rather than create a new device-identity system.

---

## 3.2 Routing/tracking service

Current files:

```text
services/routing-tracking/telemetry.py
services/routing-tracking/main.py
```

Current normalized telemetry type already has:

```text
external_id
latitude
longitude
speed_kmh
heading_deg
telemetry_source
observed_at_utc
route_progress_pct
source_metadata
```

Current sources are:

```text
BimsLiveSource
BimsPlaybackSource
```

Current `/internal/vehicles` returns the selected BIMS source only.

Therefore the routing service is already close to supporting a device source; it needs a device-relay source and a composite tracker rather than a second public tracking API.

---

## 3.3 Node tracking backend

Current files:

```text
node/src/modules/tracking/tracking.client.ts
node/src/modules/tracking/tracking.service.ts
node/src/modules/tracking/tracking.persistence.ts
node/src/modules/tracking/tracking.schema.ts
node/src/modules/tracking/tracking.router.ts

node/prisma/schema.prisma
node/prisma/sql/insertVehiclePosition.sql
node/prisma/sql/getLatestVehiclePosition.sql
```

Current `vehicle_position.telemetry_source` already supports:

```text
BIMS_LIVE
BIMS_REPLAY
DEVICE_GPS
RECORDED_GPS
```

The main problems are:

1. `tracking.service.ts` currently treats every `/internal/vehicles` observation as a BIMS vehicle and upserts:
   ```text
   vehicleSource = BIMS
   externalId = telemetry.external_id
   ```
2. `persistAuthoritativeObservations()` persists telemetry as a side effect of reading `/api/v1/tracking/vehicles`.
3. Device telemetry needs a real `vehicleId`, `tripId`, and `recordingSessionId`, not a fake BIMS identity.
4. Existing persistence lacks source-timeline fields required for video synchronization and replay diagnostics.

---

## 3.4 Vision service

Current files:

```text
services/vision/app/core/state.py
services/vision/app/services/yolo.py
services/vision/app/services/monocular.py
services/vision/app/api/playback.py
services/vision/index.html
```

Current relevant behavior:

- Vision receives:
  - `epoch`
  - `seq`
  - RTP PTS
  - QR source/capture timestamps
  - validated recording identity
- `InferenceFrame` already contains:
  - `qr_source_timestamp_ns`
  - `qr_capture_timestamp_ns`
  - `recording_identity`
- `QRResolver` already handles short missing-QR windows and rewind detection.
- playback frame metadata is generated centrally in `_frame_message()`.
- browser playback currently has a default 2-second prefetch target.

Telemetry should therefore be added to the existing live-frame metadata, not transported through an unrelated browser connection.

---

## 3.5 Operator web

Current file:

```text
operator-web/app.js
```

Current map behavior:

```text
GET /api/v1/tracking/vehicles
every 3000 ms
```

Current live-view behavior:

```text
operator page
   └── Vision iframe
```

The 3-second polling remains useful for fleet overview, but it is not appropriate for keeping the selected map marker visually synchronized with the displayed live video.

The Vision iframe should provide the selected live vehicle's synchronized telemetry directly to its parent page.

---

# 4. Is the Existing Sensor Information Sufficient?

Yes.

## GPS fields

Required/available:

```text
timestamp_ns
utc_epoch_ms
latitude
longitude
altitude_m
speed_mps
bearing_deg
horizontal_accuracy_m
```

These fields are enough for:

- map position
- speed display
- geographic heading
- accuracy/status display
- short-term movement prediction
- video/GPS synchronization
- historical position persistence

## IMU fields

Required/available:

```text
timestamp_ns
pitch_deg
roll_deg
yaw_deg
accuracy
```

These fields are enough for:

- live orientation display
- video/IMU synchronization
- future motion/orientation logic

Do not initially treat uncalibrated IMU yaw as geographic vehicle heading.

Use GPS `bearing_deg` for the map marker while moving.

---

# 5. Target End-to-End Architecture

```text
                              ANDROID
                    ┌──────────────────────┐
                    │ H.264 video          │
                    │ QR events            │
                    │ GPS + IMU telemetry  │
                    └──────────┬───────────┘
                               │ WebRTC
                               ▼
                         GO MEDIA RELAY
        ┌──────────────────────────────────────────────┐
        │ validated publisher context                 │
        │ tripId                                      │
        │ vehicleId                                   │
        │ recordingSessionId                          │
        │                                             │
        │ telemetry parser / validator                │
        │ telemetry current state + bounded history   │
        └─────────┬──────────────────┬────────────────┘
                  │                  │
        GPS persistence path         │ full GPS/IMU batches
                  │                  │
                  ▼                  ▼
               NODE              VISION
                  │                  │
            PostgreSQL              │ source timestamp match
            PostGIS                 │
                  │                  ▼
                  │            live frame metadata
                  │                  │
                  │                  ▼
                  │             Vision iframe
                  │                  │
                  │            postMessage()
                  │                  │
                  └──────────────┐   │
                                 ▼   ▼
                           OPERATOR WEB
                       ┌──────────────────┐
                       │ fleet map        │
                       │ selected marker  │
                       │ live video       │
                       │ GPS/IMU status   │
                       └──────────────────┘

                         ROUTING/TRACKING
                              ▲
                              │ current device snapshot
                              │ from Go relay
                              │
                         Go internal API
```

Two distinct uses of telemetry must remain separate:

```text
authoritative observations
    -> PostGIS / fleet tracking

source-time-matched telemetry
    -> live video synchronization
```

Do not write interpolated/predicted display positions as real GPS observations.

---

# 6. Canonical Telemetry Contract

The Android and server implementations must agree on one versioned contract.

## 6.1 Incoming DataChannel batch

Example:

```json
{
  "type": "telemetry_batch",
  "version": 1,
  "mode": "REPLAY",

  "trip_id": "102",
  "vehicle_id": "3",
  "recording_session_id": "abc-123",

  "source_clock_ns": 1445245922681115,

  "gps": [
    {
      "timestamp_ns": 1445245922681115,
      "utc_epoch_ms": 1787803384795,
      "latitude": 35.1329082,
      "longitude": 129.1070557,
      "altitude_m": 47.3,
      "speed_mps": 0.7153028,
      "bearing_deg": 89.954605,
      "horizontal_accuracy_m": 2.8
    }
  ],

  "imu": [
    {
      "timestamp_ns": 1445245922620000,
      "pitch_deg": -3.7,
      "roll_deg": -2.1,
      "yaw_deg": -30.7,
      "accuracy": 3
    }
  ]
}
```

---

## 6.2 Identity is server-authoritative

Android may include:

```text
trip_id
vehicle_id
recording_session_id
```

for diagnostics.

However, Go must **not trust these values**.

The canonical identity comes from the validated SDP offer context.

If payload identity differs from the active validated stream identity:

```text
reject the telemetry batch
increment diagnostic counter
log a bounded warning
```

Do not let a DataChannel packet assign itself to another vehicle/trip/session.

---

## 6.3 Telemetry mode mapping

For persistence:

```text
REPLAY -> RECORDED_GPS
LIVE   -> DEVICE_GPS
```

This lets the same pipeline support today's CSV-driven Android simulator and future real Android sensors.

---

# 7. Go Relay Implementation

Create a dedicated telemetry package.

Suggested structure:

```text
services/media-relay/internal/telemetry/
├── types.go
├── validate.go
├── store.go
├── node_sink.go
├── vision_sink.go
└── metrics.go
```

Tests:

```text
services/media-relay/internal/telemetry/
├── validate_test.go
├── store_test.go
├── node_sink_test.go
└── vision_sink_test.go
```

---

# 8. Go Telemetry Types

Implement explicit structs rather than passing arbitrary maps.

Example conceptual types:

```go
type Mode string

const (
    ModeReplay Mode = "REPLAY"
    ModeLive   Mode = "LIVE"
)

type GPSSample struct {
    TimestampNS         int64
    UTCEpochMS          *int64
    Latitude            float64
    Longitude           float64
    AltitudeM           *float64
    SpeedMPS            *float64
    BearingDeg          *float64
    HorizontalAccuracyM *float64
}

type IMUSample struct {
    TimestampNS int64
    PitchDeg    float64
    RollDeg     float64
    YawDeg      float64
    Accuracy    *int
}

type Batch struct {
    Type               string
    Version            int
    Mode               Mode
    TripID             string
    VehicleID          string
    RecordingSessionID string
    SourceClockNS      int64
    GPS                []GPSSample
    IMU                []IMUSample
}

type StreamIdentity struct {
    TripID             int64
    VehicleID          int64
    RecordingSessionID string
}
```

---

# 9. Go Input Validation

Reject invalid telemetry before it enters shared state.

## Batch validation

Require:

```text
type == telemetry_batch
version == 1
mode in REPLAY|LIVE
non-empty GPS or IMU
bounded number of samples
```

Initial safe limits:

```text
GPS <= 16 samples per message
IMU <= 64 samples per message
JSON payload <= existing practical DataChannel limit
```

Use named constants.

## GPS validation

Require:

```text
timestamp_ns > 0
-90 <= latitude <= 90
-180 <= longitude <= 180
speed_mps >= 0 when present
0 <= bearing_deg < 360 when present
horizontal_accuracy_m >= 0 when present
finite numeric values
```

Do not reject a GPS fix merely because accuracy is poor.

Preserve it but mark it as low quality downstream.

## IMU validation

Require:

```text
timestamp_ns > 0
finite pitch/roll/yaw
reasonable bounded serialized values
```

Do not normalize yaw into geographic heading here.

---

# 10. Make Publisher Context Available to DataChannel Handling

Current signaling uses:

```go
pc.OnDataChannel(h.broadcaster.HandleDataChannel)
```

Change this so the handler receives the peer connection and validated stream context.

Conceptually:

```go
pc.OnDataChannel(func(channel *webrtc.DataChannel) {
    h.broadcaster.HandleDataChannel(pc, recordingContext, channel)
})
```

This is important for two reasons:

1. telemetry must be associated with the validated trip/vehicle/session
2. a stale/replaced peer connection must not continue injecting telemetry

`Broadcaster.HandleDataChannel()` should reject events from a connection that is no longer the active publisher once publisher ownership is established.

Keep the existing QR behavior working.

---

# 11. Decouple Stream Identity Validation from Recording Storage

Current Go creates the Node validation client only when:

```text
RECORDING_ENABLED=true
```

Telemetry needs a validated trip/vehicle/session even if video recording is temporarily disabled.

Refactor configuration so publisher-context validation can exist independently.

Suggested configuration:

```text
ANDROID_TELEMETRY_ENABLED=true
NODE_INTERNAL_BASE_URL=http://127.0.0.1:3000
NODE_INTERNAL_SERVICE_TOKEN=...
```

Validation rule:

```text
if recording enabled OR Android telemetry enabled:
    Node internal base URL/token must be valid
```

Reuse `/internal/recordings/validate` initially if it already correctly validates:

```text
tripId
vehicleId
recordingSessionId
```

A later cleanup may rename this to a generic stream/session validation endpoint.

Do not block this implementation on that rename.

---

# 12. DataChannel Routing

Extend `Broadcaster.HandleDataChannel()`:

```text
qr-events
    -> existing QR handler

telemetry-events
    -> telemetry parser
    -> validated stream identity
    -> TelemetryStore.Ingest()
```

Unknown channel labels remain ignored.

The WebRTC callback must never block on:

```text
PostgreSQL
Node HTTP
Vision HTTP
disk
```

All downstream work must use bounded asynchronous queues/workers.

---

# 13. Go Telemetry Store

Implement an in-memory, bounded source-timestamp store.

Key:

```text
recordingSessionId
```

Also retain:

```text
tripId
vehicleId
mode
```

Per active session store:

```text
latest GPS
latest IMU
bounded GPS history
bounded IMU history
last receive time
```

Suggested initial history:

```text
GPS:  30 seconds
IMU:  10 seconds
```

or equivalent bounded sample counts.

This is small enough for the current rates and useful for diagnostics/resynchronization.

Do not store raw 1000 Hz IMU here.

---

# 14. Telemetry Store Session Rules

## New active publisher/session

When a newly validated publisher becomes active:

```text
activate session identity
clear stale telemetry from a replaced session
```

## WebRTC reconnect using same recordingSessionId

Preserve short telemetry history only if it is clearly the same logical session.

Do not mix history from a different:

```text
tripId
vehicleId
recordingSessionId
```

## Replaced publisher

Old DataChannels must no longer mutate active telemetry state.

---

# 15. Go -> Node GPS Persistence Path

GPS persistence must happen when GPS observations arrive.

Do **not** depend on someone calling:

```text
GET /api/v1/tracking/vehicles
```

to trigger database writes.

Create a Node internal endpoint:

```text
POST /internal/telemetry/gps
```

Protected by:

```text
X-Internal-Service-Token
```

Example request:

```json
{
  "mode": "REPLAY",
  "tripId": "102",
  "vehicleId": "3",
  "recordingSessionId": "abc-123",
  "receivedAt": "2026-09-18T02:40:15.123Z",
  "samples": [
    {
      "sourceTimestampNs": "1445245922681115",
      "utcEpochMs": "1787803384795",
      "latitude": 35.1329082,
      "longitude": 129.1070557,
      "altitudeM": 47.3,
      "speedMps": 0.7153028,
      "bearingDeg": 89.954605,
      "horizontalAccuracyM": 2.8
    }
  ]
}
```

Use JSON strings for nanosecond/64-bit integer identifiers where JavaScript number precision would be unsafe.

---

# 16. Go Node Sink Queue

GPS is only roughly 1 Hz, so preserve it more strongly than high-rate IMU.

Implement a bounded GPS persistence worker.

Suggested behavior:

```text
DataChannel callback
    -> enqueue GPS persistence job
    -> return immediately

worker
    -> POST Node
```

On temporary Node failure:

```text
retry with bounded exponential backoff
```

Do not block WebRTC.

Because the rate is low, a queue of a few hundred GPS observations is already several minutes of capacity.

If the queue overflows:

```text
log error
increment dropped_gps_persistence_total
prefer dropping oldest already-stale replay item rather than blocking media
```

Do not implement an unbounded queue.

---

# 17. Go -> Vision Telemetry Path

Vision needs both GPS and processed IMU.

Add:

```text
POST /internal/telemetry
```

to Vision.

Configure Go with:

```text
PY_TELEMETRY_URL=http://127.0.0.1:39011/internal/telemetry
```

Go forwards validated, canonicalized telemetry batches.

The forwarded identity must come from the trusted offer context, not directly from Android payload fields.

Example:

```json
{
  "mode": "REPLAY",
  "tripId": "102",
  "vehicleId": "3",
  "recordingSessionId": "abc-123",
  "sourceClockNs": "1445245922681115",
  "gps": [...],
  "imu": [...]
}
```

---

# 18. Vision Sink Backpressure

The Vision telemetry path is latency-oriented.

Use a bounded worker queue.

Policy:

```text
GPS:
    preserve current/new fix when practical

IMU:
    if overloaded, discard/coalesce stale batches rather than accumulate delay
```

A delayed 5-second IMU queue is worse than dropped old orientation samples.

Expose metrics:

```text
telemetry_batches_received_total
telemetry_batches_forwarded_vision_total
telemetry_batches_dropped_vision_total
gps_persistence_jobs_total
gps_persistence_failures_total
```

---

# 19. Go Internal Current-Telemetry API

The routing/tracking service needs a source-neutral way to obtain the current device location.

Add an internal relay endpoint:

```text
GET /internal/telemetry/vehicles
```

Example:

```json
{
  "generated_at_utc": "2026-09-18T02:40:15.500Z",
  "vehicles": [
    {
      "external_id": "device:3",
      "latitude": 35.1329082,
      "longitude": 129.1070557,
      "speed_kmh": 2.575,
      "heading_deg": 89.95,
      "telemetry_source": "RECORDED_GPS",
      "observed_at_utc": "2026-08-26T...",
      "route_progress_pct": null,
      "source_metadata": {
        "vehicleId": "3",
        "tripId": "102",
        "recordingSessionId": "abc-123",
        "sourceTimestampNs": "1445245922681115",
        "horizontalAccuracyM": 2.8,
        "receivedAt": "2026-09-18T02:40:15.123Z",
        "mode": "REPLAY"
      }
    }
  ],
  "warnings": []
}
```

`external_id` is only a normalized tracking-contract key.

Node must not turn `device:3` into a new BIMS vehicle.

---

# 20. Routing/Tracking Device Source

Modify:

```text
services/routing-tracking/telemetry.py
services/routing-tracking/main.py
```

Add:

```python
class DeviceRelaySource:
    ...
```

It reads:

```text
GET http://127.0.0.1:39012/internal/telemetry/vehicles
```

using a short timeout.

Add environment configuration:

```text
MEDIA_RELAY_INTERNAL_BASE_URL=http://127.0.0.1:39012
```

Do not fail the whole BIMS snapshot if the relay is temporarily unavailable.

Instead return a warning and continue with BIMS observations.

---

# 21. Composite Telemetry Source

Replace the one-source-only `VehicleTracker` setup with a composite source.

Conceptually:

```text
CompositeTelemetrySource
   ├── BimsLiveSource or BimsPlaybackSource
   └── DeviceRelaySource
```

Snapshot:

```text
BIMS observations
+
device observations
```

Device identity wins only for the actual configured device vehicle; do not globally suppress unrelated BIMS observations.

Avoid duplicate device observations for the same:

```text
vehicleId + recordingSessionId
```

---

# 22. Node Internal Telemetry Module

Create:

```text
node/src/modules/telemetry/
├── telemetry.schema.ts
├── telemetry.controller.ts
├── telemetry.service.ts
├── telemetry.persistence.ts
├── telemetry.router.ts
└── telemetry.openapi.ts
```

Register:

```text
app.use("/internal/telemetry", internalTelemetryRouter)
```

Reuse the existing internal-service-token middleware.

If practical, move `requireInternalServiceToken` out of the recording module into a common internal-auth location so recording and telemetry do not depend on each other's module boundaries.

---

# 23. Node Telemetry Validation

Validate:

```text
mode
tripId
vehicleId
recordingSessionId
samples[]
```

Per GPS sample validate:

```text
sourceTimestampNs
utcEpochMs
latitude
longitude
speedMps
bearingDeg
horizontalAccuracyM
altitudeM
```

Use Zod transforms carefully for 64-bit integer strings.

Do not convert `sourceTimestampNs` to JavaScript `number`.

Use:

```text
BigInt
```

after validation.

---

# 24. Node Session/Vehicle Authorization

For every incoming telemetry batch:

1. fetch the referenced trip
2. verify the trip exists
3. verify `trip.vehicleId == vehicleId`
4. validate the recording session identity consistently with the existing recording validation rules
5. reject mismatched vehicle/trip/session combinations

Do not create vehicles from telemetry.

The Android offer already specifies an existing physical project vehicle.

This is different from BIMS discovery, where the system creates/upserts virtual BIMS vehicles.

---

# 25. Database Schema Upgrade

The database schema change must be implemented atomically with:

```text
Prisma schema
migration
TypedSQL/raw SQL
API schema/docs
ERD documentation
```

Do not update the ERD later as a separate task.

Modify `VehiclePosition`.

Suggested fields:

```prisma
recordingSessionId  String?   @map("recording_session_id") @db.VarChar(80)
sourceTimestampNs   BigInt?   @map("source_timestamp_ns")
altitudeM           Decimal?  @map("altitude_m") @db.Decimal(10, 3)
horizontalAccuracyM Decimal?  @map("horizontal_accuracy_m") @db.Decimal(10, 3)
receivedAt          DateTime  @default(now()) @map("received_at") @db.Timestamptz(6)
```

Existing:

```text
recordedAt
```

should represent the sensor/source UTC observation time when available.

For replay:

```text
recordedAt = GPS utc_epoch_ms from the original recording
receivedAt = current server ingestion time
```

For real live GPS these times should normally be close.

---

# 26. Why `received_at` Is Required

Do not use only `recorded_at` to determine the currently active vehicle state.

Replay telemetry may contain an original historical UTC timestamp.

Example:

```text
old real GPS point:
recorded_at = September 17

current replay point:
recorded_at = August 26
received_at = September 18
```

If "latest" is ordered only by:

```text
recorded_at DESC
```

the replay currently being viewed can lose to an older server observation that happens to have a later source UTC date.

Use:

```text
received_at
```

when asking:

> what did the server most recently receive?

Use:

```text
recorded_at / source_timestamp_ns
```

when asking:

> where was the vehicle in the source recording timeline?

---

# 27. Position Indexes / Idempotency

Add useful indexes:

```text
(vehicle_id, received_at)
(recording_session_id, source_timestamp_ns)
```

Consider a unique constraint:

```text
(recording_session_id, source_timestamp_ns)
```

for non-null replay/device GPS rows.

This makes retries/reconnect duplicate samples idempotent.

If the chosen migration cannot safely apply a simple Prisma unique rule because of existing data/null semantics, implement the appropriate raw PostgreSQL unique index.

---

# 28. GPS Persistence SQL

Update or add TypedSQL/raw SQL for telemetry insertion.

The persistence operation should:

```text
insert vehicle_id
insert trip_id
create PostGIS point
speed_mps * 3.6 -> speed_kmh
bearing_deg -> heading_deg
recorded_at from utc_epoch_ms
telemetry_source
recording_session_id
source_timestamp_ns
altitude_m
horizontal_accuracy_m
received_at
```

Use:

```text
ON CONFLICT
```

for the session/source-timestamp idempotency key.

Do not insert interpolated map-display points.

One GPS source fix should correspond to one authoritative database observation.

---

# 29. Update Existing Latest-Position SQL

Review:

```text
node/prisma/sql/getLatestVehiclePosition.sql
```

Current behavior orders by:

```text
recorded_at DESC
```

For "current server tracking state", change or add a separate query ordering by:

```text
received_at DESC
```

Do not silently change historical APIs that intentionally mean source-time order.

Prefer explicit query names:

```text
getLatestReceivedVehiclePosition.sql
getTripPositionTrack.sql
```

with clear semantics.

---

# 30. Node Tracking Service: Stop Treating Everything as BIMS

Modify:

```text
node/src/modules/tracking/tracking.service.ts
```

Branch observation identity resolution.

## BIMS observation

For:

```text
BIMS_LIVE
BIMS_REPLAY
```

keep existing behavior:

```text
upsert vehicleSource=BIMS by externalId
```

## Android/device observation

For:

```text
DEVICE_GPS
RECORDED_GPS
```

read:

```text
source_metadata.vehicleId
source_metadata.tripId
source_metadata.recordingSessionId
```

Then:

```text
fetch exact Vehicle by vehicleId
verify trip belongs to vehicle
do not create/upsert a BIMS identity
```

The returned public tracking object should still have the same broad shape expected by `operator-web`.

---

# 31. Planned Route Selection for Device Vehicles

For device telemetry, use:

```text
source_metadata.tripId
```

to select the active trip/route.

Do not guess by selecting the most recent active trip if the telemetry explicitly identifies the trip.

Then return:

```text
tripId
plannedRoute
telemetry
```

as the operator page already expects.

---

# 32. Remove Device Persistence from Read Side Effects

`trackingService.getVehicles()` currently invokes:

```text
persistAuthoritativeObservations(...)
```

after fetching the current snapshot.

Do not use this path for Android device GPS.

Device GPS persistence is already performed by:

```text
Go -> POST /internal/telemetry/gps -> Node persistence
```

This guarantees that GPS history does not depend on:

```text
browser open
operator polling
API request frequency
```

BIMS persistence may remain temporarily in the existing mechanism if changing it is outside this task, but document the inconsistency for later cleanup.

---

# 33. Vision Telemetry Store

Add:

```text
services/vision/app/services/telemetry.py
```

Suggested responsibilities:

```text
validate normalized batch
store per recordingSessionId
maintain bounded GPS history
maintain bounded IMU history
match telemetry to source timestamp
reset/expire stale sessions
```

Add state reference in:

```text
services/vision/app/core/state.py
```

---

# 34. Vision Internal Telemetry Endpoint

Add API module such as:

```text
services/vision/app/api/telemetry.py
```

Endpoint:

```text
POST /internal/telemetry
```

The relay and Vision are currently same-host internal services.

If the project later exposes this port beyond loopback, add an internal service token or network-layer restriction.

The endpoint must:

1. validate identity fields
2. validate sample structures
3. update the bounded telemetry store
4. return quickly
5. never run inference or blocking work

---

# 35. Vision Telemetry History

Key by:

```text
recordingSessionId
```

Verify:

```text
tripId
vehicleId
```

match the session's first canonical identity.

Suggested retention:

```text
GPS 30 seconds
IMU 10 seconds
```

Expire inactive session stores after a bounded idle time.

Use sorted timestamp arrays/deques appropriate for:

```text
~1 Hz GPS
~125 Hz processed IMU
```

Do not store raw IMU.

---

# 36. Resolve Source Timestamp for Each Video Frame

A live frame needs a source timestamp before telemetry can be matched.

The existing QR data provides this anchor.

Do not identify telemetry by:

```text
server receive time
RTP arrival time
frame seq alone
```

Use the source recording timeline.

---

# 37. Add a Frame Source Timeline Resolver

Keep the existing monocular `QRResolver` behavior stable unless tests prove it can safely be generalized.

Prefer adding a small independent resolver for telemetry, for example:

```text
SourceTimelineResolver
```

Inputs:

```text
frame pts_90k
frame seq
QR source_timestamp_ns when present
QR decode_success
```

State:

```text
last QR source timestamp
last QR PTS
previous QR source timestamp
previous QR PTS
estimated source/PTS playback ratio
generation/discontinuity counter
```

---

# 38. Source Timestamp Extrapolation

For a QR anchor:

```text
QR source time = S0
frame RTP PTS  = P0
```

For another frame:

```text
resolved source time
    =
S0 + (P - P0) * source_time_per_pts
```

At normal 1x video:

```text
source_time_per_pts ~= 1e9 / 90000
```

Do not hard-code 1x as the only valid playback speed.

Estimate the ratio from consecutive valid QR anchors.

This supports:

```text
normal playback
slow playback
fast playback
minor timing drift
```

---

# 39. Source-Timeline Discontinuity

If QR source time jumps backward beyond a tolerance:

```text
treat as rewind/seek/new source generation
```

If it jumps forward far beyond what RTP PTS predicts:

```text
treat as seek/discontinuity
```

On discontinuity:

```text
reset telemetry matching state
do not interpolate across the jump
```

Do not attach telemetry from the old source-time interval to the new video interval.

---

# 40. Telemetry Matching Policy

Implement a `match(recording_session_id, source_timestamp_ns)` method.

Return both data and diagnostics.

Example:

```json
{
  "status": "ok",
  "source_timestamp_ns": "1445245922681115",
  "gps": {...},
  "imu": {...},
  "gps_match": "interpolated",
  "imu_match": "nearest",
  "gps_age_ms": 0.0,
  "imu_delta_ms": 3.2
}
```

---

# 41. GPS Matching

GPS is approximately 1 Hz.

Use this priority:

## Case A: bracketing fixes available

If:

```text
GPS A <= frame source time <= GPS B
```

and gap is within a safe limit, interpolate for display.

Initial maximum interpolation gap:

```text
2.5 seconds
```

Use a named/configurable constant.

For short local vehicle distances, lat/lon linear interpolation is acceptable initially.

If higher precision is later required, convert to local ENU before interpolation.

---

## Case B: only previous fix available

For a short period, optionally extrapolate using:

```text
latitude
longitude
speed
bearing
source time delta
```

Initial maximum extrapolation:

```text
1.5 seconds
```

Mark:

```text
gps_match = extrapolated
```

Do not write the extrapolated position to PostGIS.

If extrapolation is considered too risky for the first implementation, use hold-last-position and let the browser visually transition between GPS fixes. Keep the matching status explicit either way.

---

## Case C: no sufficiently recent fix

Return:

```text
gps = null
status = gps_stale
```

Do not invent a location.

---

# 42. Bearing Handling

GPS bearing is circular.

Do not linearly interpolate:

```text
359° -> 1°
```

through 180°.

Use shortest-angle interpolation.

When speed is near zero and bearing is null:

```text
retain last reliable display heading
```

or show heading unavailable.

Do not automatically substitute raw IMU yaw as map heading.

---

# 43. IMU Matching

IMU is approximately 125 Hz.

For each frame source timestamp:

- find nearest IMU sample
- optionally interpolate pitch/roll
- circularly interpolate yaw if interpolation is used
- enforce a maximum acceptable time delta

Initial maximum nearest-sample delta:

```text
50 ms
```

If outside threshold:

```text
imu = null
imu_match = stale
```

The exact threshold should be configurable and verified against actual Android transport behavior.

---

# 44. Attach Resolved Source Time to Vision Results

Extend source metadata so every live result can expose:

```text
resolved_source_timestamp_ns
source_timeline_status
source_timeline_generation
```

Do not bury this only inside monocular diagnostics.

This timestamp is useful for:

```text
telemetry matching
debugging
recording replay
future detection/telemetry correlation
```

---

# 45. Match Telemetry Independent of YOLO Success

Telemetry belongs to the video frame, not to the detector.

Therefore telemetry must still be present when:

```text
YOLO frame is skipped
inference is dropped
no detections exist
```

Do not place telemetry conceptually under:

```text
inference.items
```

Add it as top-level frame metadata.

---

# 46. Extend Vision Playback Frame Message

Current frame metadata contains:

```text
type
session_id
epoch
seq
source
encoded
frame
inference
```

Add:

```text
telemetry
```

Example:

```json
{
  "type": "frame",
  "epoch": 2,
  "seq": 981,

  "source": {
    "timestamp_us": 123456789,
    "resolved_source_timestamp_ns": "1445245922681115",
    "recording": {
      "tripId": "102",
      "vehicleId": "3",
      "recordingSessionId": "abc-123"
    }
  },

  "telemetry": {
    "status": "ok",
    "mode": "REPLAY",

    "gps": {
      "latitude": 35.1329082,
      "longitude": 129.1070557,
      "speed_kmh": 2.575,
      "bearing_deg": 89.95,
      "altitude_m": 47.3,
      "horizontal_accuracy_m": 2.8
    },

    "imu": {
      "pitch_deg": -3.7,
      "roll_deg": -2.1,
      "yaw_deg": -30.7,
      "accuracy": 3
    },

    "match": {
      "gps": "interpolated",
      "imu": "nearest",
      "gps_age_ms": 0,
      "imu_delta_ms": 3.2
    }
  },

  "inference": {
    "duration_ms": 18.4,
    "items": [],
    "monocular": {}
  }
}
```

Use strings where 64-bit nanosecond values can reach JavaScript.

---

# 47. Where to Perform the Vision Match

Keep matching close to playback metadata creation, not inside the YOLO model itself.

Preferred flow:

```text
frame/inference result
       │
       │ has recording identity + resolved source time
       ▼
playback metadata builder
       │
       ├── telemetryStore.match(...)
       │
       ▼
WebSocket frame metadata
```

This keeps GPS/IMU matching independent of detection success.

If current result architecture makes it simpler to annotate earlier, ensure skipped/passthrough frames receive the same telemetry treatment.

---

# 48. Vision Live-View UI

Modify:

```text
services/vision/index.html
```

Add a compact telemetry panel next to/below video.

Display:

```text
Vehicle ID
Trip ID
GPS latitude/longitude
Speed
Bearing
GPS accuracy
Altitude (optional)
Pitch
Roll
Yaw
Telemetry match status
Source timestamp
```

Do not hide the video if telemetry is temporarily unavailable.

Show explicit states:

```text
waiting for telemetry
GPS stale
IMU stale
session mismatch
source timestamp unavailable
```

---

# 49. Send Presented-Frame Telemetry to Parent Operator Page

The map should follow the frame actually being presented, not merely the newest frame received from WebSocket.

In the Vision browser code, after a frame is successfully presented:

```text
pair.telemetry
```

should be sent to the parent:

```javascript
window.parent.postMessage({
    type: "live-vehicle-telemetry",
    epoch: pair.epoch,
    seq: pair.seq,
    sourceTimestampNs: ...,
    recording: ...,
    telemetry: pair.telemetry
}, allowedParentOrigin);
```

Send after presentation, near the existing:

```text
presented epoch/seq acknowledgment
```

path.

This is the key video/map synchronization point.

---

# 50. Secure `postMessage`

Do not use unrestricted:

```javascript
"*"
```

in production.

Derive/whitelist the expected operator origin.

On the parent page:

1. validate `event.origin`
2. validate `event.source === liveViewFrame.contentWindow`
3. validate message type
4. validate trip/vehicle/session against the currently selected live view

Ignore mismatched messages.

---

# 51. Operator Map Live-View Path

Modify:

```text
operator-web/app.js
```

Keep:

```text
refresh() every 3000 ms
```

for fleet overview.

When Live View is open for a selected vehicle:

```text
Vision presented-frame telemetry
        │
        ▼
postMessage
        │
        ▼
operator map selected marker
```

Use that high-frequency synchronized data to override the selected vehicle marker's display position.

Other fleet vehicles continue using the normal 3-second tracking refresh.

---

# 52. Marker State Separation

Avoid letting the 3-second polling refresh fight the live-view updates.

Maintain state such as:

```text
liveViewVehicleId
liveViewRecordingSessionId
liveViewTelemetryActive
```

During active live view:

```text
selected vehicle marker:
    use Vision postMessage location

all other vehicle markers:
    use tracking polling
```

When Live View closes:

```text
clear live override
resume normal fleet polling position
```

---

# 53. Visual Map Update Rate

Do not write fake 20 Hz GPS observations to the server database.

The browser can update the marker at the video frame/presentation rate using the matched/predicted display position.

Actual source GPS remains ~1 Hz.

Conceptually:

```text
authoritative GPS:
1 Hz

displayed marker:
10-30 visual updates/sec

PostGIS:
only authoritative GPS fixes
```

This keeps data semantics correct while producing a smooth live UI.

---

# 54. GPS Quality Handling

Use `horizontal_accuracy_m`.

Suggested UI/server policy:

```text
<= 10 m:
    normal

10-30 m:
    degraded accuracy indicator

> 30 m:
    low-quality indicator
```

Do not initially discard a fix solely from these thresholds.

The values should inform display/diagnostics.

A later filtering stage may reject obvious outliers using:

```text
accuracy
maximum plausible speed
distance jump
route proximity
```

Do not add complex map matching in the first telemetry integration.

---

# 55. Server Current-State Semantics

Maintain two concepts:

## Source observation time

```text
source_timestamp_ns
utc_epoch_ms / recorded_at
```

Answers:

> Where was the vehicle at this point in the source recording?

## Server current receive time

```text
received_at
```

Answers:

> What telemetry did the server most recently receive now?

These are deliberately different for REPLAY mode.

Do not collapse them into one timestamp.

---

# 56. Route Deviation / A* Integration

For the first implementation, GPS telemetry should feed:

```text
vehicle current position
map
PostGIS history
live video synchronization
```

Do not block this work on route-deviation logic.

Once device GPS is stable, the existing route/deviation system can consume the same authoritative GPS positions.

For custom trucks with A* routes, later deviation checks should use the selected trip's current `OPTIMAL_PATH` route.

For BIMS-derived simulated vehicles, preserve their BIMS route behavior separately.

---

# 57. IMU Persistence Scope

Do not add 125 Hz IMU rows to `vehicle_position`.

For the initial live-view feature:

```text
IMU = transient synchronized telemetry
```

Keep it in:

```text
Go short history
Vision short history
live browser metadata
```

If historical IMU replay is later required, design a dedicated time-series/sidecar persistence path.

Do not overload the relational GPS position table.

---

# 58. Go Tests

Add tests for:

## DataChannel handling

- `qr-events` still works
- `telemetry-events` accepted
- unknown channel ignored
- malformed JSON rejected
- stale/replaced peer cannot inject
- payload identity mismatch rejected

## Validation

- latitude bounds
- longitude bounds
- finite values
- negative speed
- invalid bearing
- empty batch
- oversized GPS/IMU array
- unsupported version/mode

## Store

- latest GPS
- latest IMU
- session isolation
- bounded history
- session replacement
- reconnect same session

## Node sink

- GPS-only forwarding
- REPLAY -> RECORDED_GPS
- LIVE -> DEVICE_GPS
- retry
- bounded queue

## Vision sink

- full batch forwarding
- bounded queue
- stale IMU drop behavior

---

# 59. Node Tests

Add integration/unit tests for:

```text
POST /internal/telemetry/gps
```

Verify:

- internal token required
- valid trip/vehicle accepted
- wrong vehicle for trip rejected
- invalid recording session rejected
- latitude/longitude validation
- nanosecond BigInt safety
- REPLAY persists RECORDED_GPS
- LIVE persists DEVICE_GPS
- duplicate source timestamp is idempotent
- `received_at` populated
- PostGIS point correct
- speed conversion m/s -> km/h correct

Tracking tests:

- BIMS observation still creates/resolves BIMS vehicle
- device observation resolves existing `vehicleId`
- device observation does not create BIMS vehicle
- explicit telemetry trip is used
- planned route returned for device trip

---

# 60. Routing/Tracking Tests

Test:

```text
DeviceRelaySource
CompositeTelemetrySource
```

Cases:

- relay has one device vehicle
- relay unavailable -> BIMS still returned with warning
- BIMS + device combined
- device metadata preserved
- DEVICE_GPS and RECORDED_GPS normalized correctly
- no accidental conversion to BIMS identity

---

# 61. Vision Tests

Add tests for:

## telemetry store

- session isolation
- GPS insertion/order
- IMU insertion/order
- bounded retention
- duplicate handling

## source timeline resolver

- 1x QR anchors
- 2x external playback
- pause/repeated QR
- backward seek
- large forward seek
- missing QR between anchors

## GPS matcher

- exact point
- interpolation
- 359° -> 1° bearing
- extrapolation/hold
- stale gap
- no fix yet

## IMU matcher

- nearest sample
- interpolation if implemented
- stale threshold
- yaw wrap

## playback metadata

- telemetry top-level field exists
- skipped YOLO frame still gets telemetry
- recording-session mismatch never matches
- no source timestamp -> explicit unavailable state

---

# 62. Operator-Web Tests

Where practical, add browser/unit tests for:

- correct `postMessage` origin accepted
- wrong origin rejected
- wrong iframe source rejected
- wrong vehicle/session rejected
- selected marker updates
- fleet polling does not overwrite live selected marker
- closing live view removes override
- stale telemetry status shown

---

# 63. End-to-End Test Scenario

Use one Android replay dataset first.

## Setup

```text
Trip ID: A
Vehicle ID: V
Recording Session ID: S1
Telemetry mode: REPLAY
```

## Procedure

1. Start Node/Postgres.
2. Start routing/tracking.
3. Start Vision.
4. Start Go relay.
5. Open operator page.
6. Select Vehicle V / Trip A.
7. Start Android stream.
8. Android establishes WebRTC with A/V/S1.
9. Android sends `telemetry-events`.
10. Verify Go telemetry metrics increment.
11. Verify Node receives GPS.
12. Verify `vehicle_position` rows are created with:
    - V
    - A
    - S1
    - `RECORDED_GPS`
    - source timestamp
    - received timestamp
13. Verify `/internal/vehicles` contains the device vehicle.
14. Verify `/api/v1/tracking/vehicles` resolves the existing project vehicle, not a BIMS vehicle.
15. Open Live View.
16. Verify Vision telemetry panel updates.
17. Verify map marker moves with the displayed footage.
18. Verify speed/bearing match the source telemetry.
19. Verify pitch/roll/yaw update alongside video.
20. Stop Android stream.
21. Verify stale/live-state UI behaves correctly.

---

# 64. Multi-Footage Isolation Test

This is mandatory because the same Android device will be used for many recordings.

Run:

```text
Trip A / Session S1 / footage A
Trip B / Session S2 / footage B
```

Verify:

```text
S1 telemetry never appears on S2 frames
Trip A GPS never persists under Trip B
Vision does not match across recordingSessionId
operator map does not accept S1 postMessage while S2 is selected
```

Also test:

```text
same Android device
overlapping source timestamp ranges
```

Session identity must still keep the timelines independent.

---

# 65. Reconnect Test

Within one stream session:

```text
Trip A
Vehicle V
recordingSessionId S1
```

Force WebRTC disconnect/reconnect.

Verify:

- same S1 is reused if Android reconnect behavior intends the same logical session
- stale old peer DataChannel cannot inject telemetry
- Go store remains consistent
- duplicate GPS fixes do not duplicate DB rows
- Vision resumes matching
- operator marker does not jump to another session

---

# 66. QR Loss Test

Temporarily obscure the timestamp QR.

Expected:

```text
Android eventually pauses simulated telemetry according to its QR stale policy
Vision source resolver eventually marks source time unavailable/stale
live map does not continue inventing movement forever
```

On QR recovery:

```text
source time re-anchors
telemetry matching resumes
```

---

# 67. Poor GPS Test

Use or inject fixes with:

```text
horizontal_accuracy_m > 20
```

Verify:

- authoritative fix is still preserved
- UI shows degraded accuracy
- no server crash
- no automatic IMU-yaw substitution for GPS bearing

---

# 68. Performance Requirements

The implementation must preserve the current video pipeline.

## Go DataChannel callback

Must not block on network/database calls.

## Memory

All telemetry buffers/queues must be bounded.

## Vision

Telemetry matching should be:

```text
O(log n)
```

or effectively constant/bisect over small bounded arrays.

Do not linearly scan an unbounded IMU history per frame.

## Database

Persist approximately source GPS rate, not presentation-frame rate.

Expected current GPS persistence:

```text
~1 row/sec/active Android vehicle
```

---

# 69. Metrics / Diagnostics

## Go

Add:

```text
telemetry_batches_received_total
telemetry_batches_invalid_total
telemetry_identity_mismatch_total
telemetry_gps_samples_total
telemetry_imu_samples_total
telemetry_store_sessions
telemetry_node_queue_depth
telemetry_node_failures_total
telemetry_vision_queue_depth
telemetry_vision_dropped_total
```

## Vision

Add/log:

```text
telemetry_batches_received
telemetry_gps_buffer_size
telemetry_imu_buffer_size
telemetry_match_ok
telemetry_gps_stale
telemetry_imu_stale
source_timeline_resets
```

Avoid logging every IMU sample.

---

# 70. OpenAPI / Documentation Updates

Update Node OpenAPI for:

```text
POST /internal/telemetry/gps
```

Document:

```text
64-bit timestamps are strings in JSON
REPLAY vs LIVE
RECORDED_GPS vs DEVICE_GPS
recordedAt vs receivedAt
```

Update relevant architecture documentation.

Because the database changes, update in the same change set:

```text
docs/v17_its_integrated_erd.md
Prisma schema
migration
TypedSQL/raw SQL docs
API docs
```

If v17 is treated as immutable historical documentation, create the next ERD version and update references consistently rather than silently editing an archived version.

---

# 71. Deployment Configuration Updates

Update:

```text
deploy/env.local.example
deploy/env.production.example
docker-compose.yml
README/runbooks as applicable
```

Add/configure:

```text
ANDROID_TELEMETRY_ENABLED=true
PY_TELEMETRY_URL=http://127.0.0.1:39011/internal/telemetry
MEDIA_RELAY_INTERNAL_BASE_URL=http://127.0.0.1:39012
```

Ensure:

```text
NODE_INTERNAL_BASE_URL
NODE_INTERNAL_SERVICE_TOKEN
```

are available when telemetry is enabled, not only when MinIO recording is enabled.

---

# 72. Recommended Implementation Order

## Phase 1 — Go telemetry ingestion

Implement:

```text
telemetry structs
validation
telemetry-events DataChannel
trusted session identity
bounded store
metrics
```

Definition of done:

```text
Android telemetry reaches Go and is visible in diagnostics
without affecting video/QR behavior.
```

---

## Phase 2 — Node authoritative GPS persistence

Implement:

```text
/internal/telemetry/gps
schema validation
trip/vehicle/session validation
PostGIS persistence
DB schema migration
received_at/source_timestamp_ns/session/accuracy fields
idempotency
```

Definition of done:

```text
Every source GPS fix appears once in vehicle_position
without any browser polling being required.
```

This phase must include synchronized ERD/schema/API documentation changes.

---

## Phase 3 — Device current-state tracking

Implement:

```text
Go /internal/telemetry/vehicles
DeviceRelaySource
CompositeTelemetrySource
Node identity branching
```

Definition of done:

```text
/api/v1/tracking/vehicles returns both BIMS and Android/device vehicles,
and Android telemetry resolves the existing physical Vehicle row.
```

---

## Phase 4 — Vision telemetry timeline

Implement:

```text
Go -> Vision telemetry sink
Vision /internal/telemetry
TelemetryStore
SourceTimelineResolver
GPS/IMU timestamp matcher
```

Definition of done:

```text
Vision can print/log the GPS/IMU corresponding to each live video
source timestamp.
```

---

## Phase 5 — Live-view metadata/UI

Implement:

```text
top-level telemetry in frame metadata
Vision telemetry panel
presented-frame postMessage
```

Definition of done:

```text
the Vision page shows GPS/IMU synchronized to the displayed video.
```

---

## Phase 6 — Operator map synchronization

Implement:

```text
postMessage validation
selected marker live override
polling/live separation
stale-state handling
```

Definition of done:

```text
the selected map vehicle moves alongside the actual displayed live footage
without waiting for the normal 3-second fleet refresh.
```

---

## Phase 7 — Hardening

Implement/test:

```text
multi-footage isolation
reconnect
QR loss
source rewind
poor GPS accuracy
queue backpressure
Node/Vision temporary outage
```

Definition of done:

```text
no cross-session location contamination,
no unbounded queues,
no telemetry-induced video stalls.
```

---

# 73. Expected Files to Change

## Go media relay

```text
services/media-relay/main.go
services/media-relay/internal/config/config.go
services/media-relay/internal/signaling/handlers.go
services/media-relay/internal/broadcaster/broadcaster.go

services/media-relay/internal/telemetry/types.go
services/media-relay/internal/telemetry/validate.go
services/media-relay/internal/telemetry/store.go
services/media-relay/internal/telemetry/node_sink.go
services/media-relay/internal/telemetry/vision_sink.go

services/media-relay/internal/telemetry/*_test.go
services/media-relay/internal/broadcaster/*_test.go
```

Potential refactor:

```text
services/media-relay/internal/recording/clients.go
```

if the Node internal client is generalized for telemetry.

---

## Routing/tracking

```text
services/routing-tracking/telemetry.py
services/routing-tracking/main.py
services/routing-tracking/README.md
services/routing-tracking/tests/...   # add if not already present
```

---

## Node

```text
node/src/app.ts

node/src/modules/telemetry/telemetry.schema.ts
node/src/modules/telemetry/telemetry.controller.ts
node/src/modules/telemetry/telemetry.service.ts
node/src/modules/telemetry/telemetry.persistence.ts
node/src/modules/telemetry/telemetry.router.ts
node/src/modules/telemetry/telemetry.openapi.ts

node/src/modules/tracking/tracking.client.ts
node/src/modules/tracking/tracking.schema.ts
node/src/modules/tracking/tracking.service.ts
node/src/modules/tracking/tracking.persistence.ts

node/prisma/schema.prisma
node/prisma/migrations/<new_migration>/migration.sql
node/prisma/sql/insertVehiclePosition.sql
node/prisma/sql/getLatestVehiclePosition.sql
# potentially a new getLatestReceivedVehiclePosition.sql

node/tests/telemetry.integration.test.ts
node/tests/tracking.integration.test.ts
```

Internal auth may move to:

```text
node/src/common/auth/require-internal-service-token.ts
```

instead of remaining recording-specific.

---

## Vision

```text
services/vision/app/core/state.py
services/vision/app/core/settings.py
services/vision/app/main.py

services/vision/app/api/telemetry.py
services/vision/app/api/playback.py

services/vision/app/services/telemetry.py
services/vision/app/services/source_timeline.py
services/vision/app/services/yolo.py   # only where source metadata must propagate

services/vision/index.html

services/vision/tests/test_telemetry.py
services/vision/tests/test_source_timeline.py
services/vision/tests/test_playback.py
```

---

## Operator web

```text
operator-web/app.js
operator-web/index.html
operator-web/styles.css
```

---

## Documentation/deployment

```text
docs/<next ERD or v17 update according to repo policy>
docs/pipeline_architecture_control_vision_v6_notes.md
docs/integration/NEXT_PLANS.md

deploy/env.local.example
deploy/env.production.example
docker-compose.yml
README.md / relevant runbook
```

---

# 74. Out of Scope

Do not add these to the first implementation:

- uploading GPS/IMU CSV files to the server
- parsing CSV files on the server
- persisting 125 Hz IMU in PostgreSQL
- transmitting raw ~1000 Hz IMU
- full Kalman-filter sensor fusion
- lane-level positioning
- road map matching
- IMU-yaw-to-world calibration
- replacing BIMS tracking
- changing A* routing behavior
- storing interpolated/predicted map positions as authoritative GPS

These can be follow-up features after the end-to-end telemetry path is stable.

---

# 75. Acceptance Criteria

The feature is complete when:

- [ ] Android `telemetry-events` reaches Go.
- [ ] Go validates payload structure and values.
- [ ] Go uses validated stream identity rather than trusting payload identity.
- [ ] Old/replaced WebRTC peers cannot inject current telemetry.
- [ ] REPLAY telemetry maps to `RECORDED_GPS`.
- [ ] Future LIVE telemetry maps to `DEVICE_GPS`.
- [ ] GPS persistence does not depend on operator polling.
- [ ] `vehicle_position` stores `recording_session_id`.
- [ ] `vehicle_position` stores `source_timestamp_ns`.
- [ ] `vehicle_position` stores `received_at`.
- [ ] `vehicle_position` stores GPS accuracy and optionally altitude.
- [ ] duplicate/retried GPS source samples are idempotent.
- [ ] device telemetry resolves an existing project Vehicle, not a BIMS vehicle.
- [ ] device telemetry carries the explicit Trip ID through the tracking API.
- [ ] routing/tracking returns BIMS and device sources together.
- [ ] Vision stores GPS/IMU by `recordingSessionId`.
- [ ] Vision resolves source time from QR/RTP timeline.
- [ ] Vision never matches telemetry across sessions.
- [ ] GPS matching reports exact/interpolated/extrapolated/held/stale status.
- [ ] IMU matching enforces a timestamp tolerance.
- [ ] live frame metadata contains top-level telemetry even when inference is skipped.
- [ ] Vision UI shows GPS/IMU beside live video.
- [ ] operator map receives telemetry for the frame actually presented.
- [ ] the selected live marker is not overwritten by the 3-second fleet poll.
- [ ] closing Live View returns the marker to normal fleet tracking.
- [ ] only real source GPS observations are persisted.
- [ ] all queues and histories are bounded.
- [ ] telemetry failures do not block H.264 forwarding.
- [ ] two footage sessions with overlapping timestamps remain isolated.
- [ ] DB migration, Prisma schema, SQL, API docs, and ERD are updated in the same change set.

---

# 76. Final Target Behavior

```text
                Android footage / real camera
                           │
                 QR source timestamps
                           │
            Android simulated/real GPS + IMU
                           │
                           ▼
                   WebRTC PeerConnection
                  ┌────────┼──────────┐
                  │        │          │
                 RTP    qr-events  telemetry-events
                  │        │          │
                  └────────┼──────────┘
                           ▼
                        GO RELAY
                  trusted stream identity
                           │
              ┌────────────┼─────────────┐
              │            │             │
              ▼            ▼             ▼
       current state    Node GPS       Vision
                         persistence    timeline
              │            │             │
              ▼            ▼             │
      routing/tracking   PostGIS          │
              │                          │
              │                  source-time match
              │                          │
              ▼                          ▼
       fleet tracking               live frame
              │                     + telemetry
              │                          │
              └──────────────┐           │
                             ▼           ▼
                           OPERATOR WEB
                    ┌──────────────────────────┐
                    │ map                      │
                    │ selected vehicle marker  │
                    │ live video               │
                    │ speed / bearing          │
                    │ pitch / roll / yaw       │
                    │ GPS accuracy             │
                    └──────────────────────────┘
```

The core invariant is:

> **`recordingSessionId + source_timestamp_ns` identifies where telemetry belongs in the source footage, while `vehicleId + tripId` identifies which real project vehicle/trip the observation belongs to. `received_at` identifies when the server received it. These identities/times must remain separate throughout the pipeline.**
