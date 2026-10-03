"""GC policy for long-lived Vision model state."""

import gc
from time import perf_counter


def configure_gc(gen0_threshold: int | None) -> None:
    """Apply an explicit threshold override; preserve Python defaults otherwise."""
    if gen0_threshold is not None:
        gc.set_threshold(gen0_threshold, *gc.get_threshold()[1:])
        print(f"GC: threshold={gc.get_threshold()}", flush=True)


def _freeze_loaded_objects(label: str) -> None:
    """Collect garbage before moving loaded objects to the permanent generation."""
    started = perf_counter()
    gc.collect()
    gc.freeze()
    print(
        f"GC: froze {gc.get_freeze_count()} objects after {label} "
        f"in {perf_counter() - started:.1f} s",
        flush=True,
    )
