"""Measure YOLO throughput by pipeline stage.

Run from the ``server`` directory, for example::

    .venv/bin/python benchmark_yolo.py --device cuda:0

The benchmark deliberately synchronizes CUDA before reading wall-clock times.
Ultralytics' ``predict`` number includes its preprocessing, neural-network
forward pass, NMS/mask postprocessing, and result construction.  The direct
forward number isolates the model/GPU kernels.  ``run_yolo`` is the exact path
used by the live worker, including PyAV conversion and JSON-ready detection
extraction.
"""

from __future__ import annotations

import argparse
import gc
import os
from pathlib import Path
from time import perf_counter

import av
import numpy as np
import torch
from ultralytics import YOLO

from app.core.settings import settings
from app.core.state import InferenceFrame
from app.services.yolo import load_yolo_model, run_yolo


def _sync(device: str) -> None:
    if device.startswith("cuda"):
        torch.cuda.synchronize(device)


def _fps(seconds: float, iterations: int) -> float:
    return iterations / max(seconds, 1e-9)


def _measure_wall(fn, iterations: int, device: str) -> tuple[float, float]:
    _sync(device)
    started = perf_counter()
    for _ in range(iterations):
        fn()
    _sync(device)
    elapsed = perf_counter() - started
    return elapsed, _fps(elapsed, iterations)


