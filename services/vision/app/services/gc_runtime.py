"""GC policy for long-lived Vision model state."""

import gc
from time import perf_counter


_frozen_count_at_freeze = 0


def frozen_count_at_freeze() -> int:
    """Return the last freeze snapshot without traversing the permanent heap."""
    return _frozen_count_at_freeze


def configure_gc(gen0_threshold: int | None) -> None:
    """Apply an explicit threshold override; preserve Python defaults otherwise."""
    if gen0_threshold is not None:
        gc.set_threshold(gen0_threshold, *gc.get_threshold()[1:])
        print(f"GC: threshold={gc.get_threshold()}", flush=True)


def _freeze_loaded_objects(label: str) -> None:
    """Collect garbage before moving loaded objects to the permanent generation."""
    global _frozen_count_at_freeze
    started = perf_counter()
    gc.collect()
    gc.freeze()
    # CPython get_freeze_count walks every frozen object. Capture it once at
    # this explicit freeze boundary, not in the five-second metrics loop.
    _frozen_count_at_freeze = gc.get_freeze_count()
    print(
        f"GC: froze {_frozen_count_at_freeze} objects after {label} "
        f"in {perf_counter() - started:.1f} s",
        flush=True,
    )
