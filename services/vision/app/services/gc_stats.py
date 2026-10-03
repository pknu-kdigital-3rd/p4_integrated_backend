"""Process-wide cyclic GC pause counters, shared by all inference threads."""

from __future__ import annotations

import gc
from time import perf_counter


class GCStats:
    def __init__(self) -> None:
        self._started = 0.0
        self._gc0 = 0
        self._gc1 = 0
        self._gc2 = 0
        self._seconds = 0.0
        self._max_seconds = 0.0
        self._collected = 0
        self._uncollectable = 0

    def callback(self, phase: str, info: dict) -> None:
        # CPython invokes callbacks with the GIL held, including when a model
        # thread triggers collection. Avoid containers, logging and heap walks.
        if phase == "start":
            self._started = perf_counter()
        elif phase == "stop":
            elapsed = perf_counter() - self._started
            self._seconds += elapsed
            if elapsed > self._max_seconds:
                self._max_seconds = elapsed
            generation = info["generation"]
            if generation == 0:
                self._gc0 += 1
            elif generation == 1:
                self._gc1 += 1
            else:
                self._gc2 += 1
            self._collected += info["collected"]
            self._uncollectable += info["uncollectable"]

    def snapshot(self) -> dict[str, float | int]:
        return {
            "gc0": self._gc0,
            "gc1": self._gc1,
            "gc2": self._gc2,
            "gc_ms_total": self._seconds * 1000,
            "gc_collected": self._collected,
            "gc_uncollectable": self._uncollectable,
        }

    def take_max_pause_ms(self) -> float:
        maximum = self._max_seconds
        self._max_seconds = 0.0
        return maximum * 1000


_STATS = GCStats()


def install() -> GCStats:
    """Register the singleton callback once; return the cumulative counters."""
    if _STATS.callback not in gc.callbacks:
        gc.callbacks.append(_STATS.callback)
    return _STATS
