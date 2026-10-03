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

## GC baseline and allocation profiling

Use a real street frame to exercise detections and mask extraction. The default
black input normally produces no detections. The exact `run_yolo` timing keeps
GC disabled by default for comparison with older benchmark results; explicitly
enable it for the production baseline:

```bash
.venv/bin/python benchmark_yolo.py --model "$YOLO_MODEL" --device cuda:0 --imgsz 640 \
  --width 1920 --height 1080 --warmup 30 --iterations 500 \
  --image /path/to/real_street_frame.jpg --gc enabled --alloc-trace 100
```

Repeat with `--gc frozen`, then with `--gc enabled --gc-gen0-threshold 10000`
and `50000`. Each call synchronizes CUDA and the report includes p50/p99/max
latency, collection counts, total GC time, maximum pause, tracked objects and
frozen objects. The threshold and enabled state are restored after timing.
Allocation tracing runs separately after timing and reports **net retention**
and the traced peak, rather than total allocation churn.

The service emits interval `[gc]` lines next to `[mem]` and `[telemetry]`.
`gc0_per_frame` is `n/a` when no frames were inferred. The expensive tracked
object count is included only with `ENABLE_PYTHON_ALLOC_PROFILE=true`.

`benchmark_pipeline.py` uses its own reporter and now emits the same `[gc]`
line and records GC interval fields, mean `worker_cycle_ms`, and mean
`publish_ms` in its CSV. Run the ten-minute soak with a real recording:

```bash
.venv/bin/python benchmark_pipeline.py --video /path/to/recording.mp4 --duration-seconds 600
```

CSV stage timings are interval averages, not per-frame p99 measurements. Save
the baseline before applying the later optimization phases in
`docs/vision-gc-allocation-guide.md`.

### Running the baseline with Docker dependencies

If Python dependencies are installed only in Docker, run the benchmarks in a
temporary Vision container. From the repository root on the GPU host, use the
same Compose file and `--env-file` options as the deployment. The examples below
use production Compose; substitute `docker-compose.dev.yml` for development.

Production bakes app code and benchmark scripts into the application image;
only models and compiler caches are mounted. Development mounts the Vision
source directory and overrides the server command with Uvicorn reload. Both
use the application Dockerfile, whose default command is `python run.py --no-tls`.
`compose run` overrides that command with the benchmark while preserving the
entrypoint's GPU selection and the service environment. It does not start the
server in the temporary container.

After checking out Phase 0, build the application image so it includes the new
scripts and the existing GCC/G++/Python development headers. This uses the
existing dependency image; no dependency-image rebuild is needed for Phase 0:

```bash
docker compose -f docker-compose.prod.yml build p4-vision

docker compose -f docker-compose.prod.yml run --rm --no-deps -T p4-vision \
  python -c 'import sys, sysconfig; from pathlib import Path; p = Path(sysconfig.get_path("include")) / "Python.h"; print("interpreter:", sys.executable, "headers:", p, "exists:", p.is_file()); assert p.is_file(), "Python headers missing for this interpreter"'

docker compose -f docker-compose.prod.yml run --rm --no-deps -T p4-vision \
  python benchmark_yolo.py --help
```

If compilation reports `fatal error: Python.h: No such file or directory`, save
the interpreter/header check output. The application Dockerfile installs
`python3.12-dev`; an older app image or a different Python interpreter can still
leave the actual include path missing. Installing headers on the host does not
fix a container's compiler. A passing header check verifies file availability,
not successful CUDA compilation or inference; those require the warmup below.

Create `benchmark-input` on the host containing `street.jpg` and `recording.mp4`,
then capture logs and CSV on the host. The pipeline accepts the recording's
decoded resolution, including 1280x720, and records source dimensions/FPS in the
CSV. The default offered rate is 30 FPS; for another recording rate, set
`--input-fps` to match. Keep the source resolution identical between comparison
runs; 720p measurements do not establish throughput for a 1080p workload.

