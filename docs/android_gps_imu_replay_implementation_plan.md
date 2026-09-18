# Android GPS / IMU Replay Telemetry Implementation Plan

## 1. Goal

Implement an Android-side telemetry simulator that keeps prerecorded GPS and IMU CSV files **only on the Android device** and sends timestamped GPS/IMU events to the server as if they came from real Android sensors.

The Android app is already capturing an externally displayed prerecorded video with CameraX and decoding timestamp QR codes from that video. The QR `source_timestamp_ns` is therefore the authoritative link between the captured video and the local prerecorded telemetry.

The server must **not know that CSV files exist**. From the server's perspective, the Android client sends normal telemetry events over WebRTC.

### Primary outcome

For each footage/session:

```text
External prerecorded footage
        │
        │ CameraX
        ▼
Android app
        │
        ├── QR source timestamp
        │
        ├── local gps_*.csv
        │
        └── local imu_*.csv
                │
                ▼
       replay telemetry engine
                │
                ▼
     WebRTC telemetry-events DataChannel
                │
                ▼
             Server
                │
                ├── vehicle location tracking
                ├── live video metadata
                └── browser map / status display
```

No CSV upload endpoint is part of this Android work.

---

## 2. Current Project Context

Current Android project paths:

```text
android/app/src/main/java/com/example/webrtccamera/MainActivity.kt
android/app/src/main/java/com/example/webrtccamera/WebRtcPublisher.kt
android/app/src/main/res/layout/activity_main.xml
android/app/src/main/res/layout-land/activity_main.xml
android/app/build.gradle.kts
```

Current behavior that should be preserved:

- `MainActivity` owns CameraX capture and QR scanning.
- QR scanning currently runs every second analyzed frame.
- QR payload is parsed as a `Long` source timestamp.
- `WebRtcPublisher.sendQrEvent()` sends:
  - `capture_timestamp_ns`
  - `source_timestamp_ns`
  - RTP timestamp
  - decode success
  - capture index
  - decode latency
- `WebRtcPublisher` already creates a `qr-events` WebRTC DataChannel.
- The WebRTC offer already carries:
  - `tripId`
  - `vehicleId`
  - `recordingSessionId`
- `recordingSessionId` is currently generated inside `WebRtcPublisher`.

Current sample telemetry characteristics:

| Data | Rows | Approx. rate | Duration |
|---|---:|---:|---:|
| `frame_0000.csv` | 13,008 | 30 Hz | 433.56 s |
| `gps_0000.csv` | 430 | 1 Hz | 429.71 s |
| `imu_0000.csv` | 54,110 | 124.8 Hz | 433.58 s |
| `raw_imu_0000.csv` | 433,532 | ~1000 Hz | 433.59 s |

For this feature:

- use `gps_*.csv`
- use processed `imu_*.csv`
- do **not** transmit `raw_imu_*.csv`
- `frame_*.csv` is not required for Android telemetry replay because the QR source timestamp and GPS/IMU `timestamp_ns` already share the recording timeline

---

## 3. Design Principles

### 3.1 CSV is an Android-only implementation detail

Never send:

```text
gps.csv
imu.csv
raw_imu.csv
frame.csv
```

to the server.

Only send telemetry events derived from those files.

The intended abstraction is:

```text
TelemetrySource
      │
      ├── CsvReplayTelemetrySource   <-- implement now
      │
      └── AndroidLiveTelemetrySource <-- future real device sensors
                    │
                    ▼
             TelemetrySender
                    │
                    ▼
                  Server
```

The transport and server should not require different code for replay versus real sensor input.

---

### 3.2 Recording session is the synchronization boundary

The same Android phone can be used with many different footage files.

Do not identify a telemetry timeline by Android device alone.

Use:

```text
tripId
vehicleId
recordingSessionId
```

A new streaming/footage session gets its own `recordingSessionId`.

Example:

```text
Android device
   │
   ├── Trip 101 / Session A
   │      ├── footage A
   │      ├── gps A
   │      └── imu A
   │
   └── Trip 102 / Session B
          ├── footage B
          ├── gps B
          └── imu B
```

Timestamp matching must always happen within the currently selected local telemetry dataset.

---

### 3.3 Preserve original sensor timestamps

Do not generate artificial 30 Hz GPS positions on Android.

