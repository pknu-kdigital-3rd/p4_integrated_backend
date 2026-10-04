# Shared input preparation and asynchronous YOLO execution

For source-sized UniDepth input and a different YOLO grid, `VISION_FRAME_PREP=shared`
converts the decoded source to BGR once. Depth consumes that original BGR array;
YOLO is resized from it using OpenCV area interpolation for downsampling and
linear interpolation for upsampling. Both configured model grids and camera
calibration stay the same. Other depth configurations retain the previous
independent PyAV conversions; identical grids still share one array.

Depth pixels are identical to the previous source-sized conversion. YOLO pixels
are not bit-identical: resize interpolation and resize/color-conversion order
change. Compare detections on the same scene. `VISION_FRAME_PREP=independent`
restores the old preparation path when comparing accuracy or performance.

The native preparation benchmark uses actual PyAV/OpenCV operations on a
synthetic 1280x720 YUV420 frame, with 320x320 YOLO and source-sized depth:

```bash
docker compose -f docker-compose.dev.yml exec -T p4-vision python benchmark_frame_preparation.py --frames 120
```

One local Windows run (60 samples, after the service OpenCV thread policy was
initialized) measured caller CPU 9.375 -> 4.427 ms and process CPU 43.750 ->
11.719 ms per preparation. These are synthetic preparation measurements, not
deployment results or model FPS. The script prints source-depth pixel equality
and YOLO pixel differences as well as wall, caller and all-process CPU time.

`YOLO_PINNED_INPUT=true` stages one letterboxed uint8 image into reusable pinned
host/device buffers and enqueues the transfer on the inference stream. RGB
channel ordering, dtype conversion and normalization match the pinned fork.
Buffers retain only the latest shape. CPU, tensor and upstream/file consumers
keep upstream preprocessing. `false` restores the old blocking upload.

`YOLO_TRT_EXECUTION=async` replaces the backend instance's forward method with
a service-owned adapter. It uses named tensor addresses and `execute_async_v3`
for TensorRT 10+, or ordered bindings and `execute_async_v2` for older engines.
Addresses are rebound when pointers change, including dynamic output resize.
Output order matches the pinned fork. The external editable fork is unchanged.

For the in-memory service loop, preprocessing, TensorRT and postprocessing run
on one persistent nondefault stream with dependencies on the caller's stream.
The existing final blocking event precedes tracking callbacks and result reads.
A failing frame also drains queued work before retry can reuse the pinned input
or context. Input bindings retain the tensor until the next completed frame.
Synchronous execution keeps the caller stream; mixing that API with the private
preprocessing stream would permit inference to read an unfinished input.

On first use, async raw outputs are compared with the original synchronous
backend on the same prepared input at rtol/atol 0.001. Success prints:

```text
YOLO TensorRT async startup validation passed (rtol=0.001, atol=0.001)
```

