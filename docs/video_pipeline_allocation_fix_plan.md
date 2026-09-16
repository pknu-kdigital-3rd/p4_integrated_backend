# Video Inference / Frame Passthrough Allocation Optimization Plan

## Goal

Reduce unnecessary CPU/GPU memory allocation, buffer copying, garbage collection pressure, and frame retention in the video pipeline while preserving current behavior.

Primary targets:

1. Prevent decoded-frame backlog when inference is slower than ingest.
2. Reduce multi-megabyte per-frame allocations in the Python inference path.
3. Reduce unnecessary H.264 access-unit copies in Go and Python.
4. Reduce per-object allocation and GPU→CPU synchronization in segmentation post-processing.
5. Add instrumentation so allocation regressions are measurable.

The implementation should be performed incrementally. Do not combine all optimizations into one unverified change.

---

# 1. Current Problem Summary

The pipeline currently contains several allocation-heavy points.

Approximate allocation size at 1920×1080:

| Stage | Approximate allocation |
|---|---:|
| Android I420 frame | ~2.97 MiB/frame |
| PyAV decoded YUV frame | ~2.97 MiB/frame |
| `frame.to_ndarray(format="bgr24")` | ~5.93 MiB/frame |
| Go H.264 copies | tens of KiB/frame, but repeated |
| Python H.264 copies | tens of KiB/frame, repeated |
| Segmentation masks | scales with number of detections |
| Queue backlog | potentially unbounded |

The raw-frame allocations dominate bandwidth and memory pressure.

A particularly serious problem is the unbounded Python inference queue.

If video arrives at 30 FPS and inference runs at 20 FPS, 10 decoded frames per second can accumulate.

At 1080p YUV420:

```text
1920 × 1080 × 1.5 ≈ 2.97 MiB/frame

2.97 MiB × 10 frames/sec
≈ 29.7 MiB/sec retained

≈ 1.78 GiB/minute
```

This can cause increasing latency and RAM usage.

---

# 2. Priority Order

Implement in this order:

```text
P0  Bound / replace inference queue
P0  Add allocation and queue instrumentation

P1  Avoid full-resolution BGR conversion before YOLO
P1  Batch GPU→CPU transfer of detection metadata

P2  Reduce segmentation-mask allocation
P2  Reduce Python H.264 slicing/copying

P3  Reduce Go H.264 copies
P3  Reuse Go assembly buffers

P4  Android frame buffer reuse investigation
P4  Browser copy reduction investigation
```

Do not begin with micro-optimizing compressed H.264 copies while an unbounded decoded-frame queue still exists.

---

# 3. P0 — Bound the Inference Queue

## Problem

Current logic uses an unbounded `asyncio.Queue`.

Conceptually:

```python
inference_queue: asyncio.Queue[InferenceFrame] = field(
    default_factory=asyncio.Queue
)
```

When inference becomes slower than frame arrival, decoded `VideoFrame` objects accumulate.

This is especially dangerous because these frames are already decompressed.

---

## Preferred Fix: Latest-Frame Queue

For real-time inference, prefer freshness over processing every historical frame.

Use a queue with capacity 1 or 2.

Example:

```python
inference_queue: asyncio.Queue[InferenceFrame] = field(
    default_factory=lambda: asyncio.Queue(maxsize=1)
)
```

When inserting a new frame:

```python
def enqueue_latest(queue: asyncio.Queue, item) -> int:
    dropped = 0

    while queue.full():
        try:
            queue.get_nowait()
            queue.task_done()
            dropped += 1
        except asyncio.QueueEmpty:
            break

    queue.put_nowait(item)
    return dropped
```

Use:

```python
dropped = enqueue_latest(state.inference_queue, inference_frame)
state.metrics.inference_frames_dropped += dropped
```

Do not block video ingest waiting for YOLO.

---

## Alternative

If short bursts must be tolerated, use:

```python
asyncio.Queue(maxsize=2)
```

or:

```python
asyncio.Queue(maxsize=3)
```

Do not use a large queue.

---

## Configuration

Add explicit configuration:

```text
YOLO_FRAME_DROP_POLICY=latest
YOLO_INFERENCE_QUEUE_SIZE=1
```

