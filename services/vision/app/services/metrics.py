"""Low-overhead runtime metrics for the Vision media/inference pipeline."""

from __future__ import annotations

import asyncio
import gc
import os
import sys
import tracemalloc
from time import monotonic

import torch

try:
    import psutil
except ImportError:  # pragma: no cover - dependency is present in deployments
    psutil = None

try:
    import resource
except ImportError:  # pragma: no cover - resource is not available on Windows
    resource = None

from app.core.settings import settings
from app.core.state import AppState
from app.services.gc_stats import install


_PROCESS = psutil.Process(os.getpid()) if psutil is not None else None


def _rss_bytes() -> int:
    if _PROCESS is not None:
        return int(_PROCESS.memory_info().rss)
    if resource is not None:
        # Linux reports KiB; macOS reports bytes. The Linux deployment is the
        # supported target, while this fallback keeps local diagnostics useful.
        value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        return value * (1 if sys.platform == "darwin" else 1024)
    return 0


def _cuda_memory() -> tuple[int, int, int, int]:
    """Return current allocated/reserved and process peak CUDA bytes."""

    if not settings.YOLO_DEVICE.startswith("cuda") or not torch.cuda.is_available():
        return 0, 0, 0, 0
    try:
        device = torch.device(settings.YOLO_DEVICE)
        with torch.cuda.device(device):
            allocated = int(torch.cuda.memory_allocated(device))
            reserved = int(torch.cuda.memory_reserved(device))
            peak_allocated = int(torch.cuda.max_memory_allocated(device))
            peak_reserved = int(torch.cuda.max_memory_reserved(device))
            # Reset only at the five-second diagnostic boundary, never per
            # frame, so the next report shows a useful interval peak.
            torch.cuda.reset_peak_memory_stats(device)
        return allocated, reserved, peak_allocated, peak_reserved
    except (AssertionError, RuntimeError, ValueError):
        return 0, 0, 0, 0


def _rate(delta: float, elapsed: float) -> float:
    return max(0.0, delta) / max(elapsed, 1e-6)


def _average_ms(
    current: dict[str, float | int],
    previous: dict[str, float | int],
    total_key: str,
    count_delta: int,
) -> float:
    if count_delta <= 0:
        return 0.0
    return (
        max(
            0.0,
            float(current[total_key]) - float(previous[total_key]),
        )
        / count_delta
    )


def _gc_report(
    current: dict[str, float | int],
    previous: dict[str, float | int],
    max_pause_ms: float,
    inferred_delta: int,
    elapsed: float,
    count_tracked: int | None,
    *,
    threshold: tuple[int, int, int],
    frozen: int,
) -> str:
    """Format an interval without walking the heap or changing GC state."""
    gc_ms = float(current["gc_ms_total"]) - float(previous["gc_ms_total"])
    gc0 = int(current["gc0"]) - int(previous["gc0"])
    per_frame = f"{gc0 / inferred_delta:.3f}" if inferred_delta > 0 else "n/a"
    report = (
        f"[gc] gc_ms={gc_ms:.3f} "
        f"gc_pct={gc_ms / max(elapsed * 1000, 1e-6) * 100:.3f} "
        f"gc_max_ms={max_pause_ms:.3f} "
        f"gc0={gc0} "
        f"gc1={int(current['gc1']) - int(previous['gc1'])} "
        f"gc2={int(current['gc2']) - int(previous['gc2'])} "
        f"gc0_per_frame={per_frame} "
        f"gc_collected={int(current['gc_collected']) - int(previous['gc_collected'])} "
        f"gc_uncollectable={int(current['gc_uncollectable']) - int(previous['gc_uncollectable'])} "
        f"gc_threshold={threshold} gc_frozen={frozen}"
    )
    if count_tracked is not None:
        report += f" gc_tracked={count_tracked}"
    return report


