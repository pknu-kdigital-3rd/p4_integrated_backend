"""Compare lossless packed mask transfer with the production legacy contours.

Run on the deployment GPU. This isolates mask transfer/contours, not TensorRT,
depth, browser rendering, or the complete worker's latency.
"""

import argparse
from time import perf_counter

import cv2
import numpy as np
import torch
from ultralytics.engine.results import Masks

from app.services.mask_transfer import compact_mask_polygons


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--masks", type=int, default=100)
    parser.add_argument("--height", type=int, default=360)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--iterations", type=int, default=200)
    parser.add_argument("--warmup", type=int, default=30)
    args = parser.parse_args()
    if min(args.masks, args.height, args.width, args.iterations) < 1 or args.warmup < 0:
        parser.error("dimensions, masks and iterations must be positive; warmup cannot be negative")
    host = np.zeros((args.masks, args.height, args.width), np.uint8)
    rng = np.random.default_rng(42)
    for mask in host:
        for _ in range(3):
            center = (int(rng.integers(args.width)), int(rng.integers(args.height)))
            radius = int(rng.integers(2, max(3, min(args.width, args.height) // 5)))
            cv2.circle(mask, center, radius, 1, -1)
    try:
        masks = torch.from_numpy(host).to(args.device)
        # Actually execute kernels: availability/import alone is insufficient.
        packed_polygons = compact_mask_polygons(masks, (args.height, args.width))
    except RuntimeError as exc:
        raise SystemExit(f"mask processing cannot execute on {args.device}: {exc}") from exc
    legacy = lambda: Masks(masks, (args.height, args.width)).xyn
    compact = lambda: compact_mask_polygons(masks, (args.height, args.width))
    expected = legacy()
    if len(packed_polygons) != len(expected):
        raise AssertionError("polygon count changed")
    for left, right in zip(packed_polygons, expected):
        np.testing.assert_array_equal(left, right)
    print(f"device={args.device} masks={args.masks} grid={args.width}x{args.height} polygon_equality=exact")
    print(f"mask_payload_bytes legacy={host.nbytes} packed={(host.size + 7) // 8}")
    if not masks.is_cuda:
        print("CPU smoke check only: these timings do not measure CUDA transfer or speedup.")
    for name, operation in (("legacy", legacy), ("packed", compact)):
        for _ in range(args.warmup):
            operation()
        timings = []
        for _ in range(args.iterations):
            started = perf_counter()
            operation()  # Both paths wait for their host transfer before contours.
            timings.append((perf_counter() - started) * 1000)
        print(f"{name}: mean={np.mean(timings):.3f}ms p50={np.percentile(timings, 50):.3f}ms "
              f"p99={np.percentile(timings, 99):.3f}ms max={max(timings):.3f}ms")


if __name__ == "__main__":
    main()