Replay the source telemetry using its original timestamps:

```text
GPS CSV     ~1 Hz
IMU CSV     ~125 Hz
```

The server can interpolate GPS positions for smooth map rendering.

For IMU transport, batching multiple source samples in one DataChannel message is allowed, but each sample must retain its original `timestamp_ns`.

---

### 3.4 QR is the source clock

The Android camera is viewing an external prerecorded video.

Therefore there is no Android `MediaPlayer.currentPosition` to use.

The replay clock is established from:

```text
decoded QR source_timestamp_ns
        +
Android local monotonic time
```

Between QR decodes, estimate the current source timestamp. New QR observations continually correct that estimate.

---

## 4. Proposed Android Package Structure

Add the following packages/classes:

```text
android/app/src/main/java/com/example/webrtccamera/

telemetry/
├── model/
│   ├── GpsSample.kt
│   ├── ImuSample.kt
│   ├── TelemetryBatch.kt
│   ├── TelemetryDataset.kt
│   └── StreamSessionContext.kt
│
├── replay/
│   ├── CsvTelemetryParser.kt
│   ├── CsvReplayTelemetrySource.kt
│   ├── QrSourceClock.kt
│   └── TelemetryReplayScheduler.kt
│
└── transport/
    └── TelemetryDataChannelSender.kt
```

The existing app is small, so avoid adding a large framework or DI system for this feature.

---

## 5. Data Models

### 5.1 `GpsSample`

Map the current GPS CSV schema directly:

```kotlin
data class GpsSample(
    val timestampNs: Long,
    val utcEpochMs: Long?,
    val latitude: Double,
    val longitude: Double,
    val altitudeM: Double?,
    val speedMps: Double?,
    val bearingDeg: Double?,
    val horizontalAccuracyM: Double?,
)
```

Expected CSV columns:

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

---

### 5.2 `ImuSample`

Use the processed IMU file, not raw IMU:

```kotlin
data class ImuSample(
    val timestampNs: Long,
    val pitchDeg: Double,
    val rollDeg: Double,
    val yawDeg: Double,
    val accuracy: Int?,
)
```

Expected columns:

```text
timestamp_ns
pitch_deg
roll_deg
yaw_deg
accuracy
```

---

### 5.3 `TelemetryDataset`

```kotlin
data class TelemetryDataset(
    val displayName: String,
    val gps: List<GpsSample>,
    val imu: List<ImuSample>,
    val gpsStartNs: Long?,
    val gpsEndNs: Long?,
    val imuStartNs: Long?,
    val imuEndNs: Long?,
)
```

The dataset belongs only to the currently selected footage/session.

---

### 5.4 `StreamSessionContext`

Move recording-session ownership outside `WebRtcPublisher`.

```kotlin
data class StreamSessionContext(
    val tripId: Long,
    val vehicleId: Long,
    val recordingSessionId: String,
    val telemetryMode: TelemetryMode,
)

enum class TelemetryMode {
    REPLAY,
    LIVE,
}
```

For this implementation, use `REPLAY`.

---

## 6. Local Dataset Selection UI

### 6.1 Preferred UI

Add a telemetry section under the existing Trip ID / Vehicle ID controls.

Suggested UI:

```text
Telemetry simulation                 [ON]

Dataset:
[ Select dataset folder ]

Selected:
gps_0000.csv     430 samples
imu_0000.csv     54110 samples

GPS:
1445242225977657 .. 1445671933514811

IMU:
1445238603692997 .. 1445672188397964

Status: Ready

[ Start Streaming ]
```

---

### 6.2 Dataset folder convention

Because there will be many footage datasets, prefer selecting one folder rather than independently choosing two files.

Example device storage:

```text
TelemetryDatasets/
├── footage_0000/
│   ├── gps_0000.csv
│   └── imu_0000.csv
│
├── footage_0001/
│   ├── gps_0001.csv
│   └── imu_0001.csv
│
└── footage_0002/
    ├── gps_0002.csv
    └── imu_0002.csv
```

On folder selection:

1. find exactly one file matching `gps*.csv`
2. find exactly one file matching `imu*.csv`
3. ignore `raw_imu*.csv`
4. ignore `frame*.csv` for this feature
5. parse and validate the selected pair
6. display sample counts and timestamp ranges before streaming