Recommended default:

```text
YOLO_FRAME_DROP_POLICY=latest
YOLO_INFERENCE_QUEUE_SIZE=1
```

If `queue` mode is retained for debugging, require a finite maximum size.

Example:

```text
YOLO_FRAME_DROP_POLICY=queue
YOLO_INFERENCE_QUEUE_SIZE=30
```

Never permit infinite queue growth.

---

## Acceptance Criteria

Under an intentionally overloaded inference workload:

```text
input FPS:       30
inference FPS:   ~15
test duration:   5 minutes
```

Expected:

```text
inference_queue.qsize() <= configured max size
RSS remains approximately stable
latency does not continually increase
dropped-frame counter increases
browser passthrough remains unaffected
```

---

# 4. P0 — Add Allocation / Memory Instrumentation

Optimization should be based on measured values.

Add lightweight runtime metrics.

---

## Python Metrics

Track:

```python
process RSS
inference queue size
inference frames dropped
decoded frames received
frames inferred
inference latency
post-processing latency
WebSocket output FPS
CUDA allocated memory
CUDA reserved memory
CUDA peak memory
```

Example:

```python
import os
import psutil
import torch

process = psutil.Process(os.getpid())

rss_bytes = process.memory_info().rss

if torch.cuda.is_available():
    cuda_allocated = torch.cuda.memory_allocated()
    cuda_reserved = torch.cuda.memory_reserved()
    cuda_peak = torch.cuda.max_memory_allocated()
```

Log every 5 seconds instead of every frame.

Example:

```text
[mem]
rss=1324MiB
queue=1
dropped=381
cuda_alloc=812MiB
cuda_reserved=1240MiB
infer_fps=22.4
input_fps=30.0
```

---

## Python Allocation Profiling

Support optional `tracemalloc`.

```python
import tracemalloc

tracemalloc.start(25)
```

Periodically:

```python
snapshot = tracemalloc.take_snapshot()

for stat in snapshot.statistics("lineno")[:20]:
    logger.info(stat)
```

Do not enable continuously in production.

Add an environment variable:

```text
ENABLE_PYTHON_ALLOC_PROFILE=false
```

---

## CUDA Profiling

At controlled test points:

```python
torch.cuda.reset_peak_memory_stats()
```

After workload:

```python
torch.cuda.max_memory_allocated()
torch.cuda.max_memory_reserved()
```

Do not call:

```python
torch.cuda.empty_cache()
```

every frame.

---

## Go Metrics

Expose or log:

```text
HeapAlloc
HeapInuse
HeapObjects
TotalAlloc
Mallocs
Frees
NumGC
PauseTotalNs
```

Use:

```go
runtime.ReadMemStats(&m)
```

Log at intervals.

For profiling, enable `pprof`.

Useful profiles:

```bash
go tool pprof -alloc_space <profile>
go tool pprof -inuse_space <profile>
```

`alloc_space` is important because the steady-state heap can look small even when many buffers are allocated and discarded.

---

## Acceptance Criteria

The system must allow a developer to answer:

```text
How many frames are queued?
How much RSS is currently used?
How many frames have been dropped?
What is the current inference FPS?
How much CUDA memory is allocated/reserved?
Which Go functions create the most cumulative allocation?
```

without modifying source code.

---

# 5. P1 — Avoid Full-Resolution BGR Allocation Before YOLO

## Problem

Current inference includes a conversion similar to:

```python
image = frame.to_ndarray(format="bgr24")
```

At 1080p this allocates roughly:

```text
1920 × 1080 × 3
≈ 5.93 MiB/frame
```

YOLO then resizes the image to approximately 640-class inference resolution.

This means a multi-megabyte BGR image is created only to immediately shrink it.

---

# 6. Preferred Approach — Resize Before BGR Materialization

Investigate whether the PyAV frame can be reformatted/scaled before NumPy conversion.

Example direction:

```python
small_frame = frame.reformat(
    width=target_width,
    height=target_height,
    format="bgr24",
)

image = small_frame.to_ndarray()
```

Calculate dimensions while preserving aspect ratio.

Example:

```python
def fit_size(width: int, height: int, max_side: int = 640):
    scale = min(max_side / width, max_side / height, 1.0)

    return (
        int(width * scale),
        int(height * scale),
    )
```

Then:

```python
target_w, target_h = fit_size(frame.width, frame.height, 640)

small_frame = frame.reformat(
    width=target_w,
    height=target_h,
    format="bgr24",
)

image = small_frame.to_ndarray()
```

Verify how Ultralytics handles further letterboxing.

---

## Important

Do not accidentally degrade detection coordinates.

If inference operates on resized data, ensure resulting coordinates are transformed back to the original frame coordinate system.

If Ultralytics already manages source-size metadata internally, verify behavior with tests.

---

## Expected Allocation Reduction

1080p BGR:

```text
~5.93 MiB
```

640×360 BGR:

```text
640 × 360 × 3
≈ 0.66 MiB
```

Potential reduction:

```text
~5.27 MiB/inferred frame
```

At 30 FPS:

```text
~158 MiB/sec less BGR allocation/write traffic
```

Actual results depend on PyAV/FFmpeg implementation and YOLO preprocessing.

---

## Acceptance Criteria

Compare before and after:

```text
RSS
Python alloc_space / tracemalloc
inference latency
CPU utilization
GPU utilization
detection output
mask coordinates
```

Detection accuracy must remain functionally equivalent.

---

# 7. P1 — Batch Detection Tensor Transfer to CPU

## Problem

Avoid patterns that synchronize GPU→CPU once per detection:

```python
for box in result.boxes:
    confidence = float(box.conf[0])
    class_id = int(box.cls[0])
    xyxy = box.xyxy[0].cpu().tolist()
```

With many objects, each individual conversion can trigger small allocations and CUDA synchronization.

---

## Fix

Transfer the entire tensors once.

Example:

```python
boxes = result.boxes

xyxy = boxes.xyxy.detach().cpu().numpy()
conf = boxes.conf.detach().cpu().numpy()
cls = boxes.cls.detach().cpu().numpy()
```

Then:

```python
for i in range(len(xyxy)):
    detection = {
        "bbox": xyxy[i].tolist(),
        "confidence": float(conf[i]),
        "class_id": int(cls[i]),
    }
```

If normalized coordinates are required:

```python
xyxyn = boxes.xyxyn.detach().cpu().numpy()
```

Do one bulk transfer.

---

## Acceptance Criteria

Use video containing at least:

```text
20 objects/frame
50 objects/frame if available
```

Compare:

```text
postprocess latency
CUDA synchronization time
CPU usage
output equality
```

---

# 8. P2 — Reduce Segmentation Mask Allocation

## Problem

Mask work scales with number of detected objects.

Common expensive operations include:

```python
selected_masks = masks[box_indices]
```

and:

```python
F.interpolate(
    mask_data.unsqueeze(1).float(),
    ...
)
```

Large `N × H × W` tensors can create significant temporary GPU allocations.

---

## Fix A — Filter Before Mask Processing

Apply confidence/class/ROI filtering before manipulating masks.

Preferred order:

```text
boxes
↓
confidence filtering
↓
class filtering
↓
ROI / application-specific filtering
↓
select remaining mask indexes
↓
mask resizing / contour generation
```

Do not resize masks that will later be discarded.

---

## Fix B — Avoid Full-Resolution Masks When Not Needed

If browser rendering only needs polygons:

```text
mask tensor
↓
contour extraction at reduced resolution
↓
scale polygon coordinates
```

Do not create full-resolution binary masks unless required.

---

## Fix C — Remove Redundant Python List Allocation

If current code resembles:

```python
detection["mask"] = [
    [float(x), float(y)]
    for x, y in polygon.tolist()
]
```

replace with:

```python
detection["mask"] = polygon.tolist()
```

if the output format is already acceptable.

---

## Fix D — Optional Mask Simplification

Before serialization, optionally reduce polygon point count.

Use OpenCV:

```python
epsilon = 0.002 * cv2.arcLength(contour, True)
polygon = cv2.approxPolyDP(contour, epsilon, True)
```

Make this configurable.

Example:

```text
MASK_POLYGON_SIMPLIFY=true
MASK_POLYGON_EPSILON_RATIO=0.002
```

