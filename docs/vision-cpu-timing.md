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
