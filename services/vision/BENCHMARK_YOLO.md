# YOLO throughput benchmark

Run from this directory on the RTX 3090 host. The benchmark accepts both the
legacy `.pt` path and the native `.engine` path. For the production path,
build the engine first as described in [TENSORRT_LINUX.md](TENSORRT_LINUX.md),
then benchmark the engine:

```bash
export YOLO_MODEL=/opt/p4/models/yolo26s-seg.engine
export YOLO_DEVICE=cuda:0
export YOLO_HALF=true

.venv/bin/python benchmark_yolo.py \
  --model "$YOLO_MODEL" \
  --device "$YOLO_DEVICE" \
  --imgsz 640 \
  --width 1280 \
  --height 720 \
  --warmup 30 \
  --iterations 200
```

For a `.engine`, the report separates:

| Measurement | Includes | Use it to identify |
|---|---|---|
| PyAV conversion | `VideoFrame.to_ndarray()` | Decode/frame conversion overhead |
| Native TensorRT path | PyAV conversion, fixed-shape preprocessing, H2D, TensorRT enqueue, GPU NMS/masks, compact D2H, ByteTrack, JSON-ready output | Real single-frame inference throughput |
| Stage timings | `decode`, `preprocess`, `h2d`, `trt_enqueue`, `gpu_postprocess`, `compact_d2h`, `polygon_serialization`, `postprocess_tracking` | The native path bottleneck |

For a `.pt`, the report additionally separates direct PyTorch forward,
Ultralytics predict, and the exact `run_yolo` path.

The target is 30 FPS, or 33.33 ms per frame. Interpret the results in order:

1. Native TensorRT below 30 FPS: use the stage timings to identify whether
   PyAV/preprocessing, device copies, TensorRT, or CPU postprocessing is slow.
2. Native TensorRT above 30 FPS while the live queue grows: inspect relay
   input rate, WebSocket delivery, and browser pacing.
3. For `.pt`, direct forward below 30 FPS: the model/GPU workload is too slow.
   Export/build the fixed 640x640 FP16 engine or reduce the model size.
4. For `.pt`, direct forward above 30 FPS but Ultralytics predict below 30 FPS:
   preprocessing/postprocessing is the bottleneck.
5. For `.pt`, predict above 30 FPS but exact `run_yolo` below 30 FPS: PyAV
   conversion or detection/mask serialization is the bottleneck.

Always discard the first warmup iterations. CUDA timings are synchronized by
the script; without synchronization, asynchronous kernel launches make the
GPU appear faster than the live worker really is.
