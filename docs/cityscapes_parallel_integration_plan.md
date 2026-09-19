# Cityscapes Semantic + A4 Instance Integration Plan

**Status:** planning only. This document describes the integration work; it does not implement any backend or frontend changes.

## Goal

Run the existing A4 instance-segmentation model and a newly trained Cityscapes semantic-segmentation model on the same frame in parallel, then display both results together.

- A4 model: keeps per-object bounding boxes, instance masks, class labels, and tracking.
- Cityscapes model: supplies per-pixel semantic regions, initially `traffic sign` and `person`.
- Optional semantic class: `road`, enabled by adding it to the configured class list.
- Inference size: `640`, matching the deployed backend.
- Target hardware: RTX 3090, TensorRT FP16 engines.

The Cityscapes semantic model does not produce individual traffic-sign boxes or tracks. Its traffic-sign output is a class-colored region. Individual-object behavior continues to come from the A4 instance model.

## Current and target behavior

| Area | Current backend | Target dual-model backend |
|---|---|---|
| Models loaded | One instance model | One instance model plus one semantic model |
| Instance output | Boxes, masks, labels, tracks | Unchanged |
| Semantic output | None | Selected Cityscapes class regions |
| Scheduling | One inference path | Two model branches launched for the same frame |
| WebSocket payload | `inference.items` | Existing `items` plus `inference.semantic` |
| Browser overlay | Instance masks and boxes | Semantic overlay first, instance masks/boxes on top |
| Tracking | Instance tracker | Instance tracker only; semantic branch is stateless |

## Per-frame execution flow

```text
capture frame
    |
resize once to the backend's 640 limit
    |
    +------------------------------+
    |                              |
    v                              v
A4 instance branch             Cityscapes semantic branch
track(... persist=True)        predict(...)
boxes + masks + tracks         selected class masks/regions
    |                              |
    +--------------+---------------+
                   v
        join by epoch and frame sequence
                   |
       publish one combined inference result
                   |
      semantic overlay -> instance overlay
```

The two futures/tasks must be submitted before either result is awaited. This allows the branches to overlap when the GPU runtime and CUDA contexts permit it. The frame sequence and epoch are copied into both branch requests so a result from one frame cannot be combined with another frame.

## Parallel execution design

### Model ownership

Load separate model objects and separate inference contexts:

1. The instance worker owns the A4 model and its tracker state.
2. The semantic worker owns the Cityscapes model and has no tracker state.
3. Do not call both branches through the same `YOLO` predictor object.
4. For TensorRT, use separate execution contexts/streams where supported by the backend.

A persistent two-worker executor should be created once when the YOLO worker starts. It must not create or load models for every frame.

### Scheduling rules

1. Preserve the current latest-frame queue behavior: frames dropped before dispatch are dropped as a pair.
2. Submit the same resized frame, epoch, and sequence number to both branches.
3. Wait for both branch results before publishing the frame.
4. Merge only results with identical epoch and sequence values.
5. Keep the existing instance tracking calls in order; do not process instance frames concurrently with each other.
6. Do not publish a partial result with a semantic mask from one frame and instance detections from another.

The first version should share the backend's common frame resize. Each model predictor may still perform its own model-specific letterboxing and normalization because TensorRT and PyTorch predictors can have different preprocessing requirements. Any additional shared preprocessing should be added only after measurement confirms it is safe and useful.

### Error behavior

The existing retry and worker-fault policy remains the owner of recovery. If either branch fails for a dispatched frame, discard that combined frame and apply the existing retry behavior. Do not silently publish a mismatched or partially merged frame.

Instance-only operation remains available when no semantic model path is configured. When a semantic model is configured, startup should validate that it loads as a semantic model before accepting frames.

## Configuration

Add the following deployment settings while keeping the current instance settings unchanged:

| Setting | Proposed value/meaning |
|---|---|
| `YOLO_MODEL` | Existing A4 instance TensorRT engine or `.pt` model |
| `YOLO_SEMANTIC_MODEL` | Cityscapes semantic TensorRT FP16 engine |
| `YOLO_SEMANTIC_CLASSES` | Default: `traffic sign,person` |
| `YOLO_MAX_IMGSZ` | `640` |
| `YOLO_HALF` | `true` for compatible non-engine paths |
| `YOLO_RETINA_MASKS` | Preserve the current instance setting |

To include road regions, configure `YOLO_SEMANTIC_CLASSES` as `traffic sign,person,road`. Class names should be resolved from the semantic model's dataset metadata rather than assuming that Cityscapes class IDs match COCO IDs.