If folder selection is inconvenient on a target device, support two explicit file selectors as a fallback.

---

### 6.3 Storage Access Framework

Use Android Storage Access Framework.

Preferred:

```kotlin
ActivityResultContracts.OpenDocumentTree()
```

The app should not request broad filesystem/storage permissions.

Optionally persist access:

```kotlin
contentResolver.takePersistableUriPermission(...)
```

This allows the selected dataset folder to survive app restart when desired.

If using `DocumentFile`, add the small AndroidX DocumentFile dependency rather than manually traversing `DocumentsContract`.

---

## 7. CSV Parsing

### 7.1 Parse off the UI/camera thread

CSV parsing must run on a dedicated executor.

Do not parse 54k IMU rows on:

- main/UI thread
- CameraX analyzer thread
- WebRTC RTC thread

Suggested:

```kotlin
private val telemetryIoExecutor =
    Executors.newSingleThreadExecutor()
```

---

### 7.2 Parser behavior

`CsvTelemetryParser` should:

1. read the header first
2. resolve columns by header name rather than fixed array index
3. reject missing required columns
4. skip blank lines
5. report malformed rows with line number
6. parse `timestamp_ns` as `Long`
7. parse floating-point values safely
8. allow nullable optional numeric fields
9. ensure timestamp ordering
10. provide first/last timestamps and row count

Do not silently combine files with unrelated timestamp ranges.

---

### 7.3 Dataset validation

On load:

```text
GPS list non-empty
IMU list non-empty
GPS timestamps ascending
IMU timestamps ascending
GPS/IMU ranges overlap meaningfully
```

Do not require their first timestamps to be identical.

The current sample demonstrates why:

```text
IMU begins near the start of the footage
GPS begins several seconds later
```

That is valid.

When the first QR is decoded, perform a second validation that its source timeline is compatible with the selected dataset.

If the initial QR is before the first GPS sample, this is not an error. Show:

```text
Telemetry: synchronized; waiting for first GPS sample
```

---

## 8. QR-Based Source Clock

Implement `QrSourceClock`.

### 8.1 Clock state

Suggested states:

```kotlin
enum class SourceClockState {
    WAITING_FOR_QR,
    RUNNING,
    STALE,
}
```

Store at least:

```kotlin
data class QrAnchor(
    val sourceTimestampNs: Long,
    val localElapsedNs: Long,
)
```

Also retain:

```text
previous QR source timestamp
previous QR local timestamp
estimated playback rate
last successful QR time
```

---

### 8.2 Feed successful QR results into the replay clock

Current QR success path already has:

```text
capture timestamp
decoded source timestamp
QR decode latency
```

After a valid decode:

```kotlin
telemetryReplay?.onQrTimestamp(
    sourceTimestampNs = decoded,
    captureTimestampNs = timestamp,
    decodeLatencyMs = latencyMs,
)
```

Continue sending the existing `qr-events` message unchanged.

QR failure must **not** update the source clock.

---

### 8.3 Local anchor time

At QR completion, estimate when that scanned camera frame was captured.

A practical first implementation:

```text
anchorLocalElapsedNs
    =
SystemClock.elapsedRealtimeNanos()
    -
decodeLatencyNs
```

Then:

```text
estimatedSourceNs =
anchorSourceNs
+
(nowElapsedNs - anchorLocalElapsedNs) * estimatedPlaybackRate
```

Keep `captureTimestampNs` in logs/diagnostics because it is the actual CameraX frame timestamp.

Do not assume blindly that every device's CameraX timestamp source is directly comparable to `elapsedRealtimeNanos()`.

---

### 8.4 Estimate external playback rate

Do not permanently assume the external footage is playing at exactly 1x.

From consecutive QR anchors:

```text
sourceDelta = currentQrSourceNs - previousQrSourceNs
localDelta  = currentLocalNs - previousLocalNs

playbackRate = sourceDelta / localDelta
```

Examples:

```text
~1.0  normal playback
~0.5  half speed
~2.0  double speed
~0.0  paused/repeated source timestamp
```

Apply sanity limits and reject absurd one-sample estimates.

A reasonable implementation can clamp valid estimated rates to a configurable range such as:

```text
0.0 .. 4.0
```

Do not hard-code this value deep inside logic; define it as a named constant.

