import unittest

from fastapi import FastAPI
from starlette.testclient import TestClient

from app.api import playback
from app.core.state import AppState, PlaybackItem, get_app_state


def _make_client(state: AppState) -> TestClient:
    app = FastAPI()
    app.include_router(playback.router)
    app.dependency_overrides[get_app_state] = lambda: state
    return TestClient(app)


class FreshViewerJoinsLiveTests(unittest.TestCase):
    """A viewer with no session to resume must not replay stale backlog.

    Regression test for the "still frozen until I press Jump to Live" bug:
    a first-time (or storage-cleared) browser used to start at seq=0 of
    whatever epoch was already in progress, silently replaying however much
    of the backlog had piled up instead of joining the live stream.
    """

    def setUp(self):
        self.state = AppState()
        self.state.current_epoch = 3
        # Simulate a backlog that has been accumulating since the epoch began,
        # exactly what a long-idle stream would have piled up in
        # `result_store` by the time a brand-new viewer connects.
        self.state.put_result(
            PlaybackItem(
                epoch=3, seq=0, encoded=b"stale", timestamp_us=0, keyframe=True,
                result={"width": 1, "height": 1, "items": []},
            )
        )
        self.client = _make_client(self.state)

    def test_fresh_open_clears_backlog_and_requests_a_live_resync(self):
        with self.client.websocket_connect("/ws/playback") as ws:
            ws.send_json({
                "type": "open",
                "session_id": None,
                "epoch": 0,
                "last_presented_seq": -1,
                "decoder_state_preserved": False,
            })
            session = ws.receive_json()
            self.assertEqual(session["type"], "session")
            self.assertEqual(session["mode"], "new")

        self.assertEqual(self.state.result_store, {})
        command = self.state.feed_commands.get_nowait()
        self.assertEqual(command, {"type": "resync", "reason": "viewer_start"})

    def test_resumed_session_does_not_touch_the_backlog(self):
        self.state.session_id = "existing-session"
        with self.client.websocket_connect("/ws/playback") as ws:
            ws.send_json({
                "type": "open",
                "session_id": "existing-session",
                "epoch": 3,
                "last_presented_seq": -1,
                "decoder_state_preserved": True,
            })
            session = ws.receive_json()
            self.assertEqual(session["mode"], "resumed")

        self.assertIn((3, 0), self.state.result_store)
        self.assertTrue(self.state.feed_commands.empty())


class FrameTelemetryMetadataTests(unittest.TestCase):
    T0 = 1_445_245_922_681_115_000
    RECORDING = {"tripId": "102", "vehicleId": "3", "recordingSessionId": "abc-123"}

    def setUp(self):
        from app.services.telemetry import TelemetryBatchIn

        self.state = AppState()
        self.state.telemetry_store.ingest(TelemetryBatchIn.model_validate({
            "mode": "REPLAY", "tripId": "102", "vehicleId": "3", "recordingSessionId": "abc-123",
            "gps": [{"timestamp_ns": str(self.T0), "latitude": 35.1, "longitude": 129.1, "speed_mps": 1.0, "bearing_deg": 90.0}],
            "imu": [{"timestamp_ns": str(self.T0), "pitch_deg": -3.7, "roll_deg": -2.1, "yaw_deg": -30.7, "accuracy": 3}],
        }))

    def decode(self, result):
        message = playback._frame_message(
            self.state,
            PlaybackItem(epoch=2, seq=981, encoded=b"au", timestamp_us=1, keyframe=False, result=result),
        )
        length = int.from_bytes(message[:4], "big")
        import json

        return json.loads(message[4 : 4 + length])

    def source(self, resolved, recording=RECORDING):
        return {
            "timestamp_us": 1,
            "resolved_source_timestamp_ns": None if resolved is None else str(resolved),
            "source_timeline_status": "qr" if resolved is not None else "unavailable",
            "source_timeline_generation": 1,
            "recording": recording,
        }

    def test_telemetry_is_top_level_frame_metadata(self):
        meta = self.decode({"source": self.source(self.T0), "items": [], "inference_ms": 18.4})
        self.assertEqual(meta["telemetry"]["status"], "ok")
        self.assertEqual(meta["telemetry"]["mode"], "REPLAY")
        self.assertEqual(meta["telemetry"]["gps"]["latitude"], 35.1)
        self.assertEqual(meta["telemetry"]["imu"]["yaw_deg"], -30.7)
        self.assertEqual(meta["telemetry"]["source_timestamp_ns"], str(self.T0))
        self.assertNotIn("telemetry", meta["inference"])

    def test_skipped_inference_frame_still_gets_telemetry(self):
        from app.core.state import InferenceFrame
        from app.services.yolo import _skipped_frame_result

        class _Frame:
            width = 640
            height = 360

        frame = InferenceFrame(
            seq=981, frame=_Frame(), pts=0, time_base=None, media_time=None, epoch=2,
            recording_identity=self.RECORDING, resolved_source_timestamp_ns=self.T0,
            source_timeline_status="extrapolated", source_timeline_generation=1,
        )
        meta = self.decode(_skipped_frame_result(frame, None))
        self.assertEqual(meta["source"]["resolved_source_timestamp_ns"], str(self.T0))
        self.assertEqual(meta["telemetry"]["status"], "ok")
        self.assertEqual(meta["telemetry"]["source_timeline_status"], "extrapolated")

    def test_other_session_and_missing_source_time_never_match(self):
        other = {**self.RECORDING, "recordingSessionId": "other-session"}
        self.assertEqual(self.decode({"source": self.source(self.T0, other)})["telemetry"]["status"], "waiting_for_telemetry")
        self.assertEqual(self.decode({"source": self.source(None)})["telemetry"]["status"], "source_timestamp_unavailable")
        self.assertEqual(self.decode({"source": self.source(self.T0, None)})["telemetry"]["status"], "no_recording_identity")


if __name__ == "__main__":
    unittest.main()