This reduces:

```text
Python objects
JSON size
WebSocket payload size
browser parsing
browser drawing work
```

---

# 9. P2 — Reduce Python H.264 Copies

## Problem

The Unix socket record parser can create several immutable `bytes` objects.

Example:

```python
payload = await reader.readexactly(length)
body = payload[1:]
encoded = body[4 + meta_len:]
```

Each slice of `bytes` creates a new object.

---

## Fix

Parse using `memoryview`.

Example:

```python
payload = await reader.readexactly(length)
view = memoryview(payload)

record_type = view[0]
body = view[1:]

meta_len = int.from_bytes(body[:4], "big")

metadata_view = body[4:4 + meta_len]
encoded_view = body[4 + meta_len:]
```

Only convert to `bytes` at a boundary where a downstream library absolutely requires it.

Example:

```python
metadata = json.loads(metadata_view.tobytes())
```

Keep encoded H.264 as a view if possible.

---

## Caution

A `memoryview` keeps the original backing object alive.

Do not retain a tiny slice of a very large backing buffer longer than necessary.

For frame-sized records this is generally acceptable, but measure.

---

# 10. P2 — Avoid Rebuilding WebSocket Payload More Than Necessary

## Problem

Code similar to:

```python
return (
    len(metadata_bytes).to_bytes(4, "big")
    + metadata_bytes
    + item.encoded
)
```

creates a new contiguous object containing the full H.264 access unit.

---

## Possible Fixes

Investigate whether the WebSocket library accepts:

```text
memoryview
bytearray
iterable fragments
scatter/gather buffers
```

If not, keep this single unavoidable copy and optimize higher-impact areas first.

Do not introduce complex code for a ~20 KiB copy if the WebSocket API fundamentally requires one contiguous message.

---

# 11. P3 — Reduce Go Access-Unit Copies

## Problem

Current Go flow appears to create several copies:

```text
RTP payloads
↓
assembly append/reallocation
↓
copy assembled AU into retained AccessUnit
↓
copy again during lookup
↓
copy again into Unix socket message
```

---

## Fix A — Do Not Duplicate Immutable `AccessUnit.Data`

Current pattern:

```go
copyItem := *item
copyItem.Data = append([]byte(nil), item.Data...)
return &copyItem
```

If `item.Data` is immutable after publication, change to:

```go
copyItem := *item
return &copyItem
```

The copied struct can share the same immutable byte slice.

---

## Requirements

Before changing:

1. Verify no code mutates `AccessUnit.Data`.
2. Verify ring-buffer replacement cannot mutate the backing array.
3. Ensure each published frame owns a stable backing buffer.

Do not share `f.assembly` directly if it will be reused.

---

# 12. P3 — Reuse Go Assembly Buffer

## Problem

If assembly resets with:

```go
f.assembly = nil
```

every completed frame causes subsequent `append()` calls to allocate/grow another slice.

---

## Fix

Reuse capacity:

```go
f.assembly = f.assembly[:0]
```

Optionally preallocate expected size:

```go
f.assembly = make([]byte, 0, 64*1024)
```

Choose capacity from measured frame-size distribution.

Do not make the capacity excessively large.

---

## Adaptive Option

Track:

```text
p50 access-unit size
p95 access-unit size
p99 access-unit size
```

Set initial capacity near p95.

---

## Memory Retention Concern

A very large I-frame may grow the assembly buffer significantly and keep that capacity forever.

Optional cap:

```go
const maxReusableAUCap = 512 * 1024

if cap(f.assembly) > maxReusableAUCap {
    f.assembly = make([]byte, 0, defaultAUCap)
} else {
    f.assembly = f.assembly[:0]
}
```

---

# 13. P3 — Use Scatter/Gather Write in Go

## Problem

Current Unix-socket send likely creates:

```go
body := make([]byte, 4+len(metadata)+len(item.Data))
```

and copies metadata + H.264 into it.

---

## Fix

Investigate `net.Buffers`.

Example direction:

```go
buffers := net.Buffers{
    header,
    metadata,
    item.Data,
}

_, err := buffers.WriteTo(conn)
```

This can use scatter/gather writes on supported platforms.

