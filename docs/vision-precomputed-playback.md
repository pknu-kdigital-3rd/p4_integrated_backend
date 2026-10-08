# Precomputed video inference and GPU-free playback

Preprocess a recording on a supported GPU once. Review the saved segmentation,
boxes, tracked objects and distances in a portable HTML page, then use the same
bundle in the operator dashboard's **실시간 영상** tab. Playback serves the recording;
it does not infer detections for a new camera feed.

## 1. Generate on the GPU machine

Use the existing Vision Python 3.12 environment, custom Ultralytics checkout and
model assets. `uv sync --frozen` still installs the default `inference` dependency
group. GPU packages retain their locked versions and sources: PyTorch
2.12.1+cu130, torchvision 0.27.1+cu130 and xFormers 0.0.35 from the cu130 index,
plus the existing TensorRT and pinned UniDepth source/model revisions.

From `services/vision`, for example on Linux:

```bash
export VISION_INFERENCE_MODE=inference
export YOLO_DEVICE=cuda:0
export YOLO_MODEL=/path/to/a4_best.engine
# Optional separate depth GPU; otherwise depth follows YOLO_DEVICE.
# export UNIDEPTH_DEVICE=cuda:1
uv sync --frozen
uv run --frozen python preprocess_video.py \
  --video /recordings/drive/video.mp4 \
  --output /recordings/drive/precomputed
```

PowerShell uses the same command with environment assignments such as
`$env:VISION_INFERENCE_MODE='inference'` and `$env:YOLO_DEVICE='cuda:0'`.
Direct commands select devices through `YOLO_DEVICE` / `UNIDEPTH_DEVICE`;
the GPU-index selection variables belong to the existing Docker entrypoint.
TensorRT engines must be compatible with the preprocessing machine. Existing
YOLO filters, tracking, mask settings, UniDepth input size and camera calibration
settings apply; set them before starting the job. The manifest records them.

Every decoded frame is analyzed in order. There is no realtime deadline or
frame sampling. Processing can take longer than the video. Model/depth execution
errors abort the job; an individual object with no valid depth keeps its existing
unavailable-distance status. Tracking starts fresh for each job.

The output directory must not already exist. A failed job removes its temporary
output and never publishes a complete bundle. Generate another directory to
replace a recording; do not modify a bundle while it is being served.

The output contains:

| File | Purpose |
| --- | --- |
| `playback.mp4` | H.264 baseline video, no burned-in overlays and no audio |
| `inference.jsonl` | One saved result per exported frame |
| `manifest.json` | Video/result checksums, generation metadata and timestamp/byte index |
| `review.html` | Portable viewer with all code and styles included |

Export preserves frame intervals at 90 kHz precision and starts at time zero.
Missing, decreasing or colliding timestamps are rejected. Odd source dimensions
are rounded up to even dimensions for H.264, with inference performed at those
same dimensions. The generator decodes the exported MP4 and verifies that every
frame timestamp matches its inference index before publishing. Source-time offset
metadata preserves synchronization with the original recording's GPS/IMU clock.

## 2. Review without a server

Copy the four files together. Open `review.html` directly in a current Chrome or
Edge browser and select that bundle's MP4, manifest and JSONL files. No server,
internet connection, CDN or upload is used. The page offers play/pause, seeking,
previous/next frame, loop intervals, confidence filtering, and independent box,
mask and distance controls. Overlays show raw saved results without smoothing.

The player captures a video frame and draws its corresponding saved overlays
together, using presented-frame timestamps rather than estimated FPS. It reads
indexed JSONL slices with bounded lookahead and discards obsolete reads after
seeks. The browser checks file sizes, video dimensions/duration and a fingerprint
of the first/last MiB of both video and results. The server additionally checks full SHA-256 hashes of the
video and result file. These are integrity checks, not signatures of trusted data.

## 3. Serve in the dashboard without GPU dependencies

Place the bundle under the recording dataset directory:

```text
drive/
  gps.csv
  imu.csv
  precomputed/
    playback.mp4
    inference.jsonl
    manifest.json
    review.html
```

The original `video.mp4` is not needed on the playback server. Integrated playback
retains the existing GPS/IMU CSV schema and source-start configuration. Standalone
HTML review requires no telemetry files. In cached mode, inference thresholds and
model labels come from the manifest; changing inference settings on the playback
server does not regenerate results.

From the repository root:

```bash
export SERVER_DATASET_DIR=/recordings/drive
export VISION_SOURCE=server
docker compose -f docker-compose.dev.yml -f docker-compose.cached.yml \
  up -d --build --no-deps --force-recreate p4-vision
```

