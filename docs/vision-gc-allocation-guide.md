# Vision inference hot path: reducing Python allocations and GC pauses

Implementation guide for a later agent. It is written against branch `preallocate` at commit `fa995ba`. Line numbers are approximate; find the code by symbol name.

Read `AGENTS.md` at the repo root before starting. Its rules on Vision dependencies, GPU verification, commit messages and Docker deployment all apply here.

---

## 1. Background

### 1.1 What runs per frame
Service: `services/vision` (Python 3.12, FastAPI, PyTorch CUDA, the custom Ultralytics fork at `.ultralytics-custom`, UniDepth V2).

```
frame_receiver (event loop)          app/services/yolo.py::_decode_session → _queue_decoded_frame
  └─ inference_queue
yolo_worker (event loop)             app/services/yolo.py::yolo_worker
  └─ asyncio.to_thread(run_yolo)     app/services/yolo.py::run_yolo        (YOLO thread)
       ├─ frame.to_ndarray / reformat
       ├─ depth_executor.submit(predict_timed)  app/services/depth.py       (UniDepth thread)
       ├─ yolo_model.track(...)       Ultralytics
       ├─ masked_median_distances     app/services/depth.py
       └─ Python postprocess → result dict (items, bbox, mask polygons)
  └─ state.put_result(PlaybackItem)   app/core/state.py (kept in result_store until the browser ACKs)
playback websocket                    app/api/playback.py::_frame_message → json.dumps → send_bytes
skipped frames                        app/services/yolo.py::_skipped_frame_result / _publish_skipped_frames
```

