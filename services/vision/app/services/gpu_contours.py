"""Native GPU component labeling and ordered external contour extraction."""

from __future__ import annotations

from threading import local

import numpy as np
import torch
from ultralytics.data.converter import merge_multi_segment
from ultralytics.utils import ops

from app.services.mask_transfer import _copy_tensor_to_host
from app.services.cuda_contour_runtime import contour_kernels


_workspace_state = local()


def assemble_polygons(metadata: np.ndarray, counts: np.ndarray, payload: np.ndarray,
                      mask_shape: tuple[int, int], orig_shape: tuple[int, int]) -> list[np.ndarray]:
    """Merge only compact GPU-extracted contours, then normalize coordinates.

    OpenCV returns components in reverse raster-start order. Atomic GPU slot
    assignment is unordered, so restore that order before the fork's existing
    bridge construction. This function does no mask scanning or tracing.
    """
    cursor = 0
    polygons = []
    for instance, count in enumerate(counts):
        components = []
        for root, size, _total in metadata[instance, :int(count)]:
            size = int(size)
            contour = payload[cursor:cursor + size].astype(np.float32, copy=True)
            cursor += size
            components.append((int(root), contour))
        components.sort(key=lambda item: item[0], reverse=True)
        contours = [contour for _, contour in components]
        if not contours:
            polygon = np.empty((0, 2), dtype=np.float32)
        elif len(contours) == 1:
            polygon = contours[0]
        else:
            polygon = np.concatenate(merge_multi_segment(contours)).astype(np.float32, copy=False)
        polygons.append(ops.scale_coords(mask_shape, polygon, orig_shape, normalize=True))
    if cursor != len(payload):
        raise ValueError("GPU contour payload length does not match its metadata")
    return polygons


@torch.inference_mode()
def gpu_mask_polygons(masks: torch.Tensor, orig_shape: tuple[int, int], *,
                      max_points: int = 256, max_components: int = 32) -> list[np.ndarray]:
    """Trace external contours on CUDA; transfer only bounded vertices/metadata.

    Component count overflow or an invalid walk is an explicit error. There is
    no silent CPU contour fallback and no dropping disconnected components.
    """
    if not masks.is_cuda or masks.ndim != 3:
        raise ValueError("GPU contours require an NHW CUDA tensor")
    count, height, width = map(int, masks.shape)
    if not 3 <= max_points <= 4096 or not 1 <= max_components <= 256:
        raise ValueError("invalid GPU contour point/component bounds")
    if count == 0:
        return []
    if count > 300 or not 1 <= height <= 640 or not 1 <= width <= 640:
        raise ValueError("GPU contours require at most 300 masks on a grid no larger than 640x640")
    masks = masks.to(dtype=torch.uint8).contiguous()
    key = (tuple(masks.shape), masks.device, max_points, max_components)
    if getattr(_workspace_state, "key", None) != key:
        _workspace_state.buffers = (
            torch.empty((count, (height + 2) * (width + 2)), dtype=torch.int32, device=masks.device),
            torch.empty(count, dtype=torch.int32, device=masks.device),
            torch.empty((count, max_components, 3), dtype=torch.int32, device=masks.device),
            torch.empty((count, max_components, max_points, 2), dtype=torch.int32, device=masks.device),
            torch.empty(count, dtype=torch.int32, device=masks.device),
        )
        _workspace_state.key = key
    parents, counts, metadata, points, errors = _workspace_state.buffers
    with torch.cuda.device(masks.device):
        stream = torch.cuda.current_stream(masks.device)
        kernels = contour_kernels(masks.device.index)
        # All native kernels use the caller's stream, after mask reconstruction
        # and before the metadata/vertex copies. Keep owners alive until copies
        # complete, including on errors, so allocator reuse cannot race kernels.
        try:
            kernels.run(
                masks.data_ptr(), parents.data_ptr(), counts.data_ptr(), metadata.data_ptr(),
                points.data_ptr(), errors.data_ptr(), count, height, width, max_components,
                max_points, stream.cuda_stream,
            )
            diagnostics = torch.cat((counts[:, None], errors[:, None], metadata.reshape(count, -1)), dim=1)
            host = _copy_tensor_to_host(diagnostics, slot="metadata").copy()
            host_counts = host[:, 0]
            host_metadata = host[:, 2:].reshape(count, max_components, 3)
            if np.any(host[:, 1] == 2):
                raise RuntimeError("GPU contour walk did not close; no partial polygons published")
            if np.any(host[:, 1] != 0) or np.any(host_counts > max_components):
                raise RuntimeError(
                    f"GPU contour component limit ({max_components}) exceeded; "
                    "increase YOLO_GPU_CONTOUR_MAX_COMPONENTS or select packed transfer"
                )
            chunks = [points[n, slot, :int(host_metadata[n, slot, 1])]
                      for n in range(count) for slot in range(int(host_counts[n]))]
            payload = (_copy_tensor_to_host(torch.cat(chunks), slot="vertices").copy() if chunks else
                       np.empty((0, 2), dtype=np.int32))
        except BaseException:
            stream.synchronize()
            raise
    return assemble_polygons(host_metadata, host_counts, payload, (height, width), orig_shape)


def validate_gpu_contours(device: str) -> None:
    """Exercise the native operation on startup, including a hole/components."""
    from ultralytics.engine.results import Masks

    host = torch.zeros((2, 13, 17), dtype=torch.uint8)
    host[0, 1:12, 2:15] = 1
    host[0, 4:9, 5:12] = 0
    host[1, 0:4, 0:5] = 1
    host[1, 8:13, 12:17] = 1
    expected = Masks(host, (13, 17)).xyn
    actual = gpu_mask_polygons(host.to(device), (13, 17))
    if len(actual) != len(expected):
        raise RuntimeError("GPU contour startup result count validation failed")
    for left, right in zip(actual, expected):
        if not np.array_equal(left, right):
            raise RuntimeError("GPU contour startup geometry validation failed")
