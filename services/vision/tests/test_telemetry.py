import unittest

from fastapi import FastAPI
from starlette.testclient import TestClient

from app.api import telemetry as telemetry_api
from app.core.state import AppState, get_app_state
from app.services.telemetry import (
    MAX_IMU_SAMPLES,
    TelemetryBatchIn,
    TelemetryIdentityError,
    TelemetryStore,
    interpolate_angle,
)

MS = 1_000_000
S = 1_000_000_000
T0 = 1_445_245_922_681_115_000
RECORDING = {"tripId": "102", "vehicleId": "3", "recordingSessionId": "abc-123"}


def gps(ts, latitude=35.0, longitude=129.0, speed=10.0, bearing=90.0, accuracy=2.8):
    return {"timestamp_ns": str(ts), "latitude": latitude, "longitude": longitude, "speed_mps": speed,
            "bearing_deg": bearing, "horizontal_accuracy_m": accuracy, "altitude_m": 47.3}


def imu(ts, yaw=0.0, pitch=0.0):
    return {"timestamp_ns": str(ts), "pitch_deg": pitch, "roll_deg": 1.0, "yaw_deg": yaw, "accuracy": 3}


def batch(gps_samples=(), imu_samples=(), session="abc-123", trip="102", vehicle="3", mode="REPLAY"):
    return TelemetryBatchIn.model_validate({
        "mode": mode, "tripId": trip, "vehicleId": vehicle, "recordingSessionId": session,
        "sourceClockNs": str(T0), "gps": list(gps_samples), "imu": list(imu_samples),
    })


class TelemetryStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = TelemetryStore()

    def test_sessions_are_isolated_even_with_overlapping_timestamps(self):
        self.store.ingest(batch([gps(T0, latitude=10)], session="S1", trip="1"))
        self.store.ingest(batch([gps(T0, latitude=20)], session="S2", trip="2"))
        first = self.store.match({"tripId": "1", "vehicleId": "3", "recordingSessionId": "S1"}, T0)
        second = self.store.match({"tripId": "2", "vehicleId": "3", "recordingSessionId": "S2"}, T0)
        self.assertEqual(first["gps"]["latitude"], 10)
        self.assertEqual(second["gps"]["latitude"], 20)

    def test_recording_session_mismatch_never_matches(self):
        self.store.ingest(batch([gps(T0)], imu_samples=[imu(T0)]))
        result = self.store.match({**RECORDING, "tripId": "999"}, T0)
        self.assertEqual(result["status"], "session_mismatch")
        self.assertNotIn("gps", result)
        with self.assertRaises(TelemetryIdentityError):
            self.store.ingest(batch([gps(T0 + S)], trip="999"))

    def test_insertion_order_duplicates_and_bounded_retention(self):
        self.store.ingest(batch([gps(T0 + 2 * S), gps(T0), gps(T0 + S)]))
        self.store.ingest(batch([gps(T0 + S, latitude=36.0)]))
        session = self.store.session("abc-123")
        self.assertEqual(session.gps_ts, [T0, T0 + S, T0 + 2 * S])
        self.assertEqual(session.gps[1].latitude, 36.0)
        for second in range(3, 100):
            self.store.ingest(batch([gps(T0 + second * S)]))
        self.assertEqual(session.gps_ts[0], T0 + 69 * S)
        for chunk in range(0, 3000, 64):
            self.store.ingest(batch(imu_samples=[imu(T0 + (chunk + i) * MS) for i in range(64)]))
        self.assertLessEqual(len(session.imu), MAX_IMU_SAMPLES)
        self.assertLessEqual(session.imu_ts[-1] - session.imu_ts[0], 10 * S)

    def test_rewind_discards_previous_interval(self):
        self.store.ingest(batch([gps(T0 + 100 * S)]))
        self.store.ingest(batch([gps(T0 + 25 * S, latitude=1.0)]))
        self.assertEqual(self.store.session("abc-123").gps_ts, [T0 + 25 * S])

    def test_status_before_telemetry_and_without_source_time(self):
        self.assertEqual(self.store.match(None, T0)["status"], "no_recording_identity")
        self.assertEqual(self.store.match(RECORDING, T0)["status"], "waiting_for_telemetry")
        self.store.ingest(batch([gps(T0)]))
        self.assertEqual(self.store.match(RECORDING, None)["status"], "source_timestamp_unavailable")


