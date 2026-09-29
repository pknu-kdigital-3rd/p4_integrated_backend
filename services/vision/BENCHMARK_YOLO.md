# YOLO throughput benchmark

## Custom Ultralytics checkout

The checkpoint uses classes from the custom Ultralytics fork. The vision
project and lockfile refer to it through `.ultralytics-custom`, a per-machine
junction or symlink ignored by Git. Point that link at the fork's checkout
root (the directory containing `pyproject.toml` and the `ultralytics` package)
before running `uv sync --locked`.

On Windows PowerShell, from `services/vision`:

```powershell
$customUltralytics = 'C:\path\to\yolo_carafe_aspp'
New-Item -ItemType Junction -Path .ultralytics-custom -Target $customUltralytics
uv sync --locked
```

On Linux, from `services/vision`:

```bash
ln -s /home/user/yolo_custom/yolo_carafe_aspp .ultralytics-custom
uv sync --locked
```

Create the link once per checkout, using the custom fork's actual location on
that host. The source path stays identical in the vision project on both OSes.

Run from this directory on the RTX 3090 host:

```bash
export YOLO_MODEL=/home/user/models/vehicle-seg.engine
export YOLO_DEVICE=cuda:0
export YOLO_HALF=true
export YOLO_MAX_IMGSZ=640
export YOLO_RETINA_MASKS=true
export YOLO_MASK_CONTOUR_SIZE=640
export UNIDEPTH_MODEL_DIR=/home/user/p4-integrated-backend/services/vision/models/unidepth-v2-vitb14
export UNIDEPTH_RESOLUTION_LEVEL=2

.venv/bin/python benchmark_yolo.py \
  --model "$YOLO_MODEL" \
  --device "$YOLO_DEVICE" \
  --imgsz "$YOLO_MAX_IMGSZ" \
  --width 1920 \
  --height 1080 \
  --warmup 30 \
  --iterations 200
```

The report separates:

| Measurement | Includes | Use it to identify |
|---|---|---|
| Direct model forward | Only neural-network kernels on the GPU; skipped for TensorRT engines | PyTorch model limit |
| Ultralytics predict | Ultralytics preprocessing, forward, NMS, masks, result creation | Ultralytics CPU/GPU overhead |
| PyAV conversion | `VideoFrame.to_ndarray()` | Decode/frame conversion overhead |
| Exact `run_yolo` path | The production worker path, including UniDepth mask distance | Real single-frame inference throughput |

The target is 30 FPS, or 33.33 ms per frame. Interpret the results in order:

1. Direct forward below 30 FPS: the PyTorch model/GPU workload is too slow. Try
   `--imgsz 640`, then `512`, or compare with a TensorRT engine.
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

## Mask detail settings

The live service defaults to detail-first masks:

- `YOLO_RETINA_MASKS=true` preserves source-aligned mask detail before polygon
  extraction. Set it to `false` when inference latency matters more than
  polygon detail.
- `YOLO_MAX_DETECTIONS=100` bounds the number of detections retained by NMS and
  sent to mask processing for crowded frames. Increase it if more objects must be
  published in a single frame.
- `YOLO_MASK_CONTOUR_SIZE=640` bounds the mask grid on the inference device
  before CPU contour extraction. Lower it to `320` or `160` to reduce contour
  cost when latency matters more than polygon detail.
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

## Deployment GPU test and 10-minute overload run

Run this procedure on the Linux deployment host with the RTX 3090 and the
configured editable Ultralytics checkout at
`../../../yolo_custom/yolo_carafe_aspp` from `services/vision`.

```bash
cd "$P4_ROOT/services/vision"
uv sync --locked
uv run python -c 'import ultralytics, torch; print(ultralytics.__file__); assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))'
```

Set the TensorRT engine and detail-first settings. `YOLO_MAX_IMGSZ` must match
the engine's supported input shape.

```bash
export YOLO_MODEL=/home/user/models/vehicle-seg.engine
export YOLO_DEVICE=cuda:0
export YOLO_HALF=true
export YOLO_MAX_IMGSZ=640
export YOLO_RETINA_MASKS=true
export YOLO_MASK_CONTOUR_SIZE=640
export UNIDEPTH_MODEL_DIR=/home/user/p4-integrated-backend/services/vision/models/unidepth-v2-vitb14
export YOLO_FRAME_DROP_POLICY=latest
export YOLO_INFERENCE_QUEUE_SIZE=1
```

First smoke-test the actual engine and its model-loading/inference path. The
benchmark warms the same `run_yolo` path used by the service; for an engine it
reports the direct PyTorch-only forward metric as unavailable.

```bash
uv run python benchmark_yolo.py \
  --model "$YOLO_MODEL" --device "$YOLO_DEVICE" \
  --imgsz "$YOLO_MAX_IMGSZ" --width 1920 --height 1080 \
  --warmup 30 --iterations 30
```

Then run the bounded-queue overload harness against the same 1080p30 video for
ten minutes. It warms up first, offers decoded frames at 30 FPS, runs the real
TensorRT model through the production worker and writes five-second samples.
Each input frame must leave through an inference result or a latest-frame
passthrough result.

```bash
uv run python benchmark_pipeline.py \
  --video /data/benchmark-1080p30.mp4 \
  --duration-seconds 600 --warmup-frames 30 --input-fps 30 \
  --csv /data/results/light-tensor-rt-10min.csv
```

