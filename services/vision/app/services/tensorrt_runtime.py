"""In-process TensorRT runtime for the fixed-shape segmentation engine.

The live service intentionally keeps model execution behind this small class.
The rest of the pipeline still receives an :class:`InferenceFrame` and emits
the same JSON-ready result as the Ultralytics/PyTorch path.  TensorRT and
CUDA-Python are imported lazily so that the CPU/Windows test path can still
exercise the decoder and preprocessing helpers without installing NVIDIA's
Linux runtime packages.

The engine produced by ``build_tensorrt_engine.py`` is deliberately static:
batch 1, RGB NCHW, and a fixed 640x640 input.  Keeping the execution context
and all device/host buffers alive across calls avoids per-frame allocation and
engine setup overhead.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from types import SimpleNamespace
from typing import Any, Mapping

import numpy as np

from app.core.settings import settings


class TensorRTRuntimeError(RuntimeError):
    """Raised when a TensorRT engine cannot be loaded or executed."""


@dataclass(frozen=True)
class LetterboxMeta:
    """The reversible geometry transform used before the engine call."""

    original_width: int
    original_height: int
    target_width: int
    target_height: int
    resized_width: int
    resized_height: int
    scale: float
    pad_x: int
    pad_y: int


@dataclass
class _HostBuffer:
    pointer: int
    nbytes: int
    array: np.ndarray
    backing: Any


@dataclass(frozen=True)
class TrackerDetections:
    """Small Results-like object accepted by Ultralytics BYTETracker.

    Native TensorRT inference must not construct an Ultralytics ``YOLO`` or
    ``Results`` object for every frame.  BYTETracker only needs these four
    arrays and boolean indexing, so this adapter keeps the existing tracker
    contract without putting model execution back through Ultralytics.
    """

    xyxy: np.ndarray
    xywh: np.ndarray
    conf: np.ndarray
    cls: np.ndarray

    def __len__(self) -> int:
        return int(self.conf.shape[0])

    def __getitem__(self, item: Any) -> "TrackerDetections":
        return TrackerDetections(
            xyxy=self.xyxy[item],
            xywh=self.xywh[item],
            conf=self.conf[item],
            cls=self.cls[item],
        )


def load_engine_manifest(path: str | Path) -> dict[str, Any]:
    """Load and validate the sidecar manifest for a TensorRT engine."""

    manifest_path = Path(path)
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise TensorRTRuntimeError(
            f"TensorRT engine manifest is missing: {manifest_path}. "
            "Build the engine and its .manifest.json sidecar first."
        ) from exc
    except json.JSONDecodeError as exc:
        raise TensorRTRuntimeError(
            f"TensorRT engine manifest is not valid JSON: {manifest_path}"
        ) from exc

    if not isinstance(payload, dict):
        raise TensorRTRuntimeError(
            "TensorRT engine manifest must contain a JSON object"
        )
    if payload.get("schema_version") != 1:
        raise TensorRTRuntimeError(
            "unsupported TensorRT engine manifest schema: "
            f"{payload.get('schema_version')!r} (expected 1)"
        )
    if payload.get("task") != "segment":
        raise TensorRTRuntimeError(
            "TensorRT engine manifest must describe a segmentation model"
        )
    input_spec = payload.get("input")
    outputs = payload.get("outputs")
    postprocess = payload.get("postprocess")
    if not isinstance(input_spec, dict) or not isinstance(outputs, dict):
        raise TensorRTRuntimeError(
            "TensorRT engine manifest must define input and outputs"
        )
    if not isinstance(postprocess, dict):
        raise TensorRTRuntimeError(
            "TensorRT engine manifest must define postprocess settings"
        )
    if not input_spec.get("name") or not input_spec.get("shape"):
        raise TensorRTRuntimeError("TensorRT engine manifest input is incomplete")
    if not outputs:
        raise TensorRTRuntimeError("TensorRT engine manifest has no output tensors")
    names = payload.get("names")
    if not isinstance(names, (dict, list)) or not names:
        raise TensorRTRuntimeError("TensorRT engine manifest must define class names")
    return payload


def resolve_manifest_path(
    engine_path: str | Path, manifest_path: str | Path | None = None
) -> Path:
    """Resolve an explicit or conventional ``.engine.manifest.json`` sidecar."""

    if manifest_path:
        return Path(manifest_path)
    engine = Path(engine_path)
    candidates = (
        engine.with_suffix(engine.suffix + ".manifest.json"),
        engine.with_suffix(".manifest.json"),
        engine.with_suffix(".json"),
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    # Return the canonical location so the error message points at the file
    # the builder will create.
    return candidates[0]


def letterbox_bgr(
    image: np.ndarray, target_height: int, target_width: int
) -> tuple[np.ndarray, LetterboxMeta]:
    """Resize a BGR image into a constant-color, centered letterbox."""

    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("expected an HxWx3 BGR image")
    original_height, original_width = map(int, image.shape[:2])
    if original_height <= 0 or original_width <= 0:
        raise ValueError("image dimensions must be positive")
    if target_height <= 0 or target_width <= 0:
        raise ValueError("letterbox dimensions must be positive")

    scale = min(target_width / original_width, target_height / original_height)
    resized_width = max(1, min(target_width, int(round(original_width * scale))))
    resized_height = max(1, min(target_height, int(round(original_height * scale))))

    # Importing OpenCV here keeps manifest-only imports independent from the
    # native runtime packages.
    import cv2

    resized = cv2.resize(
        image,
        (resized_width, resized_height),
        interpolation=cv2.INTER_LINEAR,
    )
    canvas = np.full((target_height, target_width, 3), 114, dtype=np.uint8)
    pad_x = (target_width - resized_width) // 2
    pad_y = (target_height - resized_height) // 2
    canvas[pad_y : pad_y + resized_height, pad_x : pad_x + resized_width] = resized
    return canvas, LetterboxMeta(
        original_width=original_width,
        original_height=original_height,
        target_width=target_width,
        target_height=target_height,
        resized_width=resized_width,
        resized_height=resized_height,
        scale=scale,
        pad_x=pad_x,
        pad_y=pad_y,
    )


def prepare_tensor(
    image: np.ndarray,
    target_height: int,
    target_width: int,
    dtype: np.dtype[Any] = np.dtype(np.float16),
    color_order: str = "RGB",
    scale: float = 1.0 / 255.0,
) -> tuple[np.ndarray, LetterboxMeta]:
    """Letterbox and convert BGR uint8 pixels to a contiguous NCHW tensor."""

    letterboxed, meta = letterbox_bgr(image, target_height, target_width)
    if color_order.upper() == "RGB":
        letterboxed = letterboxed[:, :, ::-1]
    elif color_order.upper() != "BGR":
        raise ValueError(f"unsupported engine color order {color_order!r}")
    tensor = np.ascontiguousarray(letterboxed.transpose(2, 0, 1)[None])
    if tensor.dtype != dtype:
        tensor = tensor.astype(dtype, copy=False)
    if scale != 1.0:
        tensor *= np.asarray(scale, dtype=dtype)
    return tensor, meta


def _sigmoid(values: np.ndarray) -> np.ndarray:
    limit = 64.0
    values = np.clip(values, -limit, limit)
    return 1.0 / (1.0 + np.exp(-values))


def _iou_one_to_many(box: np.ndarray, boxes: np.ndarray) -> np.ndarray:
    """Compute IoU between one xyxy box and an array of xyxy boxes."""

    if len(boxes) == 0:
        return np.empty((0,), dtype=np.float32)
    left = np.maximum(box[0], boxes[:, 0])
    top = np.maximum(box[1], boxes[:, 1])
    right = np.minimum(box[2], boxes[:, 2])
    bottom = np.minimum(box[3], boxes[:, 3])
    intersection = np.maximum(0.0, right - left) * np.maximum(0.0, bottom - top)
    box_area = max(0.0, float(box[2] - box[0])) * max(0.0, float(box[3] - box[1]))
    areas = np.maximum(0.0, boxes[:, 2] - boxes[:, 0]) * np.maximum(
        0.0, boxes[:, 3] - boxes[:, 1]
    )
    return intersection / np.maximum(box_area + areas - intersection, 1e-9)


def classwise_nms(
    boxes: np.ndarray,
    scores: np.ndarray,
    class_ids: np.ndarray,
    iou_threshold: float,
    max_detections: int,
) -> np.ndarray:
    """Deterministic NumPy NMS matching the normal per-class YOLO behavior."""

    if len(boxes) == 0:
        return np.empty((0,), dtype=np.int64)
    kept: list[int] = []
    for class_id in np.unique(class_ids.astype(np.int64, copy=False)):
        candidates = np.flatnonzero(class_ids == class_id)
        order = candidates[np.argsort(-scores[candidates], kind="stable")]
        while len(order):
            current = int(order[0])
            kept.append(current)
            if len(kept) >= max_detections:
                return np.asarray(kept, dtype=np.int64)
            if len(order) == 1:
                break
            overlaps = _iou_one_to_many(boxes[current], boxes[order[1:]])
            order = order[1:][overlaps <= iou_threshold]
    # NMS above is grouped by class. Preserve score order for stable JSON and
    # to match the order users see from Ultralytics.
    kept.sort(key=lambda index: (-float(scores[index]), int(index)))
    return np.asarray(kept[:max_detections], dtype=np.int64)


def _as_numpy_output(output: np.ndarray) -> np.ndarray:
    output = np.asarray(output)
    if output.ndim >= 1 and output.shape[0] == 1:
        output = output[0]
    return np.asarray(output)


def decode_segmentation_outputs(
    outputs: Mapping[str, np.ndarray],
    meta: LetterboxMeta,
    manifest: Mapping[str, Any],
    confidence_threshold: float | None = None,
    iou_threshold: float | None = None,
    max_detections: int | None = None,
) -> list[dict[str, Any]]:
    """Decode raw Ultralytics segmentation outputs into service detections.

    The decoder handles the two-output, ``nms=False`` TensorRT export used by
    the builder: a prediction tensor containing ``xywh``/class/mask
    coefficients and a prototype tensor.  Tensor axes are inferred from the
    static manifest, allowing both ``[1,C,N]`` and ``[1,N,C]`` exports.
    """

    postprocess = manifest["postprocess"]
    output_specs = manifest["outputs"]
    prediction_name = postprocess.get("prediction_output")
    prototype_name = postprocess.get("prototype_output")
    if prediction_name is None:
        prediction_name = next(
            (
                name
                for name, spec in output_specs.items()
                if isinstance(spec, dict) and spec.get("role") == "predictions"
            ),
            None,
        )
    if prototype_name is None:
        prototype_name = next(
            (
                name
                for name, spec in output_specs.items()
                if isinstance(spec, dict) and spec.get("role") == "prototypes"
            ),
            None,
        )
    if prediction_name not in outputs:
        raise TensorRTRuntimeError(
            f"prediction output {prediction_name!r} is not present in engine outputs"
        )
    if prototype_name not in outputs:
        raise TensorRTRuntimeError(
            f"prototype output {prototype_name!r} is not present in engine outputs"
        )

    names = manifest["names"]
    class_count = len(names)
    mask_dim = int(postprocess.get("mask_dim", 32))
    layout = str(postprocess.get("layout", "raw")).lower()
    box_offset = int(postprocess.get("box_offset", 0))
    class_offset = int(postprocess.get("class_offset", 5 if layout == "end2end" else 4))
    mask_offset = int(
        postprocess.get(
            "mask_offset", 6 if layout == "end2end" else class_offset + class_count
        )
    )
    box_format = str(
        postprocess.get("box_format", "xyxy" if layout == "end2end" else "xywh")
    ).lower()
    prediction = _as_numpy_output(outputs[prediction_name]).astype(
        np.float32, copy=False
    )
    if prediction.ndim != 2:
        raise TensorRTRuntimeError(
            f"expected a 2-D prediction tensor after batch squeeze, got {prediction.shape}"
        )
    expected_channels = mask_offset + mask_dim
    if layout == "end2end":
        # The exported top-k tensor is normally [1,300,C], but accept the
        # transposed form as well so the manifest remains portable across
        # TensorRT/ONNX exporter versions.
        if (
            prediction.shape[0] == expected_channels
            and prediction.shape[1] != expected_channels
        ):
            prediction = prediction.T
    elif (
        prediction.shape[0] == expected_channels
        and prediction.shape[1] != expected_channels
    ):
        prediction = prediction.T
    elif (
        prediction.shape[1] != expected_channels
        and prediction.shape[0] < prediction.shape[1]
    ):
        # This fallback is useful for manifests made by older exporters where
        # the class count was not recorded explicitly.
        prediction = prediction.T
    if prediction.shape[1] < expected_channels:
        raise TensorRTRuntimeError(
            f"prediction tensor has {prediction.shape[1]} channels; "
            f"manifest requires at least {expected_channels}"
        )

    boxes = prediction[:, box_offset : box_offset + 4]
    if box_format == "xyxy":
        boxes_input = boxes.copy()
    elif box_format == "xywh":
        center_x, center_y, width, height = boxes.T
        boxes_input = np.column_stack(
            (
                center_x - width / 2.0,
                center_y - height / 2.0,
                center_x + width / 2.0,
                center_y + height / 2.0,
            )
        )
    else:
        raise TensorRTRuntimeError(f"unsupported prediction box format {box_format!r}")

    if layout == "end2end":
        score_offset = int(postprocess.get("score_offset", 4))
        confidences = np.asarray(prediction[:, score_offset], dtype=np.float32)
        class_ids = np.rint(prediction[:, class_offset]).astype(np.int64)
        class_ids = np.clip(class_ids, 0, max(0, class_count - 1))
    else:
        scores = prediction[:, class_offset : class_offset + class_count]
        if postprocess.get("scores_activation") == "sigmoid":
            scores = _sigmoid(scores)
        scores = np.asarray(scores, dtype=np.float32)
        class_ids = scores.argmax(axis=1).astype(np.int64)
        confidences = scores[np.arange(len(scores)), class_ids]
    confidence_threshold = (
        float(postprocess.get("confidence_threshold", settings.CONF_THRESHOLD_LOW))
        if confidence_threshold is None
        else float(confidence_threshold)
    )
    keep = confidences >= confidence_threshold
    if not np.any(keep):
        return []

    boxes_input = boxes_input[keep]
    confidences = confidences[keep]
    class_ids = class_ids[keep]
    mask_coefficients = prediction[keep, mask_offset : mask_offset + mask_dim]

    # Undo letterboxing before NMS and serialization. The transform is a
    # uniform scale plus integer padding, so this is also the correct geometry
    # for tracking in source-frame coordinates.
    boxes_original = boxes_input.copy()
    boxes_original[:, [0, 2]] = (boxes_original[:, [0, 2]] - meta.pad_x) / meta.scale
    boxes_original[:, [1, 3]] = (boxes_original[:, [1, 3]] - meta.pad_y) / meta.scale
    boxes_original[:, [0, 2]] = np.clip(
        boxes_original[:, [0, 2]], 0, meta.original_width
    )
    boxes_original[:, [1, 3]] = np.clip(
        boxes_original[:, [1, 3]], 0, meta.original_height
    )
    iou_threshold = (
        float(postprocess.get("iou_threshold", settings.YOLO_IOU_THRESHOLD))
        if iou_threshold is None
        else float(iou_threshold)
    )
    max_detections = (
        int(postprocess.get("max_detections", settings.YOLO_MAX_DETECTIONS))
        if max_detections is None
        else int(max_detections)
    )
    if layout == "end2end" and not bool(postprocess.get("apply_nms", False)):
        kept = np.argsort(-confidences, kind="stable")[:max_detections]
    else:
        kept = classwise_nms(
            boxes_original, confidences, class_ids, iou_threshold, max_detections
        )
    boxes_original = boxes_original[kept]
    confidences = confidences[kept]
    class_ids = class_ids[kept]
    mask_coefficients = mask_coefficients[kept]

    prototype = _as_numpy_output(outputs[prototype_name]).astype(np.float32, copy=False)
    if prototype.ndim == 3:
        # [mask_dim, mask_h, mask_w]
        if prototype.shape[0] != mask_dim and prototype.shape[-1] == mask_dim:
            prototype = np.moveaxis(prototype, -1, 0)
    elif prototype.ndim == 2:
        raise TensorRTRuntimeError(
            f"expected a 3-D prototype tensor after batch squeeze, got {prototype.shape}"
        )
    else:
        raise TensorRTRuntimeError(
            f"expected a 3-D prototype tensor after batch squeeze, got {prototype.shape}"
        )
    if prototype.shape[0] != mask_dim:
        raise TensorRTRuntimeError(
            f"prototype mask dimension {prototype.shape[0]} does not match {mask_dim}"
        )

    masks = _decode_masks(
        prototype,
        mask_coefficients,
        boxes_input[kept],
        meta,
        float(postprocess.get("mask_threshold", 0.5)),
    )
    detections = []
    for index, (box, confidence, class_id) in enumerate(
        zip(boxes_original, confidences, class_ids)
    ):
        class_key = str(int(class_id))
        class_name = (
            names.get(class_key, class_key)
            if isinstance(names, dict)
            else names[int(class_id)]
        )
        detection = {
            "class": class_name,
            # Keep the unrounded score for ByteTrack's threshold comparisons;
            # the public response is rounded in NativeTensorRTRuntime.infer().
            "confidence": float(confidence),
            "bbox": _format_bbox(box, meta, settings.BBOX_FORMAT),
            "bbox_format": settings.BBOX_FORMAT,
        }
        polygon = masks[index]
        if len(polygon) >= 3:
            detection["mask"] = polygon
            detection["mask_format"] = "polygon_normalized"
        detections.append(detection)
    return detections


def _format_bbox(
    box_xyxy: np.ndarray, meta: LetterboxMeta, bbox_format: str
) -> list[float]:
    x1, y1, x2, y2 = map(float, box_xyxy)
    if bbox_format == "xyxy_pixels":
        return [x1, y1, x2, y2]
    if bbox_format == "xyxy_normalized":
        return [
            x1 / meta.original_width,
            y1 / meta.original_height,
            x2 / meta.original_width,
            y2 / meta.original_height,
        ]
    center_x = (x1 + x2) / 2.0
    center_y = (y1 + y2) / 2.0
    width = x2 - x1
    height = y2 - y1
    if bbox_format == "xywh_pixels":
        return [center_x, center_y, width, height]
    if bbox_format == "xywh_normalized":
        return [
            center_x / meta.original_width,
            center_y / meta.original_height,
            width / meta.original_width,
            height / meta.original_height,
        ]
    raise ValueError(f"unsupported BBOX_FORMAT {bbox_format!r}")


def _decode_masks(
    prototype: np.ndarray,
    coefficients: np.ndarray,
    boxes_input: np.ndarray,
    meta: LetterboxMeta,
    threshold: float,
) -> list[list[list[float]]]:
    """Project prototype masks, crop them, and return normalized polygons."""

    import cv2

    mask_height, mask_width = map(int, prototype.shape[1:])
    logits = coefficients @ prototype.reshape(prototype.shape[0], -1)
    masks = _sigmoid(logits).reshape(-1, mask_height, mask_width)
    polygons: list[list[list[float]]] = []
    for mask, box in zip(masks, boxes_input):
        full = cv2.resize(
            mask,
            (meta.target_width, meta.target_height),
            interpolation=cv2.INTER_LINEAR,
        )
        x1, y1, x2, y2 = np.round(box).astype(int)
        clipped = np.zeros_like(full, dtype=np.float32)
        left = max(0, min(meta.target_width, x1))
        top = max(0, min(meta.target_height, y1))
        right = max(left, min(meta.target_width, x2))
        bottom = max(top, min(meta.target_height, y2))
        clipped[top:bottom, left:right] = full[top:bottom, left:right]
        cropped = clipped[
            meta.pad_y : meta.pad_y + meta.resized_height,
            meta.pad_x : meta.pad_x + meta.resized_width,
        ]
        original = cv2.resize(
            cropped,
            (meta.original_width, meta.original_height),
            interpolation=cv2.INTER_LINEAR,
        )
        binary = (original >= threshold).astype(np.uint8)
        contours, _ = cv2.findContours(
            binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if not contours:
            polygons.append([])
            continue
        contour = max(contours, key=cv2.contourArea).reshape(-1, 2)
        if len(contour) < 3:
            polygons.append([])
            continue
        polygons.append(
            [
                [
                    float(np.clip(point[0] / meta.original_width, 0.0, 1.0)),
                    float(np.clip(point[1] / meta.original_height, 0.0, 1.0)),
                ]
                for point in contour
            ]
        )
    return polygons


def _cuda_error_name(error: Any) -> str:
    return str(getattr(error, "name", error))


def _check_cuda(result: Any, operation: str) -> Any:
    """Check cuda-python's ``(error, value)`` or error-only return forms."""

    if isinstance(result, tuple):
        if not result:
            return None
        error, *values = result
    else:
        error, values = result, []
    error_name = _cuda_error_name(error)
    if error_name not in {
        "cudaSuccess",
        "CUDA_SUCCESS",
        "0",
    } and not error_name.endswith(".cudaSuccess"):
        raise TensorRTRuntimeError(f"{operation} failed: {error_name}")
    if not values:
        return None
    return values[0] if len(values) == 1 else tuple(values)


