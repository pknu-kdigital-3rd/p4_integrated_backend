# YOLO throughput benchmark

Run from this directory on the RTX 3090 host:

```bash
export YOLO_MODEL=yolo26s-seg.pt
export YOLO_DEVICE=cuda:0
export YOLO_HALF=true

.venv/bin/python benchmark_yolo.py \
  --model "$YOLO_MODEL" \
  --device "$YOLO_DEVICE" \
  --imgsz 704 \
  --width 1280 \
  --height 720 \
  --warmup 30 \
  --iterations 200
```

The report separates:

| Measurement | Includes | Use it to identify |
|---|---|---|
| Direct model forward | Only neural-network kernels on the GPU | GPU/model limit |
| Ultralytics predict | Ultralytics preprocessing, forward, NMS, masks, result creation | Ultralytics CPU/GPU overhead |
| PyAV conversion | `VideoFrame.to_ndarray()` | Decode/frame conversion overhead |
| Exact `run_yolo` path | The production worker path | Real single-frame inference throughput |

The target is 30 FPS, or 33.33 ms per frame. Interpret the results in order:

1. Direct forward below 30 FPS: the model/GPU workload is too slow. Try
   `--imgsz 640`, then `512`, or use an optimized exported engine.
2. Direct forward above 30 FPS but Ultralytics predict below 30 FPS:
   preprocessing/postprocessing is the bottleneck.
3. Predict above 30 FPS but exact `run_yolo` below 30 FPS: PyAV conversion or
   detection/mask serialization is the bottleneck.
4. Exact path above 30 FPS while the live queue grows: inspect relay input
   rate, WebSocket delivery, and browser presentation rather than the GPU.

Always discard the first warmup iterations. CUDA timings are synchronized by
the script; without synchronization, asynchronous kernel launches make the
GPU appear faster than the live worker really is.
