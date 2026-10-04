"""Bounded, thread-local model profiles using the calling thread's CPU clock."""

from pathlib import Path
import pstats
import sys
from threading import Lock
from time import thread_time

from app.core.settings import settings


class ThreadCpuProfiler:
    """Collect pstats with a thread-local hook; tolerate incomplete event stacks."""

    def __init__(self, timer=thread_time):
        self.timer = timer
        self.stats = {}
        self.stack = []
        self.last = 0.0

    def _event(self, frame, event, argument):
        now = self.timer()
        if self.stack:
            self.stack[-1][2] += max(0.0, now - self.last)
        if event in {"call", "c_call"}:
            if event == "call":
                code = frame.f_code
                key = (code.co_filename, code.co_firstlineno, code.co_name)
            else:
                key = ("~", 0, getattr(argument, "__qualname__", getattr(argument, "__name__", "native")))
            # key, event type, self time, child time
            self.stack.append([key, event, 0.0, 0.0])
        elif event in {"return", "c_return", "c_exception"} and self.stack:
            expected = "call" if event == "return" else "c_call"
            if self.stack[-1][1] == expected:
                self._finish()
        # Exclude hook bookkeeping CPU from attributed function time.
        self.last = self.timer()

    def _finish(self):
        key, _, own, children = self.stack.pop()
        total = own + children
        recursive = any(entry[0] == key for entry in self.stack)
        primitive, calls, tt, ct, callers = self.stats.get(key, (0, 0, 0.0, 0.0, {}))
        self.stats[key] = (primitive + (not recursive), calls + 1, tt + own,
                           ct + (0.0 if recursive else total), callers)
        if self.stack:
            parent = self.stack[-1]
            parent[3] += total
            cc, nc, pt, pc = callers.get(parent[0], (0, 0, 0.0, 0.0))
            callers[parent[0]] = (cc + (not recursive), nc + 1, pt + own,
                                  pc + (0.0 if recursive else total))

    def runcall(self, function, /, *args, **kwargs):
        self.last = self.timer()
        sys.setprofile(self._event)
        try:
            return function(*args, **kwargs)
        finally:
            sys.setprofile(None)
            while self.stack:
                self._finish()

    def create_stats(self):
        # pstats.Stats accepts profiler objects providing this method and stats.
        pass


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
        print(f"[cpu-profile] model={name} configured frames={frames} warmup={warmup} "
              f"profiler=thread_local directory={directory}", flush=True)

    def run(self, function, /, *args, **kwargs):
        with self.lock:
            self.seen += 1
            capture = (not self.disabled and self.seen > self.warmup
                       and self.claimed < self.frames)
            if capture:
                self.claimed += 1
        if not capture:
            return function(*args, **kwargs)
        # Python 3.12 cProfile's monitoring events cross thread boundaries.
        # A thread_time timer then mixes unrelated clocks and can produce
        # negative durations. Use thread-local sys.setprofile instead.
        # A small collector tolerates native callbacks and incomplete boundary
        # events without the synthetic-stack assumptions of profile.Profile.
        if sys.getprofile() is not None:
            with self.lock:
                self.disabled = True
            print(f"[cpu-profile] model={self.name} capture disabled: existing thread profile hook", flush=True)
            return function(*args, **kwargs)
        profiler = ThreadCpuProfiler(timer=thread_time)
        try:
            return profiler.runcall(function, *args, **kwargs)
        finally:
            with self.lock:
                sample = pstats.Stats(profiler)
                if self.stats is None:
                    self.stats = sample
                else:
                    self.stats.add(sample)
                self.completed += 1
                if self.completed < self.frames and (self.completed == 1 or self.completed % 20 == 0):
                    print(f"[cpu-profile] model={self.name} progress={self.completed}/{self.frames}", flush=True)
                if self.completed == self.frames:
                    try:
                        self.directory.mkdir(parents=True, exist_ok=True)
                        target = self.directory / f"{self.name}.pstats"
                        self.stats.dump_stats(str(target))
                        print(f"[cpu-profile] model={self.name} frames={self.completed} "
                              f"clock=thread_cpu profiler=thread_local path={target}", flush=True)
                    except OSError as exc:
                        # Diagnostic output must not make a successful model
                        # result fail and trigger production inference retries.
                        print(f"[cpu-profile] model={self.name} save failed: {exc}", flush=True)
                    finally:
                        self.stats = None


_collectors = {}
_collectors_lock = Lock()


def run_model_cpu_profile(name: str, function, /, *args, **kwargs):
    if settings.VISION_CPU_PROFILE_FRAMES == 0:
        return function(*args, **kwargs)
    if name not in {"yolo", "depth"}:
        raise ValueError("unknown model CPU profile")
    with _collectors_lock:
        if name not in _collectors:
            _collectors[name] = ModelCpuProfile(
                name, settings.VISION_CPU_PROFILE_FRAMES,
                settings.VISION_CPU_PROFILE_WARMUP_FRAMES, Path(settings.VISION_CPU_PROFILE_DIR),
            )
        collector = _collectors[name]
    return collector.run(function, *args, **kwargs)
