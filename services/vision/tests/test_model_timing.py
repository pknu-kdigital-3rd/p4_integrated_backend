import unittest

from app.services.model_timing import ModelTimelineMetrics, model_timeline


class ModelTimingTests(unittest.TestCase):
    def timeline(self, yolo_end=10, depth_start=3, depth_end=15, parallel=True, ok=True):
        return model_timeline(0, .002, yolo_end / 1000,
                              {"start": depth_start / 1000, "end": depth_end / 1000},
                              .001, parallel, ok)

    def test_overlap_and_critical_tail_with_staggered_starts(self):
        timeline = self.timeline()
        self.assertEqual(timeline["last_model"], "depth")
        self.assertAlmostEqual(timeline["overlap_ms"], 7)
        self.assertAlmostEqual(timeline["depth_tail_ms"], 5)
        self.assertAlmostEqual(timeline["yolo_tail_ms"], 0)
        self.assertAlmostEqual(timeline["depth_launch_delay_ms"], 2)
        self.assertAlmostEqual(timeline["yolo_start_ms"], 2)
        self.assertAlmostEqual(timeline["depth_end_ms"], 15)
        reverse = self.timeline(yolo_end=20)
        self.assertEqual(reverse["last_model"], "yolo")
        self.assertAlmostEqual(reverse["yolo_tail_ms"], 5)

    def test_serial_failure_tie_and_missing_depth(self):
        self.assertEqual(self.timeline(parallel=False)["mode"], "serial")
        self.assertEqual(self.timeline(ok=False)["mode"], "depth_error")
        self.assertEqual(self.timeline(yolo_end=15)["last_model"], "tie")
        self.assertEqual(self.timeline(depth_start=12)["overlap_ms"], 0)
        self.assertEqual(model_timeline(0, 1, 2, {}, None, False, False)["mode"], "yolo_only")

    def test_interval_means_exclude_serial_and_errors_and_keep_slowest(self):
        metrics = ModelTimelineMetrics()
        for seq, timeline, duration in ((1, self.timeline(), 20.),
                                        (2, self.timeline(yolo_end=20), 30.),
                                        (3, self.timeline(parallel=False), 40.),
                                        (4, self.timeline(ok=False), 25.)):
            metrics.record({"model_timeline": timeline, "inference_ms": duration,
                            "frame_seq": seq, "frame_epoch": 7})
        report, slow = metrics.take_reports()
        for expected in ("parallel_frames=2", "serial_frames=1", "depth_error_frames=1",
                         "yolo_last_frames=1", "depth_last_frames=1", "mean_depth_tail_ms=2.50"):
            self.assertIn(expected, report)
        self.assertIn("seq=3", slow)
        self.assertIn("epoch=7", slow)
        self.assertIn("mode=serial", slow)
        self.assertEqual(metrics.take_reports(), [])
        self.assertIsNone(metrics.slowest)


if __name__ == "__main__":
    unittest.main()
