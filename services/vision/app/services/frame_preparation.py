"""Prepare source-sized depth and resized YOLO inputs with one color conversion."""

import cv2


def shared_source_inputs(frame, yolo_size):
    source = frame.to_ndarray(format="bgr24")
    height, width = source.shape[:2]
    target_width, target_height = yolo_size
    interpolation = (cv2.INTER_AREA if target_width <= width and target_height <= height else cv2.INTER_LINEAR)
    image = cv2.resize(source, yolo_size, interpolation=interpolation)
    return image, source
