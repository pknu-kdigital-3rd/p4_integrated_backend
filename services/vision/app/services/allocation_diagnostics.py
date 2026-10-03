"""Bounded, offline allocation diagnostics; never enable in the live service."""

from collections import Counter
import gc
import sys
import tracemalloc
from types import FunctionType, MethodType


def _type_name(obj):
    cls = type(obj)
    return f"{cls.__module__}.{cls.__qualname__}"


def _young_types():
    # Retain counts only. Holding the objects would prevent their collection.
    return Counter(_type_name(obj) for obj in gc.get_objects(0))


def diagnose_allocations(fn, iterations, synchronize=lambda: None, *, label):
    """Identify young survivors and gen0 garbage from a bounded workload.

    DEBUG_SAVEALL retains otherwise unreachable objects for inspection. This
    intentionally changes timings and memory; run only in a disposable benchmark.
    Counts describe surviving objects and garbage, not total allocation churn.
    """
    if gc.garbage or gc.get_debug() & gc.DEBUG_SAVEALL:
        raise RuntimeError("allocation diagnostics require an empty GC garbage list and DEBUG_SAVEALL off")
    was_enabled = gc.isenabled()
    old_debug = gc.get_debug()
    owns_trace = not tracemalloc.is_tracing()
    try:
        gc.disable()
        synchronize()
        gc.collect()
        if owns_trace:
            tracemalloc.start(12)
        before = _young_types()
        for _ in range(iterations):
            fn()
            synchronize()
        after = _young_types()
        gc.set_debug(old_debug | gc.DEBUG_SAVEALL)
        collected = gc.collect(0)
        gc.set_debug(old_debug)
        print(f"\n[allocation-diagnostic] {label}: calls={iterations}; gen0_collected={collected}")
        print("  Young tracked survivors before collection (positive type deltas):")
        for name, count in (after - before).most_common(20):
            print(f"    {name}: {count} ({count / iterations:.2f}/call)")

        types = Counter()
        sizes = Counter()
        sites = Counter()
        functions = Counter()
        edges = Counter()
        garbage_ids = {id(obj) for obj in gc.garbage}
        for obj in gc.garbage:
            name = _type_name(obj)
            types[name] += 1
            sizes[name] += sys.getsizeof(obj)
            trace = tracemalloc.get_object_traceback(obj)
            if trace is not None:
                sites[(name, str(trace[-1]))] += 1
            if isinstance(obj, FunctionType):
                functions[(obj.__qualname__, obj.__code__.co_filename, obj.__code__.co_firstlineno)] += 1
            elif isinstance(obj, MethodType):
                functions[(f"{_type_name(obj.__self__)}.{obj.__func__.__name__}",
                           obj.__func__.__code__.co_filename, obj.__func__.__code__.co_firstlineno)] += 1
            for referent in gc.get_referents(obj):
                if id(referent) in garbage_ids:
                    edges[(name, _type_name(referent))] += 1
        print("  Unreachable objects reclaimed by gen0 (shallow bytes exclude referenced buffers):")
        for name, count in types.most_common(20):
            print(f"    {name}: {count} ({count / iterations:.2f}/call); shallow_bytes={sizes[name]}")
        print("  Allocation sites for unreachable objects (when tracemalloc provides them):")
        for (name, site), count in sites.most_common(20):
            print(f"    {count} x {name}: {site}")
        print("  Functions/bound methods retained in garbage:")
        for (name, filename, line), count in functions.most_common(20):
            print(f"    {count} x {name}: {filename}:{line}")
        print("  References among unreachable objects (edges, not proven cycle roots):")
        for (source, target), count in edges.most_common(15):
            print(f"    {count} x {source} -> {target}")
        # Avoid holding the final object/referent through cleanup collection.
        obj = referent = None
    finally:
        gc.set_debug(old_debug)
        gc.garbage.clear()
        gc.collect()
        if owns_trace:
            tracemalloc.stop()
        if was_enabled:
            gc.enable()
        else:
            gc.disable()