```bash
mkdir -p benchmark-input benchmark-results
set -o pipefail
BENCH_RESULTS="$PWD/benchmark-results"
test -w "$BENCH_RESULTS" || exit 1
printf 'Saving results on the GPU host in: %s\n' "$BENCH_RESULTS"
git rev-parse HEAD > "$BENCH_RESULTS/baseline-commit.txt"
nvidia-smi > "$BENCH_RESULTS/baseline-gpu.txt"

docker compose -f docker-compose.prod.yml run --rm --no-deps -T \
  -v "$PWD/benchmark-input:/benchmark-input:ro" \
  -v "$BENCH_RESULTS:/benchmark-results" \
  p4-vision python benchmark_yolo.py \
  --device cuda:0 --imgsz 640 --width 1920 --height 1080 \
  --warmup 30 --iterations 500 --image /benchmark-input/street.jpg \
  --gc enabled --alloc-trace 100 \
  2>&1 | tee "$BENCH_RESULTS/baseline-yolo.log"

ls -lh "$BENCH_RESULTS/baseline-yolo.log"

docker compose -f docker-compose.prod.yml run --rm --no-deps -T \
  -v "$PWD/benchmark-input:/benchmark-input:ro" \
  -v "$BENCH_RESULTS:/benchmark-results" \
  p4-vision python benchmark_pipeline.py \
  --video /benchmark-input/recording.mp4 --duration-seconds 600 \
  --csv /benchmark-results/baseline-pipeline.csv \
  2>&1 | tee "$BENCH_RESULTS/baseline-pipeline.log"

ls -lh "$BENCH_RESULTS/baseline-pipeline.log" "$BENCH_RESULTS/baseline-pipeline.csv"
```

Run the entire command, including `2>&1 | tee ...`, in the **GPU host's shell**.
`benchmark_yolo.py` prints its report to stdout; it does not automatically create
a log file. The host's `tee` creates the log immediately and saves both stdout
and stderr, while the bind mount preserves the pipeline CSV. Files written
only inside a temporary `--rm` container disappear when Docker removes it.
If no output was captured and that container has already been removed, its
Docker logs are unavailable; terminal scrollback may still contain the report.
The result directory is on the remote GPU host, not the local developer machine.

Repeat the YOLO command with `--gc frozen` and the two enabled-GC threshold
overrides, saving each run under a different log filename. `YOLO_MODEL` and
UniDepth settings come from Compose. Keep GPU selection and compile mode the
same between runs, and use GPUs without another inference workload for isolated
measurements. Verify warmup logs for `UniDepth depth-only validation passed` and
the reported compiled/eager mode. `UNIDEPTH_COMPILE=false` is an eager-mode
comparison, not a compiled-mode baseline. These commands do not replace or
verify the running Vision service's deployment.

## Phase 1 GC policy and dense-scene comparison

The application and pipeline benchmark collect and freeze objects after model
startup, then once after 30 completed worker inferences to include lazy tracker
and predictor state. Those are one-time full collections; inspect the `GC: froze`
logs and exclude startup/warmup from steady-state comparisons. Freezing reduces
future full-heap scans. It does not disable gen0/gen1 collections or guarantee
that their pauses disappear.

`VISION_GC_GEN0_THRESHOLD` is optional (100 through 1000000). Unset or blank
retains Python's default; no larger threshold has been selected automatically.
For an isolated image comparison, reuse the Docker YOLO command with a dense
street frame and compare `--gc enabled`, `--gc frozen`, and
`--gc frozen --gc-gen0-threshold 10000` / `50000`. The CLI's `--gc` choice
controls its timing block; the pipeline benchmark exercises application policy.

For the dense-video soak, reuse the Docker pipeline command and add
`-e VISION_GC_GEN0_THRESHOLD=10000` before `p4-vision`; repeat with 50000 and
with the override unset. Save separate logs/CSVs, retain the original Phase 0
baseline, and keep input, engine, GPU assignment and all model settings fixed.
The existing light-scene baseline cannot bound latency under larger mask counts.
Compare maximum GC pause and frame latency as well as aggregate GC percentage.
Monitor memory because raising the threshold delays cyclic garbage collection.

## Phase 2 dependencies and verification

Phase 2 stores production mask polygons as contiguous float32 NumPy arrays and
serializes frame metadata with `orjson.OPT_SERIALIZE_NUMPY`. The browser still
receives `[[x, y], ...]`; float32 coordinates use their shortest float32 decimal
representation. Nonfinite values become JSON `null` rather than the invalid
JSON `NaN`/`Infinity` tokens emitted by stdlib JSON. Depth distance calculation
already maps invalid values to `None`. Optional unconstrained telemetry altitude
can also be nonfinite and now serializes as `null`.

`orjson` is now direct in `pyproject.toml` and `requirements.txt`. The existing
lock remains at 3.12.0; `uv lock --offline` changed only the project's dependency
and requires-dist entries, leaving all other package/wheel records unchanged.
Its PyPI wheel covers CPython 3.12 and Linux x86_64/manylinux 2.17. It has no
PyTorch/CUDA ABI dependency; the locked PyTorch 2.12.1+cu130 and xFormers 0.0.35
were not changed. No packages were installed in the local environment, at the
user's request; actual serialization checks and the full suite require Docker.

