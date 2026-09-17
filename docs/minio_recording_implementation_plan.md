# MinIO Video Recording Implementation Plan

Target project: `p4_integrated_backend_20260917`

## 1. Recommended architecture

Record on the **Go media relay**, before Python decode/inference.

The current relay already does the expensive/important media step once:

```text
Android H.264 / WebRTC
        |
        v
Go media-relay: TrackRemote.ReadRTP()
        |
        v
yolofeed.Feed.Publish()
        |
        +--> RTP -> ordered immutable Annex-B H.264 AccessUnit
        |      - Epoch
        |      - Seq
        |      - PTS90K
        |      - TimestampUS
        |      - Keyframe
        |      - Data []byte
        |
        +--> current Python inference/playback feed
        |
        +--> NEW Recorder sink
                 |
                 +--> mux compressed H.264 into independent MP4/fMP4 segments
                 +--> local spool file
                 +--> asynchronous upload
                         |
                         v
                       MinIO
                         |
                         v
                 Node recording metadata API
                         |
                         v
                     PostgreSQL
```

Do **not** record decoded frames from FastAPI/OpenCV/PyAV. That would add CPU/GPU work, extra allocations, re-encoding, quality loss, and additional latency.

Do **not** proxy video bytes through Express. Go uploads objects to MinIO directly; Node stores business metadata and issues short-lived playback URLs.

---

## 2. Important findings in the current codebase

### Existing useful pieces

- `services/media-relay/internal/broadcaster/broadcaster.go`
  - is the single owner of `TrackRemote.ReadRTP()`.
- `services/media-relay/internal/yolofeed/yolofeed.go`
  - already reassembles RTP H.264 into Annex-B access units.
  - already maintains a 90 kHz extended timestamp (`PTS90K`).
  - already identifies IDR/keyframes.
  - published `AccessUnit.Data` is immutable.
- `node/prisma/schema.prisma`
  - already contains `TripVideo`.
- Current `docker-compose.yml`
  - has PostgreSQL/PostGIS but no object storage.
- There is currently no production `TripVideo` module/API in Node.

### Main design gap

The relay currently has no authoritative `tripId` / recording-session identity in the Android WebRTC offer. Recording cannot safely be attached to a trip until signaling carries that context.

---

## 3. Recording ownership and lifecycle

### Ownership

Use these responsibilities:

```text
Android
  - camera/H.264 source
  - sends WebRTC stream
  - sends trip/session identity during signaling

Go media-relay
  - owns recording data path
  - creates media segments
  - uploads finalized files to MinIO
  - notifies Node of finalized/failed segments

Node Express
  - owns authorization and DB metadata
  - validates that trip exists and may be recorded
  - lists recordings
  - creates short-lived MinIO presigned GET URLs

MinIO
  - owns video object bytes only

PostgreSQL
  - owns searchable recording metadata
```

### Start

Start recording when all are true:

1. Android publisher is connected.
2. signaling contains valid `tripId` and `recordingSessionId`.
3. recording is enabled.
4. first IDR/keyframe is received.

Never start an independently playable segment on a P-frame.

### Segment rollover

Recommended initial value:

```text
RECORDING_SEGMENT_SECONDS=60
```

At the segment boundary:

1. request an IDR via the existing `Broadcaster.RequestKeyFrame()` path;
2. continue current segment until that IDR arrives;
3. finalize current segment immediately before the new keyframe;
4. start the next segment with the new keyframe;
5. enqueue finalized file for MinIO upload.

This gives bounded files and keeps every object independently decodable.

### Stop

Finalize the active segment when:

- Android disconnects;
- publisher is replaced;
- explicit recording stop is received;
- relay shuts down cleanly.

If a segment cannot be finalized, report it as failed and keep the live/inference pipeline running.

---

## 4. Preserve the current zero/low-copy media path

Do not depacketize H.264 a second time in the recorder.

Refactor `yolofeed.Feed.Publish()` to return the newly completed `*AccessUnit` when the RTP marker completes a frame.

Conceptually:

```go
func (f *Feed) Publish(packet *rtp.Packet) *AccessUnit {
    if packet == nil {
        return nil
    }

    f.mu.Lock()
    defer f.mu.Unlock()

    // existing ordering / depacketization code ...

    if packet.Header.Marker {
        return f.finishAccessUnitLocked(packet.Header.Timestamp)
    }
    return nil
}
```

Change:

```go
func (f *Feed) finishAccessUnitLocked(rtpTS uint32)
```

to:

```go
func (f *Feed) finishAccessUnitLocked(rtpTS uint32) *AccessUnit
```

