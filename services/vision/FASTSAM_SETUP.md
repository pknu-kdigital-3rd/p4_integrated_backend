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
