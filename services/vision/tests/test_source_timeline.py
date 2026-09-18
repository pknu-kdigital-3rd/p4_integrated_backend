import unittest

from app.services.source_timeline import (
    STATUS_EXTRAPOLATED,
    STATUS_NO_PTS,
    STATUS_QR,
    STATUS_STALE,
    STATUS_UNAVAILABLE,
    SourceTimelineResolver,
)

S = 1_000_000_000
PTS = 90_000  # one second of 90 kHz RTP time
FRAME = 3_000  # one 30 fps frame
BASE_SOURCE = 1_445_245_922_681_115_000


class SourceTimelineTests(unittest.TestCase):
    def feed(self, resolver, seconds, rate=1.0, qr_every=2, start_pts=0, start_source=BASE_SOURCE):
        """Feed 30 fps frames whose QR advances `rate` source-seconds per second."""

        last = None
        for frame in range(int(seconds * 30)):
            pts = start_pts + frame * FRAME
            qr = start_source + int(frame * rate * S / 30) if frame % qr_every == 0 else None
            last = resolver.resolve(pts, qr, qr is not None)
        return last

    def test_unavailable_before_first_qr_and_without_pts(self):
        resolver = SourceTimelineResolver()
        self.assertEqual(resolver.resolve(0, None, False).status, STATUS_UNAVAILABLE)
        self.assertEqual(resolver.resolve(None, BASE_SOURCE, True).status, STATUS_NO_PTS)

    def test_normal_playback_extrapolates_between_qr_anchors(self):
        resolver = SourceTimelineResolver()
        self.assertEqual(resolver.resolve(0, BASE_SOURCE, True).status, STATUS_QR)
        result = resolver.resolve(FRAME, None, False)
        self.assertEqual(result.status, STATUS_EXTRAPOLATED)
        self.assertAlmostEqual(result.source_timestamp_ns - BASE_SOURCE, S / 30, delta=1)

    def test_2x_external_playback_rate_is_estimated(self):
        resolver = SourceTimelineResolver()
        self.feed(resolver, seconds=2, rate=2.0)  # frames 0..59, QR on even frames
        self.assertAlmostEqual(resolver.playback_rate, 2.0, places=2)
        result = resolver.resolve(60 * FRAME, None, False)
        self.assertEqual(result.status, STATUS_EXTRAPOLATED)
        self.assertAlmostEqual(result.source_timestamp_ns, BASE_SOURCE + 60 * 2 * S / 30, delta=1_000)

    def test_pause_drives_rate_to_zero(self):
        resolver = SourceTimelineResolver()
        self.feed(resolver, seconds=2, rate=1.0)
        generation = resolver.generation
        for frame in range(60, 120):
            resolver.resolve(frame * FRAME, BASE_SOURCE + 2 * S, frame % 2 == 0)
        self.assertLess(resolver.playback_rate, 0.05)
        result = resolver.resolve(121 * FRAME, None, False)
        self.assertAlmostEqual(result.source_timestamp_ns, BASE_SOURCE + 2 * S, delta=S // 100)
        self.assertEqual(resolver.generation, generation)

    def test_backward_seek_starts_new_generation(self):
        resolver = SourceTimelineResolver()
        self.feed(resolver, seconds=3)
        generation = resolver.generation
        result = resolver.resolve(90 * FRAME, BASE_SOURCE - 75 * S, True)
        self.assertEqual(result.generation, generation + 1)
        self.assertEqual(result.source_timestamp_ns, BASE_SOURCE - 75 * S)

    def test_large_forward_seek_starts_new_generation(self):
        resolver = SourceTimelineResolver()
        self.feed(resolver, seconds=2)
        generation = resolver.generation
        result = resolver.resolve(61 * FRAME, BASE_SOURCE + 200 * S, True)
        self.assertEqual(result.generation, generation + 1)
        self.assertEqual(resolver.playback_rate, 1.0)

    def test_missing_qr_goes_stale_and_recovers(self):
        resolver = SourceTimelineResolver(max_extrapolation_s=1.5)
        resolver.resolve(0, BASE_SOURCE, True)
        self.assertEqual(resolver.resolve(PTS, None, False).status, STATUS_EXTRAPOLATED)
        self.assertEqual(resolver.resolve(2 * PTS, None, False).status, STATUS_STALE)
        generation = resolver.generation
        recovered = resolver.resolve(5 * PTS, BASE_SOURCE + 5 * S, True)
        self.assertEqual(recovered.status, STATUS_QR)
        self.assertEqual(recovered.generation, generation, "normal-speed recovery is not a seek")

    def test_reset_forgets_anchors(self):
        resolver = SourceTimelineResolver()
        resolver.resolve(0, BASE_SOURCE, True)
        generation = resolver.generation
        resolver.reset()
        self.assertEqual(resolver.resolve(FRAME, None, False).status, STATUS_UNAVAILABLE)
        self.assertEqual(resolver.generation, generation + 1)


if __name__ == "__main__":
    unittest.main()
