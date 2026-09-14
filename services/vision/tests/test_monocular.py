import unittest
from pathlib import Path

from app.services.monocular import (
    MonocularTimeline,
    QRResolver,
    annotate_result,
)
from app.core.state import InferenceFrame


class MonocularTests(unittest.TestCase):
    def _dataset(self) -> Path:
        return Path(__file__).resolve().parent / "fixtures" / "monocular"

    def test_qr_resolver_carries_then_expires_and_detects_rewind(self):
        resolver = QRResolver(max_age_ms=200)
        self.assertEqual(
            resolver.resolve(1_000_000_000, 1_000_000_000, decode_success=True, seq=0).status,
            "ok",
        )
        carried = resolver.resolve(None, 1_100_000_000, seq=1)
        self.assertEqual(carried.status, "qr_stale")
        self.assertEqual(carried.source_timestamp_ns, 1_000_000_000)
        expired = resolver.resolve(None, 1_300_000_000, seq=2)
        self.assertEqual(expired.status, "qr_missing")
        rewound = resolver.resolve(500_000_000, 1_400_000_000, decode_success=True, seq=3)
        self.assertEqual(rewound.status, "ok")
        self.assertEqual(rewound.epoch, 1)

    def test_timeline_loads_segmented_sidecars_and_joins_imu(self):
        timeline = MonocularTimeline.load(self._dataset())
        match, status = timeline.lookup(1_001_000_000)
        self.assertEqual(status, "ok")
        assert match is not None
        self.assertEqual(match.frame_index, 0)
        self.assertEqual(match.imu.pitch_deg, 0)

    def test_ground_distance_for_level_camera(self):
        timeline = MonocularTimeline.load(self._dataset())
        match, status = timeline.lookup(1_000_000_000)
        self.assertEqual(status, "ok")
        assert match is not None
        result = {"width": 1280, "height": 720, "items": [{
            "class": "person",
            "bbox": [0.45, 0.5, 0.55, 0.95],
            "bbox_format": "xyxy_normalized",
        }]}
        frame = InferenceFrame(
            seq=0,
            frame=None,
            pts=0,
            time_base=1 / 90000,
            media_time=0.0,
            qr_source_timestamp_ns=1_000_000_000,
            qr_capture_timestamp_ns=2_000_000_000,
            qr_decode_success=True,
        )
        annotate_result(result, frame, timeline, QRResolver())
        item = result["items"][0]
        self.assertEqual(item["distance_status"], "ok")
        # Bottom of the box is 324 px below the principal point.  The exact
        # value is less important than a finite positive metric result.
        self.assertGreater(item["distance_m"], 0)
        self.assertEqual(result["monocular"]["qr_status"], "ok")

    def test_missing_calibration_is_explicit(self):
        loaded = MonocularTimeline.load(self._dataset())
        timeline = MonocularTimeline(loaded.frames, loaded.imus, loaded.intrinsics, None)
        match, status = timeline.lookup(1_000_000_000)
        self.assertEqual(status, "ok")
        assert match is not None
        result = {"width": 1280, "height": 720, "items": [{
            "class": "car", "bbox": [0.4, 0.4, 0.6, 0.8],
            "bbox_format": "xyxy_normalized",
        }]}
        frame = InferenceFrame(
            seq=0, frame=None, pts=0, time_base=1 / 90000, media_time=0.0,
            qr_source_timestamp_ns=1_000_000_000,
            qr_capture_timestamp_ns=2_000_000_000,
            qr_decode_success=True,
        )
        annotate_result(result, frame, timeline, QRResolver())
        self.assertIsNone(result["items"][0]["distance_m"])
        self.assertEqual(result["items"][0]["distance_status"], "calibration_missing")

    def test_missing_dataset_is_explicit(self):
        result = {"items": [{"class": "person", "bbox": [0.4, 0.4, 0.6, 0.8]}]}
        frame = InferenceFrame(
            seq=0, frame=None, pts=0, time_base=1 / 90000, media_time=0.0,
            qr_source_timestamp_ns=None,
            qr_capture_timestamp_ns=None,
            qr_decode_success=False,
        )
        annotate_result(result, frame, None, QRResolver())
        self.assertEqual(result["monocular"]["status"], "dataset_unavailable")
        self.assertEqual(result["items"][0]["distance_status"], "dataset_unavailable")


if __name__ == "__main__":
    unittest.main()