Both Vision Compose services build `docker/vision.Dockerfile` on top of the
dependency image, with the venv under `/opt/vision-venv`. Development bind-mounts
the source directory, the custom fork directory, and the entrypoint file and
runs Uvicorn reload. Production bakes code into the image, uses the Dockerfile's
`python run.py --no-tls` command, and mounts models/cache/socket only. Source
reload cannot add the new package. Rebuild the dependency image and application
image, using the same Compose/environment options and custom fork as before:

```bash
# From the repository root on the GPU host; adapt image tags to your build workflow.
docker buildx build --load \
  --build-context ultralytics=./services/vision/.ultralytics-custom \
  -f docker/vision-deps.Dockerfile -t p4-vision-deps:gc-phase2 \
  ./services/vision
export VISION_DEPS_IMAGE=p4-vision-deps:gc-phase2
docker compose -f docker-compose.dev.yml build p4-vision
docker compose -f docker-compose.dev.yml run --rm --no-deps -T \
  -e YOLO_DEVICE=cpu -e YOLO_GPU_INDEX= -e UNIDEPTH_GPU_INDEX= \
  -e YOLO_CLASSES= -e YOLO_INFERENCE_SIZE=auto -e YOLO_MAX_IMGSZ=640 \
  -e YOLO_APPEAR_CONFIDENCE= -e YOLO_KEEP_CONFIDENCE= \
  p4-vision python -m unittest discover -s tests -q
```

The unit-test command uses CPU stubs and clears deployment class/inference
overrides that would otherwise conflict with the test fixtures. The benchmark
commands continue to use your actual production GPU/model settings.

For a live deployment, recreate the service with the rebuilt image, then check
the actual frame serialization operation in the running container:

```bash
docker compose -f docker-compose.dev.yml up -d --no-deps --force-recreate p4-vision
docker compose -f docker-compose.dev.yml exec -T p4-vision python - <<'PY'
import numpy as np
import orjson
from app.api.playback import _frame_message
from app.core.state import AppState, PlaybackItem
mask = np.array([[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]], dtype=np.float32)
item = PlaybackItem(epoch=1, seq=1, encoded=b"video", timestamp_us=0,
                    keyframe=True, result={"items": [{"mask": mask}]})
wire = _frame_message(AppState(), item)
n = int.from_bytes(wire[:4], "big")
decoded = orjson.loads(wire[4:4+n])
np.testing.assert_allclose(decoded["inference"]["items"][0]["mask"], mask, rtol=1e-6)
assert wire[4+n:] == b"video"
print("NumPy frame serialization passed; orjson", orjson.__version__)
PY
```

Substitute production Compose when applicable. Neither a rebuild nor this
encoder check verifies GPU inference or Live View rendering. Open Live View
and check masks, boxes, labels and distances, then rerun the same dense image
and video benchmarks with new result filenames. Compare GC counts/maximum
pause, p99, postprocessing, publication and memory before proceeding to Phase 3.

## Bounded memory and allocation diagnosis

Depth staging reuses one pinned host tensor and one device tensor for the current
input shape. CPU staging is not pinned. A shape change replaces the pair; it
does not accumulate a cache of shapes. The single depth worker synchronizes its
stream even on exceptions before those buffers can be reused. YOLO and depth
share the read-only BGR ndarray, removing the separate full-frame depth copy.
GPU intermediate tensors still use PyTorch's caching allocator.

Retained polygons are capped at `YOLO_MASK_MAX_POINTS` (default 256), using
evenly spaced contour points when necessary. This can reduce overlay detail;
distance estimation continues to use the original segmentation masks.
`YOLO_MAX_DETECTIONS` already bounds model detections/masks (default 100).

Playback storage is now independently bounded by `PLAYBACK_MAX_FRAMES` (default
1800) and `BACKLOG_MAX_BYTES` encoded bytes (default 256 MiB), even without
browser acknowledgements. Oldest results are evicted; a viewer requesting
evicted sequences follows the existing resync paths. Byte accounting includes
encoded video only, not Python metadata or polygons. The point/detection/frame
caps separately bound stored polygon payloads. `[mem]` logs expose
`playback_cache`, `playback_encoded_mib`, and `playback_evictions`.

For a smaller playback budget, configure all four values together:

```dotenv
YOLO_MAX_DETECTIONS=32
YOLO_MASK_MAX_POINTS=256
PLAYBACK_MAX_FRAMES=300
BACKLOG_MAX_BYTES=67108864
```