---

### 8.5 Re-anchor on every good QR

Every successful QR should correct the source clock.

Do not accumulate long-term drift from Android's local clock.

Record diagnostic error:

```text
qrCorrectionNs =
decodedQrSourceNs - predictedSourceNsBeforeCorrection
```

This value will be useful when debugging telemetry/video alignment.

---

### 8.6 Detect seek / footage change / restart

If a new QR jumps backward significantly:

```text
old source = 200 s
new source = 50 s
```

treat it as a seek/reset.

If it jumps forward by a very large amount, also treat it as a seek rather than trying to replay every skipped sensor sample.

On discontinuity:

```text
reset GPS cursor using binary search
reset IMU cursor using binary search
do not backfill the skipped interval
```

---

### 8.7 QR stale behavior

Because correct timestamp matching is more important than blindly continuing telemetry, stop advancing the replay after QR has been stale for a configured timeout.

Initial proposal:

```text
QR_STALE_TIMEOUT_MS = 1000..2000 ms
```

Make it configurable as a named constant.

Behavior:

```text
recent QR     -> replay normally
short gap     -> extrapolate source clock
long gap      -> pause telemetry emission
new valid QR  -> re-anchor and resume
```

This avoids the simulated vehicle drifting far away from the displayed footage if QR reading fails.

---

## 9. Replay Scheduler

Implement `TelemetryReplayScheduler`.

### 9.1 Do not interpolate on Android

For realistic sensor simulation:

- emit GPS rows when their timestamp becomes due
- emit IMU rows when their timestamp becomes due

Example:

```text
source clock
   │
   ├── crosses GPS timestamp  A -> emit A
   ├── crosses IMU timestamp  1 -> emit 1
   ├── crosses IMU timestamp  2 -> emit 2
   └── crosses GPS timestamp  B -> emit B
```

Server-side tracking/UI can smooth between GPS fixes.

---

### 9.2 Maintain independent cursors

```kotlin
var nextGpsIndex: Int
var nextImuIndex: Int
```

At each scheduler tick:

```text
sourceNow = QrSourceClock.currentSourceTimestampNs()

emit GPS samples:
    timestamp <= sourceNow
    timestamp > previously emitted boundary

emit IMU samples:
    timestamp <= sourceNow
    timestamp > previously emitted boundary
```

Use binary search when:

- replay starts
- QR causes a large jump
- footage seeks backward
- session is reset

Do not scan the arrays from the beginning.

---

### 9.3 Scheduler cadence

Use a scheduler cadence significantly faster than the IMU network batch interval.

Suggested starting point:

```text
10 ms tick
```

The source timestamps, not the tick time, determine which events are due.

Do not use thousands of individual Android timers.

One scheduler is enough.

---

### 9.4 Avoid burst replay after gaps

If the clock jumps several seconds, do not send thousands of historical IMU samples as fast as possible.

On a detected discontinuity:

```text
binary-search new source position
discard skipped old samples
resume from current point
```

For a small scheduling delay, normal due-sample batching is fine.

---

## 10. Telemetry Transport

### 10.1 Add a second DataChannel

Current channels:

```text
video track
qr-events
```

Add:

```text
telemetry-events
```

Result:

```text
PeerConnection
├── H.264 video track
├── qr-events
└── telemetry-events
```

Use a separate telemetry channel rather than mixing telemetry into `qr-events`.

---

### 10.2 Initial channel reliability

Start with the normal reliable/ordered DataChannel configuration for correctness.

The sample processed IMU rate is only about 125 Hz, and batching will reduce message frequency.

Optimize reliability/ordering only after end-to-end behavior is measured.

---

### 10.3 Batch transport

Do not necessarily send one WebRTC message for every 125 Hz IMU sample.

Preserve source samples but batch them for network transport.

Example:

```json
{
  "type": "telemetry_batch",
  "mode": "REPLAY",
  "trip_id": "12",
  "vehicle_id": "4",
  "recording_session_id": "f0c3...",
  "source_clock_ns": 1445238629000000,

  "gps": [
    {
      "timestamp_ns": 1445238628000000,
      "utc_epoch_ms": 1787803384795,
      "latitude": 35.1329082,
      "longitude": 129.1070557,
      "altitude_m": 47.3,
      "speed_mps": 0.7153028,
      "bearing_deg": 89.954605,
      "horizontal_accuracy_m": 22.768
    }
  ],

  "imu": [
    {
      "timestamp_ns": 1445238627679890,
      "pitch_deg": -3.7969623,
      "roll_deg": -92.82997,
      "yaw_deg": -30.720661,
      "accuracy": 3
    },
    {
      "timestamp_ns": 1445238635679890,
      "pitch_deg": -3.80,
      "roll_deg": -92.81,
      "yaw_deg": -30.70,
      "accuracy": 3
    }
  ]
}
```

The exact server schema must be implemented consistently on both sides, but Android should keep individual sensor timestamps inside the batch.

---

### 10.4 Suggested batching policy

Initial values:

```text
flush interval:       20-50 ms
max IMU samples:      16 per batch
GPS:                  send as soon as due in the next batch
```

At 125 Hz IMU, a 40 ms batch contains roughly five samples.

This behaves like realistic sensor batching while avoiding excessive JSON/DataChannel overhead.

---

### 10.5 JSON implementation

The current Android app already uses `JSONObject`.

For this first implementation, keep that approach rather than introducing a new serialization library solely for telemetry.

If telemetry models grow significantly later, migrate both QR and telemetry payloads together to a typed serializer.

---

## 11. Backpressure Rules

The current project is latency-sensitive, so telemetry must not create an unlimited queue.

### 11.1 Bound pending telemetry

Inside `WebRtcPublisher` or `TelemetryDataChannelSender`, maintain a bounded telemetry queue.

Never allow:

```text
network slowdown
    ->
thousands of old IMU messages
    ->
several seconds of telemetry lag
```

---

### 11.2 Priority policy

GPS is more important for historical vehicle tracking than old IMU updates.

Under severe backpressure:

```text
GPS:
    preserve newly due fixes where practical

IMU:
    drop/coalesce stale samples before allowing a large delay
```

The live UI benefits more from current orientation than from a delayed backlog.

---

### 11.3 Reconnect behavior

Current `WebRtcPublisher` recreates the PeerConnection after connection failure.

When `telemetry-events` reopens:

- do not replay a large stale IMU backlog
- clear stale queued IMU batches
- send the latest relevant state/new events
- continue using the same `recordingSessionId` for that streaming attempt

---

## 12. `recordingSessionId` Refactor

### Current problem

`WebRtcPublisher` currently owns:

```kotlin
private val recordingSessionId = UUID.randomUUID().toString()
```

Telemetry replay also needs the same session identity.

### Change

Generate the session ID in `MainActivity` when a stream session starts:

```kotlin
val sessionContext = StreamSessionContext(
    tripId = recordingTripId,
    vehicleId = recordingVehicleId,
    recordingSessionId = UUID.randomUUID().toString(),
    telemetryMode = TelemetryMode.REPLAY,
)
```

Pass it to:

```text
WebRtcPublisher
CsvReplayTelemetrySource
TelemetryDataChannelSender
```

Change `WebRtcPublisher` constructor to accept the session context or explicit `recordingSessionId`.

The offer must continue sending exactly that ID.

If WebRTC internally reconnects, reuse the same session context.

A full operator stop + new start may create a new recording session.

---

## 13. MainActivity Integration

### 13.1 New state

Add fields similar to:

```kotlin
private var selectedTelemetryDataset: TelemetryDataset? = null
private var telemetryReplaySource: CsvReplayTelemetrySource? = null
private var activeSessionContext: StreamSessionContext? = null
```

Add:

```text
dataset selection launcher
dataset loading state
telemetry status UI
```

---

### 13.2 Start-stream validation

When telemetry simulation is enabled, `startStreaming()` should require:

```text
valid Trip ID
valid Vehicle ID
valid parsed GPS/IMU dataset
```

Then:

1. create `StreamSessionContext`
2. construct `WebRtcPublisher` using that context
3. construct `CsvReplayTelemetrySource`
4. start publisher
5. bind CameraX
6. start replay scheduler in `WAITING_FOR_QR`
7. do not emit telemetry until first valid QR anchor

---

### 13.3 QR success integration

Current code essentially performs:

```kotlin
publisher?.sendQrEvent(...)
```

Extend success path:

```kotlin
val latencyMs = ...

publisher?.sendQrEvent(
    captureTimestampNs = timestamp,
    sourceTimestampNs = decoded,
    decodeSuccess = decoded != null,
    ...
)

if (decoded != null) {
    telemetryReplaySource?.onQrTimestamp(
        sourceTimestampNs = decoded,
        captureTimestampNs = timestamp,
        decodeLatencyMs = latencyMs,
    )
}
```

Do not update replay synchronization on:

```text
QR absent
QR malformed
ML Kit error
```

---

### 13.4 Stop-stream cleanup

`stopStreaming()` must:

1. stop replay scheduler
2. clear replay cursors
3. close/reset active session context
4. stop publisher
5. retain the selected local dataset in the UI unless operator explicitly clears it
6. allow a new start to generate a new `recordingSessionId`

---

## 14. WebRtcPublisher Changes

Modify:

```text
android/app/src/main/java/com/example/webrtccamera/WebRtcPublisher.kt
```

### Required changes

1. remove internal UUID ownership
2. accept `StreamSessionContext` or explicit session ID
3. create `telemetry-events` DataChannel
4. register state observer
5. add bounded pending telemetry queue
6. add `sendTelemetryBatch(...)`
7. flush when channel opens
8. dispose channel on stop/reconnect
9. clear stale telemetry on reconnect
10. keep existing `qr-events` behavior unchanged

Suggested fields:

```kotlin
private var telemetryChannel: DataChannel? = null
private val pendingTelemetry = ArrayDeque<ByteArray>()
```

Do not reuse `pendingQrEvents` for telemetry.

QR and telemetry have different buffering semantics.

---

## 15. Future Real-Sensor Compatibility

Do not implement server-only replay concepts into the transport.

Define a source interface now:

```kotlin
interface TelemetrySource {
    fun start()
    fun stop()
}
```

The replay source emits normalized telemetry samples/batches.

A later real source can use:

```text
FusedLocationProvider / Android Location
SensorManager
```

and produce the same models.

Future architecture:

```text
                    TelemetrySource
                         │
        ┌────────────────┴────────────────┐
        │                                 │
CsvReplayTelemetrySource       AndroidLiveTelemetrySource
        │                                 │
        └────────────────┬────────────────┘
                         │
                         ▼
                telemetry-events
                         │
                         ▼
                       server
```

The server should only need the `mode` field for diagnostics, not for a completely different processing path.

---

## 16. Raw IMU Scope

Do not use `raw_imu_*.csv` in this implementation.

The supplied raw IMU is approximately 1000 Hz.

Sending it would:

- increase JSON serialization load
- increase Android allocations
- increase DataChannel traffic
- create more server parsing work
- provide no benefit to the first live map/status UI

If a future algorithm needs raw accelerometer/gyroscope data, add a separate opt-in raw sensor stream with binary encoding/batching.

Do not mix that future feature into the initial GPS + orientation telemetry implementation.

---

## 17. Logging and Diagnostics

Add lightweight debug logging for:

```text
dataset loaded
GPS count / timestamp range
IMU count / timestamp range

recordingSessionId
tripId
vehicleId

first QR anchor
QR source-clock correction
estimated playback rate
QR stale / resumed

GPS event count sent
IMU event count sent
telemetry batch count
telemetry queue drops/coalescing

seek/discontinuity detected
dataset end reached
```

Avoid logging every 125 Hz IMU sample individually.

---

## 18. UI Status

Add a telemetry status line.

Useful states:

```text
Telemetry: disabled
Telemetry: loading dataset…
Telemetry: dataset ready
Telemetry: waiting for QR…
Telemetry: synchronized
Telemetry: waiting for first GPS point
Telemetry: QR stale - paused
Telemetry: dataset timestamp mismatch
Telemetry: end of dataset
```

Optionally show:

```text
GPS sent: 123
IMU sent: 15321
Playback rate: 1.00x
QR correction: +7.2 ms
```

for development builds.

---

## 19. Testing Plan

### 19.1 Parser unit tests

Add tests for:

- valid GPS CSV
- valid IMU CSV
- missing required header
- malformed timestamp
- blank line
- optional numeric field
- unsorted timestamps
- empty file
- timestamp values larger than 32-bit range

Use small fixtures rather than the entire 54k/433k-row files in unit tests.