Use `docker-compose.prod.yml` in place of the development file for production,
with its existing required environment/secrets already configured. `VISION_SOURCE`
must also be `server` for Node so its bootstrap continues to select server video.
If changing Node's existing source setting, apply that configuration through the
normal stack deployment procedure. Existing server-mode installations need no
Node, database or Nginx changes for cached playback.

The override selects `docker/vision-playback.Dockerfile`, removes NVIDIA device
reservations, GPU selection/entrypoint configuration, model mounts and relay
dependencies, and starts `python run.py --no-tls`. It keeps the service name/port
and existing HTTPS/WebSocket ingress. Compose 2.24.4 or later is required for the
override tags. Cached mode rejects `VISION_SOURCE=relay` and never falls back to
model execution.

**Mount/build behavior:** the CPU image contains application code and webpage
assets. The recording directory is one read-only **directory bind mount**; the
cached override deliberately replaces the development source bind mounts, so
cached development has no automatic code reload. Code/assets/dependency changes
require rebuilding the CPU image. Data changes in a new bundle require recreating
Vision to validate and load it, without rebuilding the image:

```bash
docker compose -f docker-compose.dev.yml -f docker-compose.cached.yml \
  up -d --no-deps --force-recreate p4-vision
```

By default `VISION_CACHE_DIR` inside the container is
`/data/vision-dataset/precomputed`; override it to select another immutable bundle
within the dataset mount. Verify what the container actually sees:

```bash
docker compose -f docker-compose.dev.yml -f docker-compose.cached.yml config
docker compose -f docker-compose.dev.yml -f docker-compose.cached.yml exec p4-vision \
  python -c "from app.core.settings import settings; from app.services.inference_bundle import InferenceBundle; b=InferenceBundle(settings.VISION_CACHE_DIR); print(settings.VISION_INFERENCE_MODE, b.manifest['model_filename'], b.manifest['frame_count'], b.manifest['video']['sha256'])"
```

Then open the dashboard's video tab and verify masks, boxes, distances, seeking,
loops and GPS/map updates against the standalone review. A successful image build
or host checkout alone does not prove the running container uses the new bundle.
The existing GPU development Compose individually mounts its entrypoint script;
if returning to that configuration after Git replaces the script, recreate its
container instead of relying on a process reload or `docker compose restart`.

For a direct CPU process, use a separate environment to preserve the GPU one:

```bash
cd services/vision
UV_PROJECT_ENVIRONMENT=.venv-playback uv sync --frozen --no-default-groups --no-dev
export VISION_SOURCE=server VISION_INFERENCE_MODE=cached
export SERVER_DATASET_DIR=/recordings/drive
export VISION_CACHE_DIR=/recordings/drive/precomputed
.venv-playback/bin/python run.py --no-tls
```

Remote browsers need the existing HTTPS ingress (or `run.py --tls`) for the
WebCodecs player. CPU serving still decodes and encodes video; it performs no
YOLO, depth, CUDA or model loading. The existing single-viewer takeover behavior,
session resets, telemetry matching and ephemeral map updates remain in use.

## Verification

```bash
# Existing inference environment: targeted regression suites
python -m unittest tests.test_server_source tests.test_playback tests.test_pages \
  tests.test_run tests.test_yolo tests.test_depth tests.test_telemetry \
  tests.test_source_timeline tests.test_recording_detections tests.test_gc_runtime
# Playback-only environment, with VISION_INFERENCE_MODE=cached:
python -m unittest tests.test_inference_bundle tests.test_pages \
  tests.test_telemetry tests.test_source_timeline
# Repository root, Node 24:
node --test --test-isolation=none services/vision/tests/js/*.test.js
node services/vision/tests/browser-review-smoke.cjs /path/to/precomputed
```

The bundle tests use synthetic video and fake inference outputs to verify actual
H.264 encoding, every-frame indexing, failure cleanup, corrupted bundles, and the
full application WebSocket path with model imports denied. The browser test runs
the portable page from `file://` in a disposable headless Chrome profile with
networking disabled. Set `CHROME_EXECUTABLE` if Chrome is not at its usual Windows
path or on the Linux PATH.

Actual YOLO segmentation, GPU mask extraction and UniDepth distances must also be
checked on a compatible GPU with the real recording and model assets. The local
Quadro P2200 (sm_61) cannot execute the locked PyTorch build; passing synthetic or
CPU playback tests does not verify GPU inference quality or calibration.
