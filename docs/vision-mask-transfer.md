# GPU contour extraction (Option A)

The default `YOLO_MASK_TRANSFER=gpu` extracts ordered external contours on
the inference GPU. Only bounded vertices and small metadata cross to the CPU.
GPU mode no longer unpacks masks or calls `cv2.findContours` per frame.
CPU inference retains the existing Ultralytics path.

```text
GPU reconstruction / threshold → retained masks / contour-grid reduction
→ GPU component labeling → GPU ordered external contours / vertex cap
→ metadata and occupied vertices to CPU
→ compact component bridges / normalization → browser polygons
```

Depth calculations retain the original GPU masks. Video decoding/conversion,
tracking, compact-polygon assembly, optional simplification and serialization
still use CPU. Lower CPU utilization or latency has not yet been demonstrated
on the deployment GPU.

## Geometry and bounds

Foreground uses 8-connectivity and background uses 4-connectivity. A virtual
one-pixel border identifies external background. Holes and foreground islands
enclosed in holes are excluded, matching the external-contour policy. Directed
starting-edge closure handles thin objects and diagonally touching regions.

The GPU walker retains direction-change vertices (`CHAIN_APPROX_SIMPLE`).
Atomic component slots are sorted by reverse raster start before the fork's
existing CPU bridge construction joins disconnected components. No CPU mask
scan or contour tracing occurs in GPU mode.

`YOLO_MASK_MAX_POINTS` (default 256) now caps each component on the GPU,
before merging; the existing final polygon cap remains. Highly detailed
disconnected masks can differ from the old policy, which capped only after
merging. Smaller contours are tested for exact coordinate/order equality.

`YOLO_GPU_CONTOUR_MAX_COMPONENTS` defaults to 32 per instance (range 1..256).
Overflow or a contour that does not close raises an explicit inference error.
Components are never silently dropped; GPU mode never silently falls back to
CPU. Increase the bound for fragmented masks or use `packed`/`legacy` while
investigating a failure.

Per-thread workspaces are reused, replaced on shape/device/limit changes.
For 100 masks at 640×360, defaults require about 93 MB of component parents
and 6.6 MB of vertex capacity, plus small metadata. Only populated vertex
ranges are transferred. All kernels run on the caller's PyTorch CUDA stream;
pinned copies wait for completion events before CPU access or reuse. Error
paths synchronize before releasing input/output buffers. Inference frames
are not overlapped.

## Compiler and dependencies

NVRTC compiles the CUDA source once per process/device; the CUDA driver loads
it for the actual GPU. There is no nvcc installation, separate native library,
or Torch C++ ABI dependency. Startup actually traces masks with a hole and
disconnected components and compares normalized polygons with the legacy
path before loading YOLO. Look for `GPU contour startup validation passed`.

Both `services/vision/pyproject.toml` and `uv.lock` were inspected. Python
remains 3.12; Torch remains 2.12.1+cu130 from the explicit CUDA 13.0 PyTorch
index. The Linux lock already supplies the PyPI NVRTC 13.0.88 wheel through
Torch's `cuda-toolkit[nvrtc]` dependency. No dependencies, lockfile or
Dockerfile were changed. Runtime rejects an NVRTC CUDA major that differs
from Torch's. Source is compiled from the running checkout/image, preventing
stale precompiled contour libraries after source updates.

## Apply and verify in dev

The dev service builds from `services/vision` using `docker/vision.Dockerfile`,
bind-mounts the service directory, and runs `uvicorn ... --reload`. It also
individually mounts the entrypoint script. These changes edit mounted app
code and Compose environment defaults, without changing the entrypoint or
dependency-image inputs. Recreate Vision to apply the environment:

```bash
docker compose -f docker-compose.dev.yml up -d --no-deps --force-recreate p4-vision
docker compose -f docker-compose.dev.yml exec -T p4-vision python -c \
  'from app.core.settings import settings; print(settings.YOLO_MASK_TRANSFER)'
docker compose -f docker-compose.dev.yml logs --tail 100 p4-vision
```

The effective setting must be `gpu`, and startup must report contour validation
passing. A host override of `YOLO_MASK_TRANSFER=packed` or `legacy` takes
precedence. In production, app files are baked into the image and only models
are directory-mounted, so rebuild the app image to include this code.
No running deployment has been verified locally.

## Compare CPU cost and latency

Pinned transfers wait on a blocking CUDA event so the host thread can sleep
while GPU work completes. Default CUDA events can busy-wait and consume a CPU
core even though contour tracing itself runs on the GPU. Compare both
`process_cpu_mean` and wall latency: reduced CPU waiting need not reduce latency.

Run in the existing dev container to match its GPU visibility and dependencies:

```bash
docker compose -f docker-compose.dev.yml exec -T p4-vision \
  python -m unittest tests.test_gpu_contours tests.test_mask_transfer
docker compose -f docker-compose.dev.yml exec -T p4-vision \
  python benchmark_mask_transfer.py --device cuda:0 --masks 100 \
  --width 640 --height 360 --warmup 30 --iterations 200
```

The benchmark compares legacy CPU contours, packed-mask CPU contours and GPU
contours. It validates packed geometry against legacy and GPU geometry against
OpenCV with the same per-component cap. It reports transfer bytes, wall
mean/p50/p99/max and mean process CPU time. It excludes TensorRT, depth,
video and browser work. Also compare the full `benchmark_yolo.py` path with
a real dense input and each transfer mode.

## Local validation

The shared native walker and actual parallel CUDA kernels were compared with
OpenCV for empty/full masks, singleton/two-pixel masks, image edges, holes,
enclosed islands, diagonal contacts, disconnected regions, point sampling,
component overflow and 125 randomized masks at several densities.

Native CUDA execution was tested on the local Quadro P2200 with separately
installed CUDA 12.8 NVRTC through the CUDA driver test harness. This bypasses
PyTorch only for kernel tests and is not an application fallback. CUDA 13.0
NVRTC from the installed Torch distribution also compiled the production
kernel branch successfully to PTX for compute capability 7.5.
The modern GPU branch was also assembled for sm_75 with CUDA 12.8 ptxas.
The targeted suite passed 73 tests with two PyTorch CUDA integration tests
skipped; the benchmark CPU smoke run passed. No speedup is inferred from those
CPU timings.

The P2200 (sm_61) is unsupported by the locked CUDA 13 PyTorch build. Full
PyTorch-stream/pinned-copy integration, CUDA 13 execution and deployment-GPU
CPU/latency improvements remain unverified locally. Run the CUDA integration
tests on the supported deployment GPU.
