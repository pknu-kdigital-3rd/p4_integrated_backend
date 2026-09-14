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