---

### 19.2 QR source clock unit tests

Test:

#### Normal 1x

```text
QR source advances 1 second
local clock advances 1 second
estimated rate ~= 1.0
```

#### 2x playback

```text
QR source advances 2 seconds
local clock advances 1 second
estimated rate ~= 2.0
```

#### Pause

Repeated QR source timestamps should reduce playback-rate estimate toward zero / stop source advancement.

#### Backward seek

```text
100 s -> 25 s
```

must reset cursors.

#### Large forward seek

Must reposition without sending all skipped IMU rows.

#### QR stale

After timeout, `currentSourceTimestampNs()` must stop advancing / scheduler must stop emission.

#### Reacquisition

A new QR should re-anchor and resume.

---

### 19.3 Replay scheduler unit tests

Verify:

- each GPS sample is emitted once
- each IMU sample is emitted once during normal progression
- timestamps are unchanged
- no future sample is emitted early
- seeking resets indices correctly
- large jumps do not cause backlog burst
- GPS and IMU cursors are independent
- start before first GPS fix works correctly

---

### 19.4 Transport tests

Verify serialized telemetry batch contains:

```text
type
mode
trip_id
vehicle_id
recording_session_id
source_clock_ns
gps[]
imu[]
```

Verify:

- multiple IMU samples fit in one batch
- GPS-only batch works
- IMU-only batch works
- empty batch is not sent
- reconnect clears stale pending telemetry
- same session ID is reused across WebRTC reconnect

---

### 19.5 Manual end-to-end test

For one footage:

1. copy corresponding GPS/IMU dataset to Android
2. enter correct Trip ID and Vehicle ID
3. choose dataset folder
4. confirm row counts/ranges
5. start streaming
6. display matching prerecorded footage with QR
7. wait for first valid QR
8. verify telemetry status becomes synchronized
9. inspect server received GPS/IMU timestamps
10. verify GPS progresses with footage
11. pause footage and confirm telemetry stops/holds
12. resume and confirm telemetry resumes
13. seek/restart footage and confirm cursor reset
14. temporarily obscure QR and confirm stale timeout behavior
15. restore QR and confirm recovery

Repeat with a second footage and a different Trip ID to prove timelines do not mix.

---

## 20. Acceptance Criteria

Implementation is complete when all of the following are true:

- [ ] GPS/IMU CSV files remain entirely on Android.
- [ ] No CSV upload endpoint is used or added.
- [ ] Android can select a local telemetry dataset per footage.
- [ ] Selected dataset is validated before streaming.
- [ ] A new `recordingSessionId` identifies each streaming/footage session.
- [ ] The same session ID is used in the WebRTC offer and telemetry messages.
- [ ] QR `source_timestamp_ns` controls the local replay timeline.
- [ ] GPS events preserve original CSV timestamps.
- [ ] Processed IMU events preserve original CSV timestamps.
- [ ] Raw ~1000 Hz IMU is not transmitted.
- [ ] GPS is not artificially converted to video-frame rate on Android.
- [ ] IMU can be network-batched without changing individual sample timestamps.
- [ ] Telemetry pauses when QR synchronization becomes stale.
- [ ] QR reacquisition resumes the timeline.
- [ ] Backward/large forward QR jumps reset cursors rather than replaying backlog.
- [ ] Different footage datasets cannot accidentally share replay cursors.
- [ ] `telemetry-events` is independent from `qr-events`.
- [ ] Telemetry queues are bounded.
- [ ] WebRTC reconnect does not generate a new logical recording session.
- [ ] Stop/start cleanup does not leak executors, schedulers, channels, or dataset cursors.
- [ ] Server sees normal timestamped telemetry events and does not need CSV-specific behavior.

---

## 21. Recommended Implementation Order

### Phase 1 — Models and local dataset loader

Implement:

```text
GpsSample
ImuSample
TelemetryDataset
StreamSessionContext
CsvTelemetryParser
dataset folder selector
dataset validation/status UI
```

No networking changes yet.

Definition of done:

```text
Android successfully loads gps_0000.csv + imu_0000.csv
and displays counts + timestamp ranges.
```

---

### Phase 2 — QR source clock

Implement:

```text
QrSourceClock
QR success integration
playback-rate estimation
stale timeout
seek/discontinuity detection
```