The wire protocol does not need to change if the byte sequence remains identical.

---

## Acceptance Criteria

Use `pprof -alloc_space`.

Expected:

```text
lower cumulative allocation in sendFrame
lower GC frequency
same wire protocol
same browser playback behavior
```

---

# 14. P3 — Consider Buffer Pooling Only After Simpler Fixes

Possible Go optimization:

```go
sync.Pool
```

for large byte buffers.

Do not add it first.

Buffer pooling can:

```text
retain unexpectedly large buffers
increase memory footprint
make ownership harder to reason about
introduce use-after-return bugs
```

Only use it if profiling still shows meaningful allocation pressure after:

```text
capacity reuse
immutable slice sharing
scatter/gather writes
```

---

# 15. P4 — Android I420 Allocation

## Problem

If CameraX / WebRTC conversion currently does:

```kotlin
JavaI420Buffer.allocate(width, height)
```

for each frame, approximately:

```text
720p:  ~1.32 MiB/frame
1080p: ~2.97 MiB/frame
```

is allocated or acquired each capture cycle.

---

## Investigation

Check whether the Android/WebRTC API supports:

```text
texture-backed VideoFrame.Buffer
native buffer forwarding
I420 buffer reuse
reference-counted pooled buffers
CameraX YUV plane wrapping
```

Prefer passing an existing compatible buffer over copying into a newly allocated I420 buffer.

---

## Important

Respect WebRTC reference counting.

Do not reuse a buffer until all downstream consumers have released it.

This optimization is more complex than the backend changes and should be isolated.

---

# 16. P4 — Browser H.264 Copy Investigation

Check for code resembling:

```javascript
const encoded = bytes.slice(offset);
```

For typed arrays:

```javascript
slice()
```

copies.

Where ownership/lifetime allows it, prefer:

```javascript
subarray()
```

which creates a view.

Example:

```javascript
const encoded = bytes.subarray(offset);
```

Use only if later code does not mutate the backing buffer.

---

# 17. Separate Passthrough and Inference Ownership

The passthrough path should not depend on inference completion.

Target architecture:

```text
                    ┌──────────────→ browser playback
                    │
H.264 access unit ──┤
                    │
                    └→ decoder → latest-frame slot → YOLO
```

Inference overload must not cause playback backlog.

The encoded H.264 frame can be shared as immutable data where ownership rules allow.

---

# 18. Recommended Latest-Frame Architecture

Instead of thinking of inference as a queue, consider a single replaceable slot.

Conceptually:

```python
latest_frame: InferenceFrame | None
latest_frame_event = asyncio.Event()
latest_frame_lock = asyncio.Lock()
```

Producer:

```python
async with latest_frame_lock:
    old = latest_frame
    latest_frame = new_frame

latest_frame_event.set()
```

Consumer:

```python
await latest_frame_event.wait()

async with latest_frame_lock:
    frame = latest_frame
    latest_frame = None
    latest_frame_event.clear()
```

This makes "process the newest available frame" explicit.

However, `asyncio.Queue(maxsize=1)` is simpler and should be implemented first.

---

# 19. Optional Inference Sampling

If full camera FPS is unnecessary for detection, add configurable inference FPS.

Example:

```text
VIDEO_FPS=30
YOLO_TARGET_FPS=15
```

Passthrough stays at 30 FPS.

Inference samples approximately every second frame.

Example:

```python
min_interval = 1.0 / target_fps

if now - last_inference_enqueue < min_interval:
    drop_before_decode_or_inference()
```

The ideal place to drop is before expensive work whenever possible.

---

# 20. Prefer Dropping Before Decode

Current overload protection may occur after the frame is decoded.

A better optimization is:

```text
encoded H.264 AU
↓
decide whether inference needs this frame
↓
decode only selected inference frames
```

But H.264 dependency complicates this because P/B frames depend on earlier reference frames.

Do not simply discard arbitrary encoded frames from a stateful decoder.

Possible approaches:

1. Continue feeding all encoded frames into decoder but only materialize/infer selected decoded frames.
2. Use a decoder designed for frame skipping.
3. Start decoding at IDR boundaries when intentionally skipping GOPs.

