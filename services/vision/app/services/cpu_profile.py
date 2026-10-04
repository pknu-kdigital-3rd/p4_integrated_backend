"""Bounded per-model cProfile capture using CPU time of the calling thread."""

import cProfile
from contextlib import contextmanager, nullcontext
from pathlib import Path
import pstats
from threading import Lock
from time import thread_time

from app.core.settings import settings


# CPython 3.12 cProfile uses one interpreter-wide monitoring tool slot.
# Skip a capture when occupied; never make one model wait for the other.
_profiler_gate = Lock()


class ModelCpuProfile:
    def __init__(self, name: str, frames: int, warmup: int, directory: Path):
        self.name = name
        self.frames = frames
        self.warmup = warmup
        self.directory = directory
        self.seen = 0
        self.claimed = 0
        self.completed = 0
        self.stats = None
        self.disabled = False
        self.lock = Lock()

    @contextmanager
    def capture(self):
        with self.lock:
            self.seen += 1
            capture = (not self.disabled and self.seen > self.warmup
                       and self.claimed < self.frames and _profiler_gate.acquire(blocking=False))
            if capture:
                self.claimed += 1
        if not capture:
            yield
            return
        # Only this calling thread is profiled. The other model still runs;
        # its profile sample is deferred if this tool slot is occupied.
        profiler = cProfile.Profile(timer=thread_time)
        try:
            profiler.enable()
        except (ValueError, RuntimeError) as exc:
            _profiler_gate.release()
            with self.lock:
                self.disabled = True
            print(f"[cpu-profile] model={self.name} capture disabled: {exc}", flush=True)
            yield
            return
        try:
            yield
        finally:
            profiler.disable()
            _profiler_gate.release()
            with self.lock:
                sample = pstats.Stats(profiler)
                if self.stats is None:
                    self.stats = sample
                else:
                    self.stats.add(sample)
                self.completed += 1
                if self.completed == self.frames:
                    try:
                        self.directory.mkdir(parents=True, exist_ok=True)
                        target = self.directory / f"{self.name}.pstats"
                        self.stats.dump_stats(str(target))
                        print(f"[cpu-profile] model={self.name} frames={self.completed} "
                              f"clock=thread_cpu path={target}", flush=True)
                    except OSError as exc:
                        # Diagnostic output must not make a successful model
                        # result fail and trigger production inference retries.
                        print(f"[cpu-profile] model={self.name} save failed: {exc}", flush=True)
                    finally:
                        self.stats = None


_collectors = {}
_collectors_lock = Lock()


def model_cpu_profile(name: str):
    if settings.VISION_CPU_PROFILE_FRAMES == 0:
        return nullcontext()
    if name not in {"yolo", "depth"}:
        raise ValueError("unknown model CPU profile")
    with _collectors_lock:
        if name not in _collectors:
            _collectors[name] = ModelCpuProfile(
                name, settings.VISION_CPU_PROFILE_FRAMES,
                settings.VISION_CPU_PROFILE_WARMUP_FRAMES, Path(settings.VISION_CPU_PROFILE_DIR),
            )
        collector = _collectors[name]
    return collector.capture()
