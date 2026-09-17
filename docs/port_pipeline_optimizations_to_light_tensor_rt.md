# Port pipeline optimizations to light_tensor_rt

  ## Summary

  Port the implemented performance changes from the current branch onto light_tensor_rt as separate, reviewable stage
  commits. Preserve its TensorRT .engine loading behavior and wire format. Default to latest-frame inference and
  detail-first masks.

  ## Implementation changes

  1. Runtime and measurement baseline: retain the .engine guard that skips .to() and .fuse(); carry over the Linux
     Python 3.12/custom Ultralytics dependency and lockfile. Port Python and relay diagnostics so changes can be
     compared.

  2. Inference backpressure: add the bounded queue and configurable latest/queue policies. Default to latest with
     queue size 1; skipped inference frames still pass through playback with the last completed detections, and drops
     are counted.

  3. Frame preparation and detections: resize oversized PyAV frames before BGR materialization, map pixel boxes back
     to source dimensions, and batch detection-tensor CPU transfers.

  4. Segmentation masks: port mask-count logging, filtered mask extraction, device-side contour resizing, and optional
     polygon simplification. Default to retina_masks=true and contour size 640 for detail; keep the controls
     configurable.

  5. Compressed-frame and browser path: use memory views to reduce Python H.264 copies and Uint8Array.subarray() in
     the browser, preserving packet and playback behavior.

  6. Go relay: port bounded assembly-buffer reuse, immutable access-unit sharing, and scatter/gather writes. Keep
     ownership safe and the existing wire format unchanged.

  7. Configuration and runbook: carry over the relevant environment examples and benchmark guidance. Keep allocation
     profiling and pprof opt-in.

  The port should be applied stage by stage on top of light_tensor_rt, resolving vision-loader conflicts without
  dropping its TensorRT behavior. Do not port the Android buffer-pooling investigation, which is not implemented, or
  the standalone planning document.

  ## Tests and acceptance

  - Don't run actual test. just make it testable and writedown how to test it in the deploy server environment which is linux box with rtx3090 gpus

  - Make the vision test suite, including queue/drop behavior, frame resizing and box mapping, mask-to-box alignment,
    and model-loading tests. Add a loader test proving .engine models skip .to()/.fuse().

  - Make uv sync --locked on Linux with Python 3.12 and the configured custom Ultralytics checkout; run go test ./...
    in the media relay.

  - Make the smoke-test the actual TensorRT engine on the deployment GPU/runtime, then run a warmed, 10-minute 1080p30 overload
    benchmark. Confirm the queue stays within its configured bound, memory stabilizes, playback remains near real
    time, and boxes/masks/timestamps remain correct.

  - Make comparison before/after using the same engine, video, TensorRT environment, and mask settings; record stage timings
    and allocation/throughput results. Treat 30 FPS as the benchmark target, not a guarantee under the detail-first
    mask setting.

  ## Assumptions and defaults

  - Port scope includes the Linux vision service, Go relay, and browser client; no Android changes.
  - Latest-frame mode may skip tracker updates under overload; the finite ordered queue mode remains available through
    configuration.

  - Detail-first mask defaults are YOLO_RETINA_MASKS=true and YOLO_MASK_CONTOUR_SIZE=640; operators can lower these if
    latency takes priority.

  - The custom Ultralytics checkout remains available at the configured relative path on the Linux host. The port adds
    environment configuration, not changes to the video protocol or public payload schema.
