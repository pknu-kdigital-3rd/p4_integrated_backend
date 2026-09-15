from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

import cv2
import numpy as np
import torch
from PIL import Image

from app.core.settings import settings
from app.core.state import InferenceFrame


@dataclass
class Sam3Model:
    """Loaded SAM3 model and its text-prompt processor."""

    model: Any
    processor: Any
    checkpoint_path: str
    prompt: str
    device: str


def load_sam3_model() -> Sam3Model:
    """Load SAM3 using the same builder and processor as sam3_ex01.ipynb."""

    try:
        from sam3.model.sam3_image_processor import Sam3Processor
        from sam3.model_builder import build_sam3_image_model
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "SAM3 is selected but its source package is unavailable. Install "
            "the SAM3 checkout (for example, `uv pip install -e /workspace/sam3`) "
            "before starting the vision service."
        ) from exc

    checkpoint = Path(settings.SAM3_CHECKPOINT_PATH)
    bpe_path = Path(settings.SAM3_BPE_PATH)
    if not checkpoint.is_file():
        raise FileNotFoundError(f"SAM3 checkpoint not found: {checkpoint}")
    if not bpe_path.is_file():
        raise FileNotFoundError(f"SAM3 BPE vocabulary not found: {bpe_path}")

    device = settings.SAM3_DEVICE
    if device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError(f"SAM3 device {device!r} requested but CUDA is unavailable")

    print(f"SAM3 inference device: {device}")
    model = build_sam3_image_model(
        bpe_path=str(bpe_path),
        checkpoint_path=str(checkpoint),
        load_from_HF=False,
        device=device,
    )
    model.eval()
    model.to(device)
    processor = Sam3Processor(model)
    return Sam3Model(
        model=model,
        processor=processor,
        checkpoint_path=str(checkpoint),
        prompt=settings.SAM3_PROMPT,
        device=device,
    )


def reset_sam3(_: Sam3Model) -> None:
    """SAM3 image prompting is stateless between frames."""


def _as_numpy(value: Any) -> np.ndarray:
    if value is None:
        return np.empty((0,))
    if hasattr(value, "detach"):
        return value.detach().float().cpu().numpy()
    return np.asarray(value)


def _normalised_box(box: Any, width: int, height: int) -> list[float] | None:
    values = _as_numpy(box).reshape(-1)
    if values.size < 4:
        return None
    x1, y1, x2, y2 = map(float, values[:4])
    # The notebook treats SAM3 boxes as pixel coordinates. Accept normalized
    # coordinates too so this adapter remains compatible with package updates.
    if max(abs(x1), abs(y1), abs(x2), abs(y2)) <= 1.5:
        normalized = [x1, y1, x2, y2]
    else:
        normalized = [x1 / width, y1 / height, x2 / width, y2 / height]
    left, top, right, bottom = normalized
    left = max(0.0, min(1.0, left))
    top = max(0.0, min(1.0, top))
    right = max(0.0, min(1.0, right))
    bottom = max(0.0, min(1.0, bottom))
    if right <= left or bottom <= top:
        return None
    return [left, top, right, bottom]


def _normalised_polygon(mask: Any, width: int, height: int) -> list[list[float]] | None:
    array = np.squeeze(_as_numpy(mask))
    if array.ndim != 2 or not array.size:
        return None
    if array.shape != (height, width):
        array = cv2.resize(array, (width, height), interpolation=cv2.INTER_NEAREST)
    binary = (array > 0.5).astype(np.uint8)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if len(contour) < 3:
        return None
    points = cv2.approxPolyDP(contour, epsilon=1.0, closed=True).reshape(-1, 2)
    if len(points) < 3:
        return None
    return [[float(x) / width, float(y) / height] for x, y in points]


def run_sam3(inference_frame: InferenceFrame, sam3_model: Sam3Model) -> dict:
    start = perf_counter()
    image_array = inference_frame.frame.to_ndarray(format="rgb24")
    height, width = image_array.shape[:2]
    image = Image.fromarray(image_array, mode="RGB")
    autocast = (
        torch.autocast(device_type="cuda", dtype=torch.bfloat16)
        if sam3_model.device.startswith("cuda")
        else nullcontext()
    )
    with torch.inference_mode(), autocast:
        state = sam3_model.processor.set_image(image)
        output = sam3_model.processor.set_text_prompt(
            state=state,
            prompt=sam3_model.prompt,
        )

    boxes = _as_numpy(output.get("boxes"))
    masks = _as_numpy(output.get("masks"))
    scores = _as_numpy(output.get("scores")).reshape(-1)
    if boxes.size == 0:
        boxes = np.empty((0, 4), dtype=np.float32)
    elif boxes.ndim == 1:
        boxes = boxes.reshape(-1, 4)
    if masks.size == 0:
        masks = np.empty((0,), dtype=np.float32)
    elif masks.ndim == 2:
        masks = masks[np.newaxis, ...]
    items: list[dict[str, Any]] = []
    count = min(len(boxes), len(scores), settings.SAM3_MAX_DETECTIONS)
    for index in range(count):
        score = float(scores[index])
        if score < settings.SAM3_SCORE_THRESHOLD:
            continue
        bbox = _normalised_box(boxes[index], width, height)
        if bbox is None:
            continue
        item: dict[str, Any] = {
            "class": sam3_model.prompt,
            "confidence": round(score, 2),
            "bbox": bbox,
            "bbox_format": "xyxy_normalized",
        }
        if len(masks) > index:
            polygon = _normalised_polygon(masks[index], width, height)
            if polygon is not None:
                item["mask"] = polygon
                item["mask_format"] = "polygon_normalized"
        items.append(item)

    return {
        "source": {
            "epoch": inference_frame.epoch,
            "seq": inference_frame.seq,
            "pts": inference_frame.pts,
            "time_base": inference_frame.time_base,
            "time": inference_frame.media_time,
            "timestamp_us": inference_frame.timestamp_us,
        },
        "width": width,
        "height": height,
        "items": items,
        "inference_ms": round((perf_counter() - start) * 1000, 1),
    }
