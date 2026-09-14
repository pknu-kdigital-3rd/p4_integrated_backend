import unittest
from pathlib import Path

from telemetry import BimsPlaybackSource


class PlaybackTelemetryTests(unittest.TestCase):
    def test_playback_normalizes_latest_observation_without_network(self):
        path = Path(__file__).parents[1] / "data" / "busan_bus_gps.csv"
        result = BimsPlaybackSource(path).snapshot()
        self.assertTrue(result["vehicles"])
        self.assertEqual(result["vehicles"][0]["telemetry_source"], "BIMS_REPLAY")