## Backend integration points

### `app/core/settings.py`

- Add the semantic model path and selected semantic class configuration.
- Keep the existing A4 model setting as the instance model setting.
- Keep `640` as the deployment input size.

### `app/core/state.py`

- Store the semantic model alongside the existing instance model, or store a small dual-model runner owned by the YOLO worker.
- Do not put tracker state on the semantic branch.

### `app/services/yolo.py`

- Extend model loading to validate the two model tasks separately: instance `segment`, semantic `semantic`.
- Keep the current instance serialization and tracking path intact.
- Add a semantic branch that converts the selected semantic class IDs into normalized regions suitable for the browser.
- Add a persistent two-branch executor/runner.
- Resize the source frame once before dispatch.
- Join branch results by epoch and sequence before returning the combined result.
- Preserve the current timing fields, adding separate instance, semantic, and combined timings for diagnosis.

Semantic output should be filtered before serialization. Do not send a full dense `H x W` class tensor through the WebSocket. For the current browser overlay, serialize selected class regions as normalized polygons, allowing multiple disconnected regions per class.

### `app/api/playback.py`

Extend the inference payload without changing existing instance fields:

```json
{
  "duration_ms": 0.0,
  "items": [],
  "semantic": {
    "enabled": true,
    "classes": [
      {
        "class_id": 7,
        "name": "traffic sign",
        "regions": [
          [[0.10, 0.20], [0.12, 0.20], [0.12, 0.24]]
        ]
      }
    ]
  },
  "monocular": {}
}
```

Coordinates are normalized to `[0, 1]`, matching the existing instance overlay convention. `items` remains the source for boxes, instance masks, labels, and tracks.

### `index.html`

Update the existing overlay path in this order:

1. Draw selected semantic regions with a low-opacity class color.
2. Draw A4 instance masks.
3. Draw A4 boxes, labels, and track IDs.

This keeps person/road context visible while preserving the sharper object-level A4 display. The semantic person region should not replace the instance person mask; it is an additional background/context layer.

## TensorRT and performance validation

The RTX 3090 FP16 estimate must be measured with the actual exported engines. Same-GPU parallel execution is not guaranteed to reduce latency because kernels can contend for the same GPU resources.

Measure these cases at `640` after warmup:

1. A4 instance engine alone.
2. Cityscapes semantic engine alone.
3. Both branches launched through the parallel runner.
4. Both branches run sequentially as a diagnostic comparison.

Record:

- p50 and p95 end-to-end latency;
- instance branch latency;
- semantic branch latency;
- merge/serialization latency;
- achieved FPS and dropped-frame count;
- GPU memory usage;
- whether the two branches actually overlap on the RTX 3090.

The expected parallel latency is approximately:

```text
max(instance_latency, semantic_latency) + merge_overhead
```

when GPU work overlaps. If the measured result is close to the sum of both branch latencies, the implementation is functionally parallel but GPU execution is effectively serialized. That result should be reported rather than hidden; a later optimization can evaluate separate CUDA streams, TensorRT contexts, or a different scheduling policy.

## Verification plan

Use the existing backend tests and add only focused coverage for the new owner path:

- model loading accepts the instance-plus-semantic pair and rejects an incorrect semantic task;
- both branches receive the same frame sequence and epoch;
- the merged payload contains both `items` and `semantic` data;
- semantic class filtering defaults to `traffic sign` and `person`;
- adding `road` produces road regions without changing instance results;
- instance tracking remains ordered and stable;
- a failed branch does not produce a mismatched partial frame;
- instance-only mode still behaves exactly as before;
- a short prerecorded-video smoke test displays semantic regions beneath instance boxes/masks;
- the benchmark reports separate and combined timings.

## Acceptance criteria

The integration is complete when:

- A4 boxes, instance masks, labels, and tracks remain unchanged.
- Cityscapes `traffic sign` and `person` semantic regions are visible by default.
- `road` can be enabled through configuration without code changes.
- The two models are dispatched concurrently for the same frame.
- No cross-frame semantic/instance mismatches occur under frame dropping.
- The WebSocket and browser overlay remain backward-compatible with instance-only mode.
- RTX 3090 FP16 measurements document whether concurrent execution improves total latency.

## Explicit non-goals

- No retraining or model-architecture change is part of this integration plan.
- No traffic-sign instance boxes or tracking are inferred from the Cityscapes semantic labels.
- No replacement of the A4 instance model with the semantic model.
- No implementation changes are made by this planning document.
