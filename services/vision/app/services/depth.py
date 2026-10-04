"""UniDepth V2 metric depth and instance-mask distance fusion."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from dataclasses import dataclass
from importlib.metadata import distribution
import json
import math
import os
from pathlib import Path
import shutil
from time import perf_counter
from typing import Any

import numpy as np

from app.core.settings import settings
from app.services.depth_path import DepthOnlyPath
from app.services.mask_transfer import _copy_tensor_to_host


SOURCE_REVISION = "8d8cfe4c7ee15297099983607febf0d4f32eb3d6"
MODEL_ID = "lpiccinelli/unidepth-v2-vitb14"
MODEL_REVISION = "6830c15e415da7f94babbe0e83b46e1a04bc28ea"


@dataclass(frozen=True, slots=True)
class DepthFrame:
    width: int
    height: int
    tensor: Any


def scale_camera_intrinsic(
    matrix: tuple[tuple[float, ...], ...] | list[list[float]],
    width: int,
    height: int,
    calibration_width: int,
    calibration_height: int,
) -> np.ndarray:
    """Scale a calibrated pixel-space camera matrix to the model input size."""

    if width <= 0 or height <= 0 or calibration_width <= 0 or calibration_height <= 0:
        raise ValueError("image and calibration dimensions must be positive")
    intrinsic = np.asarray(matrix, dtype=np.float32).copy()
    if intrinsic.shape != (3, 3) or not np.isfinite(intrinsic).all():
        raise ValueError("camera intrinsic must be a finite 3x3 matrix")
    intrinsic[0, :] *= width / calibration_width
    intrinsic[1, :] *= height / calibration_height
    return intrinsic


class DepthEstimator:
    """Loads the pinned local UniDepth checkpoint once and predicts one frame."""

    def __init__(self, model_path: str | Path, device: str) -> None:
        model_path = Path(model_path).expanduser().resolve()
        required = ("config.json", "model.safetensors", "stage24_model_provenance.json")
        missing = [name for name in required if not (model_path / name).is_file()]
        if missing:
            raise FileNotFoundError(f"Local UniDepth model is incomplete: {missing}")
        provenance = json.loads(
            (model_path / "stage24_model_provenance.json").read_text(encoding="utf-8")
        )
        if provenance.get("model_id") != MODEL_ID or provenance.get("revision") != MODEL_REVISION:
            raise ValueError("UniDepth model provenance differs from the pinned runtime model")

        installed = distribution("unidepth")
        direct = installed.read_text("direct_url.json")
        revision = json.loads(direct).get("vcs_info", {}).get("commit_id") if direct else None
        if revision != SOURCE_REVISION:
            raise RuntimeError("installed UniDepth source revision differs from vehicle_runtime")

        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        import torch
        from unidepth.models import UniDepthV2

        self._torch = torch
        self._device = torch.device(device)
        self._input_shape = None
        self._host_input = None
        self._host_input_array = None
        self._device_input = None
        self._model = UniDepthV2.from_pretrained(
            str(model_path), local_files_only=True
        ).to(self._device).eval()
        self._model.resolution_level = settings.UNIDEPTH_RESOLUTION_LEVEL
        print(
            f"UniDepth resolution level: {self._model.resolution_level}",
            flush=True,
        )
        self._depth_path = DepthOnlyPath(self._model, torch)
        self._optimized = True
        requested_compiler = os.environ.get("CC")
        compiler_name = requested_compiler.split()[0] if requested_compiler else None
        compiler_available = (
            shutil.which(compiler_name) is not None
            if compiler_name
            else any(shutil.which(name) is not None for name in ("gcc", "cc", "clang"))
        )
        self._compiled = settings.UNIDEPTH_COMPILE and compiler_available
        if self._compiled:
            self._depth_path.forward = torch.compile(
                self._depth_path.eager_forward, mode="default", fullgraph=False
            )
            print("UniDepth torch.compile enabled; warming up before serving frames", flush=True)
        elif not settings.UNIDEPTH_COMPILE:
            print("UniDepth torch.compile disabled; using eager inference", flush=True)
        else:
            print(
                "UniDepth C compiler unavailable; using eager inference",
                flush=True,
            )
        self._stream = (
            torch.cuda.Stream(device=self._device)
            if self._device.type == "cuda"
            else None
        )
        self._ready = None
        if self._stream is not None:
            with torch.cuda.device(self._device):
                self._ready = torch.cuda.Event(blocking=True)

    def predict(self, frame_bgr: np.ndarray, camera_intrinsic: np.ndarray) -> DepthFrame:
        torch = self._torch
        height, width = frame_bgr.shape[:2]
        try:
            depth = self._infer(frame_bgr, camera_intrinsic)
        except Exception as exc:
            if not self._compiled:
                raise
            self._depth_path.forward = self._depth_path.eager_forward
            self._compiled = False
            print(
                f"UniDepth torch.compile failed ({type(exc).__name__}: {exc}); "
                "retrying in eager mode",
                flush=True,
            )
            depth = self._infer(frame_bgr, camera_intrinsic)
        if tuple(depth.shape) != (1, 1, height, width):
            raise RuntimeError("UniDepth output is not aligned to the model input frame")
        return DepthFrame(width, height, depth[0, 0])

    def warmup(self) -> None:
        """Compile for the configured input shape before the live feed starts."""
        configured = settings.YOLO_INFERENCE_SIZE
        if configured == "source":
            width = settings.UNIDEPTH_CALIBRATION_WIDTH
            height = settings.UNIDEPTH_CALIBRATION_HEIGHT
        elif configured == "auto":
            source_width = settings.UNIDEPTH_CALIBRATION_WIDTH
            source_height = settings.UNIDEPTH_CALIBRATION_HEIGHT
            scale = min(
                settings.YOLO_MAX_IMGSZ / max(source_width, source_height), 1.0
            )
            width = max(1, round(source_width * scale))
            height = max(1, round(source_height * scale))
        else:
            height_text, width_text = configured.split("x", 1)
            height, width = int(height_text), int(width_text)
        width, height = depth_input_size(
            settings.UNIDEPTH_CALIBRATION_WIDTH, settings.UNIDEPTH_CALIBRATION_HEIGHT,
            width, height,
        )
        camera = scale_camera_intrinsic(
            settings.UNIDEPTH_CAMERA_INTRINSIC,
            width,
            height,
            settings.UNIDEPTH_CALIBRATION_WIDTH,
            settings.UNIDEPTH_CALIBRATION_HEIGHT,
        )
        print(f"UniDepth depth-only warmup shape: {width}x{height}", flush=True)
        started = perf_counter()
        frame = np.random.default_rng(0).integers(
            0, 256, (height, width, 3), dtype=np.uint8
        )
        candidate = self.predict(frame, camera).tensor
        reference = self._infer(frame, camera, reference=True)[0, 0]
        try:
            self._torch.testing.assert_close(candidate, reference, rtol=0.01, atol=0.01)
        except AssertionError as exc:
            self._optimized = False
            self._compiled = False
            print(f"UniDepth depth-only validation failed; using upstream eager path: {exc}", flush=True)
        else:
            print("UniDepth depth-only validation passed (rtol=0.01, atol=0.01m)", flush=True)
        print(
            f"UniDepth warmup finished in {perf_counter() - started:.1f}s; "
            f"mode={'compiled' if self._compiled else 'eager fallback'}",
            flush=True,
        )

    def _stage_input(self, frame: np.ndarray) -> Any:
        """Reuse one host/device pair; one depth worker owns these buffers."""
        if frame.ndim != 3 or frame.shape[2] != 3 or frame.dtype != np.uint8:
            raise ValueError("depth input must be an HxWx3 uint8 BGR image")
        shape = tuple(frame.shape)
        if shape != self._input_shape:
            host = self._torch.empty(shape, dtype=self._torch.uint8,
                                     pin_memory=self._device.type == "cuda")
            device = self._torch.empty(shape, dtype=self._torch.uint8, device=self._device)
            # Only one shape is cached; changing shape replaces the old pair.
            self._host_input = host
            self._host_input_array = host.numpy()
            self._device_input = device
            self._input_shape = shape
        np.copyto(self._host_input_array, frame)
        self._device_input.copy_(self._host_input, non_blocking=self._device.type == "cuda")
        return self._device_input.permute(2, 0, 1).flip(0)

    def _infer(self, frame: np.ndarray, camera: np.ndarray, reference: bool = False) -> Any:
        torch = self._torch
        with torch.inference_mode():
            context = torch.cuda.stream(self._stream) if self._stream is not None else nullcontext()
            try:
                with context, torch.autocast("cuda", dtype=torch.float16, enabled=self._device.type == "cuda"):
                    rgb = self._stage_input(frame)
                    if reference or not self._optimized:
                        intrinsic = torch.as_tensor(camera.copy(), device=self._device)
                        output = self._model.infer(rgb, intrinsic)["depth"]
                    else:
                        output = self._depth_path(rgb, camera)
                    output = output.detach().float()
            finally:
                if self._stream is not None:
                    # max_workers=1 and synchronization even on failure keep
                    # retries from overwriting an in-flight pinned H2D copy.
                    self._ready.record(self._stream)
                    self._ready.synchronize()
        return output


def depth_input_size(source_width: int, source_height: int,
                     yolo_width: int, yolo_height: int) -> tuple[int, int]:
    """Select the depth image size independently of YOLO's image grid."""
    configured = settings.UNIDEPTH_INFERENCE_SIZE
    if configured == "yolo":
        return yolo_width, yolo_height
    if configured == "source":
        return source_width, source_height
    height, width = map(int, configured.split("x"))
    return width, height


