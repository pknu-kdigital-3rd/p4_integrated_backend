"""Replay identical decoded video frames through the live inference function in fresh sync/async processes."""

import argparse
import asyncio
from collections import Counter
from array import array
from contextlib import closing
from itertools import islice
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from time import perf_counter, process_time

import av
import numpy as np

from app.core.settings import settings
from app.core.state import InferenceFrame
from app.services.depth import load_depth_on_worker, make_depth_executor
from app.services.gc_runtime import configure_gc, _freeze_loaded_objects
from app.services.yolo import load_yolo_model, reset_tracker, run_yolo


def iter_frames(path, count, start):
    decoded = 0
    with av.open(str(path)) as container:
        for index, frame in enumerate(container.decode(video=0)):
            if index < start:
                continue
            yield InferenceFrame(index, frame, frame.pts,
                                 float(frame.time_base) if frame.time_base else None,
                                 frame.time, epoch=1)
            decoded += 1
            if count and decoded == count:
                return
    if count and decoded != count:
        raise ValueError(f"need {count} frames after --start-frame={start}; found {decoded}")


def read_frames(path, count, start):
    return list(iter_frames(path, count, start))


def read_warmup_frames(path, count, start):
    with closing(iter_frames(path, 0, start)) as frames:
        selected = list(islice(frames, count))
    if not selected:
        raise ValueError("video has no frames after the selected start")
    return selected


def measure_frames(frames, infer):
    # Only one float per frame is retained for exact latency percentiles.
    # Decoded images, results and detection polygons are not accumulated.
    walls = array("d")
    process_total = mask_total = count = wall_total = 0
    keys = ("yolo_thread_cpu_ms", "depth_thread_cpu_ms", "frame_convert_thread_cpu_ms",
            "postprocess_thread_cpu_ms", "model_ms", "depth_ms", "frame_convert_ms", "inference_ms")
    totals = dict.fromkeys(keys, 0.0)
    last = Counter()
    for frame in frames:
        started, cpu = perf_counter(), process_time()
        result = infer(frame)
        walls.append((perf_counter() - started) * 1000)
        wall_total += walls[-1]
        process_total += (process_time() - cpu) * 1000
        if result.get("depth", {}).get("status") != "ok":
            raise RuntimeError("depth inference failed; this is not a valid parallel comparison")
        count += 1
        for key in keys:
            totals[key] += result[key]
        mask_total += result.get("mask_count", 0)
        last[result["model_timeline"]["last_model"]] += 1
        if count % 300 == 0:
            print(f"[trt-ab-progress] frames={count} inference_wall_mean_ms={wall_total / count:.3f}", flush=True)
    if not count:
        raise ValueError("no video frames were measured")
    means = {key: total / count for key, total in totals.items()}
    return dict(means, frames=count, wall_mean_ms=float(np.mean(walls)),
                wall_p50_ms=float(np.percentile(walls, 50)), wall_p99_ms=float(np.percentile(walls, 99)),
                wall_max_ms=max(walls), process_cpu_ms=process_total / count,
                mask_mean=mask_total / count, last_model_counts=dict(last))


