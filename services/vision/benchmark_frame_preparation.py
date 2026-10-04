"""Compare the real frame preparation operations without either model."""

import argparse
import statistics
from time import perf_counter, process_time, thread_time

import av
import numpy as np
import ultralytics  # Apply the same OpenCV thread policy as the service.

from app.services.frame_preparation import shared_source_inputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--yolo-size", type=int, default=320)
    parser.add_argument("--frames", type=int, default=120)
    args = parser.parse_args()
    if min(args.width, args.height, args.yolo_size, args.frames) <= 0:
        parser.error("sizes and frame count must be positive")
    pixels = np.random.default_rng(2).integers(0, 256, (args.height, args.width, 3), np.uint8)
    source = av.VideoFrame.from_ndarray(pixels, format="bgr24").reformat(format="yuv420p")
    def independent():
        image = source.reformat(width=args.yolo_size, height=args.yolo_size, format="bgr24").to_ndarray()
        return image, source.to_ndarray(format="bgr24")
    def shared():
        return shared_source_inputs(source, (args.yolo_size, args.yolo_size))
    for label, operation in (("independent", independent), ("shared", shared)):
        for _ in range(10):
            operation()
        wall, caller_cpu, all_cpu = [], [], []
        for _ in range(args.frames):
            started, cpu, process = perf_counter(), thread_time(), process_time()
            operation()
            wall.append((perf_counter() - started) * 1000)
            caller_cpu.append((thread_time() - cpu) * 1000)
            all_cpu.append((process_time() - process) * 1000)
        print(f"{label}: wall_mean={statistics.mean(wall):.3f}ms "
              f"thread_cpu_mean={statistics.mean(caller_cpu):.3f}ms "
              f"process_cpu_mean={statistics.mean(all_cpu):.3f}ms")
    before, depth_before = independent()
    after, depth_after = shared()
    print(f"depth_exact={np.array_equal(depth_before, depth_after)} "
          f"yolo_pixel_mae={np.abs(before.astype(float) - after).mean():.3f}")
    print("YOLO resize order/interpolation changes; this benchmark measures preparation, not model FPS.")


if __name__ == "__main__":
    main()
