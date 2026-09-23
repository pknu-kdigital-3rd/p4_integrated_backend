"""Exercise the bounded production inference queue with a 1080p video at 30 FPS.

Run on the deployment GPU with ``YOLO_MODEL`` set to the TensorRT ``.engine``
file. The script warms the model, paces decoded frames at the configured input
rate, uses the production inference worker and drop policy, and records memory,
queue, throughput, and stage timing samples to CSV. Relay/WebSocket delivery is
verified separately with the live smoke test in ``BENCHMARK_YOLO.md``.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
from pathlib import Path
from time import monotonic

import av
import psutil
import torch

from app.core.settings import settings
from app.core.state import AppState, InferenceFrame
from app.services.depth import load_depth_estimator, make_depth_executor
from app.services.yolo import (
    _enqueue_inference_frame,
    load_yolo_model,
    reset_tracker,
    run_yolo,
    yolo_worker,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--duration-seconds", type=int, default=600)
    parser.add_argument("--warmup-frames", type=int, default=30)
    parser.add_argument("--input-fps", type=float, default=30.0)
    parser.add_argument("--report-interval-seconds", type=float, default=5.0)
    parser.add_argument("--csv", type=Path, default=Path("pipeline-benchmark.csv"))
    return parser.parse_args()


def _next_video_frame(container, stream, decoder):
    try:
        return next(decoder), decoder
    except StopIteration:
        container.seek(0, stream=stream)
        decoder = iter(container.decode(stream))
        try:
            return next(decoder), decoder
        except StopIteration as exc:
            raise RuntimeError("video contains no decodable frames") from exc


def _mean_stage_ms(current: dict, previous: dict, key: str, inferred_delta: int) -> float:
    if inferred_delta <= 0:
        return 0.0
    return max(0.0, float(current[key]) - float(previous[key])) / inferred_delta


async def _run(args: argparse.Namespace) -> None:
    if args.duration_seconds < 1 or args.warmup_frames < 0:
        raise SystemExit("duration must be positive and warmup cannot be negative")
    if args.input_fps <= 0 or args.report_interval_seconds < 1:
        raise SystemExit("input FPS must be positive and report interval at least 1s")
    if not args.video.is_file():
        raise SystemExit(f"video file does not exist: {args.video}")
    if Path(settings.YOLO_MODEL).suffix.lower() != ".engine":
        raise SystemExit("set YOLO_MODEL to the deployment TensorRT .engine file")
    if not settings.YOLO_DEVICE.startswith("cuda") or not torch.cuda.is_available():
        raise SystemExit("the overload benchmark requires YOLO_DEVICE=cuda:0")
    if settings.YOLO_FRAME_DROP_POLICY != "latest":
        raise SystemExit("set YOLO_FRAME_DROP_POLICY=latest for this benchmark")
    if not settings.YOLO_RETINA_MASKS or settings.YOLO_MASK_CONTOUR_SIZE != 640:
        raise SystemExit(
            "set YOLO_RETINA_MASKS=true and YOLO_MASK_CONTOUR_SIZE=640"
        )

    container = av.open(str(args.video))
    video_stream = next(iter(container.streams.video), None)
    if video_stream is None:
        container.close()
        raise SystemExit("video file has no video stream")
    source_fps = (
        float(video_stream.average_rate) if video_stream.average_rate else None
    )
    if source_fps is not None and abs(source_fps - args.input_fps) > 0.5:
        container.close()
        raise SystemExit(
            f"source is {source_fps:.3f} FPS; expected a 30 FPS source"
        )

    decoder = iter(container.decode(video_stream))
    try:
        first_frame = next(decoder)
    except StopIteration as exc:
        container.close()
        raise SystemExit("video contains no decodable frames") from exc
    if (first_frame.width, first_frame.height) != (1920, 1080):
        container.close()
        raise SystemExit(
            f"source is {first_frame.width}x{first_frame.height}; expected 1920x1080"
        )

    model = load_yolo_model()
    depth_model = load_depth_estimator()
    depth_executor = make_depth_executor()
    print(
        f"engine={settings.YOLO_MODEL} gpu={torch.cuda.get_device_name(0)} "
        f"source={first_frame.width}x{first_frame.height}@{source_fps or args.input_fps:.3f} "
        f"offered_fps={args.input_fps:.3f} queue={settings.YOLO_INFERENCE_QUEUE_SIZE} "
        f"retina_masks={settings.YOLO_RETINA_MASKS} "
        f"contour_size={settings.YOLO_MASK_CONTOUR_SIZE}",
        flush=True,
    )
    warmup_frame = InferenceFrame(
        epoch=1,
        seq=-1,
        frame=first_frame,
        pts=0,
        time_base=1 / 90000,
        media_time=0.0,
        timestamp_us=0,
        keyframe=True,
    )
    print(f"warming the production path ({args.warmup_frames} frames)...", flush=True)
    for warmup_index in range(args.warmup_frames):
        warmup_frame.seq = -warmup_index - 1
        run_yolo(warmup_frame, model, depth_model, depth_executor)
    torch.cuda.synchronize()
    reset_tracker(model)
    torch.cuda.reset_peak_memory_stats(torch.device(settings.YOLO_DEVICE))

    state = AppState(
        yolo_model=model,
        depth_model=depth_model,
        depth_executor=depth_executor,
        current_epoch=1,
    )
    process = psutil.Process()
    args.csv.parent.mkdir(parents=True, exist_ok=True)
    columns = [
        "elapsed_seconds",
        "input_frames",
        "input_fps",
        "inferred_frames",
        "infer_fps",
        "dropped_frames",
        "published_frames",
        "playback_fps",
        "queue_depth",
        "queue_limit",
        "queue_max_observed",
        "completed_cache",
        "rss_mib",
        "cuda_allocated_mib",
        "cuda_reserved_mib",
        "cuda_interval_peak_mib",
        "frame_convert_ms",
        "model_ms",
        "depth_ms",
        "postprocess_ms",
    ]
    input_frames = 0
    max_queue_observed = 0
    feed_started = monotonic()
    previous_at = feed_started
    previous = state.metrics.snapshot()
    peak_rss = 0
    stop_reporter = asyncio.Event()

    def write_sample() -> None:
        nonlocal previous, previous_at, peak_rss
        now = monotonic()
        elapsed = max(now - previous_at, 1e-6)
        current = state.metrics.snapshot()
        inferred_delta = int(current["frames_inferred"]) - int(
            previous["frames_inferred"]
        )
        row = {
            "elapsed_seconds": round(now - feed_started, 1),
            "input_frames": input_frames,
            "input_fps": round(
                (input_frames - int(previous["decoded_frames_received"])) / elapsed,
                2,
            ),
            "inferred_frames": current["frames_inferred"],
            "infer_fps": round(inferred_delta / elapsed, 2),
            "dropped_frames": current["inference_frames_dropped"],
            "published_frames": current["playback_frames_published"],
            "playback_fps": round(
                (
                    int(current["playback_frames_published"])
                    - int(previous["playback_frames_published"])
                )
                / elapsed,
                2,
            ),
            "queue_depth": state.inference_queue.qsize(),
            "queue_limit": state.inference_queue.maxsize,
            "queue_max_observed": max_queue_observed,
            "completed_cache": len(state.completed_sequences),
            "rss_mib": round(process.memory_info().rss / 1024**2, 1),
            "cuda_allocated_mib": round(
                torch.cuda.memory_allocated(settings.YOLO_DEVICE) / 1024**2, 1
            ),
            "cuda_reserved_mib": round(
                torch.cuda.memory_reserved(settings.YOLO_DEVICE) / 1024**2, 1
            ),
            "cuda_interval_peak_mib": round(
                torch.cuda.max_memory_allocated(settings.YOLO_DEVICE) / 1024**2,
                1,
            ),
            "frame_convert_ms": _mean_stage_ms(
                current, previous, "frame_convert_ms_total", inferred_delta
            ),
            "model_ms": _mean_stage_ms(
                current, previous, "model_ms_total", inferred_delta
            ),
            "depth_ms": _mean_stage_ms(
                current, previous, "depth_ms_total", inferred_delta
            ),
            "postprocess_ms": _mean_stage_ms(
                current, previous, "postprocess_ms_total", inferred_delta
            ),
        }
        writer.writerow(row)
        output.flush()
        print(
            "[benchmark] "
            f"t={row['elapsed_seconds']:.0f}s input={row['input_fps']:.1f}fps "
            f"infer={row['infer_fps']:.1f}fps playback={row['playback_fps']:.1f}fps "
            f"queue={row['queue_depth']}/{row['queue_limit']} "
            f"drops={row['dropped_frames']} rss={row['rss_mib']:.0f}MiB "
            f"cuda={row['cuda_allocated_mib']:.0f}/"
            f"{row['cuda_reserved_mib']:.0f}MiB",
            flush=True,
        )
        peak_rss = max(peak_rss, process.memory_info().rss)
        torch.cuda.reset_peak_memory_stats(torch.device(settings.YOLO_DEVICE))
        previous = current
        previous_at = now

    async def acknowledge_presented_frames() -> None:
        next_seq = 0
        while True:
            async with state.result_condition:
                advanced = False
                while (state.current_epoch, next_seq) in state.result_store:
                    state.acknowledge(state.current_epoch, next_seq)
                    next_seq += 1
                    advanced = True
                if not advanced:
                    await state.result_condition.wait()

    async def report_metrics() -> None:
        while not stop_reporter.is_set():
            try:
                await asyncio.wait_for(
                    stop_reporter.wait(), timeout=args.report_interval_seconds
                )
            except TimeoutError:
                write_sample()
        write_sample()

    with args.csv.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=columns)
        writer.writeheader()
        worker_task = asyncio.create_task(yolo_worker(state))
        ack_task = asyncio.create_task(acknowledge_presented_frames())
        reporter_task = asyncio.create_task(report_metrics())
        try:
            next_frame_at = feed_started
            feed_deadline = feed_started + args.duration_seconds
            video_decoder = decoder
            next_video_frame = first_frame
            while monotonic() < feed_deadline:
                if next_video_frame is None:
                    next_video_frame, video_decoder = _next_video_frame(
                        container, video_stream, video_decoder
                    )
                seq = input_frames
                inference_frame = InferenceFrame(
                    epoch=state.current_epoch,
                    seq=seq,
                    frame=next_video_frame,
                    pts=round(seq * 90000 / args.input_fps),
                    time_base=1 / 90000,
                    media_time=seq / args.input_fps,
                    encoded=b"",
                    timestamp_us=round(seq * 1_000_000 / args.input_fps),
                    keyframe=(seq == 0),
                )
                state.metrics.decoded_frames_received += 1
                state.queued_sequences.add((inference_frame.epoch, inference_frame.seq))
                await _enqueue_inference_frame(state, inference_frame)
                input_frames += 1
                max_queue_observed = max(
                    max_queue_observed, state.inference_queue.qsize()
                )
                next_video_frame, video_decoder = _next_video_frame(
                    container, video_stream, video_decoder
                )
                next_frame_at += 1 / args.input_fps
                await asyncio.sleep(max(0.0, next_frame_at - monotonic()))

            feed_finished = monotonic()
            last_seq = input_frames - 1
            drain_deadline = monotonic() + 180
            while (
                (state.current_epoch, last_seq) not in state.completed_sequences
                or not state.inference_queue.empty()
                or state.inference_active
            ):
                if state.fault:
                    raise RuntimeError(state.fault)
                if monotonic() >= drain_deadline:
                    raise TimeoutError("timed out draining the final inference frame")
                await asyncio.sleep(0.05)

            if state.metrics.playback_frames_published < input_frames:
                raise RuntimeError(
                    "some input frames were not published through the inference result path"
                )
            if max_queue_observed > state.inference_queue.maxsize:
                raise RuntimeError("the inference queue exceeded its configured bound")
            write_sample()
        finally:
            stop_reporter.set()
            await reporter_task
            ack_task.cancel()
            worker_task.cancel()
            await asyncio.gather(ack_task, worker_task, return_exceptions=True)
            container.close()
            await asyncio.to_thread(depth_executor.shutdown, wait=True, cancel_futures=True)

    feed_elapsed = max(feed_finished - feed_started, 1e-6)
    total_elapsed = max(monotonic() - feed_started, 1e-6)
    totals = state.metrics.snapshot()
    published = int(totals["playback_frames_published"])
    print("\nBenchmark summary")
    print(f"  feed duration       : {feed_elapsed:.1f} s")
    print(f"  source frames       : {input_frames} ({input_frames / feed_elapsed:.2f} FPS)")
    print(f"  inferred frames     : {totals['frames_inferred']}")
    print(f"  skipped inference   : {totals['inference_frames_dropped']}")
    print(
        f"  published frames    : {published} ({published / total_elapsed:.2f} FPS, "
        f"including {total_elapsed - feed_elapsed:.1f}s drain)"
    )
    print(
        f"  queue bound         : {max_queue_observed}/"
        f"{state.inference_queue.maxsize} frames"
    )
    print(f"  peak sampled RSS    : {peak_rss / 1024**2:.1f} MiB")
    print(f"  CSV samples         : {args.csv.resolve()}")
    if totals["inference_frames_dropped"] == 0:
        print("  load note           : this engine kept up with the offered 30 FPS stream")


def main() -> None:
    args = _parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
