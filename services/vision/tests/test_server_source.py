import asyncio
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace
from fractions import Fraction

import av
import numpy as np

from app.services.server_source import ServerSource, server_frame_receiver
from app.core.state import AppState
from app.api.playback import _frame_telemetry, _receive_controls


class ServerSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        with av.open(str(root / "video.mp4"), "w") as output:
            stream = output.add_stream("libx264", rate=10)
            stream.width, stream.height, stream.pix_fmt = 64, 48, "yuv420p"
            for i in range(20):
                frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), i * 10, dtype=np.uint8), format="rgb24")
                frame.pts, frame.time_base = i, Fraction(1, 10)
                for packet in stream.encode(frame):
                    output.mux(packet)
            for packet in stream.encode():
                output.mux(packet)
        (root / "gps.csv").write_text("timestamp_ns,latitude,longitude\n1000000000,35,129\n2000000000,36,130\n3000000000,37,131\n")
        (root / "imu.csv").write_text("timestamp_ns,pitch_deg,roll_deg,yaw_deg\n1000000000,0,1,2\n2000000000,10,11,12\n3000000000,20,21,22\n")
        self.source = ServerSource(SimpleNamespace(SERVER_DATASET_DIR=str(root), SERVER_VIDEO_FILE="video.mp4",
            SERVER_GPS_FILE="gps.csv", SERVER_IMU_FILE="imu.csv", SERVER_SOURCE_START_NS=None, SERVER_VEHICLE_ID="server"))
        self.source.load()

    def test_seek_reencodes_decodable_keyframe_and_preserves_timeline(self):
        frames = self.source.frames(0.75)
        self.addCleanup(frames.close)
        seconds, frame, encoded, keyframe = next(frames)
        self.assertAlmostEqual(seconds, 0.8)
        self.assertTrue(keyframe)
        decoder = av.CodecContext.create("h264", "r")
        decoded = decoder.decode(av.Packet(encoded))
        self.assertEqual((decoded[0].width, decoded[0].height), (64, 48))
        self.assertAlmostEqual(float(frame.pts * frame.time_base), seconds)
        self.assertAlmostEqual(self.source.duration, 2.0)

    def test_telemetry_matches_frame_and_rewinds(self):
        state = AppState(server_source=self.source)
        for ts, latitude, pitch in [(2000000000, 36, 10), (1000000000, 35, 0)]:
            telemetry = _frame_telemetry(state, {"recording": self.source.identity, "resolved_source_timestamp_ns": str(ts)})
            self.assertEqual(telemetry["gps"]["latitude"], latitude)
            self.assertEqual(telemetry["imu"]["pitch_deg"], pitch)

    def test_controls_reject_invalid_seek_and_loop(self):
        for value in [-1, 2, float("nan"), float("inf")]:
            with self.assertRaises(ValueError):
                self.source.seek(value)
        for start, end in [(1, 1), (1, 0), (-1, 1), (0, 3)]:
            with self.assertRaises(ValueError):
                self.source.set_loop(start, end)
        self.source.set_loop(0.5, 1.5)
        self.assertEqual(self.source.status()["loop"], [0.5, 1.5])

    def test_video_end_and_seek_back(self):
        tail = list(self.source.frames(1.8))
        self.assertEqual(len(tail), 2)
        self.assertAlmostEqual(tail[-1][0], 1.9)
        rewind = self.source.frames(0)
        self.addCleanup(rewind.close)
        self.assertEqual(next(rewind)[0], 0)

    def test_receiver_seeks_with_fresh_epoch_and_stops_at_loop_end(self):
        async def check():
            from app.services.yolo import _publish_skipped_frames
            state = AppState(server_source=self.source, viewer_connected=True)
            async def publish(state, frame):
                await _publish_skipped_frames(state, [frame], None, None)
            with patch('app.services.yolo._enqueue_inference_frame', side_effect=publish), patch('app.services.yolo._schedule_playback_deadline'):
                self.source.set_loop(0.5, 0.9)
                task = asyncio.create_task(server_frame_receiver(state))
                try:
                    await state.feed_commands.put({"type": "seek", "position": 0.5})
                    async def wait_end():
                        while self.source.end_seq is None:
                            await asyncio.sleep(0.01)
                    await asyncio.wait_for(wait_end(), 3)
                    first_epoch = state.current_epoch
                    items = list(state.result_store.values())
                    self.assertEqual([item.timestamp_us for item in items], [500000, 600000, 700000, 800000])
                    self.assertTrue(items[0].keyframe)
                    self.assertEqual(self.source.end_seq, 3)
                    await state.feed_commands.put({"type": "seek", "position": 0.5})
                    async def wait_epoch():
                        while state.current_epoch == first_epoch:
                            await asyncio.sleep(0.01)
                    await asyncio.wait_for(wait_epoch(), 3)
                    self.assertTrue(all(key[0] == state.current_epoch for key in state.result_store))
                    self.assertIsNone(state.last_presented)
                finally:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        asyncio.run(check())

    def test_websocket_controls_queue_valid_seek_loop_and_clear(self):
        async def check():
            state = AppState(server_source=self.source, viewer_connected=True, viewer_token=1)
            commands = iter([
                {"type": "seek", "position": -1},
                {"type": "set_loop", "start": 0.5, "end": 1.5},
                {"type": "clear_loop", "position": 0.7},
                {"type": "stop"},
            ])
            errors = []
            class Socket:
                client = "test"
                async def receive_text(self):
                    return json.dumps(next(commands))
                async def send_json(self, message):
                    errors.append(message)
            await _receive_controls(Socket(), state, [0], 1)
            self.assertEqual(len(errors), 1)
            self.assertEqual(errors[0]["type"], "control_error")
            self.assertEqual(await state.feed_commands.get(), {"type": "seek", "position": 0.5})
            self.assertEqual(await state.feed_commands.get(), {"type": "seek", "position": 0.7})
            self.assertEqual(await state.feed_commands.get(), {"type": "stop"})
            self.assertIsNone(self.source.loop)
        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