The harness requires a 1920x1080 source whose declared frame rate is within
0.5 FPS of 30. It records source, inference, skip and published counts, maximum
observed queue depth, process RSS, CUDA allocation, and frame conversion/model/
postprocessing timings. Confirm the queue maximum never exceeds its configured
size, all input frames are published, playback output stays near 30 FPS, and
RSS/CUDA memory settle after warmup. A nonzero skip count means inference
backpressure was exercised; skipped calls still count as published playback
frames. If the model keeps up, the script reports that no overload was induced.

The harness tests frame preparation, queue/drop behavior, inference and
result publication. It does not run the relay or browser. For end-to-end
verification, start the stack, publish a 1080p30 Android stream, and open the
Live View. During the same ten-minute period, save the Vision `[mem]` and Go
`[relay-mem]` logs. Check that `queue` stays within its bound, `ws_fps` and the
browser's displayed FPS remain near real time, and boxes, masks and timestamps
stay aligned with the source video.

## ByteTrack versus BoT-SORT branches

The two integration branches share the UniDepth and segmentation changes:

- `feature/vision-unidepth-bytetrack` uses Vision's existing ByteTrack setup.
- `feature/vision-unidepth-botsort` uses the `vehicle_runtime` BoT-SORT setup.

Run the same commands and input video on both branches, on the same GPU and
runtime. Save each branch's commit ID and CSV. Compare throughput and stage
timings, then review the overlay for ID continuity, ID switches, lost/reacquired
objects, and false tracks. Ground-truth labels are optional for this review;
they are needed to calculate formal tracking accuracy metrics such as IDF1 or
HOTA. The pipeline benchmark reports a separate `depth_ms` stage.

UniDepth's `UNIDEPTH_RESOLUTION_LEVEL` accepts 0 through 9. The default is 2;
the previous setting was 3. Lower values reduce its internal inference pixel
budget and can improve throughput at the cost of depth detail. Compare levels
2 and 3 with the same input video and GPU, using `depth_ms`, `infer_fps`, and
measured distance error on representative objects. This setting changes the
Vision application only; it does not require rebuilding the dependency image.

Compose defaults UniDepth to host GPU 2 and YOLO to the last host GPU (GPU 3
on a four-GPU machine). The entrypoint maps them to container `cuda:1` and
`cuda:0`. Set `UNIDEPTH_GPU_INDEX` to the YOLO host index for a same-GPU
comparison. Compare `inference_ms`, `depth_ms`, `model_ms`, and `infer_fps` at
the same resolution level; cross-GPU mask transfer is included in postprocess.

The live Vision `[mem]` line also reports `worker_cycle_ms` (from taking an
inference frame through publishing its result), `queue_wait_ms` (time waiting
for the next inference frame), `inference_wait_ms` (time awaiting the model
thread), `thread_gap_ms` (wait time minus the model's own `inference_ms`),
`publish_ms`, `worker_other_ms` (remaining worker time), and
`skipped_publish_ms` per skipped playback frame. These measurements identify
where throughput is lost after the model has finished.

The Vision application image installs GCC, G++, and Python headers so
UniDepth's existing `torch.compile` path can run without rebuilding the large
dependency image. Compilation is enabled by default. The app compiles with a
dummy frame at startup and logs the warmup shape, duration, and whether it
stayed compiled or fell back to eager execution. The first warmup may take
minutes; the Compose cache volume keeps compiler artifacts across container
recreations. Set `UNIDEPTH_COMPILE=false` to compare the eager path with the
same model, input size, and GPU. Compare steady-state `depth_ms` and
`infer_fps` after startup; successful compilation does not guarantee a speedup.

For a quantitative comparison, use the same engine file, input video, runtime,
GPU, `YOLO_MAX_IMGSZ`, mask settings, warmup count, duration and queue policy.
Record the code revision, hashes of the engine and video, GPU details, the
custom Ultralytics path, and each CSV/log set. Treat 30 FPS as the target, not a guarantee with
`YOLO_RETINA_MASKS=true` and contour size 640.

The deployment test suites are prepared but are not run on developer machines:

```bash
cd "$P4_ROOT/services/vision"
uv run python -m unittest discover -s tests -v
cd "$P4_ROOT/services/media-relay"
go test ./...
```
# Postprocessing diagnostics

The periodic `[mem]` log reports averages per completed inference:

- `tracking_ms`: BoT-SORT input preparation, update, and ID assignment.
- `gmc_ms`: sparse optical flow within `tracking_ms`; do not add it again.
- `distance_ms`: mask transfer and median depth calculation.
- `polygon_ms`: mask contour extraction and polygon simplification.
- `output_ms`: remaining postprocessing, including box extraction and detection formatting.

Tracking, distance, polygon, and output timings sum to `postprocess_ms` before
display rounding. These are wall-clock timings with existing transfer waits;
diagnostics do not add GPU synchronization. ByteTrack's internal tracking remains
inside `model_ms`, so its separate `tracking_ms` is zero.

`torch_cuda[role@cuda:N/visible=ID]` identifies the model role, process CUDA index,
and the corresponding `CUDA_VISIBLE_DEVICES` entry when available. Shared GPUs
are sampled once. Allocated/reserved memory and interval peaks cover PyTorch's
allocator, not all TensorRT or device memory. Peaks reset at each log interval.
