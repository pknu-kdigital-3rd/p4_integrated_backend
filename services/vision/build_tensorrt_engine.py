"""Build a deployment-specific TensorRT segmentation engine and manifest.

The command is intended to run on the Linux deployment GPU, for example::

    uv run python build_tensorrt_engine.py \
        --model yolo26s-seg.pt \
        --output /opt/p4/models/yolo26s-seg.engine \
        --device cuda:0

TensorRT plans are hardware/runtime specific. Build them on the target
machine (or on a machine with the same GPU and compatible TensorRT runtime)
and deploy the generated ``.engine`` together with its
``.engine.manifest.json`` sidecar.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ultralytics import YOLO

from app.services.tensorrt_runtime import unwrap_ultralytics_engine


def _device_for_export(device: str) -> int | str:
    if device.startswith("cuda:"):
        return int(device.split(":", 1)[1] or 0)
    if device == "cuda":
        return 0
    return device


def _names(value: Any) -> dict[str, str] | list[str]:
    if isinstance(value, dict):
        return {str(key): str(name) for key, name in value.items()}
    return [str(name) for name in value]


def _inspect_engine(
    engine_path: Path, class_count: int, model_version: str, args: argparse.Namespace
) -> dict[str, Any]:
    try:
        import numpy as np
        import tensorrt as trt
    except ImportError as exc:
        raise SystemExit(
            "engine inspection requires TensorRT; install the Linux TensorRT extra"
        ) from exc

    logger = trt.Logger(trt.Logger.WARNING)
    runtime = trt.Runtime(logger)
    engine_bytes = unwrap_ultralytics_engine(engine_path.read_bytes())
    engine = runtime.deserialize_cuda_engine(engine_bytes)
    if engine is None:
        raise SystemExit(
            f"TensorRT could not deserialize exported engine {engine_path}"
        )
    input_names: list[str] = []
    output_names: list[str] = []
    tensors: dict[str, dict[str, Any]] = {}
    for index in range(int(engine.num_io_tensors)):
        name = engine.get_tensor_name(index)
        shape = [int(value) for value in engine.get_tensor_shape(name)]
        dtype = np.dtype(trt.nptype(engine.get_tensor_dtype(name))).name
        tensors[name] = {"name": name, "shape": shape, "dtype": dtype}
        if engine.get_tensor_mode(name) == trt.TensorIOMode.INPUT:
            input_names.append(name)
        else:
            output_names.append(name)
    if len(input_names) != 1:
        raise SystemExit(f"expected one input tensor, found {input_names}")
    if len(output_names) < 2:
        raise SystemExit(
            "segmentation export must expose prediction and prototype outputs; "
            f"found {output_names}"
        )

    input_name = input_names[0]
    input_spec = tensors[input_name]
    input_shape = input_spec["shape"]
    if (
        len(input_shape) != 4
        or input_shape[:2] != [1, 3]
        or any(value <= 0 for value in input_shape)
    ):
        raise SystemExit(
            "the builder requires a static batch-1 NCHW input with three channels; "
            f"got {input_shape}"
        )
    if input_shape[2:] != [640, 640]:
        raise SystemExit(
            "the native runtime requires a fixed 640x640 input; "
            f"export produced {input_shape[2:]}"
        )
    prototype_name = None
    prediction_name = None
    mask_dim = None
    for name in output_names:
        shape = tensors[name]["shape"]
        if len(shape) == 4 and shape[0] == 1:
            prototype_name = name
            candidate_dims = [shape[1], shape[-1]]
            candidates = [value for value in candidate_dims if 1 < value <= 256]
            mask_dim = min(candidates) if candidates else None
        elif len(shape) == 3 and prediction_name is None:
            prediction_name = name
    if prototype_name is None or prediction_name is None or mask_dim is None:
        raise SystemExit(
            "could not identify the segmentation prediction/prototype tensors; "
            f"outputs={tensors}"
        )
    prediction_shape = tensors[prediction_name]["shape"]
    prediction_channels = min(prediction_shape[1], prediction_shape[2])
    # YOLO26/end-to-end exports expose a fixed top-k tensor with
    # [x1,y1,x2,y2,confidence,class,mask_coefficients]. Older one-to-many
    # segmentation exports expose [xywh,class_scores,mask_coefficients].
    end2end = bool(getattr(args, "end2end", False))
    if not end2end and 300 in prediction_shape[1:] and prediction_channels >= 6:
        end2end = True
    expected_channels = (6 if end2end else 4 + class_count) + int(mask_dim)
    if prediction_channels < expected_channels:
        raise SystemExit(
            f"prediction tensor {prediction_name} has {prediction_channels} channels, "
            f"but manifest expects at least {expected_channels}"
        )

    outputs: dict[str, dict[str, Any]] = {}
    for name in output_names:
        spec = dict(tensors[name])
        spec["role"] = "prototypes" if name == prototype_name else "predictions"
        outputs[name] = spec
    return {
        "schema_version": 1,
        "model_version": model_version,
        "task": "segment",
        "engine": {
            "file": engine_path.name,
            "sha256": hashlib.sha256(engine_path.read_bytes()).hexdigest(),
            "tensorrt_version": getattr(trt, "__version__", "unknown"),
            "platform": platform.platform(),
        },
        "input": {
            "name": input_name,
            "shape": input_shape,
            "dtype": input_spec["dtype"],
            "color_order": "RGB",
            "scale": 1.0 / 255.0,
        },
        "outputs": outputs,
        "postprocess": {
            "decoder": "ultralytics-seg-v1",
            "layout": "end2end" if end2end else "raw",
            "prediction_output": prediction_name,
            "prototype_output": prototype_name,
            "box_format": "xyxy" if end2end else "xywh",
            # Ultralytics' exported Detect head already applies sigmoid to
            # class scores, so the runtime must not apply it a second time.
            "scores_activation": "identity",
            "box_offset": 0,
            "score_offset": 4 if end2end else None,
            "class_offset": 5 if end2end else 4,
            "mask_offset": 6 if end2end else 4 + class_count,
            "mask_dim": int(mask_dim),
            "apply_nms": not end2end,
            "confidence_threshold": args.confidence,
            "iou_threshold": args.iou,
            "mask_threshold": 0.5,
            "max_detections": args.max_detections,
        },
        "names": args.names,
        "created_utc": datetime.now(timezone.utc).isoformat(),
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model", required=True, help="Ultralytics segmentation checkpoint"
    )
    parser.add_argument("--output", required=True, help="destination .engine path")
    parser.add_argument("--device", default=os.getenv("YOLO_DEVICE", "cuda:0"))
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--confidence", type=float, default=0.1)
    parser.add_argument("--iou", type=float, default=0.7)
    parser.add_argument("--max-detections", type=int, default=300)
    parser.add_argument(
        "--force", action="store_true", help="replace existing output and manifest"
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    if args.imgsz != 640:
        raise SystemExit("the native runtime currently requires --imgsz 640")
    if not 0.0 <= args.confidence <= 1.0 or not 0.0 <= args.iou <= 1.0:
        raise SystemExit("--confidence and --iou must be between 0 and 1")
    if args.max_detections < 1:
        raise SystemExit("--max-detections must be positive")

    model_path = Path(args.model)
    output_path = Path(args.output)
    manifest_path = Path(str(output_path) + ".manifest.json")
    if output_path.exists() and not args.force:
        raise SystemExit(
            f"output already exists; pass --force to replace it: {output_path}"
        )
    if manifest_path.exists() and not args.force:
        raise SystemExit(
            f"manifest already exists; pass --force to replace it: {manifest_path}"
        )

    model = YOLO(str(model_path))
    if model.task != "segment":
        raise SystemExit(
            f"--model must be a segmentation checkpoint, got task={model.task!r}"
        )
    args.names = _names(model.names)
    model_version = model_path.stem
    print(
        f"exporting {model_path} -> TensorRT FP16 engine "
        f"(device={args.device}, imgsz={args.imgsz}, batch=1)"
    )
    exported = model.export(
        format="engine",
        imgsz=args.imgsz,
        batch=1,
        dynamic=False,
        half=True,
        nms=False,
        device=_device_for_export(args.device),
        verbose=True,
    )
    exported_path = Path(str(exported))
    if not exported_path.is_file():
        raise SystemExit(
            f"Ultralytics export did not produce an engine: {exported_path}"
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if exported_path.resolve() != output_path.resolve():
        shutil.copy2(exported_path, output_path)
    # Ultralytics prepends its metadata to the serialized plan. Keep the
    # deployment artifact as a native TensorRT plan so both this inspector and
    # the in-process runtime can pass the plan header at byte zero.
    raw_engine = output_path.read_bytes()
    unwrapped_engine = unwrap_ultralytics_engine(raw_engine)
    if unwrapped_engine != raw_engine:
        output_path.write_bytes(unwrapped_engine)
        print("removed Ultralytics metadata prefix from the TensorRT plan")
    manifest = _inspect_engine(output_path, len(args.names), model_version, args)
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"engine={output_path}")
    print(f"manifest={manifest_path}")
    print(f"sha256={manifest['engine']['sha256']}")


if __name__ == "__main__":
    main()
