import asyncio
import json
import unittest
import time
from unittest.mock import patch

from fastapi import FastAPI
from starlette.testclient import TestClient

from app.api import playback
from app.core.state import AppState, PlaybackItem, get_app_state


class LivePreviewFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from types import SimpleNamespace

        self.state = AppState(current_epoch=3, session_id="existing")
        self.state.yolo_model = SimpleNamespace(_p4_overlay_classes=["person"])
        self.controls = asyncio.Queue()
        self.messages = asyncio.Queue()

        async def accept():
            pass

        async def receive_text():
            return json.dumps(await self.controls.get())

        async def send_text(text):
            await self.messages.put(json.loads(text))

        self.ws = SimpleNamespace(
            client="test", accept=accept, receive_text=receive_text,
            send_text=send_text, send_json=self.messages.put, send_bytes=self.messages.put,
        )
        await self.controls.put({
            "type": "open", "live": True, "session_id": "existing", "epoch": 3,
            "last_presented_seq": 0, "decoder_state_preserved": True,
        })
        self.task = asyncio.create_task(playback.playback(self.ws, self.state))
        self.assertEqual((await self.message())["mode"], "new")
        command = await asyncio.wait_for(self.state.feed_commands.get(), 1)
        self.assertEqual(command, {"type": "resync", "reason": "jump_to_live"})

    async def asyncTearDown(self):
        self.task.cancel()
        try:
            await self.task
        except asyncio.CancelledError:
            pass

    async def message(self):
        return await asyncio.wait_for(self.messages.get(), 1)

    def frame(self, seq, timestamp_us=0):
        return PlaybackItem(
            epoch=self.state.current_epoch, seq=seq, timestamp_us=timestamp_us,
            encoded=b"frame", keyframe=seq == 0,
            result={"width": 1, "height": 1, "items": []},
        )

    async def reset(self, epoch=3):
        async with self.state.result_condition:
            self.state.current_epoch = epoch
            self.state.playback_reset_generation += 1
            self.state.clear_all_results()
            self.state.result_condition.notify_all()
        self.assertEqual((await self.message())["type"], "epoch")

    async def test_live_open_waits_for_reset_even_when_epoch_number_is_reused(self):
        # An old inference call can complete between the request and relay reset.
        self.state.put_result(self.frame(0))
        await asyncio.sleep(0.08)
        self.assertTrue(self.messages.empty())
        await self.reset()
        async with self.state.result_condition:
            self.state.put_result(self.frame(0))
            self.state.result_condition.notify_all()
        self.assertIsInstance(await self.message(), bytes)

    async def test_live_backlog_requests_new_keyframe_instead_of_replaying_history(self):
        await self.reset()
        async with self.state.result_condition:
            for seq in range(40):
                self.state.put_result(self.frame(seq, seq * 33_333))
            self.state.result_condition.notify_all()
        command = await asyncio.wait_for(self.state.feed_commands.get(), 1)
        self.assertEqual(command, {"type": "resync", "reason": "live_backlog"})
        self.assertEqual((await self.message())["type"], "resyncing")
        self.assertFalse(self.state.result_store)

    async def test_epoch_reset_releases_a_full_unacknowledged_send_window(self):
        await self.reset()
        async with self.state.result_condition:
            for seq in range(16):
                self.state.put_result(self.frame(seq, seq * 33_333))
            self.state.result_condition.notify_all()
        for _ in range(playback.LIVE_SEND_WINDOW_FRAMES):
            self.assertIsInstance(await self.message(), bytes)
        await asyncio.sleep(0.08)
        self.assertTrue(self.messages.empty())
        await self.reset(epoch=4)
        async with self.state.result_condition:
            self.state.put_result(self.frame(0))
            self.state.result_condition.notify_all()
        self.assertIsInstance(await self.message(), bytes)


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

    def test_session_lists_the_overlay_classes(self):
        from types import SimpleNamespace

        self.state.yolo_model = SimpleNamespace(_p4_overlay_classes=["person", "bicycle"])
        with self.client.websocket_connect("/ws/playback") as ws:
            ws.send_json({
                "type": "open",
                "session_id": None,
                "epoch": 0,
                "last_presented_seq": -1,
                "decoder_state_preserved": False,
            })
            session = ws.receive_json()
        self.assertEqual(session["overlay_classes"], ["person", "bicycle"])

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