Implement only after queue/backpressure fixes.

---

# 21. Memory Ownership Rules

Document ownership for every main buffer.

Example table:

| Buffer | Owner | Mutable? | Lifetime |
|---|---|---|---|
| Go RTP payload | RTP stack | no | packet handling |
| Go assembly | Feed | yes | current AU |
| Go published AU | AccessUnit/ring | no | ring retention |
| Unix record | Python reader | no | parsing |
| PyAV packet | decoder | no | decode call |
| VideoFrame | PyAV/FFmpeg | effectively no | inference queue |
| NumPy BGR | inference worker | yes | current inference |
| CUDA tensor | model/runtime | yes | inference |
| mask tensor | result/postprocess | no | result handling |

Do not optimize by sharing mutable buffers without explicit lifetime rules.

---

# 22. Profiling Test Cases

Create reproducible test workloads.

## Case A — Passthrough Only

Disable YOLO.

Run:

```text
720p30
1080p30
```

Measure:

```text
Go allocations/sec
Python RSS
Python allocations/sec
browser playback stability
Unix socket throughput
```

---

## Case B — Normal Inference

Use video with approximately:

```text
1–5 objects/frame
```

Measure:

```text
input FPS
inference FPS
queue depth
RSS
CUDA memory
latency
```

---

## Case C — Heavy Segmentation

Use footage with:

```text
20+ objects/frame
```

Measure:

```text
YOLO latency
mask postprocess latency
queue depth
RSS slope
CUDA peak
CPU utilization
```

---

## Case D — Intentional Overload

Artificially slow inference.

Example:

```python
await asyncio.sleep(0.05)
```

or use a heavier model.

Verify:

```text
queue remains bounded
memory remains stable
frames are dropped
live latency remains bounded
```

---

# 23. Benchmark Output Format

Create one benchmark record every 5 seconds.

Example:

```json
{
  "timestamp": 0,
  "input_fps": 30.1,
  "passthrough_fps": 30.0,
  "inference_fps": 21.8,
  "inference_queue": 1,
  "inference_dropped": 184,
  "rss_mb": 1282,
  "cuda_allocated_mb": 812,
  "cuda_reserved_mb": 1240,
  "decode_ms": 3.2,
  "preprocess_ms": 1.7,
  "inference_ms": 31.4,
  "postprocess_ms": 7.8
}
```

Store benchmark logs under:

```text
benchmarks/
```

Example:

```text
benchmarks/
  baseline_720p30.jsonl
  optimized_720p30.jsonl
  baseline_1080p30.jsonl
  optimized_1080p30.jsonl
  heavy_objects_baseline.jsonl
  heavy_objects_optimized.jsonl
```

---

# 24. Regression Tests

Add tests where practical.

---

## Queue Test

Verify:

```text
100 frames produced quickly
consumer deliberately slow
queue size never exceeds configured limit
latest frame is eventually processed
drop count is correct
```

---

## Go AccessUnit Ownership Test

After eliminating a copy:

1. Publish AU A.
2. Start assembling AU B using reusable assembly buffer.
3. Verify AU A bytes do not change.

This test is mandatory before sharing backing buffers.

---

## Wire Protocol Test

Verify Go scatter/gather output is byte-for-byte equivalent to the previous contiguous message.

---

## Detection Output Test

For a fixed test video, compare:

```text
class IDs
confidence values
bounding boxes
mask polygons
```

before and after preprocessing changes.

Allow small numerical tolerance where resizing changes interpolation.

---

# 25. Implementation Phases

## Phase 1 — Safety / Backpressure

Implement:

- bounded inference queue
- latest-frame policy
- dropped-frame metric
- queue-size metric
- RSS metric
- CUDA metrics

Do not modify frame representation yet.

Commit independently.

Suggested commit:

```text
perf(video): bound inference queue and add memory metrics
```

---

## Phase 2 — Python Raw-Frame Allocation

Implement:

- resize/reformat before full BGR conversion
- benchmark accuracy and latency
- bulk box tensor CPU transfer

Suggested commit:

```text
perf(inference): reduce raw frame and detection allocation
```

---

## Phase 3 — Segmentation Post-Processing

Implement:

