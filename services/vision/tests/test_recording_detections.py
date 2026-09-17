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
    def test_default_sample_interval_stores_every_inference_result(self):
        writer = RecordingDetectionWriter("http://node:3000", "secret")
        metrics = SimpleNamespace(
            recording_samples_queued=0,
            recording_samples_dropped=0,
        )
        for index, pts in enumerate((0, 1, 1, 90_000, 90_001)):
            writer.offer(_result(pts, seq=index), metrics)

        samples = [writer.queue.get_nowait() for _ in range(5)]
        self.assertEqual([sample["frameSeq"] for sample in samples], ["0", "1", "2", "3", "4"])
        self.assertEqual(metrics.recording_samples_queued, 5)

    def test_queue_is_bounded_without_waiting(self):
        writer = RecordingDetectionWriter("http://node:3000", "secret", queue_size=1)
        metrics = SimpleNamespace(
            recording_samples_queued=0,
            recording_samples_dropped=0,
        )
        writer.offer(_result(90_000), metrics)
        writer.offer(_result(134_999), metrics)
        self.assertEqual(writer.queue.qsize(), 1)
        self.assertEqual(metrics.recording_samples_queued, 1)
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

    def test_samples_every_n_completed_inference_results(self):
        writer = RecordingDetectionWriter(
            "http://node:3000", "secret", sample_every_n_frames=2
        )
        metrics = SimpleNamespace(
            recording_samples_queued=0,
            recording_samples_dropped=0,
        )
        for index, seq in enumerate((7, 42, 100, 170, 203, 246)):
            writer.offer(_result(index, seq=seq), metrics)

        samples = [writer.queue.get_nowait() for _ in range(3)]
        self.assertEqual([sample["frameSeq"] for sample in samples], ["42", "170", "246"])
        self.assertEqual(metrics.recording_samples_queued, 3)


if __name__ == "__main__":
    unittest.main()
