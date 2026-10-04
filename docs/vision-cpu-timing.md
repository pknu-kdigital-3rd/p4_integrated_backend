# Vision CPU attribution

Every metrics interval now includes a `[cpu]` report. Millisecond fields are
averages per completed inference frame, measured with `time.thread_time()`:

- `yolo_thread_cpu_ms`: CPU spent in the YOLO call, including preprocessing,
  prediction, mask reconstruction, tracking callbacks, and any busy-waiting.
- `depth_thread_cpu_ms`: CPU spent in UniDepth's worker during its prediction.
- `frame_convert_thread_cpu_ms`: preparation of the YOLO and depth input images.
- `postprocess_thread_cpu_ms`: service box transfers, object-distance calculations,
  contour handling and result construction after the models return.
- `inference_thread_cpu_ms`: the inference caller's total CPU time across these
  stages and orchestration. In production, depth prediction runs in another
  thread, so its CPU time is excluded from this total.

The stage counters are nested: do not add YOLO/conversion/postprocessing to the
inference total. If a caller runs depth without its executor, depth CPU is also
included in that caller's inference total.

`inference_thread_cpu_pct` and `depth_thread_cpu_pct` convert their attributed
completed-frame CPU milliseconds to percentages of one core over the reporting
interval. For example 5 ms/frame at 30 FPS is 15% of one CPU core. Work straddling
intervals is attributed when its frame completes; failed frames are not included.

`process_cpu_pct` uses `time.process_time()` and includes CPU from all process
threads, including decoding, the event loop, diagnostics, and native library
workers. Values can exceed 100% when multiple cores are used. Native OpenMP,
OpenCV or PyTorch child-worker CPU is not charged to the calling thread's clock,
so the per-model fields alone do not measure the model's total CPU footprint.

Compare CPU fields with the existing wall-time fields (`model_ms`, `depth_ms`,
`inference_ms`). GPU execution, sleeping and scheduler waits consume wall time
without consuming CPU on the waiting thread. No extra GPU synchronization or
per-frame logging is introduced. Individual completed results carry the same
CPU timing fields for deeper inspection.

The running container must contain this code before these fields appear.
These measurements require deployment validation; local tests verify clock
selection and reporting arithmetic, not CPU usage of the deployed models.

## Locate CPU cost inside the calls

The installed TensorRT backend uses synchronous `execute_v2()`, and YOLO's
preprocessing uses a blocking `Tensor.to(device)` transfer. These are code
findings, not yet measured CPU attribution. UniDepth's optimized path stages a
pinned input, normalizes/resizes it, calls the compiled model and resizes the
depth output. Its final completion event is blocking; internal Torch calls can
still consume CPU for dispatch, allocation or implicit synchronization.

Enable bounded CPU profiles in `.env` on the deployment host:

```env
VISION_CPU_PROFILE_FRAMES=60
VISION_CPU_PROFILE_WARMUP_FRAMES=60
```

The default is zero (disabled). Dev directory-mounts app code and runs Uvicorn
with reload; recreate to apply the new environment. The unchanged entrypoint is
individually mounted. No dependency/image build inputs changed:

```bash
docker compose -f docker-compose.dev.yml up -d --no-deps --force-recreate p4-vision
docker compose -f docker-compose.dev.yml exec -T p4-vision python -c "from app.core.settings import settings; print(settings.VISION_CPU_PROFILE_FRAMES, settings.VISION_CPU_PROFILE_WARMUP_FRAMES)"
docker compose -f docker-compose.dev.yml logs -f --tail 100 p4-vision
```

Replay the problematic scene. Each model skips its first 60 calls, then captures
60 calls using `cProfile` with `time.thread_time()` as its clock. Models still
run concurrently. CPython 3.12 allows only one active cProfile tool per interpreter,
so a capture is deferred when the other call is being profiled; inference is
never deferred. Both files may therefore take more than 120 frames to complete.
Capture stops automatically after the configured sample count.

Wait for fresh `[cpu-profile]` completion messages for **both** models before
reading files; old files can remain from a previous capture. Files are stored
in the already-mounted compile-cache volume:

```bash
docker compose -f docker-compose.dev.yml exec -T p4-vision python -c "import pstats; pstats.Stats('/var/cache/p4-vision-compile/cpu-profile/yolo.pstats').strip_dirs().sort_stats('tottime').print_stats(20)"
docker compose -f docker-compose.dev.yml exec -T p4-vision python -c "import pstats; pstats.Stats('/var/cache/p4-vision-compile/cpu-profile/depth.pstats').strip_dirs().sort_stats('tottime').print_stats(20)"
```

`tottime` locates CPU charged directly to a function; `cumtime` includes its
children. Times are aggregate CPU seconds across sampled calls, not GPU duration.
An expensive C-extension entry identifies a native boundary, not necessarily
the precise driver/kernel operation inside it. Native child-worker CPU is still
excluded. Profiling adds overhead: use it for attribution, not baseline FPS or
CPU utilization. Set `VISION_CPU_PROFILE_FRAMES=0` and recreate after the capture.
Production app code is baked into its image and requires an app-image rebuild.

No local Vision container is running, and the local GPU cannot execute the
locked Torch build. Actual model profiles must be captured on the deployment
GPU; local tests validate bounded capture, concurrent inference, and output files.
