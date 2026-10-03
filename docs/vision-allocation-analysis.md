# Vision allocation analysis and bounded memory

## Evidence from the supplied runtime log

One gen0 collection took 3.173 ms and reclaimed 1,664 objects. No gen1/gen2
collection occurred; thresholds were `(700, 10, 10)` and 713,033 objects were
frozen. The reclaimed count is not the number of allocations, scanned objects,
or bytes. Inferring an hourly memory leak from it is unreliable.

Gen0 scans young live objects as well as unreachable cycles. Frozen startup
state does not cover new inference results, input frames or telemetry samples.
The reported 1,250 IMU samples alone retain Pydantic instances and field sets.
The completed-sequence cache is bounded at 1,800 keys, but previously the
separate playback result store only released results on acknowledgements/reset.
A missing viewer or missing acknowledgements could therefore grow that store.
This is a concrete retention problem; it is not proof of the observed cycles.

## Local experiments

Bounded captures temporarily disabled automatic GC and inspected unreachable
gen0 objects using DEBUG_SAVEALL after the workload. Existing dependencies were
used without installation. These experiments did not reproduce the 1,664
objects from the production log:

| Workload | Calls | Gen0 reclaimed |
| --- | ---: | ---: |
| Single-worker executor handoff with simple result | 150 | 0 |
| asyncio.to_thread plus executor handoff | 150 frames | 0 |
| PyAV frame creation, resize to 320x320, ndarray conversion | 150 | 0 |
| torchvision normalize on CPU | 150 | 0 |
| Custom Ultralytics get_cfg rebuild | 150 | 0 |
| Pydantic telemetry validation/ingestion, one IMU sample per batch | 150 | 0 |
| Real a4_best.pt CPU run_yolo, blank 320x320, tracking off, no depth | 5 | 0 |

Telemetry retained 150 ImuSampleIn objects and 150 field sets during its capture;
these were intentional live history, not garbage. The CPU YOLO capture retained
the latest Results/Boxes/input state and some weak references. Captures include
small observer overhead and count survivors, not total allocation churn.

TensorRT, compiled UniDepth, real detections/masks, Linux transport and the
combined concurrent live path are not represented by these CPU experiments.
The local Quadro P2200 is unsupported by the installed PyTorch CUDA build.
Use `benchmark_yolo.py --gc-diagnose 100` in Docker on the GPU host to attribute
garbage types, available allocation sites and function locations in the real
model path. It excludes telemetry/WebSocket/live decode. Further attribution
of the combined runtime may still be necessary if isolated captures are clean.

## Implemented bounds and reuse

- Depth staging retains one uint8 host/device tensor pair for the current
  image shape. The host is pinned on CUDA, ordinary memory on CPU. Repeated
  frames reuse the pair; shape changes replace it. Stream synchronization on
  success and failure prevents an in-flight copy being overwritten by a retry.
- The duplicate `img.copy()` for concurrent depth inference was removed after
  inspecting the pinned fork's LetterBox, preprocessing and TensorRT backend.
  LetterBox creates output storage, preprocessing converts uint8 before
  in-place normalization, and TensorRT receives the preprocessed tensor.
- Model detection/mask count remains bounded by YOLO_MAX_DETECTIONS (100 by
  default). Stored polygons now have at most YOLO_MASK_MAX_POINTS (256 by
  default). Point sampling can reduce overlay detail, but mask median distances
  still use the original masks. Contour extraction still allocates temporary
  arrays before this retention cap.
- Playback retention has independent frame and encoded-byte bounds, even
  without acknowledgements. Defaults are 1,800 frames and 256 MiB of encoded
  video. Eviction can shorten reconnect history; existing missing-sequence
  handling requests a resync. Metadata and mask arrays are not included in the
  encoded-byte counter; their payload is separately bounded by frame/count/point
  limits. Logs expose retained frames, encoded bytes and evictions.

With 32 detections, 256 points, 300 stored frames and 64 MiB encoded video, the
raw float32 polygon payload is bounded at 18.75 MiB. Python metadata, allocator
caches, model weights, GPU activations, decoded/transport buffers and telemetry
are additional. Caps bound retention; they do not preallocate all third-party
objects or establish zero RSS growth.

## Checks and remaining work

The depth and YOLO CPU suites passed 46 tests, including buffer identity reuse,
shape replacement, CPU non-pinning, RGB equality, shared-image immutability,
actual fork preprocessing immutability, point caps and playback eviction/byte
accounting. No dependency changes were made. GPU pinned transfer, TensorRT
inference, compiled-depth equality and long-run RSS/VRAM plateau need Docker
checks. Keep automatic GC enabled until real cycle ownership is identified.