def _measure_forward(net: torch.nn.Module, tensor: torch.Tensor, iterations: int, device: str) -> tuple[float, float, float]:
    # GPU event timing excludes Python loop overhead and reports the actual
    # kernel time. Wall timing is retained to expose synchronization/dispatch
    # overhead that a live single-frame worker also pays.
    for _ in range(5):
        with torch.inference_mode():
            net(tensor)
    _sync(device)

    started = perf_counter()
    if device.startswith("cuda"):
        event_start = torch.cuda.Event(enable_timing=True)
        event_end = torch.cuda.Event(enable_timing=True)
        event_start.record()
        with torch.inference_mode():
            for _ in range(iterations):
                net(tensor)
        event_end.record()
        _sync(device)
        gpu_ms = event_start.elapsed_time(event_end) / iterations
    else:
        with torch.inference_mode():
            for _ in range(iterations):
                net(tensor)
        gpu_ms = float("nan")
    elapsed = perf_counter() - started
    return elapsed, _fps(elapsed, iterations), gpu_ms


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=settings.YOLO_MODEL)
    parser.add_argument("--device", default=os.getenv("YOLO_DEVICE", "cuda:0"))
    parser.add_argument("--imgsz", type=int, default=int(os.getenv("YOLO_MAX_IMGSZ", "640")))
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--iterations", type=int, default=100)
    parser.add_argument("--precision", choices=("fp16", "fp32"), default="fp16")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    if args.iterations < 1 or args.warmup < 0:
        raise SystemExit("--iterations must be positive and --warmup cannot be negative")
    if args.imgsz <= 0 or args.imgsz % 32:
        raise SystemExit("--imgsz must be a positive multiple of 32")
    if args.device.startswith("cuda") and not torch.cuda.is_available():
        raise SystemExit("CUDA was requested but torch.cuda.is_available() is false")

    settings.YOLO_MODEL = args.model
    settings.YOLO_DEVICE = args.device
    settings.YOLO_MAX_IMGSZ = args.imgsz
    settings.YOLO_HALF = args.precision == "fp16"

    print(f"model={args.model}")
    print(f"device={args.device}")
    if args.device.startswith("cuda"):
        index = torch.device(args.device).index or 0
        print(f"gpu={torch.cuda.get_device_name(index)}")
    print(
        f"input={args.width}x{args.height}, imgsz={args.imgsz}, "
        f"precision={args.precision}, retina_masks={settings.YOLO_RETINA_MASKS}, "
        f"contour_size={settings.YOLO_MASK_CONTOUR_SIZE}"
    )

    model: YOLO = load_yolo_model()
    if model.task != "segment":
        raise SystemExit(f"expected a segmentation model, got task={model.task!r}")

    image = np.zeros((args.height, args.width, 3), dtype=np.uint8)
    frame = av.VideoFrame.from_ndarray(image, format="bgr24")
    inference_frame = InferenceFrame(
        epoch=1,
        seq=0,
        frame=frame,
        pts=0,
        time_base=1 / 90000,
        media_time=0.0,
        timestamp_us=0,
        keyframe=True,
    )
    quantize = 16 if args.precision == "fp16" and args.device.startswith("cuda") else 32

    print(f"warming up exact run_yolo path ({args.warmup} iterations)...")
    for warmup_index in range(args.warmup):
        inference_frame.seq = -warmup_index - 1
        run_yolo(inference_frame, model)
    _sync(args.device)

    # This is the public Ultralytics path used by run_yolo, but without PyAV
    # conversion or our result-to-JSON extraction.
    predict_seconds, predict_fps = _measure_wall(
        lambda: model.predict(
            image,
            device=args.device,
            imgsz=args.imgsz,
            quantize=quantize,
            max_det=settings.YOLO_MAX_DETECTIONS,
            retina_masks=settings.YOLO_RETINA_MASKS,
            verbose=False,
        ),
        args.iterations,
        args.device,
    )

    # The neural-network-only metric is meaningful for PyTorch checkpoints.
    # A TensorRT engine is invoked through its backend and has no comparable
    # torch.nn.Module forward path.
    direct_forward_available = (
        Path(args.model).suffix.lower() != ".engine"
        and isinstance(getattr(model, "model", None), torch.nn.Module)
    )
    if direct_forward_available:
        net = model.model.eval()
        dtype = torch.float16 if quantize == 16 else torch.float32
        if quantize == 16:
            net.half()
        else:
            net.float()
        tensor = torch.zeros((1, 3, args.imgsz, args.imgsz), device=args.device, dtype=dtype)
        forward_seconds, forward_fps, forward_gpu_ms = _measure_forward(
            net, tensor, args.iterations, args.device
        )
    else:
        forward_seconds = None
        forward_fps = None
        forward_gpu_ms = None

    # Isolate conversion from the model and from detection postprocessing.
    conversion_seconds, conversion_fps = _measure_wall(
        lambda: frame.to_ndarray(format="bgr24"), args.iterations, "cpu"
    )

    # Exact production path, including PyAV conversion and bbox/mask extraction.
    gc.disable()
    exact_seconds, exact_fps = _measure_wall(
        lambda: run_yolo(inference_frame, model), args.iterations, args.device
    )
    gc.enable()

    print("\nResults")
    if forward_fps is None:
        print("  direct model forward : n/a (TensorRT backend)")
    else:
        print(f"  direct model forward : {forward_fps:6.2f} FPS ({forward_gpu_ms:6.2f} ms GPU event)")
    print(f"  Ultralytics predict  : {predict_fps:6.2f} FPS ({predict_seconds * 1000 / args.iterations:6.2f} ms wall)")
    print(f"  PyAV conversion      : {conversion_fps:6.2f} FPS ({conversion_seconds * 1000 / args.iterations:6.2f} ms wall)")
    print(f"  exact run_yolo path  : {exact_fps:6.2f} FPS ({exact_seconds * 1000 / args.iterations:6.2f} ms wall)")

    print("\nInterpretation")
    if forward_fps is not None and forward_fps < 30:
        print("  GPU/model is below the 30 FPS target; reduce imgsz or use a faster/exported engine.")
    elif predict_fps < 30:
        print("  GPU forward clears 30 FPS, but Ultralytics preprocessing/postprocessing is the bottleneck.")
    elif exact_fps < 30:
        print("  PyAV conversion or detection-to-JSON extraction is the bottleneck.")
    else:
        print("  This isolated path clears 30 FPS; inspect relay input rate, WebSocket delivery, and browser pacing.")
    print("  30 FPS budget: 33.33 ms per completed frame, including decode and result handling.")


if __name__ == "__main__":
    main()
