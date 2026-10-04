import asyncio
import gc
import unittest
from unittest.mock import AsyncMock, patch

from app.services.gc_stats import GCStats, install
from app.services.metrics import _gc_report


class GCStatsTests(unittest.TestCase):
    def test_counts_all_generations_and_resets_interval_max(self):
        stats = GCStats()
        with patch("app.services.gc_stats.perf_counter", side_effect=[1, 1.002, 2, 2.005, 3, 3.001]):
            for generation in (0, 2, 1):
                stats.callback("start", {})
                stats.callback("stop", {
                    "generation": generation, "collected": 5, "uncollectable": 1,
                })
        snapshot = stats.snapshot()
        self.assertEqual((snapshot["gc0"], snapshot["gc1"], snapshot["gc2"]), (1, 1, 1))
        self.assertEqual(snapshot["gc_collected"], 15)
        self.assertEqual(snapshot["gc_uncollectable"], 3)
        self.assertAlmostEqual(snapshot["gc_ms_total"], 8)
        self.assertAlmostEqual(stats.take_max_pause_ms(), 5)
        self.assertEqual(stats.take_max_pause_ms(), 0)
        self.assertEqual(stats.snapshot(), snapshot)

    def test_install_is_idempotent(self):
        with patch.object(gc, "callbacks", []):
            first = install()
            self.assertIs(install(), first)
            self.assertEqual(gc.callbacks, [first.callback])

    def test_gc_report_uses_deltas_and_optional_heap_count(self):
        before = {
            "gc0": 2, "gc1": 1, "gc2": 1, "gc_ms_total": 10,
            "gc_collected": 5, "gc_uncollectable": 0,
        }
        after = {
            "gc0": 8, "gc1": 3, "gc2": 2, "gc_ms_total": 30,
            "gc_collected": 12, "gc_uncollectable": 1,
        }
        report = _gc_report(after, before, 9, 3, 2, 42, threshold=(700, 10, 10), frozen=100)
        for expected in (
            "gc_ms=20.000", "gc_pct=1.000", "gc_max_ms=9.000",
            "gc0=6", "gc1=2", "gc2=1", "gc0_per_frame=2.000",
            "gc_collected=7", "gc_uncollectable=1",
            "gc_threshold=(700, 10, 10)", "gc_frozen_at_freeze=100", "gc_tracked=42",
        ):
            self.assertIn(expected, report)
        idle = _gc_report(after, after, 0, 0, 0, None, threshold=(700, 10, 10), frozen=0)
        self.assertIn("gc0_per_frame=n/a", idle)
        self.assertNotIn("gc_tracked", idle)


class MetricsHeapTraversalTests(unittest.IsolatedAsyncioTestCase):
    async def test_cpu_report_aggregates_stage_clocks_and_one_core_percentages(self):
        from app.core.state import AppState
        from app.services.metrics import metrics_worker

        state = AppState()
        async def tick(_interval):
            if state.metrics.frames_inferred:
                raise asyncio.CancelledError()
            state.metrics.record_inference({"yolo_thread_cpu_ms": 4, "depth_thread_cpu_ms": 2,
                                            "inference_thread_cpu_ms": 10})
        with patch("app.services.metrics.settings.ENABLE_PYTHON_ALLOC_PROFILE", False), patch(
            "app.services.metrics.asyncio.sleep", side_effect=tick
        ), patch("app.services.metrics._cuda_memory", return_value=(0, 0, 0, 0)), patch(
            "app.services.metrics.monotonic", side_effect=[0, 0, 2]
        ), patch("app.services.metrics.process_time", side_effect=[1, 1.1]), patch("builtins.print") as output:
            with self.assertRaises(asyncio.CancelledError):
                await metrics_worker(state)
        report = next(call.args[0] for call in output.call_args_list if call.args[0].startswith("[cpu]"))
        for field in ("yolo_thread_cpu_ms=4.000", "depth_thread_cpu_ms=2.000",
                      "inference_thread_cpu_ms=10.000", "inference_thread_cpu_pct=0.5",
                      "depth_thread_cpu_pct=0.1", "process_cpu_pct=5.0"):
            self.assertIn(field, report)

    async def test_periodic_timeline_report_includes_same_slow_frame(self):
        from app.core.state import AppState
        from app.services.metrics import metrics_worker
        from app.services.model_timing import model_timeline

        state = AppState()
        async def tick(_interval):
            if state.metrics.frames_inferred:
                raise asyncio.CancelledError()
            state.metrics.record_inference({
                "inference_ms": 35., "frame_seq": 42, "frame_epoch": 2,
                "model_timeline": model_timeline(0, .002, .030,
                    {"start": .004, "end": .025}, .001, True, True),
            })
        with patch("app.services.metrics.settings.ENABLE_PYTHON_ALLOC_PROFILE", False), patch(
            "app.services.metrics.asyncio.sleep", side_effect=tick
        ), patch("app.services.metrics._cuda_memory", return_value=(0, 0, 0, 0)), patch("builtins.print") as output:
            with self.assertRaises(asyncio.CancelledError):
                await metrics_worker(state)
        reports = [call.args[0] for call in output.call_args_list]
        report = next(line for line in reports if line.startswith("[model-timeline]"))
        slow = next(line for line in reports if line.startswith("[model-timeline-slow]"))
        self.assertIn("yolo_last_frames=1", report)
        self.assertIn("mean_yolo_tail_ms=5.00", report)
        self.assertIn("seq=42", slow)
        self.assertIn("last_model=yolo", slow)
        self.assertEqual(state.metrics.model_timelines.take_reports(), [])

    async def test_periodic_report_does_not_walk_frozen_or_tracked_objects(self):
        from app.core.state import AppState
        from app.services.metrics import metrics_worker

        with patch("app.services.metrics.settings.ENABLE_PYTHON_ALLOC_PROFILE", False), patch(
            "app.services.metrics.asyncio.sleep", new=AsyncMock(side_effect=[None, asyncio.CancelledError()])
        ), patch("app.services.metrics._cuda_memory", return_value=(0, 0, 0, 0)), patch(
            "app.services.metrics.frozen_count_at_freeze", return_value=1047533
        ), patch("gc.get_freeze_count", side_effect=AssertionError("frozen heap scan")), patch(
            "gc.get_objects", side_effect=AssertionError("tracked heap scan")
        ), patch("builtins.print") as output:
            with self.assertRaises(asyncio.CancelledError):
                await metrics_worker(AppState())
        reports = [call.args[0] for call in output.call_args_list]
        self.assertTrue(any("gc_frozen_at_freeze=1047533" in report for report in reports))


if __name__ == "__main__":
    unittest.main()