Return the same immutable `AccessUnit` pointer already appended to the inference backlog.

Then in `Broadcaster.readPublisher()`:

```go
item := b.yolo.Publish(packet)
if item != nil && b.recorder != nil {
    b.recorder.Publish(item)
}
```

The recorder must use only immutable fields:

- `Epoch`
- `Seq`
- `PTS90K`
- `TimestampUS`
- `Keyframe`
- `Data`

Do not rely on `QR`, because it may be attached after the access unit was first created.

---

## 5. Recorder package

Add:

```text
services/media-relay/internal/recording/
  recorder.go
  segment.go
  uploader.go
  minio.go
  nodeclient.go
  recorder_test.go
```

Suggested interfaces:

```go
type Context struct {
    TripID             int64
    VehicleID          int64
    RecordingSessionID string
}

type AccessUnit struct {
    Epoch       uint64
    Seq         uint64
    PTS90K      int64
    TimestampUS int64
    Keyframe    bool
    Data        []byte
}

type Recorder interface {
    Start(ctx Context) error
    Publish(au *yolofeed.AccessUnit)
    Stop(reason string)
    Close() error
}
```

### Backpressure rule

Recording must not make `TrackRemote.ReadRTP()` wait on MinIO/network I/O.

Use two stages:

```text
RTP/read loop
   |
   v
bounded recorder channel
   |
   v
local segment writer
   |
   v
bounded upload queue
   |
   v
MinIO uploader goroutine
```

Important policy:

- local mux/write may be buffered;
- MinIO upload is always asynchronous;
- queue sizes are bounded;
- if recorder input cannot keep up, abort the current recording segment, emit a metric/error, request a new IDR, and start a new segment when possible;
- **never let MinIO outage freeze live streaming or YOLO ingestion**.

Suggested configuration:

```text
RECORDING_ENABLED=true
RECORDING_SEGMENT_SECONDS=60
RECORDING_QUEUE_FRAMES=180
RECORDING_UPLOAD_QUEUE=8
RECORDING_SPOOL_DIR=/var/tmp/p4-recordings
RECORDING_SPOOL_MAX_BYTES=10737418240
```

---

## 6. Container format

Store browser-friendly **H.264 in fragmented MP4 / MP4**, not decoded images.

Use the relay's 90 kHz RTP presentation clock as the MP4 video timescale where practical:

```text
TimeScale = 90000
```

Each MinIO object should be independently playable and should begin with SPS/PPS + IDR.

A suitable Go implementation can use a maintained MP4/fMP4 muxing library. `mediacommon/v2/pkg/formats/fmp4` supports fragmented-MP4 initialization blocks, parts, H.264 samples, durations, base times, and a 90 kHz-style timescale. Pin the exact dependency version after a playback smoke test; do not use an unpinned moving dependency in production.

Do not invoke a full H.264 re-encode. This is a **mux/remux only** path.

---

## 7. MinIO object layout

Private bucket:

```text
p4-trip-recordings
```

Object key:

```text
trips/{tripId}/sessions/{recordingSessionId}/segment-{segmentIndex:06d}.mp4
```

Example:

```text
trips/312/sessions/01K5.../segment-000004.mp4
```

Do not put temporary presigned URLs in the database because they expire.

Store bucket + object key as the durable object identity.

### Upload flow

Finalize to a local spool file first, then use MinIO Go SDK `FPutObject()`.

Why:

- finalized MP4/fMP4 metadata is known;
- object size is known;
- retrying is simple;
- a MinIO outage does not hold the media ingest loop open;
- incomplete multipart objects are avoided for ordinary short segments.

On successful upload:

1. capture `ETag`, object size, bucket and object key;
2. notify Node internal API;
3. only delete the local spool file after Node acknowledges finalized metadata.

If Node is temporarily unavailable after upload, retry metadata registration idempotently.

---

## 8. MinIO deployment

Extend `docker-compose.yml` with a MinIO service and persistent volume.

Development shape:

```yaml
minio:
  image: minio/minio:<PINNED_RELEASE>
  command: server /data --console-address ":9001"
  restart: unless-stopped
  environment:
    MINIO_ROOT_USER: ${MINIO_ROOT_USER}
    MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    MINIO_BROWSER_REDIRECT_URL: ${MINIO_BROWSER_REDIRECT_URL}
  ports:
    - "127.0.0.1:9000:9000"
    - "127.0.0.1:9001:9001"
  volumes:
    - p4_minio_data:/data
```

Add:

```yaml
volumes:
  p4_pgdata:
  p4_minio_data:
```