def load_depth_estimator() -> DepthEstimator:
    device = settings.UNIDEPTH_DEVICE or settings.YOLO_DEVICE
    print(f"UniDepth inference device: {device}", flush=True)
    estimator = DepthEstimator(settings.UNIDEPTH_MODEL_DIR, device)
    estimator.warmup()
    return estimator


def _exact_median(values: Any, torch: Any) -> Any:
    """Match vehicle_runtime's interpolated, exact median semantics."""

    count = int(values.numel())
    position = (count - 1) * 0.5
    lower = int(position)
    upper = lower + (1 if position > lower else 0)
    low = values.kthvalue(lower + 1).values
    if lower == upper:
        return low
    high = values.kthvalue(upper + 1).values
    return low + (high - low) * (position - lower)


def box_median_distances(
    depth_tensor: Any,
    box_rows: list,
    detection_indices: list[int],
    *,
    bbox_format: str,
    image_width: int,
    image_height: int,
    scale: float,
) -> list[tuple[float | None, str]]:
    """Median valid depth in a centered, scaled box, without full-image masks.

    Rows are the already materialized model boxes, before source-image scaling.
    A scale of 1 uses the full box; 0.5 uses half its width and half its height.
    """
    import torch

    if not isinstance(depth_tensor, torch.Tensor) or depth_tensor.ndim != 2:
        raise ValueError("depth map must be a two-dimensional torch tensor")
    if bbox_format not in {"xyxy_normalized", "xyxy_pixels", "xywh_normalized", "xywh_pixels"}:
        raise ValueError("unsupported box format for depth sampling")
    if not math.isfinite(scale) or not 0 < scale <= 1:
        raise ValueError("box scale must be finite and in (0, 1]")
    if image_width <= 0 or image_height <= 0:
        raise ValueError("box image dimensions must be positive")
    if not detection_indices:
        return []
    height, width = map(int, depth_tensor.shape)
    pixel_boxes = bbox_format.endswith("_pixels")
    sx = width / image_width if pixel_boxes else width
    sy = height / image_height if pixel_boxes else height
    statuses = []
    medians = []
    for index in detection_indices:
        status = "invalid_box"
        median = None
        if 0 <= index < len(box_rows):
            row = box_rows[index]
            x0, y0, x1, y1 = (float(row[i]) for i in range(4))
            if all(math.isfinite(value) for value in (x0, y0, x1, y1)):
                if bbox_format.startswith("xywh"):
                    cx, cy, bw, bh = x0, y0, x1, y1
                    x0, x1 = cx - bw / 2, cx + bw / 2
                    y0, y1 = cy - bh / 2, cy + bh / 2
                if x1 > x0 and y1 > y0:
                    cx, cy = (x0 + x1) * sx / 2, (y0 + y1) * sy / 2
                    half_w, half_h = (x1 - x0) * sx * scale / 2, (y1 - y0) * sy * scale / 2
                    left = max(0, min(width, math.floor(cx - half_w)))
                    right = max(0, min(width, math.ceil(cx + half_w)))
                    top = max(0, min(height, math.floor(cy - half_h)))
                    bottom = max(0, min(height, math.ceil(cy + half_h)))
                    region = depth_tensor[top:bottom, left:right]
                    status = "empty_box"
                    if region.numel():
                        values = region[torch.isfinite(region) & (region > 0)]
                        status = "no_valid_depth"
                        if values.numel():
                            median = _exact_median(values, torch)
                            status = "ok"
        statuses.append(status)
        medians.append(median if median is not None else
                       torch.full((), float("nan"), device=depth_tensor.device))
    # One transfer for all detection medians, as in the mask path.
    values = _copy_tensor_to_host(torch.stack(medians), slot="depth").tolist()
    return [(float(value), status) if status == "ok" and math.isfinite(value)
            else (None, status if status != "ok" else "no_valid_depth")
            for value, status in zip(values, statuses)]


