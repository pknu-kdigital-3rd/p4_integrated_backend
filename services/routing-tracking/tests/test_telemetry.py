import unittest
from pathlib import Path

from telemetry import BimsPlaybackSource, BimsLiveSource
from unittest.mock import Mock


class PlaybackTelemetryTests(unittest.TestCase):
    def test_stale_fix_keeps_live_provenance_and_original_observation_time(self):
        service = Mock()
        service.snapshot.return_value = {"generated_at_utc":"2026-01-01T00:01:00Z", "vehicles":[{
            "vehicle_id":"bus-1", "line_number":"111", "lat":35.1, "lon":129.1,
            "source":"stale", "live_age_s":60,
            "live_observed_at_utc":"2026-01-01T00:00:00Z",
        }]}
        vehicle = BimsLiveSource(service).snapshot()["vehicles"][0]
        self.assertEqual(vehicle["telemetry_source"], "BIMS_LIVE")
        self.assertEqual(vehicle["observed_at_utc"], "2026-01-01T00:00:00Z")
        self.assertEqual(vehicle["source_metadata"]["state"], "stale")

    def test_playback_normalizes_latest_observation_without_network(self):
        path = Path(__file__).parents[1] / "data" / "busan_bus_gps.csv"
        result = BimsPlaybackSource(path).snapshot()
        self.assertTrue(result["vehicles"])
        self.assertEqual(result["vehicles"][0]["telemetry_source"], "BIMS_REPLAY")
