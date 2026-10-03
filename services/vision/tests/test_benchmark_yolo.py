import gc
import tracemalloc
import unittest
from unittest.mock import Mock, patch

import numpy as np

from benchmark_yolo import _allocation_trace, _measure_exact, _parse_args, main


class ExactBenchmarkTests(unittest.TestCase):
    def test_times_each_call_and_restores_gc_settings(self):
        original_threshold = gc.get_threshold()
        original_enabled = gc.isenabled()
        fn = Mock()
        with patch("benchmark_yolo._sync") as sync, patch(
            "benchmark_yolo.perf_counter", side_effect=[1, 1.010, 2, 2.020]
        ):
            timings, report = _measure_exact(fn, 2, "cpu", "disabled", 10000)
        np.testing.assert_allclose(timings, [10, 20])
        self.assertEqual(fn.call_count, 2)
        self.assertEqual(sync.call_count, 3)
        self.assertEqual(report["gc_threshold"][0], 10000)
        self.assertIn("gc_tracked", report)
        self.assertIn("gc_max_ms", report)
        self.assertEqual(gc.get_threshold(), original_threshold)
        self.assertEqual(gc.isenabled(), original_enabled)

    def test_restores_disabled_gc_on_error(self):
        original_threshold = gc.get_threshold()
        original_enabled = gc.isenabled()
        gc.disable()
        try:
            with self.assertRaisesRegex(RuntimeError, "inference failed"):
                _measure_exact(Mock(side_effect=RuntimeError("inference failed")), 1, "cpu", "enabled", 50000)
            self.assertFalse(gc.isenabled())
            self.assertEqual(gc.get_threshold(), original_threshold)
        finally:
            if original_enabled:
                gc.enable()

    def test_frozen_mode_collects_before_freezing(self):
        calls = []
        with patch("benchmark_yolo.gc.collect", side_effect=lambda: calls.append("collect")), patch(
            "benchmark_yolo.gc.freeze", side_effect=lambda: calls.append("freeze")
        ), patch("benchmark_yolo.gc.unfreeze") as unfreeze, patch(
            "benchmark_yolo.gc.get_freeze_count", return_value=0
        ):
            _measure_exact(lambda: calls.append("infer"), 1, "cpu", "frozen", None)
        self.assertEqual(calls, ["collect", "freeze", "infer"])
        unfreeze.assert_called_once()

    def test_new_options_preserve_default_gc_mode(self):
        with patch("sys.argv", ["benchmark_yolo.py"]):
            args = _parse_args()
        self.assertEqual(args.gc, "disabled")
        self.assertIsNone(args.image)
        self.assertIsNone(args.gc_gen0_threshold)
        self.assertEqual(args.alloc_trace, 0)

    def test_counts_actual_collections_during_timing(self):
        _, report = _measure_exact(lambda: gc.collect(0), 3, "cpu", "enabled", 1000000)
        self.assertEqual(report["gc0"], 3)
        self.assertEqual(report["gc0_per_frame"], 1)
        self.assertGreater(report["gc_ms_total"], 0)
        self.assertGreater(report["gc_max_ms"], 0)

    def test_allocation_trace_stops_on_error(self):
        self.assertFalse(tracemalloc.is_tracing())
        with self.assertRaisesRegex(RuntimeError, "trace failed"):
            _allocation_trace(Mock(side_effect=RuntimeError("trace failed")), 1, "cpu")
        self.assertFalse(tracemalloc.is_tracing())

    def test_main_shuts_down_depth_executor_on_error(self):
        executor = Mock()
        model = Mock(task="segment")
        with patch("sys.argv", ["benchmark_yolo.py", "--device", "cpu"]), patch(
            "benchmark_yolo.load_yolo_model", return_value=model
        ), patch("benchmark_yolo.load_depth_estimator"), patch(
            "benchmark_yolo.make_depth_executor", return_value=executor
        ), patch("benchmark_yolo._run_benchmarks", side_effect=RuntimeError("benchmark failed")), patch(
            "benchmark_yolo.print"
        ):
            with self.assertRaisesRegex(RuntimeError, "benchmark failed"):
                main()
        executor.shutdown.assert_called_once_with(wait=True, cancel_futures=True)


if __name__ == "__main__":
    unittest.main()
