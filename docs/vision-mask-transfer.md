# Compact GPU mask transfer (Option A)

Vision now packs binary masks on their inference device before transferring
them to the host. The default is `YOLO_MASK_TRANSFER=packed`; `legacy` selects
the previous uint8 transfer for comparisons. CPU inference uses the previous
path directly. Both Compose configurations pass this setting through, and
worker/benchmark logs report it.

The implemented path is:

```text
TensorRT CUDA outputs
  → existing GPU mask reconstruction and thresholding
  → retained-mask selection and existing contour-grid reduction
  → GPU bit-packing (one bit per pixel)
  → one packed copy to pinned host memory
  → wait for the copy's CUDA event
  → lossless CPU unpacking and existing Ultralytics contour extraction
  → existing polygon simplification / point cap
  → normalized polygons over the existing metadata protocol
```

For N binary masks of H×W pixels, the mask payload falls from N×H×W bytes to
ceil(N×H×W/8) bytes. For 100 masks at 640×360, this is 23,040,000 bytes versus
2,880,000 bytes. Byte reduction alone does not establish a latency improvement:
GPU packing and CPU unpacking have costs and must be measured on the target GPU.

Packing flattens all masks together, so arbitrary widths and instance boundaries
need only one final partial byte. It adds no contour approximation. Original
GPU masks remain available to UniDepth distance calculations. The installed
fork still handles disconnected components, external contours, letterbox
coordinates and polygon normalization.

Each inference thread reuses one pinned host buffer, replaced when payload size
changes. The copy follows packing on the current CUDA stream. Its completion
event is awaited before NumPy reads the buffer or another frame reuses it.
This is an asynchronous copy with an explicit consumption boundary; it does
not implement overlap between inference frames. No new dependencies or custom
CUDA extension are required.

GPU contour tracing, ROI compaction, RLE and reconstruction directly at a
smaller resolution are not part of this implementation. Full-frame retina
mask reconstruction and existing Ultralytics synchronization remain. CPU
contour extraction is retained deliberately to preserve geometry while
reducing data crossing the device boundary.

## Verify on the deployment GPU

From `services/vision`, run the CUDA regression test and isolated benchmark:

```bash
.venv/bin/python -m unittest tests.test_mask_transfer
.venv/bin/python benchmark_mask_transfer.py --device cuda:0 \
  --masks 100 --width 640 --height 360 --warmup 30 --iterations 200
```

The benchmark actually executes packing, host transfer, unpacking and contour
extraction. It asserts exact polygon equality against the legacy route before
reporting payload bytes and mean/p50/p99/max latency. Its synthetic masks cover
multiple components; use real dense-scene input for the complete pipeline:

```bash
YOLO_MASK_TRANSFER=legacy .venv/bin/python benchmark_yolo.py \
  --model "$YOLO_MODEL" --device cuda:0 --image /path/to/dense-frame.jpg \
  --imgsz 320 --width 1280 --height 720 --warmup 30 --iterations 500 --gc enabled
YOLO_MASK_TRANSFER=packed .venv/bin/python benchmark_yolo.py \
  --model "$YOLO_MODEL" --device cuda:0 --image /path/to/dense-frame.jpg \
  --imgsz 320 --width 1280 --height 720 --warmup 30 --iterations 500 --gc enabled
```

Use the same engine, input, inference size, contour size, depth settings and GC
settings in both runs. Repeat with low and high detection counts. Compare exact
worker latency, especially p99, rather than assuming less transfer means faster
processing. The existing pipeline soak can also be run with either transfer
setting; it reports interval means rather than per-frame p99.

## Local validation limitations

CPU tests exercise packing byte order, tail padding, noncontiguous tensors,
polygon equality, selected-mask ordering and contour-grid reduction. The local
Quadro P2200 (sm_61) is unsupported by the installed PyTorch CUDA build. CUDA
execution and pinned-buffer reuse therefore require the deployment GPU test;
no CUDA speedup or running deployment has been verified locally.

The targeted mask-transfer, YOLO and depth run passed 52 tests, with one CUDA
test skipped. A CPU benchmark smoke run also asserted exact polygon equality.
The playback suite could not import because this local environment lacks the
already-declared `orjson` dependency; it was not verified. No dependency or
lockfile changes were made.