A validation mismatch restores synchronous execution. Missing async APIs also
retain synchronous execution. Failed enqueue/address/shape operations raise;
partly enqueued work is not silently retried through another execution API.
`YOLO_TRT_EXECUTION=sync` restores the original backend for comparisons.
See [NVIDIA's TensorRT Python API](https://docs.nvidia.com/deeplearning/tensorrt/latest/inference-library/python-api-docs.html)
for stream, binding and buffer-lifetime requirements.

## Deployment comparison

Defaults enable these changes; leave model resolutions and depth compile mode
unchanged. Disable CPU profiling for baseline readings:

```env
VISION_FRAME_PREP=shared
YOLO_TRT_EXECUTION=async
YOLO_PINNED_INPUT=true
VISION_CPU_PROFILE_FRAMES=0
```

Dev directory-mounts app code, individually mounts the unchanged entrypoint and
runs Uvicorn with reload. Recreate for the new Compose environment; the dev app
code comes from the directory mount, and dependencies/Dockerfiles are unchanged:

```bash
docker compose -f docker-compose.dev.yml up -d --no-deps --force-recreate p4-vision
docker compose -f docker-compose.dev.yml exec -T p4-vision python -c "from app.core.settings import settings; from app.services.tensorrt_execution import AsyncTensorRT; print(settings.VISION_FRAME_PREP, settings.YOLO_TRT_EXECUTION, settings.YOLO_PINNED_INPUT, settings.VISION_CPU_PROFILE_FRAMES, AsyncTensorRT.__name__)"
docker compose -f docker-compose.dev.yml logs -f --tail 100 p4-vision
```

Expect `shared async True 0 AsyncTensorRT`, the frame-preparation configuration
log and the async startup validation log once inference starts. Settings alone
do not prove an engine passed validation or avoided fallback. Production app
code is baked into its image and requires an app-image rebuild and recreation.

Replay the same scene; compare conversion/Yolo CPU, model wall time, process CPU,
inference FPS, skipped FPS, depth tail and the resulting detections. The earlier
deployment baseline averaged conversion CPU 5.94 ms, YOLO CPU 9.32 ms, process
CPU 113.8%, inferred FPS 28.92 and skipped FPS 1.05.

Local checks execute native PyAV/OpenCV preparation and verify staging values,
buffer reuse, stream/error handling, TensorRT binding APIs, validation/fallback,
dynamic shapes and output order with CPU tests/mocks. The local GPU cannot run
the locked Torch build; pinned CUDA copies and actual TensorRT enqueue/outputs
must be verified on the deployment GPU. No deployed GPU speedup is claimed.

## Controlled TensorRT comparison

`benchmark_trt_execution.py` isolates async versus sync while keeping shared
preparation, pinned input, model resolutions, tracking and concurrent UniDepth.
Use a local video of the scene, visible at the same path inside the container.
Pause live playback/feed inference and wait for its queue to drain before the
benchmark; concurrent live inference on the same GPU would invalidate isolation.
The benchmark loads its own model copies, so it also needs GPU memory for them.

```bash
docker compose -f docker-compose.dev.yml exec -T p4-vision python benchmark_trt_execution.py --video /path/inside/container/scene.mp4 --frames 120 --start-frame 0 --warmup 30 --rounds 2
```

Each phase starts a fresh process, warms up, resets the tracker, then measures
the same decoded frames in the same order. GC is configured and frozen after
warmup as in the live service. Two rounds use sync/async then
async/sync to reduce order effects. CPU profiling is disabled and the active
TensorRT mode is checked after warmup. Depth errors or eager fallback reject
the comparison. Startup, decoding and engine validation are excluded from the
timed calls; no extra per-frame device-wide sync is added to `run_yolo`.

Copy both `[trt-ab-summary]` lines and the `[trt-ab-result]` lines. They include
caller YOLO/depth/conversion CPU, all-process CPU per frame, wall latency/tails
and mask counts. The summary p99 is the average of phase p99s, not a pooled p99.
`--output /path/report.json` optionally saves each phase's report. This compares
isolated inference and does not measure WebSocket work or live drop rate.

Use `--frames 0` to measure every video frame from `--start-frame` through EOF.
Decoded frames and result dictionaries are streamed rather than accumulated;
only one 8-byte wall timing per frame is retained for exact latency percentiles.
Warmup caches at most 600 images and rereads the video for measurement, so the
start of the scene is included. Progress prints every 300 measured frames.
All phases must report the same measured frame count or the comparison fails.
`--rounds 1` performs two full-video passes (sync then async); `--rounds 2`
performs four passes in the balanced order described above.

With physical GPUs 0 and 3 busy, explicitly map available GPUs 1 and 2 for the
benchmark. `docker compose exec` does not run the entrypoint's GPU-selection
exports, so do not rely on those process-specific exports being inherited:

```bash
docker compose -f docker-compose.dev.yml exec -T -e CUDA_DEVICE_ORDER=PCI_BUS_ID -e CUDA_VISIBLE_DEVICES=1,2 -e YOLO_DEVICE=cuda:0 -e UNIDEPTH_DEVICE=cuda:1 p4-vision python benchmark_trt_execution.py --video /path/inside/container/scene.mp4 --frames 0 --warmup 30 --rounds 1
```

For a live follow-up, use the same recording start point and playback duration,
keep the browser connected and verify `input_fps` and `ws_fps` stay near 30 in
both captures. Change only `YOLO_TRT_EXECUTION=sync` versus `async`, recreating
the dev container for each environment change. Keep shared preparation and
pinned input enabled. Exclude startup validation, initial bursts and reconnect
intervals before comparing `[cpu]` and pipeline metrics.

The CLI is locally verified for native video decoding, identical frame order,
CPU accounting, alternating fresh processes and error handling. Actual TensorRT
comparison requires the deployment GPU; it cannot execute on the local GPU.
