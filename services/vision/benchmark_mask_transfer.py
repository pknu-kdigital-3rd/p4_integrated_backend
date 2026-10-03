"""Compare GPU contours, packed masks and production legacy contours.

Run on the deployment GPU. This isolates mask transfer/contours, not TensorRT,
depth, browser rendering, or the complete worker's latency.
"""

import argparse
from time import perf_counter, process_time

import cv2
import numpy as np
import torch
from ultralytics.engine.results import Masks
from ultralytics.data.converter import merge_multi_segment
from ultralytics.utils import ops

from app.services.mask_transfer import compact_mask_polygons
from app.services.gpu_contours import gpu_mask_polygons
from app.services.yolo import _bounded_mask_polygon


def component_cap_reference(host, max_points):
    """CPU setup oracle for the GPU per-component point bound, not a timed path."""
    polygons = []
    vertex_count = 0
    for mask in host:
        contours = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
        contours = [_bounded_mask_polygon(c.reshape(-1, 2).astype(np.float32), max_points) for c in contours]
        vertex_count += sum(len(contour) for contour in contours)
        polygon = (np.concatenate(merge_multi_segment(contours)) if len(contours) > 1 else
                   contours[0] if contours else np.empty((0, 2), np.float32))
        polygons.append(ops.scale_coords(mask.shape, polygon, mask.shape, normalize=True))
    return polygons, vertex_count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--masks", type=int, default=100)
    parser.add_argument("--height", type=int, default=360)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--iterations", type=int, default=200)
    parser.add_argument("--warmup", type=int, default=30)
    parser.add_argument("--max-points", type=int, default=256)
    parser.add_argument("--max-components", type=int, default=32)
    parser.add_argument("--modes", choices=("legacy", "packed", "gpu"), nargs="+")
    args = parser.parse_args()
    if min(args.masks, args.height, args.width, args.iterations) < 1 or args.warmup < 0:
        parser.error("dimensions, masks and iterations must be positive; warmup cannot be negative")
    if not 3 <= args.max_points <= 4096 or not 1 <= args.max_components <= 256:
        parser.error("max-points must be 3..4096 and max-components must be 1..256")
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
    modes = args.modes or (["legacy", "packed", "gpu"] if masks.is_cuda else ["legacy", "packed"])
    operations = {"legacy": legacy, "packed": compact}
    if "gpu" in modes:
        if not masks.is_cuda:
            parser.error("gpu mode requires a CUDA device")
        operations["gpu"] = lambda: gpu_mask_polygons(
            masks, (args.height, args.width), max_points=args.max_points, max_components=args.max_components,
        )
        reference, vertex_count = component_cap_reference(host, args.max_points)
        actual = operations["gpu"]()
        if len(actual) != len(reference):
            raise AssertionError("GPU polygon count changed")
        for left, right in zip(actual, reference):
            np.testing.assert_array_equal(left, right)
        metadata_bytes = args.masks * (2 + 3 * args.max_components) * 4
        print(f"gpu_component_geometry=exact vertices={vertex_count} "
              f"gpu_transfer_bytes={metadata_bytes + vertex_count * 8}")
    print(f"device={args.device} masks={args.masks} grid={args.width}x{args.height} polygon_equality=exact")
    print(f"mask_payload_bytes legacy={host.nbytes} packed={(host.size + 7) // 8}")
    if not masks.is_cuda:
        print("CPU smoke check only: these timings do not measure CUDA transfer or speedup.")
    for name in modes:
        operation = operations[name]
        for _ in range(args.warmup):
            operation()
        timings = []
        cpu_timings = []
        for _ in range(args.iterations):
            started = perf_counter()
            cpu_started = process_time()
            operation()  # Both paths wait for their host transfer before contours.
            timings.append((perf_counter() - started) * 1000)
            cpu_timings.append((process_time() - cpu_started) * 1000)
        print(f"{name}: mean={np.mean(timings):.3f}ms p50={np.percentile(timings, 50):.3f}ms "
              f"p99={np.percentile(timings, 99):.3f}ms max={max(timings):.3f}ms "
              f"process_cpu_mean={np.mean(cpu_timings):.3f}ms")


if __name__ == "__main__":
    main()