def _pointer(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise TensorRTRuntimeError(
            f"CUDA returned an invalid pointer {value!r}"
        ) from exc


class NativeTensorRTRuntime:
    """Persistent TensorRT execution context plus native segmentation decode."""

    def __init__(
        self,
        engine_path: str | Path,
        manifest_path: str | Path | None = None,
        device: str | None = None,
    ) -> None:
        self.engine_path = Path(engine_path)
        if not self.engine_path.is_file():
            raise TensorRTRuntimeError(
                f"TensorRT engine file does not exist: {self.engine_path}"
            )
        self.manifest_path = resolve_manifest_path(self.engine_path, manifest_path)
        self.manifest = load_engine_manifest(self.manifest_path)
        expected_hash = self.manifest.get("engine", {}).get("sha256")
        if expected_hash:
            actual_hash = hashlib.sha256(self.engine_path.read_bytes()).hexdigest()
            if actual_hash.lower() != str(expected_hash).lower():
                raise TensorRTRuntimeError(
                    f"TensorRT engine checksum does not match manifest: {self.engine_path}"
                )
        self.model_version = str(
            self.manifest.get("model_version", self.engine_path.stem)
        )
        self.task = str(self.manifest.get("task", "segment"))
        self.names = self.manifest["names"]
        self.device = device or settings.YOLO_DEVICE
        self._closed = False
        self._allocations: list[tuple[int, int]] = []
        self._host_allocations: list[_HostBuffer] = []
        self.last_timings: dict[str, float] = {}
        self._cuda_thread_state = threading.local()

        try:
            import tensorrt as trt
            from cuda.bindings import runtime as cudart
        except ImportError as exc:
            raise TensorRTRuntimeError(
                "native TensorRT requires the Linux tensorrt-cu13 and "
                "cuda-python packages; install the vision project's TensorRT extra"
            ) from exc
        self.trt = trt
        self.cudart = cudart
        self._load_engine()
        self._create_tracker()

    def _load_engine(self) -> None:
        if not str(self.device).startswith("cuda"):
            raise TensorRTRuntimeError(
                f"TensorRT requires a CUDA device, got YOLO_DEVICE={self.device!r}"
            )
        device_index = (
            int(str(self.device).split(":", 1)[1] or 0)
            if ":" in str(self.device)
            else 0
        )
        self.device_index = device_index
        _check_cuda(self.cudart.cudaSetDevice(device_index), "cudaSetDevice")

        logger = self.trt.Logger(self.trt.Logger.WARNING)
        self._trt_logger = logger
        self._trt_runtime = self.trt.Runtime(logger)
        engine_bytes = self.engine_path.read_bytes()
        self.engine = self._trt_runtime.deserialize_cuda_engine(engine_bytes)
        if self.engine is None:
            raise TensorRTRuntimeError(
                f"TensorRT could not deserialize engine {self.engine_path}; "
                "the plan may target a different GPU/TensorRT version"
            )
        self.context = self.engine.create_execution_context()
        if self.context is None:
            raise TensorRTRuntimeError("TensorRT failed to create an execution context")
        stream_result = self.cudart.cudaStreamCreate()
        self.stream = _pointer(_check_cuda(stream_result, "cudaStreamCreate"))

        input_names = []
        output_names = []
        for index in range(int(self.engine.num_io_tensors)):
            name = self.engine.get_tensor_name(index)
            mode = self.engine.get_tensor_mode(name)
            if mode == self.trt.TensorIOMode.INPUT:
                input_names.append(name)
            else:
                output_names.append(name)
        if len(input_names) != 1:
            raise TensorRTRuntimeError(
                f"expected one TensorRT input tensor, found {input_names}"
            )
        self.input_name = input_names[0]
        manifest_input = self.manifest["input"]
        if manifest_input.get("name") != self.input_name:
            raise TensorRTRuntimeError(
                f"manifest input {manifest_input.get('name')!r} does not match "
                f"engine input {self.input_name!r}"
            )
        self.input_shape = tuple(
            int(value) for value in self.engine.get_tensor_shape(self.input_name)
        )
        if any(value <= 0 for value in self.input_shape):
            raise TensorRTRuntimeError(
                "dynamic TensorRT shapes are not supported by the static runtime; "
                f"got {self.input_shape}"
            )
        manifest_shape = tuple(int(value) for value in manifest_input["shape"])
        if self.input_shape != manifest_shape:
            raise TensorRTRuntimeError(
                f"manifest input shape {manifest_shape} does not match engine shape "
                f"{self.input_shape}"
            )
        if len(self.input_shape) != 4 or self.input_shape[:2] != (1, 3):
            raise TensorRTRuntimeError(
                f"expected batch-1 3-channel NCHW input, got {self.input_shape}"
            )
        if self.input_shape[2:] != (640, 640):
            raise TensorRTRuntimeError(
                "the native runtime is intentionally fixed at 640x640; "
                f"got {self.input_shape[2:]}"
            )

        self.output_names = output_names
        output_specs = self.manifest["outputs"]
        if set(output_names) != set(output_specs):
            raise TensorRTRuntimeError(
                "manifest output names do not match engine outputs: "
                f"manifest={sorted(output_specs)}, engine={sorted(output_names)}"
            )
        self._buffers: dict[str, dict[str, Any]] = {}
        for name in [self.input_name, *self.output_names]:
            shape = tuple(int(value) for value in self.engine.get_tensor_shape(name))
            if any(value <= 0 for value in shape):
                raise TensorRTRuntimeError(
                    f"dynamic TensorRT output shape is not supported for {name}: {shape}"
                )
            dtype = np.dtype(self.trt.nptype(self.engine.get_tensor_dtype(name)))
            size = int(np.prod(shape, dtype=np.int64)) * dtype.itemsize
            device_pointer = _pointer(
                _check_cuda(self.cudart.cudaMalloc(size), f"cudaMalloc({name})")
            )
            self._allocations.append((device_pointer, size))
            host = self._allocate_host(shape, dtype)
            self._buffers[name] = {
                "shape": shape,
                "dtype": dtype,
                "nbytes": size,
                "device": device_pointer,
                "host": host,
            }
            if not self.context.set_tensor_address(name, device_pointer):
                raise TensorRTRuntimeError(f"failed to bind TensorRT tensor {name!r}")

        input_spec = self._buffers[self.input_name]
        self.input_height = int(self.input_shape[2])
        self.input_width = int(self.input_shape[3])
        if np.dtype(input_spec["dtype"]) != np.dtype(
            str(manifest_input.get("dtype", input_spec["dtype"]))
        ):
            raise TensorRTRuntimeError(
                f"manifest input dtype {manifest_input.get('dtype')!r} does not match "
                f"engine dtype {input_spec['dtype']}"
            )

    def _allocate_host(
        self, shape: tuple[int, ...], dtype: np.dtype[Any]
    ) -> _HostBuffer:
        nbytes = int(np.prod(shape, dtype=np.int64)) * dtype.itemsize
        pointer = _pointer(
            _check_cuda(self.cudart.cudaMallocHost(nbytes), "cudaMallocHost")
        )
        backing_type = ctypes.c_ubyte * nbytes
        backing = backing_type.from_address(pointer)
        array = np.frombuffer(
            backing, dtype=dtype, count=nbytes // dtype.itemsize
        ).reshape(shape)
        host = _HostBuffer(pointer, nbytes, array, backing)
        self._host_allocations.append(host)
        return host

    def _create_tracker(self) -> None:
        self._tracker = None
        if not settings.YOLO_TRACKING:
            return
        try:
            from ultralytics.trackers.byte_tracker import BYTETracker
        except ImportError as exc:
            raise TensorRTRuntimeError(
                "native TensorRT tracking requires ultralytics' BYTETracker module"
            ) from exc
        args = _load_tracker_args(settings.YOLO_TRACKER_CONFIG)
        self._tracker = BYTETracker(SimpleNamespace(**args), frame_rate=30)

    def warmup(self, iterations: int = 3) -> None:
        """Run a few zero-image launches to pay one-time CUDA setup costs."""

        if iterations <= 0:
            return
        input_buffer = self._buffers[self.input_name]["host"]
        input_buffer.array.fill(0)
        for _ in range(iterations):
            self._execute(input_buffer.array)

    def _execute(self, tensor: np.ndarray) -> dict[str, np.ndarray]:
        # yolo_worker calls infer through asyncio.to_thread. CUDA's current
        # device is thread-local, so establish it once on that worker thread
        # before using the stream created during startup.
        if not getattr(self._cuda_thread_state, "device_set", False):
            _check_cuda(
                self.cudart.cudaSetDevice(self.device_index), "cudaSetDevice(worker)"
            )
            self._cuda_thread_state.device_set = True
        started = perf_counter()
        input_buffer = self._buffers[self.input_name]
        np.copyto(input_buffer["host"].array, tensor, casting="unsafe")
        host_to_device = self.cudart.cudaMemcpyKind.cudaMemcpyHostToDevice
        device_to_host = self.cudart.cudaMemcpyKind.cudaMemcpyDeviceToHost
        _check_cuda(
            self.cudart.cudaMemcpyAsync(
                input_buffer["device"],
                input_buffer["host"].array.ctypes.data,
                input_buffer["nbytes"],
                host_to_device,
                self.stream,
            ),
            "cudaMemcpyAsync(host-to-device)",
        )
        h2d_ms = (perf_counter() - started) * 1000.0
        enqueue_started = perf_counter()
        try:
            launched = self.context.execute_async_v3(stream_handle=self.stream)
        except TypeError:
            # Some TensorRT 10 Python wheels expose the stream as a positional
            # argument even though current wheels use the keyword form.
            launched = self.context.execute_async_v3(self.stream)
        if launched is False:
            raise TensorRTRuntimeError("TensorRT execute_async_v3 returned false")
        enqueue_ms = (perf_counter() - enqueue_started) * 1000.0
        d2h_started = perf_counter()
        outputs: dict[str, np.ndarray] = {}
        for name in self.output_names:
            buffer = self._buffers[name]
            _check_cuda(
                self.cudart.cudaMemcpyAsync(
                    buffer["host"].array.ctypes.data,
                    buffer["device"],
                    buffer["nbytes"],
                    device_to_host,
                    self.stream,
                ),
                f"cudaMemcpyAsync({name}, device-to-host)",
            )
        _check_cuda(
            self.cudart.cudaStreamSynchronize(self.stream), "cudaStreamSynchronize"
        )
        d2h_ms = (perf_counter() - d2h_started) * 1000.0
        self.last_timings.update(
            {
                "h2d_ms": h2d_ms,
                # This is host dispatch time. The synchronized d2h span below
                # includes waiting for the TensorRT kernels to finish; users
                # should read it as the end-to-end device phase in this
                # Python/cuda-python benchmark.
                "trt_enqueue_ms": enqueue_ms,
                "d2h_and_sync_ms": d2h_ms,
            }
        )
        for name in self.output_names:
            outputs[name] = self._buffers[name]["host"].array
        return outputs

    def infer(self, inference_frame: Any) -> dict[str, Any]:
        """Run one decoded frame and return the service's existing result shape."""

        started = perf_counter()
        decode_started = perf_counter()
        image = inference_frame.frame.to_ndarray(format="bgr24")
        decode_ms = (perf_counter() - decode_started) * 1000.0
        frame_height, frame_width = map(int, image.shape[:2])
        input_spec = self.manifest["input"]
        preprocess_started = perf_counter()
        tensor, meta = prepare_tensor(
            image,
            self.input_height,
            self.input_width,
            dtype=self._buffers[self.input_name]["dtype"],
            color_order=str(input_spec.get("color_order", "RGB")),
            scale=float(input_spec.get("scale", 1.0 / 255.0)),
        )
        preprocess_ms = (perf_counter() - preprocess_started) * 1000.0
        outputs = self._execute(tensor)
        postprocess_started = perf_counter()
        detections = decode_segmentation_outputs(
            outputs,
            meta,
            self.manifest,
            confidence_threshold=settings.CONF_THRESHOLD_LOW,
            iou_threshold=settings.YOLO_IOU_THRESHOLD,
            max_detections=settings.YOLO_MAX_DETECTIONS,
        )
        if self._tracker is not None:
            self._apply_tracking(detections, frame_width, frame_height)
        for detection in detections:
            detection["confidence"] = round(float(detection["confidence"]), 2)
        self.last_timings.update(
            {
                "decode_ms": decode_ms,
                "preprocess_ms": preprocess_ms,
                "postprocess_tracking_ms": (perf_counter() - postprocess_started)
                * 1000.0,
                "total_ms": (perf_counter() - started) * 1000.0,
            }
        )
        return {
            "source": {
                "epoch": inference_frame.epoch,
                "seq": inference_frame.seq,
                "pts": inference_frame.pts,
                "time_base": inference_frame.time_base,
                "time": inference_frame.media_time,
                "timestamp_us": inference_frame.timestamp_us,
            },
            "width": frame_width,
            "height": frame_height,
            "items": detections,
            "inference_ms": round((perf_counter() - started) * 1000, 1),
        }

    def _apply_tracking(
        self, detections: list[dict[str, Any]], frame_width: int, frame_height: int
    ) -> None:
        if not detections:
            self._tracker.update(
                TrackerDetections(
                    np.empty((0, 4), dtype=np.float32),
                    np.empty((0, 4), dtype=np.float32),
                    np.empty((0,), dtype=np.float32),
                    np.empty((0,), dtype=np.float32),
                )
            )
            return
        boxes_xyxy = np.asarray(
            [
                _bbox_to_xyxy(
                    item["bbox"], item["bbox_format"], frame_width, frame_height
                )
                for item in detections
            ],
            dtype=np.float32,
        )
        centers = (boxes_xyxy[:, :2] + boxes_xyxy[:, 2:]) / 2.0
        sizes = boxes_xyxy[:, 2:] - boxes_xyxy[:, :2]
        boxes_xywh = np.column_stack((centers, sizes)).astype(np.float32, copy=False)
        confidences = np.asarray(
            [item["confidence"] for item in detections], dtype=np.float32
        )
        class_ids = np.asarray(
            [_class_id_from_name(item["class"], self.names) for item in detections],
            dtype=np.float32,
        )
        tracks = self._tracker.update(
            TrackerDetections(boxes_xyxy, boxes_xywh, confidences, class_ids)
        )
        if tracks is None:
            return
        for track in np.asarray(tracks):
            if len(track) < 8:
                continue
            detection_index = int(track[7])
            if 0 <= detection_index < len(detections):
                detections[detection_index]["track_id"] = int(track[4])

    def reset_tracker(self) -> None:
        if self._tracker is not None:
            self._tracker.reset()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            # The live worker is single-stream, so this also keeps an
            # in-flight launch from racing the buffer frees during shutdown.
            self.cudart.cudaStreamSynchronize(self.stream)
        except Exception:
            pass
        for host in self._host_allocations:
            try:
                self.cudart.cudaFreeHost(host.pointer)
            except Exception:
                pass
        for pointer, _size in self._allocations:
            try:
                self.cudart.cudaFree(pointer)
            except Exception:
                pass
        try:
            self.cudart.cudaStreamDestroy(self.stream)
        except Exception:
            pass

    def __enter__(self) -> "NativeTensorRTRuntime":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    def __del__(self) -> None:
        with_context = getattr(self, "_closed", True)
        if not with_context:
            try:
                self.close()
            except Exception:
                pass


def _bbox_to_xyxy(
    bbox: list[float], bbox_format: str, width: int, height: int
) -> list[float]:
    if bbox_format == "xyxy_pixels":
        return bbox
    if bbox_format == "xyxy_normalized":
        return [bbox[0] * width, bbox[1] * height, bbox[2] * width, bbox[3] * height]
    if bbox_format == "xywh_pixels":
        return [
            bbox[0] - bbox[2] / 2,
            bbox[1] - bbox[3] / 2,
            bbox[0] + bbox[2] / 2,
            bbox[1] + bbox[3] / 2,
        ]
    if bbox_format == "xywh_normalized":
        center_x, center_y, box_width, box_height = (
            bbox[0] * width,
            bbox[1] * height,
            bbox[2] * width,
            bbox[3] * height,
        )
        return [
            center_x - box_width / 2,
            center_y - box_height / 2,
            center_x + box_width / 2,
            center_y + box_height / 2,
        ]
    raise ValueError(f"unsupported bbox format {bbox_format!r}")


def _class_id_from_name(class_name: Any, names: Mapping[str, Any] | list[Any]) -> int:
    if isinstance(names, dict):
        for key, value in names.items():
            if value == class_name:
                return int(key)
        return int(class_name)
    for index, value in enumerate(names):
        if value == class_name:
            return index
    return int(class_name)


def _load_tracker_args(path: str) -> dict[str, Any]:
    defaults: dict[str, Any] = {
        "track_high_thresh": 0.25,
        "track_low_thresh": 0.1,
        "new_track_thresh": 0.35,
        "track_buffer": 30,
        "match_thresh": 0.8,
        "fuse_score": True,
    }
    try:
        import yaml

        payload = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        if isinstance(payload, dict):
            for key in defaults:
                if key in payload:
                    defaults[key] = payload[key]
    except (FileNotFoundError, OSError, ValueError):
        # The same values are the checked-in defaults. Keep the runtime usable
        # when a deployment supplies an equivalent inline/packaged config.
        pass
    return defaults
