import gc
import unittest
from unittest.mock import patch

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
            "gc_threshold=(700, 10, 10)", "gc_frozen=100", "gc_tracked=42",
        ):
            self.assertIn(expected, report)
        idle = _gc_report(after, after, 0, 0, 0, None, threshold=(700, 10, 10), frozen=0)
        self.assertIn("gc0_per_frame=n/a", idle)
        self.assertNotIn("gc_tracked", idle)


if __name__ == "__main__":
    unittest.main()
