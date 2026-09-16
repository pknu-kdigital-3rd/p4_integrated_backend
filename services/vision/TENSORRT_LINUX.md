# Native TensorRT on Linux

The vision service selects the native runtime when `YOLO_MODEL` ends in
`.engine`. A `.pt` model continues to use the existing Ultralytics/PyTorch
path. The native path is deliberately in-process so the Go relay, PyAV decode,
ordered worker, ByteTrack settings, and browser JSON contract do not change.

## Install

On the deployment host, use the project's Linux environment and verify the
NVIDIA driver/GPU first:

```bash
cd services/vision
uv sync
uv run python -c 'import torch, tensorrt; from cuda.bindings import runtime; print(torch.cuda.get_device_name(0)); print(tensorrt.__version__)'
```

The project declares `tensorrt-cu13` and `cuda-python` only for Linux. The
TensorRT plan must be built with a compatible TensorRT runtime on the target
GPU; do not copy a plan built for a different GPU family or incompatible
runtime.

## Build the fixed engine

Build once on the RTX 3090 host. The builder uses Ultralytics only as the
export front end; live inference does not instantiate `YOLO(engine)` or call
Ultralytics prediction. It emits the engine and a manifest containing the
actual tensor names, shapes, data types, segmentation decoder, thresholds, and
class names.

```bash
uv run python build_tensorrt_engine.py \
  --model yolo26s-seg.pt \
  --output /opt/p4/models/yolo26s-seg.engine \
  --device cuda:0 \
  --imgsz 640
```

This creates:

```text
/opt/p4/models/yolo26s-seg.engine
/opt/p4/models/yolo26s-seg.engine.manifest.json
```

The engine is static batch 1, FP16, RGB NCHW, and 640x640. The runtime
preallocates pinned host/device buffers and one CUDA stream, launches with
TensorRT `execute_async_v3`, then performs NumPy/OpenCV segmentation decode
and the existing ByteTrack association.

## Select it

Set these values in `deploy/env.local`:

```bash
export YOLO_MODEL="/opt/p4/models/yolo26s-seg.engine"
export YOLO_ENGINE_MANIFEST="/opt/p4/models/yolo26s-seg.engine.manifest.json"
export YOLO_DEVICE="cuda:0"
export YOLO_HALF="true"
```

The manifest path is optional when the conventional sidecar is beside the
engine. Startup fails clearly if the engine, manifest, TensorRT runtime, or
CUDA device is unavailable; there is no silent fallback from a configured
`.engine` to PyTorch.

## Measure it

```bash
uv run python benchmark_yolo.py \
  --model /opt/p4/models/yolo26s-seg.engine \
  --device cuda:0 \
  --imgsz 640 \
  --width 1280 \
  --height 720 \
  --warmup 30 \
  --iterations 200
```

The target for the current single-stream pipeline is 33.33 ms per completed
frame, including frame conversion and result handling. The benchmark prints
separate decode/preprocess, H2D, TensorRT dispatch, D2H synchronization, and
postprocess/tracking timings so a future GPU-decode phase can be justified by
measurement rather than added speculatively.