- filtering before mask processing
- remove redundant `tolist()` reconstruction
- optional polygon simplification
- mask/postprocess timing metrics

Suggested commit:

```text
perf(segmentation): reduce mask and polygon allocation
```

---

## Phase 4 — Python Passthrough Buffer Copies

Implement:

- `memoryview` parsing
- avoid unnecessary `bytes` conversion
- keep WebSocket copy only where required

Suggested commit:

```text
perf(video): reduce python encoded-frame copies
```

---

## Phase 5 — Go Relay Allocation

Implement:

- reuse assembly capacity
- remove duplicate AccessUnit copy where safe
- add allocation metrics / pprof
- investigate `net.Buffers`

Suggested commit:

```text
perf(relay): reduce access-unit allocation and copying
```

---

## Phase 6 — Android / Browser

Investigate separately:

- Android native/pooled frame buffer
- browser `subarray()` instead of `slice()`

Suggested commits:

```text
perf(android): reduce camera frame buffer allocation
```

```text
perf(web): avoid redundant encoded frame copies
```

---

# 26. Do Not Do These

Do not:

```text
increase the queue size to hide slow inference
call gc.collect() every frame
call torch.cuda.empty_cache() every frame
create a large generic buffer pool before profiling
drop arbitrary H.264 packets before a stateful decoder
reuse mutable Go buffers after publication
optimize 20 KiB copies before solving multi-MiB decoded frame buildup
```

---

# 27. Target End State

The desired pipeline behavior is:

```text
Android
  │
  │ H.264
  ▼
Go relay
  │
  ├── immutable encoded AU
  │
  ▼
Unix socket
  │
  ▼
Python
  │
  ├──────────────────────────────→ browser passthrough
  │
  ▼
PyAV decoder
  │
  ▼
bounded latest-frame handoff
  │
  ▼
resize/reformat
  │
  ▼
small BGR / model input
  │
  ▼
YOLO
  │
  ▼
bulk tensor transfer
  │
  ▼
filtered segmentation postprocess
  │
  ▼
detections
```

The core invariants should be:

```text
passthrough never waits for inference
decoded frame backlog is bounded
latency does not continually grow
memory reaches a stable steady state
raw frames are not unnecessarily copied at full resolution
compressed H.264 is treated as immutable wherever possible
per-object GPU→CPU synchronization is minimized
```

---

# 28. Final Acceptance Criteria

The optimization task is complete when all of the following are true.

### Memory

During a 10-minute 1080p30 overload test:

```text
RSS reaches stable steady state
no monotonic memory growth caused by queued VideoFrames
CUDA allocated/reserved memory remains bounded
```

### Queue

```text
inference queue <= configured maximum at all times
latest-frame mode drops old frames under load
drop counter is observable
```

### Latency

When inference FPS falls below camera FPS:

```text
inference latency remains bounded
browser passthrough remains near real time
```

### Allocation

Compared with baseline:

```text
lower Python allocation rate
lower Go alloc_space
lower Go GC frequency where measurable
full-resolution BGR allocation removed or significantly reduced
```

### Correctness

```text
video playback remains correct
timestamps / sequence numbers remain correct
bounding boxes remain correctly mapped
segmentation polygons remain correctly mapped
no corruption from reused buffers
```

---

# 29. Agent Instructions

The coding agent should follow these rules:

1. Inspect the existing implementation before changing architecture.
2. Identify the exact files/functions corresponding to each item in this plan.
3. Make one optimization class at a time.
4. Add measurements before or together with optimization work.
5. Preserve current protocol formats unless a change is explicitly necessary.
6. Add tests for buffer ownership whenever copies are removed.
7. Benchmark before/after every major phase.
8. Do not claim an allocation is removed without validating through profiling or code-path analysis.
9. Prefer simple ownership rules over aggressive zero-copy designs.
10. Record benchmark results in the repository.

For each phase, the agent should report:

```text
files changed
allocation/copy removed
ownership/lifetime implications
benchmark before
benchmark after
correctness tests
remaining bottlenecks
```

The first implementation target should be:

```text
bounded latest-frame inference queue + memory instrumentation
```

because this prevents runaway latency/memory even before deeper optimization work begins.