This bounds raw retained polygon coordinates to at most 18.75 MiB and encoded
video to 64 MiB; metadata, tensors, model weights, allocator caches and transport
buffers are additional. It shortens replay history and limits detections.
These bounds do not prove zero RSS growth or eliminate cyclic GC.

Run the new offline diagnostic in the dev container, which mounts benchmark
scripts from the host. It temporarily disables automatic collection over a
bounded capture and uses `DEBUG_SAVEALL` to inspect otherwise reclaimed gen0
objects. It restores GC state and releases captured garbage afterwards. The
diagnostic changes memory and timings and must not be enabled in a live service:

```bash
set -o pipefail
docker compose -f docker-compose.dev.yml run --rm --no-deps -T \
  -v /home/kdt/benchmark_input:/benchmark-input:ro \
  p4-vision python benchmark_yolo.py \
  --device cuda:0 --imgsz 320 --width 1280 --height 720 \
  --warmup 30 --iterations 100 --image /benchmark-input/mpv-shot0001.jpg \
  --gc frozen --gc-diagnose 100 \
  2>&1 | tee /home/kdt/benchmark_results/allocation-diagnostic.log
```

The report separates `run_yolo` without depth and with the depth executor. It
reports young tracked survivors, gen0 garbage types, shallow sizes, available
allocation sites, function locations, and references among garbage objects.
These are not total allocation counts, complete retained sizes, or proven cycle
roots. The isolated benchmark excludes telemetry, WebSocket and live decode.
Use the GPU report to attribute the observed runtime garbage before changing
third-party model internals. Repeat the long pipeline benchmark and verify the
`UniDepth depth-only validation passed` log for the new staging path.

## Recording-specific UniDepth intrinsics

The current UniDepth inference path uses `UNIDEPTH_CAMERA_INTRINSIC` with
`UNIDEPTH_CALIBRATION_WIDTH` and `UNIDEPTH_CALIBRATION_HEIGHT`; it does not
automatically read the recording's `intrinsics.json`. Both Compose files expose
these settings. The fixed defaults now match
`20260827_longtrip_merged/intrinsics.json`. Configure the matrix and dimensions
together when switching to another recording. The current values are:

```dotenv
UNIDEPTH_CAMERA_INTRINSIC=[[920.0,0.0,640.0],[0.0,690.0,360.0],[0.0,0.0,1.0]]
UNIDEPTH_CALIBRATION_WIDTH=1280
UNIDEPTH_CALIBRATION_HEIGHT=720
```

Existing environment overrides take precedence; remove old values or replace
them with the values above in the GPU server's Compose environment file. The service
scales this matrix to the decoded image passed to depth inference; for an
explicit 320x320 input, this becomes `fx=230`, `fy=306.6667`, `cx=160`, `cy=160`.
The matrix is for the recording's original image geometry. Cropped, rotated or
stabilized footage may require further calibration adjustments.

For development, this is a Compose environment change: recreate Vision with
`docker compose -f docker-compose.dev.yml up -d --no-deps --force-recreate p4-vision`
(using the same `--env-file` options as before). No image rebuild is needed for
this calibration-only change once the Phase 2 images are available. Development
still mounts the source directory and entrypoint file and runs Uvicorn reload;
recreation applies the new environment and refreshes the file mount.

Verify the effective values in the running container:

```bash
docker compose -f docker-compose.dev.yml exec -T p4-vision python -c \
  'from app.core.settings import settings as s; print(s.UNIDEPTH_CAMERA_INTRINSIC); print(s.UNIDEPTH_CALIBRATION_WIDTH, s.UNIDEPTH_CALIBRATION_HEIGHT)'
```

Then repeat the same input/engine/compile-mode comparison and check several
objects with measured physical distances. Matching the recording's intrinsics
fixes the input mismatch; it does not by itself demonstrate accurate metric
depth or explain all overestimation.

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

The harness accepts any decoded source resolution. Its declared frame rate
must be within 0.5 FPS of `--input-fps` (30 by default). It records source
dimensions/FPS, inference, skip and published counts, maximum
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

The periodic `[mem]` line keeps `dropped` as the total inference frames skipped
since process start. `drop_enqueue` counts frames discarded while entering the
inference queue (latest-policy replacement or a full bounded queue).
`drop_worker_latest` counts frames discarded when the inference worker drains
queued work to the newest frame. These counters are cumulative and their sum
equals `dropped`; compare them between log lines to locate where skips occur.

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
