import unittest

from telemetry import CompositeTelemetrySource, DeviceRelaySource


def relay_payload(*vehicles):
    return {"generated_at_utc": "2026-09-18T02:40:15.500Z", "vehicles": list(vehicles), "warnings": []}


def device_vehicle(vehicle_id="3", session="abc-123", source="RECORDED_GPS", latitude=35.1329082):
    return {
        "external_id": f"device:{vehicle_id}",
        "latitude": latitude,
        "longitude": 129.1070557,
        "speed_kmh": 2.575,
        "heading_deg": 89.95,
        "telemetry_source": source,
        "observed_at_utc": "2026-08-26T21:23:04.795Z",
        "route_progress_pct": None,
        "source_metadata": {
            "vehicleId": vehicle_id,
            "tripId": "102",
            "recordingSessionId": session,
            "sourceTimestampNs": "1445245922681115",
            "horizontalAccuracyM": 2.8,
            "mode": "REPLAY",
        },
    }


class StaticSource:
    def __init__(self, snapshot):
        self._snapshot = snapshot

    def snapshot(self):
        return self._snapshot


BIMS = StaticSource({
    "generated_at_utc": "2026-09-18T02:40:14Z",
    "vehicles": [{
        "external_id": "5200126000",
        "latitude": 35.2,
        "longitude": 129.2,
        "telemetry_source": "BIMS_LIVE",
        "observed_at_utc": "2026-09-18T02:40:10Z",
        "speed_kmh": 30.0,
        "heading_deg": None,
        "route_progress_pct": 42.0,
        "source_metadata": {"lineNumber": "126"},
    }],
    "warnings": [],
})


class DeviceRelaySourceTests(unittest.TestCase):
    def test_normalizes_device_vehicle_and_preserves_metadata(self):
        calls = []

        def fetch(url, timeout):
            calls.append((url, timeout))
            return relay_payload(device_vehicle())

        result = DeviceRelaySource("http://127.0.0.1:39012/", timeout=0.5, fetch=fetch).snapshot()
        self.assertEqual(calls, [("http://127.0.0.1:39012/internal/telemetry/vehicles", 0.5)])
        [vehicle] = result["vehicles"]
        self.assertEqual(vehicle["external_id"], "device:3")
        self.assertEqual(vehicle["telemetry_source"], "RECORDED_GPS")
        self.assertEqual(vehicle["source_metadata"]["recordingSessionId"], "abc-123")
        self.assertEqual(vehicle["source_metadata"]["sourceTimestampNs"], "1445245922681115")
        self.assertIsNone(vehicle["route_progress_pct"])

    def test_live_and_replay_sources_are_kept_and_bims_sources_are_ignored(self):
        bims_shaped = dict(device_vehicle(vehicle_id="9"), telemetry_source="BIMS_LIVE")
        result = DeviceRelaySource("http://relay", fetch=lambda *_: relay_payload(
            device_vehicle(vehicle_id="3", source="DEVICE_GPS"),
            device_vehicle(vehicle_id="4", source="RECORDED_GPS"),
            bims_shaped,
        )).snapshot()
        self.assertEqual([v["telemetry_source"] for v in result["vehicles"]], ["DEVICE_GPS", "RECORDED_GPS"])

    def test_relay_unavailable_returns_warning_instead_of_failing(self):
        def fetch(*_):
            raise OSError("connection refused")

        result = DeviceRelaySource("http://relay", fetch=fetch).snapshot()
        self.assertEqual(result["vehicles"], [])
        self.assertEqual(result["warnings"][0]["source"], "device_relay")


class CompositeTelemetrySourceTests(unittest.TestCase):
    def test_bims_and_device_are_combined(self):
        device = DeviceRelaySource("http://relay", fetch=lambda *_: relay_payload(device_vehicle()))
        result = CompositeTelemetrySource(BIMS, device).snapshot()
        self.assertEqual([v["external_id"] for v in result["vehicles"]], ["5200126000", "device:3"])
        self.assertEqual(result["generated_at_utc"], "2026-09-18T02:40:14Z")
        self.assertEqual(result["vehicles"][0]["telemetry_source"], "BIMS_LIVE")

    def test_relay_outage_keeps_bims_with_warning(self):
        def fetch(*_):
            raise OSError("timed out")

        result = CompositeTelemetrySource(BIMS, DeviceRelaySource("http://relay", fetch=fetch)).snapshot()
        self.assertEqual([v["external_id"] for v in result["vehicles"]], ["5200126000"])
        self.assertEqual(len(result["warnings"]), 1)

    def test_duplicate_device_observation_for_same_vehicle_session_is_collapsed(self):
        first = DeviceRelaySource("http://a", fetch=lambda *_: relay_payload(device_vehicle(latitude=1.0)))
        second = DeviceRelaySource("http://b", fetch=lambda *_: relay_payload(
            device_vehicle(latitude=2.0), device_vehicle(session="other-session", latitude=3.0),
        ))
        result = CompositeTelemetrySource(BIMS, first, second).snapshot()
        device = [v for v in result["vehicles"] if v["external_id"] == "device:3"]
        self.assertEqual([(v["source_metadata"]["recordingSessionId"], v["latitude"]) for v in device],
                         [("abc-123", 2.0), ("other-session", 3.0)])


if __name__ == "__main__":
    unittest.main()
