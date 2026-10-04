# Independent UniDepth input resolution

`UNIDEPTH_INFERENCE_SIZE` selects the image grid supplied to UniDepth independently
of YOLO. Both models still infer the same frame concurrently.

- `yolo` (default): reuse YOLO's resized image and avoid a second conversion.
- `source`: use the decoded source image, independent of YOLO's input size.
- `HxW`, for example `180x320`: resize the decoded source to this depth grid.
  Each dimension must be between 32 and 4096. Height comes first.

Set the value in the Compose environment or `.env`:

```env
UNIDEPTH_INFERENCE_SIZE=180x320
```

The default preserves the previous behavior. Explicit grids resize the full
field of view without cropping; choose the source aspect ratio to avoid image
stretching. A larger depth input is resized from the decoded frame directly,
not from YOLO's smaller input. Camera focal lengths and principal point are
scaled independently in x and y to the depth image dimensions.

Depth warmup uses the selected input grid. With `source` or `yolo`, warmup uses
the calibration source dimensions to estimate the input grid, as before; a live
source with different dimensions can require an additional compilation.

The mask distance path resizes YOLO masks to the resulting depth map. The box
distance path scales box coordinates to that map. YOLO segmentation and overlay
resolution remain controlled by the YOLO settings. Use retina masks to obtain
masks in the YOLO image coordinate system, without letterbox padding.

`UNIDEPTH_RESOLUTION_LEVEL` still controls the model's internal inference pixel
budget. A smaller supplied image does not necessarily shrink its internal grid,
so benchmark model latency and object-distance quality before choosing a size.
Small and distant objects may have fewer depth samples at a smaller output grid.
`frame_convert_ms` includes preparation of both input images.

## Dev application and verification

Dev builds from `services/vision`, directory-mounts its app code, individually
mounts the unchanged entrypoint, and runs Uvicorn with reload. Recreate Vision
to apply the new environment setting; these changes do not require rebuilding
the dependency image:

```bash
docker compose -f docker-compose.dev.yml up -d --no-deps --force-recreate p4-vision
docker compose -f docker-compose.dev.yml exec -T p4-vision python -c "from app.core.settings import settings; print(settings.UNIDEPTH_INFERENCE_SIZE)"
docker compose -f docker-compose.dev.yml logs --tail 100 p4-vision
```

Verify the effective setting inside the container and the `UniDepth depth-only
warmup shape` log. Per-frame results report `depth.input_width` and
`depth.input_height`. Production bakes app files into the image and mounts models,
so rebuild the app image to include these changes.

Tests exercise size validation, warmup camera scaling, source/smaller/larger depth
grids, correct mask and box medians, and concurrent scheduling with test models.
Actual UniDepth/TensorRT CUDA execution, deployment, speedup and distance accuracy
on recorded scenes have not been verified locally; the local GPU is unsupported
by the locked PyTorch build. No dependencies or lockfiles were changed.