### 1.2 Why GC pauses matter here
- CPython's cyclic GC runs while holding the GIL. One pause stalls the event loop (decode, WebSocket), the YOLO thread and the UniDepth thread together.
- Python 3.12 uses thresholds `(700, 10, 10)`. A gen0 collection is triggered by net allocations of **GC-tracked container objects** (list, dict, tuple, class instances). Floats, ints, str, bytes and numpy arrays are **not** tracked (`gc.is_tracked(ndarray) is False`).
- A gen0 collection scans only young objects and is cheap. A **full (gen2) collection walks every tracked object in the process**. That includes everything torch, Ultralytics, UniDepth, `torch.compile`/Inductor, FastAPI and aiortc created at import and startup, which is likely millions of objects. That walk is the long pause. (In 3.12 a full collection runs only when the pending long-lived objects exceed 25% of the long-lived total. Measure; don't assume.)
- Precedent in this repo is commit `496d336` (`services/routing-tracking/main.py`). There, a full collection cost ~450 ms with the routing graph loaded. `gc.collect(); gc.freeze()` after loading brought that to ~0 ms. Reuse its `_gc_timer` / `_freeze_loaded_objects` pattern.

### 1.3 Current state (what is missing or wasteful)
| Item | Location | Problem |
|---|---|---|
| No GC measurement | `app/services/metrics.py` | `tracemalloc` (`ENABLE_PYTHON_ALLOC_PROFILE`) shows *retained* memory only, not churn or pause time |
| Benchmark hides GC | `benchmark_yolo.py` (`gc.disable()` around the exact `run_yolo` timing) | Reported numbers never include GC pauses |
| Benchmark uses a black frame | `benchmark_yolo.py` (`np.zeros(...)`) | No detections, so postprocess and mask allocations are never exercised |
| No `gc.freeze()` | `app/main.py` lifespan | Every full collection walks all startup objects |
| Mask polygons → nested lists | `run_yolo`: `polygon.tolist()` | One list for each contour point; hundreds of points × detections per frame |
| 4 separate box transfers | `run_yolo` → `_box_field_values` (conf, cls, coords, id) | 4 GPU→CPU syncs and 4 Python lists per frame |
| Skipped frames copy every item | `_skipped_frame_result` | N dict copies for **each** skipped frame, recomputed from the same `previous_result` |
| Stdlib `json.dumps` per sent frame | `app/api/playback.py::_frame_message` | Walks the full nested result, including all mask points, for every frame sent (skipped frames too) |
| Large per-frame host buffers | `run_yolo`: `depth_input = img.copy()`; `DepthEstimator._infer`: `frame[:, :, ::-1].copy()` + pageable `.to(device)` | malloc/mmap churn and page faults (not GC, but hot-path allocation) |

### 1.4 Local micro-benchmark (synthetic)
Measured on a macOS dev machine (Python 3.12.5, numpy 1.26), CPU only, with 10 detections × 200 points of float32 polygons standing in for one frame. These are indicative numbers, not production measurements.

| | GC-tracked allocations/frame | time |
|---|---|---|
| `[p.tolist() for p in polys]` (current) | ~2,011 | 0.28 ms |
| keep ndarrays | 1 | ~0 ms |
| `json.dumps` of the lists | – | 3.07 ms |
| `orjson.dumps(arrays, option=OPT_SERIALIZE_NUMPY)` | – | 0.27 ms |

So masks alone cause about 3 gen0 collections per frame at threshold 700. Results also stay in `result_store` until the browser ACKs them, so these lists get promoted to older generations and are walked again by later collections.

---

## 2. Order of work

Do the phases in order and measure between them. Each phase should be its own commit.

0. Instrument (no behaviour change), then capture a **baseline** on the GPU host.
1. `gc.freeze()` after startup, plus an optional gen0 threshold setting.
2. Fewer per-frame Python objects: numpy masks + orjson, a single box transfer, held-item caching, hoisted constants.
3. Preallocated pinned buffers for the depth input.

Stop after any phase if the measurements show GC is no longer significant.

---

## 3. Phase 0: Instrumentation

### 3.1 New module `app/services/gc_stats.py`
A process-wide accumulator registered in `gc.callbacks`:
- `callback(phase, info)`: on `"start"` record `perf_counter()`. On `"stop"`, add the pause to the total, update the **max single pause**, and increment the count for `info["generation"]`. Accumulate `info["collected"]` and `info["uncollectable"]`.
- `snapshot()` → dict `{gc0, gc1, gc2, gc_ms_total, gc_collected, gc_uncollectable}`.
- `take_max_pause_ms()` returns the interval max and resets it, like the CUDA peak reset in `metrics._cuda_memory`.
- `install()` appends the callback once (it must be idempotent) and returns the singleton.
- The callback runs on whichever thread triggered the collection, and the GIL serializes it, so plain counters are safe. Keep it allocation-free and cheap.

### 3.2 `app/services/metrics.py`
- In `metrics_worker`, call `install()`. Take an initial snapshot and reset the max.
- After the existing `[telemetry]` print, print a separate `[gc]` line for each interval with:
  - `gc_ms`;
  - `gc_pct` (GC ms as a percentage of wall time);
  - `gc_max_ms`;
  - `gc0`/`gc1`/`gc2` deltas;
  - `gc0_per_frame` (gen0 collections ÷ inferred frames; × threshold ≈ tracked allocations per frame);
  - `gc_collected`, `gc_uncollectable`;
  - `gc_threshold=gc.get_threshold()`;
  - `gc_frozen=gc.get_freeze_count()`.
- Add `gc_tracked=len(gc.get_objects())` **only when `ENABLE_PYTHON_ALLOC_PROFILE` is on**, because walking the whole heap is expensive. After a freeze, `gc.get_objects()` no longer includes frozen objects; `gc.get_freeze_count()` covers those.
- Put the formatting in a pure helper (e.g. `_gc_report(current, previous, max_pause_ms, inferred_delta, elapsed, count_tracked)`) so it can be unit-tested.

### 3.3 `benchmark_yolo.py`
- `--image PATH`: read with `cv2.imread` and resize to `--width x --height`. Without it, keep the black frame, but note in the output that it produces no detections.
- `--gc {disabled,enabled,frozen}`, default `disabled` so existing numbers stay comparable:
  - `enabled` is the production defaults;
  - `frozen` runs `gc.collect(); gc.freeze()` just before timing.
- `--gc-gen0-threshold N`: temporary override for the timing; restore it afterwards.
- Time `run_yolo` **per call** (sync CUDA after each), not only in aggregate. Report p50/p99/max, because GC shows up in the tail.
- Report the tracked object count at start, the freeze count, gc0/gc1/gc2 during the run, gc0 per frame, total GC ms and max pause.
- `--alloc-trace N` (optional): after timing, run N `run_yolo` calls under `tracemalloc.start(25)`. Print `after.compare_to(before, "lineno")[:25]` and the traced peak (`tracemalloc.reset_peak()` before the loop). This points to the allocation sites; note in the output that net retention for a steady-state frame should be near zero.
- Keep the existing `_measure_wall` and the "Interpretation" section working.

### 3.4 Baseline capture (GPU host, RTX 3090)
From `services/vision`, with the env vars in `BENCHMARK_YOLO.md`:
```bash
.venv/bin/python benchmark_yolo.py --model "$YOLO_MODEL" --device cuda:0 --imgsz 640 \
  --width 1920 --height 1080 --warmup 30 --iterations 500 \
  --image /path/to/real_street_frame.jpg --gc enabled --alloc-trace 100
# repeat with --gc frozen, and with --gc-gen0-threshold 10000 / 50000
```
Also run a `benchmark_pipeline.py` soak (it already writes CSV and uses the metrics worker), with a real recording:
```bash
.venv/bin/python benchmark_pipeline.py --video /path/to/recording.mp4 --duration-seconds 600
```
Record from the `[gc]` lines and `[mem]` lines: `gc_ms`, `gc_pct`, `gc_max_ms`, `gc2`, `gc0_per_frame`, and p99 `worker_cycle_ms`. Save the numbers; the commit message must quote before/after.

---

## 4. Phase 1: Take startup objects out of the GC

### 4.1 Freeze after loading
In `app/main.py` lifespan, after `load_yolo_model()`, `load_depth_estimator()` (which already does warmup and `torch.compile`) and `make_depth_executor()`, but **before** creating the worker tasks:
```python
def _freeze_loaded_objects(label: str) -> None:
    started = perf_counter()
    gc.collect()          # don't freeze garbage
    gc.freeze()           # move everything tracked to the permanent generation
    print(f"GC: froze {gc.get_freeze_count()} objects after {label} in {perf_counter() - started:.1f} s", flush=True)
```
Use the same shape as `_freeze_loaded_objects` in `services/routing-tracking/main.py` from `496d336`.

### 4.2 Second one-shot freeze after first inferences
Ultralytics creates its predictor, tracker and other state lazily on the first `track()` call, and cuDNN benchmark/Inductor may create more on the first real frames. Add a one-shot `gc.freeze()` in `yolo_worker` after the first K completed inferences (K ≈ 30; make it a module constant). `gc.freeze()` is cumulative. That second freeze costs one full collection, once.

Caveats:
- Frozen objects are never collected. That is fine for long-lived model and library state, but don't freeze while per-frame results are alive in large numbers. Freezing in the worker right after `put_result` will freeze the ~30 results then held in `result_store`, which is negligible. Alternatively, call `gc.collect()` first, as the helper does.
- `reset_tracker` and epoch changes create new tracker state after the freeze. That is expected and small.

### 4.3 Optional gen0 threshold setting
In `app/core/settings.py`, add `VISION_GC_GEN0_THRESHOLD: int | None = Field(default=None, ge=100, le=1_000_000)`. When it is set, apply `gc.set_threshold(value, *gc.get_threshold()[1:])` next to the freeze, and log it. Don't change the default until Phase 0/1 measurements justify a value. Add it to `deploy/env.local.example` if that file lists other Vision settings, which commit `1ceb368` did.

### 4.4 Expected outcome
`gc_max_ms` and the p99 tail should drop sharply. `gc2` pauses should become close to 0 ms. If they do and `gc_pct` is already well under ~1%, Phase 2 is optional.

---

## 5. Phase 2: Fewer per-frame Python objects

### 5.1 Keep mask polygons as numpy, serialize with orjson
These two changes **must ship together**. Stdlib `json` cannot serialize ndarrays, and calling `tolist()` at send time would make things worse, because skipped frames are re-sent.

**`run_yolo` (`yolo.py`)**: replace
```python
detection["mask"] = polygon.tolist() if hasattr(polygon, "tolist") else polygon
```
with storing a C-contiguous float32 `(N, 2)` ndarray (`np.ascontiguousarray(polygon, dtype=np.float32)` when it is an ndarray; leave lists from test doubles as they are). Verify in `.ultralytics-custom` what `Masks.xyn` returns (expected: list of float32 ndarrays) so no extra copy is made. `_simplify_mask_polygon` already returns ndarrays. `len(polygon) >= 3` and `mask_count` work unchanged.

**`_frame_message` (`app/api/playback.py`)**: use `orjson.dumps(metadata, option=orjson.OPT_SERIALIZE_NUMPY)`. It returns bytes directly, so drop the `.encode()`. Small control messages can stay on stdlib `json`.

**Before changing, grep every consumer of `result["items"][*]["mask"]`** (`grep -rn '"mask"' services/vision/app services/vision/*.py`). Also check every place a result or `PlaybackItem.result` is JSON-encoded with stdlib `json` (`grep -rn "json.dumps\|send_json" services/vision/app`). Known consumers:
- `recording_detections.normalized_detections` ignores masks, so it is safe.
- `_skipped_frame_result` shares the reference (shallow dict copy), so it is safe.
- `_frame_message` must switch to orjson.
- Any other endpoint that serializes results must also switch, or convert there.

**Dependency (AGENTS.md):**
- Add `orjson` as a **direct** dependency in `services/vision/pyproject.toml`. It is already in `uv.lock` (3.12.0) transitively.
- Run `uv lock` and confirm the lock diff is limited to the project's dependency list.
- Confirm the locked wheel covers cp312 / linux x86_64 (the deployment target).
- If `requirements.txt` mirrors `pyproject.toml`, update it as well (commit `1ceb368` touched both).

**Wire compatibility:** the JSON shape stays `[[x, y], ...]`. orjson writes float32 values with the shortest float32 repr (e.g. `0.12345679`), which is different digits but the same meaning. Floats elsewhere are Python floats and serialize as before. NaN/Inf: stdlib `json` emits `NaN`, while orjson emits `null`. Check whether any field can be NaN (`distance_m` is already `None` when not finite). The frontend (`index.html`, `live-view-tracks.js`, `operator-web`) needs no change; confirm by loading Live View.

### 5.2 One GPU→CPU transfer for box fields
In `run_yolo`, on the production path (when `boxes.conf`, `boxes.cls` and the coordinate field are `torch.Tensor`):
```python
columns = [coords, conf.unsqueeze(1), cls.unsqueeze(1)]
if tracking and boxes.id is not None:
    columns.append(boxes.id.unsqueeze(1))
rows = torch.cat([c.float() for c in columns], dim=1).cpu().tolist()   # 1 sync, N small lists
```
Then index `rows[i][0:4]`, `rows[i][4]` and so on. `boxes.id` is `None` when the tracker has no tracks; handle that. Track IDs are integral floats, so round-trip them through `int()`. Keep `_box_field_values` as the fallback for the Results-like test doubles in `tests/test_yolo.py`. Behaviour (values, ordering, filtering by `CONF_THRESHOLD_LOW`) must not change.

### 5.3 Compute held items once per inference result
`_skipped_frame_result` rebuilds the "held distance" copies of every item for each skipped frame, even though `previous_result` is the same object. Cache the held list per source result:
- Preferably keep a small cache in `AppState`, e.g. `held_items_cache: tuple[dict, list] | None` compared by `is`. Don't use a private key in the result dict, so it can't leak into serialization.
- Each skipped result still needs its own outer dict (source metadata differs). Its `items` list can be the shared cached list, because results are immutable after storing (the existing comment in `_skipped_frame_result` already relies on this).
- Also cache `mask_count` alongside.
- Keep the function signature tests rely on, or update `tests/test_yolo.py` accordingly.

### 5.4 Hoist per-frame constants in `run_yolo`
- Move the `coordinate_field` mapping dict to module level.
- Compute `scale_x`/`scale_y` and `settings.BBOX_FORMAT.endswith("_pixels")` once before the loop, not per detection.
- Read `settings.*` values used inside loops into locals once.

These are small wins; don't refactor beyond them.

### 5.5 Expected outcome
`gc0_per_frame` should fall roughly in proportion to the masks' share. Compare with the `--alloc-trace` output from Phase 0. `postprocess_ms` and `publish_ms` / WebSocket send time should also drop.

---

## 6. Phase 3: Preallocated depth input buffers

Goal: remove three full-frame host allocations per frame (`img.copy()`, the BGR→RGB `.copy()`, the pageable staging) and make the H2D copy asynchronous on the depth stream.

### 6.1 `DepthEstimator` (`app/services/depth.py`)
- Add a cache keyed by `(height, width)`:
  - a pinned host tensor `torch.empty((h, w, 3), dtype=torch.uint8, pin_memory=True)`;
  - a device tensor `torch.empty((h, w, 3), dtype=torch.uint8, device=self._device)`.
- Reallocate only when the shape changes, the same way `DepthOnlyPath` caches geometry. On CPU devices, skip pinning (`pin_memory` requires CUDA).
- In `_infer`, inside the existing stream context:
  ```python
  host = self._host_buffer(h, w)                 # pinned, reused
  host.numpy()[...] = frame                       # single memcpy from the BGR ndarray
  dev = self._device_buffer(h, w)
  dev.copy_(host, non_blocking=True)              # async H2D on self._stream
  rgb = dev.permute(2, 0, 1).flip(0)              # BGR→RGB on GPU (CHW)
  ```
  The flip produces a new GPU tensor through the CUDA caching allocator, which is fine. Downstream (`DepthOnlyPath.__call__`, `self._model.infer`) receives the same CHW uint8 RGB tensor as today.
- Reusing the pinned buffer is safe because `_infer` already ends with `self._stream.synchronize()`, and `make_depth_executor` uses `max_workers=1`. Keep both invariants, and document that with a comment.
- `warmup()` calls `_infer` twice (optimized and `reference=True`) and compares with `assert_close`. That must still pass, and the log line `UniDepth depth-only validation passed` is the equality check for this phase.

### 6.2 Remove `depth_input = img.copy()` in `run_yolo`
`img` is read concurrently by the UniDepth thread and by Ultralytics. Without the copy, this is safe **only if neither mutates it**:
- `DepthEstimator._infer` will only read it (copy into the pinned buffer).
- Ultralytics: inspect `.ultralytics-custom` `BasePredictor.preprocess` / `pre_transform` / `LetterBox`. Stock Ultralytics allocates new arrays (`cv2.resize`, `np.stack`, `[..., ::-1]` + `np.ascontiguousarray`). However, when no resize is needed, `LetterBox` may return the input unchanged, so verify that the subsequent step copies before any in-place op. The fork may differ, so read its code; don't assume.
- Also check the TensorRT `.engine` path (`AutoBackend`), since production uses `.engine`.
- Add a unit test that checks the array passed to the model and depth stubs is unchanged after `run_yolo` (for example via a checksum).
- If you can't prove it, keep the copy and say so in the commit.

### 6.3 Out of scope
- `masked_median_distances` allocates small GPU tensors for each detection, which the CUDA caching allocator handles; it is not Python GC.
- Ultralytics internals (Results, Boxes, Masks, STrack objects; kwarg merging on each `model.track()` call). Reconsider only if `--alloc-trace` after Phase 2 shows they dominate.

---

## 7. Tests

The suite is `services/vision/tests` (unittest-style, runnable with pytest). It imports `av`, `ultralytics` (the custom fork), FastAPI and so on.

On this macOS dev machine there is **no `uv`, and the system Python lacks `av`/`ultralytics`**, so the suite cannot run locally as-is. Don't install packages or create venvs without asking the user. Run the suite on the GPU host, or wherever `uv sync --locked` with `.ultralytics-custom` is set up (see `BENCHMARK_YOLO.md`):
```bash
cd services/vision && uv run python -m pytest tests -q
```

Tests to add or update:
- **gc_stats**: feed synthetic `("start", {})`/`("stop", {"generation": 2, "collected": 5, "uncollectable": 0})` calls and check the counts, total, max and the max reset; `install()` is idempotent. `_gc_report` formatting, including `inferred_delta == 0` → `n/a`.
- **Phase 1**: the freeze helper calls `gc.collect` then `gc.freeze` (patch the `gc` module); the threshold setting is applied only when set.
- **Phase 2**:
  - `_frame_message` with numpy masks: `orjson.loads(payload)` equals the result of the old `json.dumps` with masks converted by `tolist()`, using `math.isclose` per coordinate, since float32 repr differs.
  - `run_yolo` emits ndarray masks with `mask_count` unchanged.
  - The single-transfer box path gives identical bbox/conf/cls/track_id to the old path for tensor inputs, with and without `boxes.id`.
  - The held-items cache returns the same list object for repeated skipped frames from one result and recomputes for a new result.
  - Update existing assertions that compare `detection["mask"]` to a list.
- **Phase 3**: the `img` immutability test; the shape-change path reallocates buffers; the CPU device path doesn't pin.

---

## 8. Verification and acceptance

For each phase, on the RTX 3090 host:
1. `benchmark_yolo.py --image <real frame> --gc enabled --iterations 500` before and after: compare p50/p99/max, gc0/gc2, total GC ms and max pause.
2. `benchmark_pipeline.py` soak (≥10 min) before and after: compare the `[gc]` line (`gc_pct`, `gc_max_ms`, `gc2`, `gc0_per_frame`) and the `[mem]` line (p99 `worker_cycle_ms`, `postprocess_ms`, `publish_ms`, `depth_ms`, `infer_fps`, dropped counts).
3. Phase 2: open Live View and confirm masks, boxes, labels and distances render identically.
4. Phase 3: the warmup log shows `UniDepth depth-only validation passed`, and `depth_ms` does not regress.

Acceptance:
- p99 frame time and `gc_max_ms` are lower.
- There are no functional changes in Live View output or recorded detections.
- All tests pass.

Report honestly: if a GPU measurement could not be run, say so in the commit and summary rather than claiming verification (AGENTS.md).

---

## 9. Commits and deployment

- Use one commit per phase, style `perf(vision): ...`, matching history (e.g. `1ceb368 perf(vision): bound inference work and reduce allocations`).
- The body states the measured before/after numbers, which checks were actually run, and which were not. The Phase 2 commit must describe the `orjson` dependency change and the lock check (AGENTS.md "Vision dependencies").
- Deployment: before giving restart instructions, inspect the vision service's `build`, `volumes` and `command` in `docker-compose.dev.yml` / `docker-compose.prod.yml`, and check whether the app code is baked into the image or bind-mounted:
  - Phase 2 adds a dependency, so the image must be **rebuilt**.
  - Code-only phases may need just `docker compose -f <file> up -d --no-deps --force-recreate <vision-service>` if the code is bind-mounted.
  - Afterwards, verify inside the running container (e.g. the `GC: froze N objects` log line and the presence of `[gc]` lines) before claiming it is deployed.
