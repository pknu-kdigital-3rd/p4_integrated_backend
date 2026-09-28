# Depth inference optimization

## Plan

1. Preserve the pinned UniDepth model, resolution, calibrated geometry, and fresh per-frame depth.
2. Cache camera rays for the current input size, calibration, and resolution only.
3. Compile a tensor-only depth result so unused output branches can be eliminated; resize only depth.
4. Put uploads, inference, and output conversion on the depth CUDA stream.
5. Compare against upstream inference during GPU startup, falling back if equivalence fails.

## Verification

Local checks cover syntax and diff integrity, not GPU correctness or performance.
Startup checks a deterministic nonuniform image against upstream inference.
Compare steady-state `depth_ms`, `model_ms`, `worker_cycle_ms`, and `infer_fps`
on the same live feed after warmup. Matching segmentation latency is the target,
not a measured guarantee. No dependency image rebuild is required.

The adapter uses helpers from the pinned UniDepth source revision recorded in
`depth.py`; upstream geometry and interpolation rules remain authoritative.

## Deployment

For the development Compose stack, the Vision source directory is bind mounted.
After updating the checkout, run from the repository root:

```sh
docker compose -f docker-compose.dev.yml restart p4-vision
docker compose -f docker-compose.dev.yml logs -f p4-vision
```

Wait for `UniDepth depth-only validation passed` and warmup completion. The new
compiled graph may require a first-start compilation. The check uses a 1% relative
plus 0.01 metre absolute tolerance on a synthetic image; it is a regression guard,
not a dataset accuracy evaluation. A validation failure logs the upstream fallback.
Production without a source bind mount requires rebuilding the Vision app image.