async def metrics_worker(state: AppState) -> None:
    """Emit a compact five-second health/allocation report."""

    profile_enabled = settings.ENABLE_PYTHON_ALLOC_PROFILE
    if profile_enabled:
        tracemalloc.start(25)
        print("Python allocation profiling enabled", flush=True)

    interval = settings.METRICS_LOG_INTERVAL_SECONDS
    profile_interval = settings.PYTHON_ALLOC_PROFILE_INTERVAL_SECONDS
    next_profile_at = monotonic() + profile_interval
    previous = state.metrics.snapshot()
    previous_at = monotonic()
    gc_stats = install()
    previous_gc = gc_stats.snapshot()
    gc_stats.take_max_pause_ms()
    try:
        while True:
            await asyncio.sleep(interval)
            now = monotonic()
            elapsed = max(now - previous_at, 1e-6)
            current = state.metrics.snapshot()
            decoded_delta = int(current["decoded_frames_received"]) - int(
                previous["decoded_frames_received"]
            )
            inferred_delta = int(current["frames_inferred"]) - int(
                previous["frames_inferred"]
            )
            published_delta = int(current["playback_frames_published"]) - int(
                previous["playback_frames_published"]
            )
            websocket_delta = int(current["websocket_frames_sent"]) - int(
                previous["websocket_frames_sent"]
            )
            decode_ms = _average_ms(current, previous, "decode_ms_total", decoded_delta)
            frame_convert_ms = _average_ms(
                current,
                previous,
                "frame_convert_ms_total",
                inferred_delta,
            )
            model_ms = _average_ms(current, previous, "model_ms_total", inferred_delta)
            depth_ms = _average_ms(current, previous, "depth_ms_total", inferred_delta)
            inference_ms = _average_ms(
                current, previous, "inference_ms_total", inferred_delta
            )
            postprocess_ms = _average_ms(
                current,
                previous,
                "postprocess_ms_total",
                inferred_delta,
            )
            worker_cycle_ms = _average_ms(
                current, previous, "worker_cycle_ms_total", inferred_delta
            )
            queue_wait_ms = _average_ms(
                current, previous, "queue_wait_ms_total", inferred_delta
            )
            inference_wait_ms = _average_ms(
                current, previous, "inference_wait_ms_total", inferred_delta
            )
            publish_ms = _average_ms(
                current, previous, "publish_ms_total", inferred_delta
            )
            skipped_delta = int(current["skipped_frames_published"]) - int(
                previous["skipped_frames_published"]
            )
            skipped_publish_ms = _average_ms(
                current, previous, "skipped_publish_ms_total", skipped_delta
            )
            allocated, reserved, peak_allocated, peak_reserved = _cuda_memory()
            queue_max = state.inference_queue.maxsize
            queue_limit = str(queue_max) if queue_max > 0 else "unbounded"
            print(
                "[mem] "
                f"rss={_rss_bytes() / 1024**2:.0f}MiB "
                f"queue={state.inference_queue.qsize()}/{queue_limit} "
                f"active={state.inference_active} "
                f"completed_cache={len(state.completed_sequences)}/"
                f"{state.completed_sequence_limit} "
                f"dropped={current['inference_frames_dropped']} "
                f"drop_enqueue={current['inference_enqueue_dropped']} "
                f"drop_worker_latest={current['inference_worker_dropped']} "
                f"input_fps={_rate(decoded_delta, elapsed):.1f} "
                f"infer_fps={_rate(inferred_delta, elapsed):.1f} "
                f"skipped_fps={_rate(skipped_delta, elapsed):.1f} "
                f"playback_fps={_rate(published_delta, elapsed):.1f} "
                f"ws_fps={_rate(websocket_delta, elapsed):.1f} "
                f"decode_ms={decode_ms:.1f} "
                f"convert_ms={frame_convert_ms:.1f} "
                f"model_ms={model_ms:.1f} "
                f"depth_ms={depth_ms:.1f} "
                f"inference_ms={inference_ms:.1f} "
                f"postprocess_ms={postprocess_ms:.1f} "
                f"worker_cycle_ms={worker_cycle_ms:.1f} "
                f"queue_wait_ms={queue_wait_ms:.1f} "
                f"inference_wait_ms={inference_wait_ms:.1f} "
                f"thread_gap_ms={max(0.0, inference_wait_ms - inference_ms):.1f} "
                f"publish_ms={publish_ms:.1f} "
                f"worker_other_ms={max(0.0, worker_cycle_ms - inference_wait_ms - publish_ms):.1f} "
                f"skipped_publish_ms={skipped_publish_ms:.1f} "
                f"recording_samples_queued={current['recording_samples_queued']} "
                f"recording_samples_dropped={current['recording_samples_dropped']} "
                f"recording_samples_uploaded={current['recording_samples_uploaded']} "
                f"cuda_alloc={allocated / 1024**2:.0f}MiB "
                f"cuda_reserved={reserved / 1024**2:.0f}MiB "
                f"cuda_peak={peak_allocated / 1024**2:.0f}MiB/"
                f"{peak_reserved / 1024**2:.0f}MiB",
                flush=True,
            )
            telemetry = state.telemetry_store.counters
            gps_buffer, imu_buffer = state.telemetry_store.buffer_sizes()
            print(
                "[telemetry] "
                f"telemetry_batches_received={telemetry.batches_received} "
                f"telemetry_batches_rejected={telemetry.batches_rejected} "
                f"telemetry_gps_buffer_size={gps_buffer} "
                f"telemetry_imu_buffer_size={imu_buffer} "
                f"telemetry_match_ok={telemetry.match_ok} "
                f"telemetry_gps_stale={telemetry.gps_stale} "
                f"telemetry_imu_stale={telemetry.imu_stale} "
                f"source_timeline_resets={state.source_timeline.resets} "
                f"source_playback_rate={state.source_timeline.playback_rate:.2f}",
                flush=True,
            )

            current_gc = gc_stats.snapshot()
            print(
                _gc_report(
                    current_gc, previous_gc, gc_stats.take_max_pause_ms(),
                    inferred_delta, elapsed,
                    len(gc.get_objects()) if profile_enabled else None,
                    threshold=gc.get_threshold(), frozen=gc.get_freeze_count(),
                ),
                flush=True,
            )
            previous_gc = current_gc

            if profile_enabled and now >= next_profile_at:
                snapshot = tracemalloc.take_snapshot()
                top_stats = snapshot.statistics("lineno")[
                    : settings.PYTHON_ALLOC_PROFILE_TOP
                ]
                if top_stats:
                    print(
                        "[alloc] " + " | ".join(str(stat) for stat in top_stats),
                        flush=True,
                    )
                next_profile_at = now + profile_interval

            previous = current
            previous_at = now
    finally:
        if profile_enabled:
            tracemalloc.stop()
