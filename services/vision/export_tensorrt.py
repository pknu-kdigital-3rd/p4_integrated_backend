"""Export a custom Ultralytics segmentation checkpoint to a TensorRT engine.

Run this from ``services/vision`` with the project's environment, for example::

    uv run python export_tensorrt.py --model models/a4_best.pt

TensorRT engines are compiled for the GPU and TensorRT runtime used during the
export. Build the engine on the deployment machine (or a compatible GPU), then
place the resulting ``.engine`` file in ``models``.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path


VISION_ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = VISION_ROOT / "models" / "a4_best.pt"


def _parse_imgsz(value: str) -> int | tuple[int, int]:
    value = value.strip().lower()
    if value.isdecimal():
        return int(value)
    parts = value.replace("x", ",").split(",")
    if len(parts) == 2 and all(part.strip().isdecimal() for part in parts):
        return int(parts[0]), int(parts[1])
    raise argparse.ArgumentTypeError(
        "imgsz must be an integer or HxW, for example 720x1280"
    )


def _default_imgsz() -> int | tuple[int, int]:
    configured = os.environ.get("YOLO_INFERENCE_SIZE", "").strip().lower()
    if configured in {"", "auto", "source", "original"}:
        configured = os.environ.get("YOLO_MAX_IMGSZ", "640")
    return _parse_imgsz(configured)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export a custom Ultralytics segmentation checkpoint to TensorRT."
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=DEFAULT_MODEL,
        help=f"input PyTorch checkpoint (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="engine output path (default: same directory and stem as --model)",
    )
    parser.add_argument(
        "--device",
        default=os.environ.get("YOLO_EXPORT_DEVICE", os.environ.get("YOLO_DEVICE", "0")),
        help="CUDA device used for export, for example 0 or cuda:0 (default: %(default)s)",
    )
    parser.add_argument(
        "--imgsz",
        type=_parse_imgsz,
        default=_default_imgsz(),
        help="fixed engine input size, integer or HxW (default: %(default)s)",
    )
    parser.add_argument(
        "--batch",
        type=int,
        default=1,
        help="maximum engine batch size (default: %(default)s)",
    )
    parser.add_argument(
        "--workspace",
        type=float,
        default=4.0,
        help="TensorRT builder workspace in GiB (default: %(default)s)",
    )
    parser.add_argument(
        "--precision",
        choices=("fp16", "fp32"),
        default="fp16",
        help="engine precision (default: %(default)s)",
    )
    parser.add_argument(
        "--dynamic",
        action="store_true",
        help="build dynamic input shapes instead of the fixed deployment shape",
    )
    parser.add_argument(
        "--keep-onnx",
        action="store_true",
        help="keep the intermediate ONNX file next to the checkpoint",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="overwrite an existing engine and intermediate ONNX file",
    )
    return parser.parse_args()


def _cuda_device_index(device: str) -> int | None:
    value = device.strip().lower()
    if value == "cuda":
        return 0
    if value.startswith("cuda:"):
        value = value.split(":", 1)[1]
    if value.isdecimal():
        return int(value)
    return None


def _check_runtime(device: str) -> None:
    try:
        import torch
    except ImportError as exc:  # pragma: no cover - environment diagnostic
        raise SystemExit("PyTorch is not installed in this environment; run `uv sync --locked` first.") from exc

    if not torch.cuda.is_available():
        raise SystemExit(
            "CUDA is not available. TensorRT export must run on a machine with an NVIDIA GPU "
            "and a CUDA-enabled PyTorch installation."
        )

    index = _cuda_device_index(device)
    if index is not None and index >= torch.cuda.device_count():
        raise SystemExit(
            f"CUDA device {device!r} is unavailable; this host exposes "
            f"{torch.cuda.device_count()} GPU(s)."
        )

    try:
        import tensorrt as trt
    except ImportError as exc:  # pragma: no cover - environment diagnostic
        raise SystemExit(
            "The TensorRT Python bindings are not installed. Install a TensorRT package "
            "compatible with this CUDA/driver environment, then rerun this command."
        ) from exc

    print(f"CUDA device: {device} ({torch.cuda.get_device_name(index or 0)})")
    print(f"TensorRT: {trt.__version__}")


def main() -> int:
    args = _parse_args()
    model_path = args.model.expanduser().resolve()
    if not model_path.is_file():
        raise SystemExit(f"model file does not exist: {model_path}")
    if model_path.suffix.lower() != ".pt":
        raise SystemExit(f"--model must be a .pt checkpoint: {model_path}")
    dimensions = (args.imgsz, args.imgsz) if isinstance(args.imgsz, int) else args.imgsz
    if any(dimension <= 0 or dimension > 4096 for dimension in dimensions):
        raise SystemExit("--imgsz dimensions must be between 1 and 4096")
    if args.batch < 1:
        raise SystemExit("--batch must be at least 1")
    if args.workspace <= 0:
        raise SystemExit("--workspace must be greater than zero")

    output_path = (
        args.output.expanduser().resolve()
        if args.output is not None
        else model_path.with_suffix(".engine")
    )
    generated_path = model_path.with_suffix(".engine")
    onnx_path = model_path.with_suffix(".onnx")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    existing_paths = [output_path, generated_path, onnx_path]
    if not args.force:
        existing = next((path for path in existing_paths if path.is_file()), None)
        if existing is not None:
            raise SystemExit(
                f"output already exists: {existing}. Use --force to replace it."
            )

    _check_runtime(args.device)

    try:
        from ultralytics import YOLO
        import ultralytics
    except ImportError as exc:  # pragma: no cover - environment diagnostic
        raise SystemExit(
            "Ultralytics is not installed. Run this command from services/vision "
            "with `uv sync --locked`."
        ) from exc

    print(f"Ultralytics: {ultralytics.__file__}")
    model = YOLO(str(model_path))
    if getattr(model, "task", None) != "segment":
        raise SystemExit(
            f"The checkpoint task is {getattr(model, 'task', None)!r}; "
            "the Vision service requires a segmentation checkpoint."
        )

    # The custom fork used by this project names export precision `quantize`:
    # 16 requests FP16 and an omitted value leaves the engine in FP32.
    export_kwargs = {
        "format": "engine",
        "imgsz": args.imgsz,
        "batch": args.batch,
        "device": args.device,
        "workspace": args.workspace,
        "dynamic": args.dynamic,
        "simplify": True,
    }
    if args.precision == "fp16":
        export_kwargs["quantize"] = 16

    print(f"Exporting {model_path} -> {output_path}")
    exported = Path(model.export(**export_kwargs)).expanduser().resolve()
    if not exported.is_file():
        raise SystemExit(f"Ultralytics reported an invalid engine path: {exported}")

    if output_path != exported:
        if output_path.exists():
            if not args.force:
                raise SystemExit(f"output already exists: {output_path}")
            output_path.unlink()
        shutil.move(str(exported), str(output_path))

    if not args.keep_onnx and onnx_path.is_file():
        onnx_path.unlink()

    print(f"TensorRT engine ready: {output_path}")
    print("Set YOLO_MODEL to this .engine file or use the Compose default path.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
