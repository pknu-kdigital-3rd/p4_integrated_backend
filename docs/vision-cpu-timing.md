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

### Determine which model finishes last

Each completed result includes `model_timeline`: YOLO and depth start/end offsets
in milliseconds from the beginning of that frame's `run_yolo` call. Depth's
timestamps are measured inside its worker, not when its Future is retrieved.
Both use `perf_counter`, the same monotonic clock across threads. These are host
call intervals including preprocessing, GPU waits and model callbacks, not a GPU
kernel trace. No additional CUDA synchronization is introduced.

Every metrics interval prints `[model-timeline]` with parallel-frame counts for
`yolo_last_frames`, `depth_last_frames` and ties, plus mean overlap, each model's
tail beyond the other model's finish, and depth submission-to-start delay.
Means and finish-order counts cover successful parallel pairs only; serial,
YOLO-only and depth-error frames have separate counts. Finish order measures
the last model call; it does not prove the model is the only pipeline bottleneck
or predict the benefit of speeding it up under CPU/GPU contention.

`[model-timeline-slow]` reports the slowest inference frame in that interval,
identified by epoch and sequence, with its actual start/end offsets and mode.
This keeps one frame rather than an accumulating history and avoids per-frame
console output. Look for its `last_model`, tails and launch delay during drops.
Input conversion and result postprocessing are outside these model intervals;
compare their existing metrics too. Disable CPU profiling for baseline timings
(`VISION_CPU_PROFILE_FRAMES=0`); profiling changes scheduling and CPU cost.

### Capture model CPU profiles

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
60 calls using a pstats collector with `time.thread_time()` as its clock and
thread-local `sys.setprofile` hooks. Models and their captures run concurrently.
Capture stops automatically after the configured sample count. The completion
message includes `profiler=thread_local` to identify the corrected implementation.
Each model also logs its configured frame/warmup counts on first use and progress
after the first sample and every 20 samples. If no configuration message appears
while models are running, check the effective settings and mounted code inside
the container. Files live inside the named Docker volume, not the host repo.

Discard files captured by the earlier cProfile implementation: on Python 3.12
its monitoring events crossed thread boundaries, mixing different thread CPU
clocks. Negative times, unrelated decoder calls and inflated totals from those
files are invalid. The replacement has more Python profiling overhead. Its hook
bookkeeping CPU is excluded from attribution, but profiling still affects model
execution; compare the attribution with unprofiled `[cpu]` data.

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

## Reduce UniDepth kernel-launch overhead

`UNIDEPTH_COMPILE_MODE=reduce-overhead` is now the default when compilation is
enabled on CUDA. It requests TorchInductor CUDA graphs to reduce repeated CPU
kernel dispatch. `default` restores the previous compile mode; CPU execution
always uses `default`. `UNIDEPTH_COMPILE=false` retains eager execution.
No dependencies, resolution, weights or depth-median semantics change.

Loading and warmup run on the existing single depth worker, so graph state is
initialized on the thread that performs live inference. Every optimized graph
frame marks a new iteration. Returned depth is cloned outside compilation to
protect it from graph pool reuse. CUDA completion retains the existing blocking
event; this change adds no per-stage GPU synchronization.

Graph-mode startup tests three different images against upstream eager output
at the existing 1%/0.01 m tolerance, and checks that the first returned depth
stays unchanged through later calls. Setup/runtime compiler failures retry eager;
output-validation failures use the upstream eager path. Logs show the requested
compile mode and the final warmup mode. Successful validation is a correctness
check, not proof that every region captured a CUDA graph. Unsupported operations
or graph breaks can prevent capture; compare actual timings and launch profiles.
Graph workspace caching may increase CUDA reserved memory.

For a deployment comparison, leave the current input size and resolution level
unchanged and disable CPU profiling:

```env
UNIDEPTH_COMPILE=true
UNIDEPTH_COMPILE_MODE=reduce-overhead
VISION_CPU_PROFILE_FRAMES=0
```

Dev directory-mounts app code, individually mounts the unchanged entrypoint and
runs Uvicorn with reload. Recreate for the new Compose environment. Dev uses
the directory mount for changed app code; dependencies and Dockerfiles are unchanged:

```bash
docker compose -f docker-compose.dev.yml up -d --no-deps --force-recreate p4-vision
docker compose -f docker-compose.dev.yml exec -T p4-vision python -c "from app.core.settings import settings; print(settings.UNIDEPTH_COMPILE, settings.UNIDEPTH_COMPILE_MODE, settings.VISION_CPU_PROFILE_FRAMES)"
docker compose -f docker-compose.dev.yml logs -f --tail 100 p4-vision
```

Expect effective settings `True reduce-overhead 0`, followed by a final
`UniDepth warmup finished ... mode=compiled/reduce-overhead` log and successful
three-frame validation with `output_lifetime_checked=True`. A settings value
alone does not prove the active model avoided fallback. Replay the same scene
and compare `[cpu] depth_thread_cpu_ms`, `[mem] depth_ms/infer_fps/skipped_fps`,
depth tails in `[model-timeline]`, and CUDA memory. For rollback set
`UNIDEPTH_COMPILE_MODE=default` and recreate. Production bakes app code into its
image and requires an app-image rebuild plus container recreation.

Local tests cover mode selection, worker ownership, output copying, repeated
frame validation and fallback. Actual CUDA graph inference/replay cannot run on
the local GPU with the locked Torch build; no deployment speedup is claimed.

References: [torch.compile modes](https://docs.pytorch.org/docs/stable/generated/torch.compile.html),
[CUDA graph output lifetime](https://docs.pytorch.org/docs/main/user_guide/torch_compiler/torch.compiler_cudagraph_trees.html).
