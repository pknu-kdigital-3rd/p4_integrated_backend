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


if __name__ == "__main__":
    unittest.main()