Keep both MinIO ports loopback-bound. When operators need console access, expose
it through the HTTPS reverse proxy and set `MINIO_BROWSER_REDIRECT_URL` to the
proxy URL (port `39004` in this deployment).

Create the recording bucket during deployment/bootstrap and keep it private.

---

## 9. Environment variables

Set these variables in `deploy/env.local` or `deploy/env.production` when
recording is enabled. The Linux stack script loads this file and passes the
relevant settings to MinIO, the Go relay, and the Node backend:

```dotenv
RECORDING_ENABLED=true
RECORDING_SEGMENT_SECONDS=60
RECORDING_QUEUE_FRAMES=180
RECORDING_SPOOL_DIR=/var/tmp/p4-recordings
RECORDING_SPOOL_MAX_BYTES=10737418240
RECORDING_UPLOAD_QUEUE=8

NODE_INTERNAL_BASE_URL=http://127.0.0.1:3000
NODE_INTERNAL_SERVICE_TOKEN="replace-with-a-random-token-at-least-32-characters"

# Go relay's private MinIO API connection and write-only service account
MINIO_ENDPOINT=127.0.0.1:9000
MINIO_USE_SSL=false
MINIO_RECORDING_BUCKET=p4-trip-recordings
MINIO_ACCESS_KEY=p4-relay
MINIO_SECRET_KEY="replace-with-an-independent-random-secret"

# Node backend's read-only MinIO service account and public playback origin
MINIO_NODE_ACCESS_KEY=p4-node
MINIO_NODE_SECRET_KEY="replace-with-an-independent-random-secret"
MINIO_PUBLIC_ENDPOINT=https://10.174.96.95:39003

# MinIO server/bootstrap administrator credentials and Console URL
MINIO_ROOT_USER=p4-minio-root
MINIO_ROOT_PASSWORD="replace-with-an-independent-random-secret"
MINIO_BROWSER_REDIRECT_URL=https://10.174.96.95:39004
```

Replace every example secret before setting `RECORDING_ENABLED=true`. Use
independent secrets for the Node internal-service token, relay MinIO account,
Node MinIO account, and MinIO root account. MinIO secret keys must be at least
8 characters; `NODE_INTERNAL_SERVICE_TOKEN` must be at least 32 characters and
must have the same value in the Go relay and Node process environments.

`MINIO_ENDPOINT` is the loopback API address used by the relay to upload files.
`MINIO_PUBLIC_ENDPOINT` is the HTTPS S3 API origin used to create playback
URLs, and must be reachable by clients at port `39003`. Set
`MINIO_BROWSER_REDIRECT_URL` to the HTTPS Console proxy at port `39004`.
`MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` are for MinIO bootstrap and
administration only; application services use their dedicated accounts.

The public URLs above use `10.174.96.95`; change them to match
`TLS_PUBLIC_ADDRESS` if the host address changes.

---

## 10. Signaling: attach a recording to the correct trip

Current `/offer/android` only contains SDP and type.

Extend it:

```json
{
  "type": "offer",
  "sdp": "...",
  "tripId": "312",
  "vehicleId": "27",
  "recordingSessionId": "01K5..."
}
```

Go model:

```go
type OfferModel struct {
    SDP                string `json:"sdp"`
    Type               string `json:"type"`
    TripID             int64  `json:"tripId"`
    VehicleID          int64  `json:"vehicleId"`
    RecordingSessionID string `json:"recordingSessionId"`
}
```

Do not trust `tripId` blindly.

Preferred flow:

```text
Android -> Node: obtain active trip / recording token
Android -> Go /offer/android: offer + short-lived recording token
Go -> Node internal validation: token -> tripId / vehicleId
Go: start recorder with validated context
```

For the first local PoC, passing numeric IDs directly is acceptable on a trusted LAN, but keep token validation as the production target.

Because this relay currently supports a single active publisher, recording state can remain single-session initially.

---

## 11. Prisma / database changes

The existing `TripVideo` table is close but insufficient for MinIO segments and relay epoch/sequence identity.

Do not store an expiring HTTP URL as the only source of truth.

Recommended evolution:

```prisma
model TripVideo {
    tripVideoId       BigInt    @id @default(autoincrement()) @map("trip_video_id")
    tripId            BigInt    @map("trip_id")

    recordingSessionId String   @map("recording_session_id") @db.VarChar(80)
    segmentIndex       Int      @map("segment_index")

    storageBucket      String   @map("storage_bucket") @db.VarChar(100)
    objectKey          String   @unique @map("object_key")
    videoUrl           String?  @map("video_url") // compatibility only; do not store presigned URL
    contentType        String   @default("video/mp4") @map("content_type") @db.VarChar(100)
    etag               String?  @db.VarChar(128)
    sizeBytes          BigInt?  @map("size_bytes")

    relayEpoch         BigInt   @map("relay_epoch")
    startSeq           BigInt   @map("start_seq")
    endSeq             BigInt?  @map("end_seq")
    startPts90k        BigInt   @map("start_pts_90k")
    endPts90k          BigInt?  @map("end_pts_90k")

    startFrameId       BigInt?  @map("start_frame_id")
    endFrameId         BigInt?  @map("end_frame_id")

    startedAt          DateTime @map("started_at") @db.Timestamptz(6)
    endedAt            DateTime? @map("ended_at") @db.Timestamptz(6)
    fps                 Decimal? @db.Decimal(5, 2)
    durationSec         Int?     @map("duration_sec")

    uploadStatus        String   @default("FINALIZED") @map("upload_status") @db.VarChar(20)
    failureReason       String?  @map("failure_reason")
    createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

    trip Trip @relation(fields: [tripId], references: [tripId])

    @@unique([recordingSessionId, segmentIndex])
    @@index([tripId, startedAt], map: "idx_trip_video_trip_start")
    @@index([tripId, relayEpoch, startSeq], map: "idx_trip_video_relay_seq")
    @@map("trip_video")
}
```

Suggested `upload_status` values:

```text
FINALIZED | FAILED
```

Do not keep long-lived `UPLOADING` rows unless Node creates the row before object upload. A simpler first implementation registers only completed segments and separately logs failed segments.

### Migration rule

Update in the same change set:

- `node/prisma/schema.prisma`
- generated migration SQL
- Prisma generated client
- Node OpenAPI/schema definitions
- current ERD documentation (`docs/v17_its_integrated_erd.md` or the next version)
- recording/replay architecture docs

---

## 12. Node recording module

Add:

```text
node/src/modules/recording/
  recording.schema.ts
  recording.repository.ts
  recording.service.ts
  recording.controller.ts
  recording.router.ts
  recording.openapi.ts
```

### Internal finalize endpoint

```text
POST /internal/recordings/segments
```

Example body:

```json
{
  "tripId": "312",
  "vehicleId": "27",
  "recordingSessionId": "01K5...",
  "segmentIndex": 4,
  "storageBucket": "p4-trip-recordings",
  "objectKey": "trips/312/sessions/01K5.../segment-000004.mp4",
  "contentType": "video/mp4",
  "etag": "...",
  "sizeBytes": "48382910",
  "relayEpoch": "8",
  "startSeq": "2010",
  "endSeq": "3811",
  "startPts90k": "90281201",
  "endPts90k": "95681201",
  "startedAt": "2026-09-17T00:10:00.000Z",
  "endedAt": "2026-09-17T00:11:00.000Z",
  "durationSec": 60
}
```

Make this endpoint idempotent with:

```text
(recording_session_id, segment_index)
```

as a unique key.

### Public/operator endpoints

```text
GET /trips/:tripId/videos
GET /trip-videos/:tripVideoId
POST /trip-videos/:tripVideoId/playback-url
```

`playback-url` flow:

1. authenticate user;
2. authorize trip access;
3. load bucket/object key from DB;
4. create MinIO `presignedGetObject()` URL, e.g. 5 minutes;
5. return URL + expiry + segment metadata.

Never stream the large object through Express.

---

## 13. MinIO clients

### Go relay

Add:

```text
github.com/minio/minio-go/v7
```

Use `FPutObject()` for finalized spool files.

### Node

Add:

```text
minio
```

Use `presignedGetObject()` to create short-lived private playback links.

Keep separate credentials:

```text
relay credential:
  write recording bucket
  stat objects if needed

node credential:
  read/stat + presign
  no bucket administration in ordinary runtime
```

---

## 14. Failure handling

### MinIO down

- finish segment locally;
- keep it in spool;
- retry upload with bounded exponential backoff;
- do not block RTP ingest;
- enforce spool disk limit;
- oldest failed/unuploaded file must not be silently deleted: emit a clear critical log/metric before any configured eviction policy.

### Node down after MinIO upload

- retain a tiny sidecar manifest next to the spool file or in an uploader journal;
- retry the idempotent Node registration;
- only mark the segment completely committed after Node acknowledges.

### Relay crash

- on startup scan spool directory;
- retry any finalized `.mp4` + manifest files;
- discard only clearly incomplete temp files after logging them.

File convention:

```text
segment-000004.mp4.tmp   # currently writing
segment-000004.mp4       # finalized, ready to upload
segment-000004.json      # durable upload/DB manifest
```

### RTP discontinuity / feed epoch reset

