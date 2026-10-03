"""Lossless mask compaction before the device-to-host boundary.

The wire protocol remains normalized polygons. Only the internal mask transfer
is bit-packed; contour ordering, disconnected components and scaling continue
to use the installed Ultralytics implementation.
"""

from __future__ import annotations

from threading import local

import numpy as np
import torch
import torch.nn.functional as F
from ultralytics.engine.results import Masks


_transfer_state = local()


def pack_binary_masks(masks: torch.Tensor) -> torch.Tensor:
    """Pack binary NHW masks, least significant bit first, on their device.

    The caller supplies binary values (0/1), as produced by YOLO. Flattening
    across instance boundaries avoids row/instance padding and keeps the output
    size known without a GPU reduction or a host synchronization.
    """
    if masks.ndim != 3:
        raise ValueError("masks must have shape (instances, height, width)")
    pixels = masks.reshape(-1).to(dtype=torch.uint8)
    padding = (-pixels.numel()) % 8
    if padding:
        pixels = F.pad(pixels, (0, padding))
    # Reuse the tiny device constant: constructing it every frame would add a
    # host-to-device copy to the hot path.
    weights = getattr(_transfer_state, "weights", None)
    if weights is None or weights.device != masks.device:
        weights = torch.tensor([1, 2, 4, 8, 16, 32, 64, 128],
                               dtype=torch.uint8, device=masks.device)
        _transfer_state.weights = weights
    return (pixels.reshape(-1, 8) * weights).sum(dim=1, dtype=torch.uint8)


def unpack_binary_masks(packed: np.ndarray, shape: tuple[int, int, int]) -> np.ndarray:
    """Restore contiguous uint8 NHW masks, discarding the final byte's padding."""
    if len(shape) != 3 or any(size < 0 for size in shape):
        raise ValueError("mask shape must contain three nonnegative dimensions")
    count = int(np.prod(shape))
    if packed.dtype != np.uint8 or packed.ndim != 1 or packed.size != (count + 7) // 8:
        raise ValueError("packed mask payload does not match its shape")
    return np.unpackbits(packed, bitorder="little", count=count).reshape(shape)


def _copy_tensor_to_host(packed: torch.Tensor, *, slot: str = "default") -> np.ndarray:
    if slot not in {"default", "metadata", "vertices", "boxes", "depth", "mask_validity"}:
        raise ValueError("unknown host transfer buffer slot")
    if not packed.is_cuda:
        return packed.detach().cpu().numpy()
    # Keep a fixed set of buffers for different transfer purposes so alternating
    # shapes do not replace pinned allocations several times per frame. Each
    # slot retains only its current shape, not every observed input size.
    attribute = "host" if slot == "default" else f"host_{slot}"
    host = getattr(_transfer_state, attribute, None)
    if host is None or host.shape != packed.shape or host.dtype != packed.dtype:
        host = torch.empty(packed.shape, dtype=packed.dtype, pin_memory=True)
        setattr(_transfer_state, attribute, host)
    stream = torch.cuda.current_stream(packed.device)
    ready = getattr(_transfer_state, "ready", None)
    if ready is None or ready.device != packed.device:
        # Default CUDA event synchronization busy-waits on the host. Sleep
        # while the GPU finishes instead of spending a CPU core on the wait.
        ready = torch.cuda.Event(blocking=True)
        _transfer_state.ready = ready
    # Copy follows packing on the same stream. Wait before NumPy reads pinned
    # memory or the next frame reuses it. This does not overlap inference frames.
    try:
        host.copy_(packed.detach(), non_blocking=True)
        ready.record(stream)
        ready.synchronize()
    except BaseException:
        stream.synchronize()
        raise
    return host.numpy()


def compact_mask_polygons(masks: torch.Tensor, orig_shape: tuple[int, int]) -> list[np.ndarray]:
    """Transfer packed masks and extract the same polygons as Masks.xyn."""
    shape = tuple(map(int, masks.shape))
    packed = pack_binary_masks(masks)
    restored = unpack_binary_masks(_copy_tensor_to_host(packed), shape)
    # Reuse the fork's contour merging and letterbox-aware normalization rather
    # than duplicating their geometry rules. NumPy data causes no second copy
    # across the GPU boundary, and depth continues to use the original tensor.
    return Masks(restored, orig_shape).xyn