class LiveResyncTests(unittest.TestCase):
    def setUp(self):
        self.state = AppState()
        self.state.current_epoch = 3
        self.state.session_id = "existing-session"
        self.state.put_result(PlaybackItem(
            epoch=3, seq=0, encoded=b"queued-old-frame", timestamp_us=0, keyframe=True,
            result={"width": 1, "height": 1, "items": []},
        ))
        self.client = _make_client(self.state)

    def test_jump_to_live_discards_queued_results_and_requests_resync(self):
        with self.client.websocket_connect("/ws/playback") as ws:
            ws.send_json({
                "type": "open",
                "session_id": "existing-session",
                "epoch": 3,
                "last_presented_seq": -1,
                "decoder_state_preserved": True,
            })
            self.assertEqual(ws.receive_json()["mode"], "resumed")
            ws.send_json({"type": "jump_to_live"})

            deadline = time.monotonic() + 1
            command = None
            while time.monotonic() < deadline:
                try:
                    command = self.state.feed_commands.get_nowait()
                    break
                except asyncio.QueueEmpty:
                    time.sleep(0.01)

            self.assertEqual(command, {"type": "resync", "reason": "jump_to_live"})
            self.assertEqual(self.state.result_store, {})


class SingleViewerSlotTests(unittest.TestCase):
    """The newest viewer takes the single slot; the replaced one is told so."""

    OPEN = {
        "type": "open",
        "session_id": None,
        "epoch": 0,
        "last_presented_seq": -1,
        "decoder_state_preserved": False,
    }

    def test_newest_viewer_takes_over_and_the_old_one_is_closed_with_4001(self):
        from starlette.websockets import WebSocketDisconnect

        state = AppState()
        state.current_epoch = 3
        # Both connections must share one event loop, as under uvicorn; the
        # TestClient context manager provides that.
        with _make_client(state) as client, client.websocket_connect("/ws/playback") as first:
            first.send_json(self.OPEN)
            self.assertEqual(first.receive_json()["type"], "session")
            with client.websocket_connect("/ws/playback") as second:
                second.send_json(self.OPEN)
                self.assertEqual(second.receive_json()["type"], "session")
                with self.assertRaises(WebSocketDisconnect) as closed:
                    while True:
                        first.receive_json()
                self.assertEqual(closed.exception.code, playback.VIEWER_REPLACED_CLOSE_CODE)
                # The replaced viewer leaving must not free the new owner's slot.
                time.sleep(0.1)
                self.assertTrue(state.viewer_connected)
                self.assertIs(state.viewer_websocket is not None, True)
        deadline = time.monotonic() + 1
        while state.viewer_connected and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(state.viewer_connected)


class SequenceGapResyncTests(unittest.TestCase):
    """A missing sequence with later results present must not freeze playback."""

    def setUp(self):
        self.state = AppState()
        self.state.current_epoch = 3
        self.state.session_id = "existing-session"
        for seq in (0, 2):  # seq 1 never arrives
            self.state.put_result(PlaybackItem(
                epoch=3, seq=seq, encoded=b"frame", timestamp_us=seq * 33_000, keyframe=seq == 0,
                result={"width": 1, "height": 1, "items": []},
            ))
        self.client = _make_client(self.state)

    def _next_command(self, timeout=2.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                return self.state.feed_commands.get_nowait()
            except asyncio.QueueEmpty:
                time.sleep(0.01)
        return None

    def test_gap_triggers_a_live_resync(self):
        with patch.object(playback, "SEQUENCE_GAP_RESYNC_SECONDS", 0.1), patch.object(
            playback, "WAIT_POLL_SECONDS", 0.05
        ), self.client.websocket_connect("/ws/playback") as ws:
            ws.send_json({
                "type": "open",
                "session_id": "existing-session",
                "epoch": 3,
                "last_presented_seq": -1,
                "decoder_state_preserved": True,
            })
            self.assertEqual(ws.receive_json()["mode"], "resumed")
            ws.receive_bytes()  # seq 0 is delivered normally
            command = self._next_command()
            self.assertEqual(command, {"type": "resync", "reason": "sequence_gap"})
            self.assertEqual(self.state.result_store, {})

    def test_waiting_for_the_live_edge_is_not_a_gap(self):
        self.state.result_store.pop((3, 2))
        with patch.object(playback, "SEQUENCE_GAP_RESYNC_SECONDS", 0.1), patch.object(
            playback, "WAIT_POLL_SECONDS", 0.05
        ), self.client.websocket_connect("/ws/playback") as ws:
            ws.send_json({
                "type": "open",
                "session_id": "existing-session",
                "epoch": 3,
                "last_presented_seq": -1,
                "decoder_state_preserved": True,
            })
            self.assertEqual(ws.receive_json()["mode"], "resumed")
            ws.receive_bytes()
            self.assertIsNone(self._next_command(timeout=0.4))


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