Definition of done:

```text
Logcat shows a stable source clock that follows the QR footage,
including pause/restart/seek behavior.
```

---

### Phase 3 — Replay scheduler

Implement:

```text
TelemetryReplayScheduler
GPS cursor
IMU cursor
binary-search reposition
batch creation
```

Initially log batches locally instead of sending them.

Definition of done:

```text
GPS/IMU source rows become due at the correct QR source timestamps.
```

---

### Phase 4 — WebRTC telemetry channel

Modify `WebRtcPublisher`:

```text
telemetry-events DataChannel
sendTelemetryBatch()
bounded queue
channel-open flushing
reconnect cleanup
```

Move `recordingSessionId` to shared session context.

Definition of done:

```text
Server can observe correctly timestamped telemetry batches from Android.
```

---

### Phase 5 — Backpressure and reconnect hardening

Implement:

```text
bounded pending telemetry
stale IMU coalescing/drop policy
GPS preservation
reconnect state reset
latest-state recovery
```

Definition of done:

```text
Network interruption does not create seconds of delayed telemetry.
```

---

### Phase 6 — End-to-end multi-footage validation

Test at least:

```text
Footage A + GPS A + IMU A + Trip A
Footage B + GPS B + IMU B + Trip B
```

Verify:

```text
different recordingSessionId
different tripId
no cross-dataset timestamps
correct server tracking
```

---

## 22. Files Expected to Change

### Existing

```text
android/app/src/main/java/com/example/webrtccamera/MainActivity.kt
android/app/src/main/java/com/example/webrtccamera/WebRtcPublisher.kt

android/app/src/main/res/layout/activity_main.xml
android/app/src/main/res/layout-land/activity_main.xml

android/app/build.gradle.kts
```

### New

```text
android/app/src/main/java/com/example/webrtccamera/telemetry/model/GpsSample.kt
android/app/src/main/java/com/example/webrtccamera/telemetry/model/ImuSample.kt
android/app/src/main/java/com/example/webrtccamera/telemetry/model/TelemetryBatch.kt
android/app/src/main/java/com/example/webrtccamera/telemetry/model/TelemetryDataset.kt
android/app/src/main/java/com/example/webrtccamera/telemetry/model/StreamSessionContext.kt

android/app/src/main/java/com/example/webrtccamera/telemetry/replay/CsvTelemetryParser.kt
android/app/src/main/java/com/example/webrtccamera/telemetry/replay/CsvReplayTelemetrySource.kt
android/app/src/main/java/com/example/webrtccamera/telemetry/replay/QrSourceClock.kt
android/app/src/main/java/com/example/webrtccamera/telemetry/replay/TelemetryReplayScheduler.kt

android/app/src/main/java/com/example/webrtccamera/telemetry/transport/TelemetryDataChannelSender.kt
```

Add unit tests alongside the implementation using the project's existing Android test layout.

---

## 23. Out of Scope for This Android Plan

Do not implement these as part of this change:

- server-side CSV upload
- MinIO telemetry CSV storage
- server-side CSV parsing
- raw 1000 Hz IMU transmission
- GPS interpolation on Android
- browser/map UI
- PostGIS persistence
- server vehicle-tracking implementation
- actual Android GPS/SensorManager source

The last item is a follow-up implementation that should plug into the same `TelemetrySource` / transport design once replay telemetry works.

---

## 24. Final Target Behavior

```text
                       EXTERNAL DISPLAY
                 prerecorded footage + QR
                            │
                            ▼
                         CameraX
                            │
                    QR source timestamp
                            │
                            ▼
                    QrSourceClock
                            │
           ┌────────────────┴────────────────┐
           │                                 │
     local GPS CSV                    local IMU CSV
        ~1 Hz                            ~125 Hz
           │                                 │
           └──────────► Replay Scheduler ◄───┘
                            │
                     timestamped samples
                            │
                     transport batching
                            │
                            ▼
                  telemetry-events channel
                            │
                         WebRTC
                            │
                            ▼
                          SERVER
                            │
                 same contract later used by
                  real Android GPS + IMU
```

The core rule is:

> **QR determines where the externally displayed footage currently is; Android uses that source time to release the corresponding local GPS/IMU samples, and only those simulated sensor events are sent to the server.**
