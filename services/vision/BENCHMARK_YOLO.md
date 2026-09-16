# YOLO throughput benchmark

Run from this directory on the RTX 3090 host:

```bash
export YOLO_MODEL=yolo26s-seg.pt
export YOLO_DEVICE=cuda:0
export YOLO_HALF=true

.venv/bin/python benchmark_yolo.py \
  --model "$YOLO_MODEL" \
  --device "$YOLO_DEVICE" \
  --imgsz 704 \
  --width 1280 \
  --height 720 \
  --warmup 30 \
  --iterations 200
```

The report separates:

| Measurement | Includes | Use it to identify |
|---|---|---|
| Direct model forward | Only neural-network kernels on the GPU | GPU/model limit |
| Ultralytics predict | Ultralytics preprocessing, forward, NMS, masks, result creation | Ultralytics CPU/GPU overhead |
| PyAV conversion | `VideoFrame.to_ndarray()` | Decode/frame conversion overhead |
| Exact `run_yolo` path | The production worker path | Real single-frame inference throughput |

The target is 30 FPS, or 33.33 ms per frame. Interpret the results in order:

1. Direct forward below 30 FPS: the model/GPU workload is too slow. Try
   `--imgsz 640`, then `512`, or use an optimized exported engine.
2. Direct forward above 30 FPS but Ultralytics predict below 30 FPS:
   preprocessing/postprocessing is the bottleneck.
3. Predict above 30 FPS but exact `run_yolo` below 30 FPS: PyAV conversion or
   detection/mask serialization is the bottleneck.
4. Exact path above 30 FPS while the live queue grows: inspect relay input
   rate, WebSocket delivery, and browser presentation rather than the GPU.

Always discard the first warmup iterations. CUDA timings are synchronized by
the script; without synchronization, asynchronous kernel launches make the
GPU appear faster than the live worker really is.

For the exact production path, frames larger than `YOLO_MAX_IMGSZ` are scaled
with PyAV before BGR materialization. Normalized boxes/masks are unchanged and
pixel-format boxes are mapped back to the original source dimensions. Compare
the exact path with the same source dimensions when evaluating this change.

## Mask performance

The live service defaults to the faster mask path:

- `YOLO_RETINA_MASKS=false` keeps masks at model resolution before polygon
  extraction. The browser still receives normalized polygons, but native
  camera-resolution upsampling is avoided. Set it to `true` only when the
  extra mask detail is worth the latency.
- `YOLO_MAX_DETECTIONS=100` bounds the number of detections retained by NMS and
  sent to mask processing for crowded frames. Increase it if more objects must be
  published in a single frame.
- `YOLO_MASK_CONTOUR_SIZE=160` downsamples masks on the inference device before
  CPU contour extraction. This matches the native prototype scale for a 640px
  input and keeps polygon generation from scaling with the camera resolution.
  Use `320` or `640` when more polygon detail is required.
- `YOLO_MASK_POLYGON_SIMPLIFY=true` applies configurable OpenCV contour
  simplification before JSON serialization. It can reduce payload and browser
  drawing cost for noisy masks; leave it false when exact polygon fidelity is
  required.

The service also extracts polygons only for detections retained after its
confidence filter, avoiding unnecessary CPU contour conversion for discarded
boxes.

## Live frame policy

Set `YOLO_FRAME_DROP_POLICY=latest` to keep inference near the live edge when
the model cannot keep up. The worker skips queued model calls but still passes
the compressed frames through with the last completed detections, preserving
H.264 playback. `YOLO_INFERENCE_QUEUE_SIZE` bounds the decoded-frame handoff;
the recommended default is `1`. `YOLO_FRAME_DROP_POLICY=queue` is available for
ordered debugging, but it is also finite and drops newly arriving inference
work when that bound is full.

## Runtime allocation diagnostics

The vision process emits a `[mem]` line every five seconds containing RSS,
queue depth/limit, input/inference/playback/WebSocket rates, stage timings,
drop count, and CUDA allocated/reserved/interval-peak memory. Set
`ENABLE_PYTHON_ALLOC_PROFILE=true` temporarily to add periodic `tracemalloc`
top-allocation reports; do not leave it enabled for production throughput
measurements.