Treat an epoch change as a hard recording discontinuity:

1. finalize/abort previous segment;
2. do not bridge frames across epochs;
3. wait for new IDR;
4. create a new segment carrying the new `relayEpoch`.

---

## 15. Metrics and logging

Add relay metrics/log fields:

```text
recording_active
recording_session_id
recording_segment_index
recording_segment_frames
recording_segment_bytes
recording_queue_depth
recording_upload_queue_depth
recording_spool_bytes
recording_segments_uploaded_total
recording_upload_failures_total
recording_dropped_segments_total
recording_last_upload_ms
```

Extend `/internal/status` with non-secret recording status:

```json
{
  "live": true,
  "recording": {
    "active": true,
    "tripId": "312",
    "segmentIndex": 4,
    "uploadQueue": 0
  }
}
```

Do not expose MinIO credentials or internal service tokens.

---

## 16. Tests

### Go unit tests

1. segment does not start before IDR;
2. SPS/PPS are available at segment start;
3. AU order follows `(epoch, seq)`;
4. PTS is monotonic inside a segment;
5. 60-second rollover waits for / requests a keyframe;
6. epoch change closes current segment;
7. upload worker retries MinIO errors;
8. recorder queue overload does not deadlock broadcaster;
9. publisher disconnect finalizes segment;
10. replacement publisher cannot append to previous recording session.

### Integration test

Use Docker MinIO and a deterministic H.264 fixture:

```text
fixture H.264 -> recorder -> MinIO -> download object -> ffprobe
```

Verify:

- codec = H.264;
- object duration approximately matches expected duration;
- first video sample is independently decodable;
- no re-encode occurred;
- segment count and DB rows match;
- presigned URL supports GET / Range GET.

### Regression test

Run existing relay + Vision tests and compare:

- relay allocations;
- YOLO feed FPS;
- playback FPS;
- Go heap;
- Python decode/inference latency.

Recording must not materially change the Python allocation profile because Python should receive the same compressed feed as before.

---

## 17. Implementation phases

### Phase 1 - MinIO infrastructure

- add MinIO to compose;
- add env settings;
- private bucket bootstrap;
- add local credentials;
- health check.

### Phase 2 - Relay recorder

- make `Feed.Publish()` return completed immutable `AccessUnit`;
- create recorder package;
- mux to 60-second MP4/fMP4 segments;
- spool locally;
- async MinIO upload;
- lifecycle on connect/disconnect/epoch change.

### Phase 3 - recording identity

- extend Android signaling with recording context;
- extend Go `OfferModel`;
- validate trip/session context;
- protect against publisher replacement mixing sessions.

### Phase 4 - DB + Node

- migrate `TripVideo`;
- add recording module;
- add internal idempotent segment registration API;
- add public list/detail/presign endpoints;
- update OpenAPI and ERD in the same change.

### Phase 5 - replay integration

- UI lists trip recording segments;
- request presigned URL from Node;
- play segment directly from MinIO;
- later add synchronized detection/GPS overlay using `(relayEpoch, seq/PTS)` mapping.

### Phase 6 - resilience

- spool recovery after process restart;
- retry policy;
- disk limits;
- metrics;
- MinIO/Node outage tests.

---

## 18. Agent implementation order

Give an implementation agent these commits in order:

```text
1. infra: add MinIO service + config
2. relay: expose completed AccessUnit from yolofeed without extra H264 copy
3. relay: add segmented H264->MP4 recorder with local spool
4. relay: add async MinIO uploader and recovery journal
5. signaling/android: add recording trip/session context
6. node/db: evolve TripVideo schema and migration
7. node: add internal segment registration endpoint
8. node: add recording list/detail/presigned playback endpoint
9. docs: update ERD + recording architecture + env/runbook
10. tests: MinIO integration, playback validation, failure recovery, allocation regression
```

Do not combine all ten into one large change. Keep the live video path green after each step.

---

## 19. Acceptance criteria

The recording feature is complete when:

1. Android connects and live YOLO playback behaves exactly as before.
2. A recording automatically starts on the first usable IDR for a validated trip.
3. Video is split into bounded independently playable objects.
4. Objects are stored in a private MinIO bucket.
5. PostgreSQL stores durable bucket/object metadata; it does not store temporary presigned URLs.
6. Operator API lists recordings by trip.
7. Authorized clients receive a short-lived MinIO GET URL and can play the object directly.
8. MinIO or Node failure does not stop the WebRTC/inference pipeline.
9. Finalized-but-uncommitted recordings survive relay restart through the local spool/journal.
10. Existing allocation/FPS tests show no significant regression in the live path.
