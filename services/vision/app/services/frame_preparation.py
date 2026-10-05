"""Prepare source-sized depth and resized YOLO inputs with one color conversion."""

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class PreparedInputs:
    """Model inputs converted from one decoded frame, possibly off the inference thread."""

    image: np.ndarray
    depth_input: np.ndarray | None
    source_width: int
    source_height: int
    imgsz: int | tuple[int, int]
    depth_enabled: bool
    convert_ms: float
    convert_cpu_ms: float


def shared_source_inputs(frame, yolo_size):
    source = frame.to_ndarray(format="bgr24")
    height, width = source.shape[:2]
    target_width, target_height = yolo_size
    interpolation = (cv2.INTER_AREA if target_width <= width and target_height <= height else cv2.INTER_LINEAR)
    image = cv2.resize(source, yolo_size, interpolation=interpolation)
    return image, source