class GpsMatchTests(unittest.TestCase):
    def setUp(self):
        self.store = TelemetryStore()

    def match(self, t):
        return self.store.match(RECORDING, t)

    def test_exact_point(self):
        self.store.ingest(batch([gps(T0, latitude=35.5)]))
        result = self.match(T0)
        self.assertEqual(result["match"]["gps"], "exact")
        self.assertEqual(result["gps"]["latitude"], 35.5)
        self.assertAlmostEqual(result["gps"]["speed_kmh"], 36.0)
        self.assertEqual(result["source_timestamp_ns"], str(T0))

    def test_interpolation_between_bracketing_fixes(self):
        self.store.ingest(batch([gps(T0, latitude=35.0, speed=10), gps(T0 + S, latitude=35.001, speed=20)]))
        result = self.match(T0 + S // 4)
        self.assertEqual(result["match"]["gps"], "interpolated")
        self.assertAlmostEqual(result["gps"]["latitude"], 35.00025, places=9)
        self.assertAlmostEqual(result["gps"]["speed_kmh"], 12.5 * 3.6)

    def test_bearing_interpolates_across_north(self):
        self.store.ingest(batch([gps(T0, bearing=359.0), gps(T0 + S, bearing=1.0)]))
        bearing = self.match(T0 + S // 2)["gps"]["bearing_deg"]
        self.assertAlmostEqual(min(bearing, 360 - bearing), 0.0, places=6)
        self.assertAlmostEqual(interpolate_angle(350.0, 10.0, 0.25), 355.0)

    def test_short_gap_extrapolates_and_slow_vehicle_holds(self):
        self.store.ingest(batch([gps(T0, latitude=35.0, longitude=129.0, speed=10.0, bearing=0.0)]))
        moving = self.match(T0 + S)
        self.assertEqual(moving["match"]["gps"], "extrapolated")
        self.assertAlmostEqual((moving["gps"]["latitude"] - 35.0) * 111_195, 10.0, delta=0.1)
        self.assertAlmostEqual(moving["match"]["gps_age_ms"], 1000.0)

        slow = TelemetryStore()
        slow.ingest(batch([gps(T0, speed=0.1)]))
        self.assertEqual(slow.match(RECORDING, T0 + S)["match"]["gps"], "held")

    def test_stale_gap_and_no_fix_yet(self):
        self.store.ingest(batch([gps(T0)], imu_samples=[imu(T0 + 5 * S)]))
        stale = self.match(T0 + 5 * S)
        self.assertIsNone(stale["gps"])
        self.assertEqual(stale["match"]["gps"], "stale")
        self.assertEqual(stale["status"], "gps_stale")
        before = self.match(T0 - S)
        self.assertEqual(before["match"]["gps"], "no_fix")

    def test_poor_accuracy_is_flagged_not_dropped(self):
        self.store.ingest(batch([gps(T0, accuracy=45.0)]))
        result = self.match(T0)
        self.assertEqual(result["gps"]["accuracy_quality"], "low")
        self.assertEqual(result["gps"]["horizontal_accuracy_m"], 45.0)


class ImuMatchTests(unittest.TestCase):
    def setUp(self):
        self.store = TelemetryStore()
        self.store.ingest(batch([gps(T0)]))

    def test_nearest_sample(self):
        self.store.ingest(batch(imu_samples=[imu(T0, pitch=-3.7), imu(T0 + 200 * MS, pitch=5.0)]))
        result = self.store.match(RECORDING, T0 + 3 * MS)
        self.assertEqual(result["match"]["imu"], "nearest")
        self.assertEqual(result["imu"]["pitch_deg"], -3.7)
        self.assertAlmostEqual(result["match"]["imu_delta_ms"], 3.0)

    def test_interpolation_with_yaw_wrap(self):
        self.store.ingest(batch(imu_samples=[imu(T0, yaw=179.0, pitch=0.0), imu(T0 + 8 * MS, yaw=-179.0, pitch=8.0)]))
        result = self.store.match(RECORDING, T0 + 2 * MS)
        self.assertEqual(result["match"]["imu"], "interpolated")
        self.assertAlmostEqual(result["imu"]["pitch_deg"], 2.0)
        self.assertAlmostEqual(result["imu"]["yaw_deg"], 179.5)
        self.assertEqual(result["status"], "ok")

    def test_stale_threshold(self):
        self.store.ingest(batch(imu_samples=[imu(T0 - 80 * MS)]))
        result = self.store.match(RECORDING, T0)
        self.assertIsNone(result["imu"])
        self.assertEqual(result["match"]["imu"], "stale")
        self.assertEqual(result["status"], "imu_stale")


class TelemetryEndpointTests(unittest.TestCase):
    def setUp(self):
        self.state = AppState()
        app = FastAPI()
        app.include_router(telemetry_api.router)
        app.dependency_overrides[get_app_state] = lambda: self.state
        self.client = TestClient(app)

    def payload(self, **overrides):
        body = {"mode": "REPLAY", "tripId": "102", "vehicleId": "3", "recordingSessionId": "abc-123",
                "sourceClockNs": str(T0), "gps": [gps(T0)], "imu": [imu(T0)]}
        body.update(overrides)
        return body

    def test_accepts_relay_batch_with_string_timestamps(self):
        response = self.client.post("/internal/telemetry", json=self.payload())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.state.telemetry_store.session("abc-123").gps_ts, [T0])

    def test_rejects_invalid_samples_and_precision_losing_numbers(self):
        self.assertEqual(self.client.post("/internal/telemetry", json=self.payload(gps=[{**gps(T0), "latitude": 91}])).status_code, 422)
        self.assertEqual(self.client.post("/internal/telemetry", json=self.payload(gps=[{**gps(T0), "timestamp_ns": 1.4e15}])).status_code, 422)
        self.assertEqual(self.client.post("/internal/telemetry", json=self.payload(recordingSessionId="../x")).status_code, 422)

    def test_identity_conflict_is_409(self):
        self.client.post("/internal/telemetry", json=self.payload())
        response = self.client.post("/internal/telemetry", json=self.payload(tripId="7"))
        self.assertEqual(response.status_code, 409)


class LiveViewParentOriginTests(unittest.TestCase):
    def test_page_injects_configured_parent_origins_safely(self):
        from unittest import mock

        from app.api import pages

        with mock.patch.object(pages.settings, "LIVE_VIEW_PARENT_ORIGINS", "https://ops.example:39001/, </script>"):
            injected = pages.parent_origins_json()
        self.assertEqual(injected, '["https://ops.example:39001", "\\u003c/script>"]')
        app = FastAPI()
        app.include_router(pages.router)
        html = TestClient(app).get("/").text
        self.assertNotIn("__LIVE_VIEW_PARENT_ORIGINS__", html)
        self.assertIn("const CONFIGURED_PARENT_ORIGINS = [];", html)


if __name__ == "__main__":
    unittest.main()