def run_worker(args):
    settings.YOLO_TRT_EXECUTION = args.worker
    settings.VISION_FRAME_PREP = "shared"
    settings.YOLO_PINNED_INPUT = True
    settings.VISION_CPU_PROFILE_FRAMES = 0
    if Path(settings.YOLO_MODEL).suffix.lower() != ".engine" or not settings.YOLO_DEVICE.startswith("cuda"):
        raise ValueError("comparison requires the deployment TensorRT .engine and CUDA device settings")
    warmup_frames = read_warmup_frames(args.video, min(args.warmup, args.frames) if args.frames else args.warmup,
                                     args.start_frame)
    print(f"[trt-ab-config] mode={args.worker} model={settings.YOLO_MODEL} "
          f"device={settings.YOLO_DEVICE} yolo_size={settings.YOLO_INFERENCE_SIZE} "
          f"depth_size={settings.UNIDEPTH_INFERENCE_SIZE} depth_level={settings.UNIDEPTH_RESOLUTION_LEVEL} "
          f"depth_compile_mode={settings.UNIDEPTH_COMPILE_MODE} tracking={settings.YOLO_TRACKING} "
          "frame_prep=shared pinned_input=True profile_frames=0", flush=True)
    model = load_yolo_model()
    with make_depth_executor() as executor:
        depth = asyncio.run(load_depth_on_worker(executor))
        if not depth._compiled:
            raise RuntimeError("depth fell back to eager; retain the same compiled configuration for both modes")
        def infer(frame):
            return run_yolo(frame, model, depth, executor)
        for index in range(args.warmup):
            infer(warmup_frames[index % len(warmup_frames)])
        del warmup_frames
        backend = model.predictor.model.backend
        active_async = bool(getattr(backend, "_p4_async_execution", False))
        if active_async != (args.worker == "async"):
            raise RuntimeError("requested TensorRT execution mode is not active; check startup validation")
        if active_async and not backend._p4_async_validated:
            raise RuntimeError("async TensorRT startup validation did not pass")
        # Each process begins the measured scene with the same tracker state.
        reset_tracker(model)
        configure_gc(settings.VISION_GC_GEN0_THRESHOLD)
        _freeze_loaded_objects("TensorRT comparison warmup")
        with closing(iter_frames(args.video, args.frames, args.start_frame)) as frames:
            result = measure_frames(frames, infer)
        result.update(mode=args.worker, depth_compiled=depth._compiled,
                      depth_compile_mode=depth._compile_mode, active_async=active_async)
        if not depth._compiled:
            raise RuntimeError("depth fell back during measurement; comparison is invalid")
    print("[trt-ab-result] " + json.dumps(result), flush=True)


def phase_order(rounds):
    return [(round_index + 1, mode) for round_index in range(rounds)
            for mode in (("sync", "async") if round_index % 2 == 0 else ("async", "sync"))]


def run_command(command):
    output = []
    with subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child:
        for line in child.stdout:
            print(line, end="", flush=True)
            output.append(line)
        returncode = child.wait()
    return SimpleNamespace(returncode=returncode, stdout="".join(output))


def compare(args):
    results = []
    for round_number, mode in phase_order(args.rounds):
        command = [sys.executable, str(Path(__file__).resolve()), "--worker", mode,
                   "--video", str(args.video), "--frames", str(args.frames),
                   "--start-frame", str(args.start_frame), "--warmup", str(args.warmup)]
        print(f"[trt-ab] round={round_number} mode={mode} loading/warming/measuring...", flush=True)
        completed = run_command(command)
        if completed.returncode:
            raise RuntimeError(f"{mode} benchmark process failed; no valid comparison")
        records = [line.removeprefix("[trt-ab-result] ") for line in completed.stdout.splitlines()
                   if line.startswith("[trt-ab-result] ")]
        if len(records) != 1:
            raise RuntimeError("benchmark process did not return exactly one result")
        results.append(dict(json.loads(records[0]), round=round_number))
    counts = {row["frames"] for row in results}
    if len(counts) != 1:
        raise RuntimeError("phases measured different frame counts; comparison is invalid")
    keys = ("wall_mean_ms", "wall_p99_ms", "yolo_thread_cpu_ms", "depth_thread_cpu_ms",
            "frame_convert_thread_cpu_ms", "process_cpu_ms", "model_ms", "depth_ms", "mask_mean")
    for mode in ("sync", "async"):
        phases = [row for row in results if row["mode"] == mode]
        print(f"[trt-ab-summary] mode={mode} " + " ".join(
            f"{key}={np.mean([row[key] for row in phases]):.3f}" for key in keys), flush=True)
    print("[trt-ab] isolated inference comparison; decode, browser traffic and live frame drops are excluded")
    if args.output:
        args.output.write_text(json.dumps(results, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=120, help="number of frames; 0 replays the entire video")
    parser.add_argument("--start-frame", type=int, default=0)
    parser.add_argument("--warmup", type=int, default=30)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--worker", choices=("sync", "async"), help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not (args.frames >= 0 and args.start_frame >= 0 and 1 <= args.warmup <= 600 and 1 <= args.rounds <= 4):
        parser.error("frames/start-frame must be nonnegative, warmup 1..600, and rounds 1..4")
    if not args.video.is_file():
        parser.error("video file does not exist inside this environment")
    run_worker(args) if args.worker else compare(args)


if __name__ == "__main__":
    main()
