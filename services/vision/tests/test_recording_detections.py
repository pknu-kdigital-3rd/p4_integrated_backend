import unittest
from types import SimpleNamespace

from app.services.recording_detections import RecordingDetectionWriter, normalized_detections


def _result(pts, *, detections=None, epoch=7, seq=None):
    return {
        "source": {
            "epoch": epoch,
            "seq": int(pts // 3000 if seq is None else seq),
            "pts_90k": pts,
            "recording": {
                "tripId": "12",
                "vehicleId": "3",
                "recordingSessionId": "session-a",
            },
        },
        "width": 100,
        "height": 200,
        "items": detections or [],
    }


class NormalizedReplayDetectionTests(unittest.TestCase):
    def test_pixel_xywh_boxes_become_normalized_xyxy(self):
        items = normalized_detections(
            {
                "width": 100,
                "height": 200,
                "items": [
                    {
                        "class": "car",
                        "confidence": 0.876,
                        "bbox": [10, 20, 30, 40],
                        "bbox_format": "xywh_pixels",
                        "track_id": 4,
                    }
                ],
            }
        )
        self.assertEqual(items, [{
            "class": "car",
            "confidence": 0.876,
            "bbox": [0.1, 0.1, 0.4, 0.3],
            "trackId": 4,
        }])

    def test_empty_detection_list_is_a_valid_sample(self):
        self.assertEqual(normalized_detections({"width": 10, "height": 10, "items": []}), [])


class RecordingDetectionWriterTests(unittest.TestCase):
    def test_samples_at_half_second_cadence_and_bounds_queue_without_waiting(self):
        writer = RecordingDetectionWriter("http://node:3000", "secret", queue_size=1)
        metrics = SimpleNamespace(
            recording_samples_queued=0,
            recording_samples_dropped=0,
        )
        writer.offer(_result(90_000), metrics)
        writer.offer(_result(134_999), metrics)
        self.assertEqual(writer.queue.qsize(), 1)
        self.assertEqual(metrics.recording_samples_queued, 1)

        writer.offer(_result(135_000), metrics)
        self.assertEqual(writer.queue.qsize(), 1)
        self.assertEqual(metrics.recording_samples_dropped, 1)
        stored = writer.queue.get_nowait()
        self.assertEqual(stored["tripId"], "12")
        self.assertEqual(stored["relayEpoch"], "7")
        self.assertEqual(stored["videoPts90k"], "90000")
        self.assertEqual(stored["detections"], [])

    def test_disabled_writer_does_not_enqueue(self):
        writer = RecordingDetectionWriter("http://node:3000", None)
        metrics = SimpleNamespace(recording_samples_queued=0, recording_samples_dropped=0)
        writer.offer(_result(0), metrics)
        self.assertTrue(writer.queue.empty())


if __name__ == "__main__":
    unittest.main()
