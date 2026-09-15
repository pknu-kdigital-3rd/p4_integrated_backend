# FastSAM inference backend

The `fastsam` branch uses Ultralytics FastSAM for per-frame instance
segmentation. FastSAM-s is the default checkpoint; set `YOLO_MODEL=FastSAM-x.pt`
to use the larger checkpoint. The legacy `YOLO_*` setting names are retained
for compatibility with the existing relay and deployment environment.

```bash
cd /workspace/p4_integrated_backend/services/vision
uv sync
export YOLO_MODEL=FastSAM-s.pt
export YOLO_DEVICE=cuda:0
export YOLO_HALF=true
export FASTSAM_PROMPT=person
export FASTSAM_IOU=0.9
```

The first startup downloads the checkpoint if it is not already present. The
service passes each decoded frame to FastSAM with retina masks enabled and
returns the existing normalized box/polygon schema. When tracking is enabled,
Ultralytics' persistent tracker supplies `track_id` values.

FastSAM supports everything, box, point, and text prompts. This service uses the
configured `FASTSAM_PROMPT` text prompt (`person` by default); set it to an
empty value to expose the model's generic class label instead.

The Vision log reports timing values: `last` is the complete per-frame
pipeline, `input` is frame conversion/preparation, `model` is the wall-clock
duration of the Ultralytics call, and `gpu` is CUDA-event time for GPU work in
that call. `post` is result processing after Ultralytics returns; its `masks`
and `boxes` components measure polygon conversion and detection serialization.
A large gap between `model` and `gpu` indicates CPU preprocessing, prompt
filtering, or tracking overhead, while a large `post` value points to result
conversion overhead.