def masked_median_distances(
    depth_tensor: Any,
    masks_data: Any | None,
    detection_indices: list[int],
) -> list[tuple[float | None, str]]:
    """Return one valid-depth median per retained YOLO detection, in order."""

    if not detection_indices:
        return []
    if masks_data is None:
        return [(None, "mask_unavailable") for _ in detection_indices]

    import torch
    import torch.nn.functional as functional

    if not isinstance(depth_tensor, torch.Tensor) or depth_tensor.ndim != 2:
        raise ValueError("depth map must be a two-dimensional torch tensor")
    if not isinstance(masks_data, torch.Tensor) or masks_data.ndim != 3:
        return [(None, "mask_unavailable") for _ in detection_indices]
    # YOLO masks may live on a different GPU from the UniDepth map. Transfer
    # before resizing so only the smaller mask tensor crosses devices.
    if masks_data.device != depth_tensor.device:
        masks_data = masks_data.to(device=depth_tensor.device)
    height, width = map(int, depth_tensor.shape)
    if tuple(masks_data.shape[-2:]) != (height, width):
        masks_data = functional.interpolate(
            masks_data.unsqueeze(1).float(),
            size=(height, width),
            mode="nearest",
        ).squeeze(1)

    valid_depth = torch.isfinite(depth_tensor) & (depth_tensor > 0)
    statuses: list[str] = []
    medians: list[Any] = []
    empty_indices: list[int] = []
    mask_presence: list[Any] = []
    for detection_index in detection_indices:
        if detection_index < 0 or detection_index >= int(masks_data.shape[0]):
            statuses.append("mask_unavailable")
            medians.append(torch.full((), float("nan"), device=depth_tensor.device))
            continue
        mask = masks_data[detection_index] > 0.5
        if tuple(mask.shape) != (height, width):
            raise ValueError("instance mask could not be aligned with the depth map")
        values = depth_tensor[mask & valid_depth]
        if not values.numel():
            empty_indices.append(len(statuses))
            mask_presence.append(mask.any())
            statuses.append("empty_mask")  # Resolve presence with the final host copy.
            medians.append(torch.full((), float("nan"), device=depth_tensor.device))
            continue
        statuses.append("ok")
        medians.append(_exact_median(values, torch))

    output = torch.stack(medians)
    if mask_presence:
        output = torch.cat((output, torch.stack(mask_presence).to(dtype=output.dtype)))
    host_output = _copy_tensor_to_host(output, slot="depth").tolist()
    host_values = host_output[:len(medians)]
    for index, present in zip(empty_indices, host_output[len(medians):]):
        if present:
            statuses[index] = "no_valid_depth"
    result = []
    for status, value in zip(statuses, host_values):
        distance = float(value) if status == "ok" and np.isfinite(value) else None
        result.append((distance, status if distance is not None else (status if status != "ok" else "no_valid_depth")))
    return result


def predict_timed(
    estimator: DepthEstimator,
    frame_bgr: np.ndarray,
    camera_intrinsic: np.ndarray,
) -> tuple[DepthFrame, float]:
    started = perf_counter()
    result = estimator.predict(frame_bgr, camera_intrinsic)
    return result, (perf_counter() - started) * 1000.0


def make_depth_executor() -> ThreadPoolExecutor:
    return ThreadPoolExecutor(max_workers=1, thread_name_prefix="unidepth")
