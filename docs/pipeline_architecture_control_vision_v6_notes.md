# Vehicle Vision & Control Architecture — Flow Notes

The SVG intentionally shows only topology, protocols, and short responsibility labels. Detailed semantics live here.

| # | Flow | Purpose / payload |
|---|---|---|
| 1 | Android → Node/Express — HTTPS Control | Device authentication and bootstrap request. |
| 2 | Node/Express → Android — Bootstrap | Returns device credential plus service addresses, including the **Vision Service Address**. Node does not host the Vision gRPC endpoint. |
| 3 | Android → FastAPI Vision — gRPC Inference | Sends `FrameEnvelope` for GPU inference. The **actual Vision gRPC endpoint is owned by FastAPI Vision Service**. |
| 4 | Android → Tauri — Direct gRPC Frames | Low-latency live-frame path. It bypasses Node/Express and FastAPI. |
| 5 | Android → Object Storage — H.264 PUT | Uploads locally encoded recording segments with video PTS. |
| 6 | FastAPI Vision → Tauri — gRPC Detections | Streams inference results carrying the same frame identity used by Android. |
| 7 | Tauri ↔ Node/Express — HTTPS REST | Operator auth, RBAC, business APIs, history/replay metadata, and service discovery. Auth/bootstrap may return JWT + Vision Service Address. |
| 8 | Object Storage → Tauri — Range GET | Replay media retrieval using access authorized/presigned through the control plane. |

## Ownership

| Component | Owns |
|---|---|
| Node / Express | Auth, RBAC, JWT issuance, service discovery, business/history/replay APIs |
| FastAPI Vision Service + GPU | Vision gRPC endpoint, inference, tracking/post-processing, live detections |
| PostgreSQL + PostGIS | Shared persistent business and inference metadata |
| Object Storage | H.264 segments, event images, replay media |
| Tauri Dashboard | Live view, control UI, frame/detection join, replay UI |
| Android Device | Capture identity, live frames, inference frames, local H.264 recording |

## Frame synchronization

- Android is the source of `session_id`, `frame_id`, and `capture_timestamp_ns`.
- GPU/FastAPI echoes the same identity in detection results.
- Live joining uses `session_id + frame_id` rather than arrival order.
- Replay aligns capture time with video PTS through stored time anchors.
- FastAPI persistence is asynchronous/batched and remains outside the inference critical path.

## Android GPS/IMU telemetry (v18)

Android sends `telemetry-events` on the same WebRTC PeerConnection as video and `qr-events` (`mode=REPLAY` when replaying a recorded dataset, `LIVE` for real sensors; the server path is identical).

| Flow | Purpose / payload |
|---|---|
| Android → Go relay — `telemetry-events` DataChannel | Batches of GPS (~1 Hz) and processed IMU (~125 Hz) samples, each with its source `timestamp_ns`. |
| Go relay → Node — `POST /internal/telemetry/gps` | Every authoritative GPS fix, bound to the relay-validated trip/vehicle/session, persisted idempotently to `vehicle_position` (`REPLAY→RECORDED_GPS`, `LIVE→DEVICE_GPS`). |
| Go relay → Vision — `POST /internal/telemetry` | Full GPS/IMU batches for the live-video source timeline (bounded, stale IMU dropped first). |
| Routing/tracking → Go relay — `GET /internal/telemetry/vehicles` | Current device positions merged with BIMS in `/internal/vehicles`. |
| Vision → browser — frame metadata `telemetry` | GPS/IMU matched to the frame's resolved source timestamp (interpolated/extrapolated/held/stale status explicit). |
| Vision iframe → operator page — `postMessage` | Telemetry of the frame actually presented; drives only the selected Live View marker. |

- Identity is server-authoritative: telemetry is bound to the Node-validated `tripId`/`vehicleId`/`recordingSessionId` of the SDP offer; payload identity that disagrees is rejected, and a replaced PeerConnection cannot inject telemetry.
- `recordingSessionId + source_timestamp_ns` locate telemetry in the source footage; `vehicleId + tripId` identify the real vehicle/trip; `received_at` is when the server received it. These stay separate end to end.
- Vision resolves each frame's source time from QR anchors plus RTP PTS (playback rate estimated, rewinds/seeks start a new generation) and matches telemetry only within the frame's own session.
- Only real source GPS fixes are persisted. IMU and display positions are transient.
