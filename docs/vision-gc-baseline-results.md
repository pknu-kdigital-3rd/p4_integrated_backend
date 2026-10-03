# Vision GC baseline — 2026-10-03

Source artifacts supplied by the user: `E:/project4/benchmark_results/`:
`baseline-yolo.log`, `baseline-pipeline.log`, and `baseline-pipeline.csv`.
The logs report successful completion of both benchmarks. These GPU operations
were performed on the remote server, not rerun on the local developer machine.
The source files do not include a Git revision or engine/input hashes, so the
exact benchmark checkout and input identity cannot be established from them.

## Workload

- GPU: NVIDIA RTX 6000 Ada Generation, host GPU 3, mapped to `cuda:0`.
- Engine: `yolo26m-seg-320.engine`, FP16.
- Input image and video: 1280x720. Video reports 29.968 FPS; offered rate 30 FPS.
- Pipeline inference size: explicit `320x320`; logged maximum imgsz is 640.
  The isolated YOLO command uses `--imgsz 320`.
- Retina masks enabled; contour size 640; queue size 1; latest-frame policy.
- UniDepth resolution level 2, on the same GPU as YOLO.
- UniDepth warmup logs `depth-only validation passed (rtol=0.01, atol=0.01m)`
  and `mode=compiled` in both runs; startup warmup took 6.6 seconds.

## Isolated YOLO benchmark

Thirty warmup calls and 500 timed calls with enabled GC:

- Exact production inference path: 58.51 FPS; mean 17.09 ms.
- Per-call latency: p50 16.904 ms, p99 19.687 ms, maximum 20.946 ms.
- Ultralytics predict: 296.51 FPS, 3.37 ms wall time.
- GC: one gen0 collection; zero gen1 and gen2 collections.
- Total and maximum GC pause: 0.063452 ms.
- Gen0 collections per inferred frame: 0.002.
- Tracked objects at timing start: 703,944; frozen objects: 375.
- Thresholds: `(700, 10, 10)`.
- Separate 100-call allocation trace: traced peak 1.010 MiB. The printed
  differences measure net retention, not total allocation churn.

No frozen-mode or elevated-threshold comparison logs were supplied.

## Pipeline soak

CSV totals and inference-count-weighted stage means for a 2400-second run:

- Input and published frames: 72,000 each, approximately 30 FPS.
- Inferred frames: 71,990; skipped inference: 10 frames (0.01389%).
- Maximum observed queue size: 1/1.
- GC counts: gen0 278, gen1 25, gen2 0.
- Total GC time: 184.701955 ms, approximately 0.007696% of wall time.
- Maximum single GC pause: 3.274875 ms.
- Gen0 collections per inferred frame: 0.003862.
- Collected objects: 182,069; uncollectable objects: zero.
- Mean worker cycle: 22.815 ms; model: 12.123 ms; depth: 13.119 ms;
  frame conversion: 5.281 ms; postprocessing: 2.569 ms; publication: 0.097 ms.
  YOLO and depth execute concurrently, so these stages are not additive.
- RSS: 2841.0 MiB at the first sample, 2863.1 MiB at the final sample and peak.
- CUDA reserved memory: 858.0 MiB initially, 912.0 MiB finally and at peak.

The final two CSV samples both round to elapsed time 2400.0 seconds. The last
sample has no new inferred frames and reports 106.13% GC over a very short
reporting interval. That value does not describe the soak's GC share. The
aggregate above sums all recorded GC time and divides by the full duration;
the maximum GC percentage among intervals with input frames is 0.06547%.

CSV worker/stage timings are interval means. Their percentiles would not be
per-frame latency percentiles; pipeline per-frame p99 is unavailable here.
The harness acknowledges results without a real relay, WebSocket or browser,
so publication throughput does not verify Live View delivery or rendering.

## Decision

Proceed to Phase 1 to evaluate frame latency under denser mask workloads, as
requested after reviewing this baseline. The low average GC share does not
establish an acceptable maximum pause: the observed 3.275 ms pause consumes
9.8% of a 33.33 ms frame budget. The user reports more severe scenes with more
masks than this benchmark, so the earlier decision to stop was too broad.

Phase 1 freezes startup and lazily initialized model state and exposes an
optional gen0 threshold override. Freeze targets full-heap collection scans;
the observed pauses were gen0/gen1, with no gen2 collection. Do not assume
freezing alone removes these observed pauses. Keep the default threshold and
compare explicit overrides on dense input before selecting a production value.
Phase 1 after-change GPU measurements are pending; no improvement has yet
been demonstrated. Phases 2–3 remain gated on those measurements.

These results apply to the measured 720p input, 320x320 inference and RTX 6000
Ada configuration. They do not establish performance for 1080p/640 inference,
an RTX 3090, denser detections, a live browser backlog or longer lifetimes.
No gen2 collection was observed, so full-collection pause duration remains
unmeasured. If the live service shows stalls, capture its existing `[mem]` and
`[gc]` lines during the stall before choosing an optimization phase.
