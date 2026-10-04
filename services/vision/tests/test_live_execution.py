import asyncio
import threading
import unittest
import json
from fractions import Fraction
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

import av
import numpy as np

from app.core.state import AppState, VisionMetrics
from app.services.live_execution import OrderedDecoder, timed_inference
from app.services.yolo import _decode_session, K_START, K_FRAME, K_RESET, K_END, FRAME_META_LENGTH


class LiveExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_decode_error_preserves_relay_resync(self):
        state = AppState()

        class Context:
            def decode(self, packet):
                raise av.error.InvalidDataError(1, "bad packet")

        metadata = json.dumps({"epoch": 1, "seq": 1, "pts_90k": 3000}).encode()
        body = memoryview(FRAME_META_LENGTH.pack(len(metadata)) + metadata + b"packet")
        with patch("app.services.live_execution.av.CodecContext.create", side_effect=lambda *_: Context()), patch(
            "app.services.yolo._read_record", new=AsyncMock(return_value=(K_FRAME, body))
        ):
            with self.assertRaisesRegex(RuntimeError, "requested a new epoch"):
                await _decode_session(None, state)
        self.assertEqual(state.feed_commands.get_nowait(), {"type": "resync", "reason": "decode_error"})
        self.assertEqual(state.metrics.decode_calls, 1)

    async def test_relay_session_resets_and_flushes_matching_metadata(self):
        state = AppState()
        calls = []

        class Context:
            def __init__(self):
                self.pending = None
                calls.append("reset")

            def decode(self, packet=None):
                if packet is not None:
                    self.pending = packet.pts
                    return []
                return [SimpleNamespace(pts=self.pending)]

        def record(kind, metadata):
            encoded = json.dumps(metadata).encode()
            if kind == K_FRAME:
                encoded = FRAME_META_LENGTH.pack(len(encoded)) + encoded + b"packet"
            return kind, memoryview(encoded)

        records = [
            record(K_START, {"epoch": 1}),
            record(K_FRAME, {"epoch": 1, "seq": 1, "pts_90k": 3000}),
            record(K_RESET, {"new_epoch": 2}),
            record(K_FRAME, {"epoch": 2, "seq": 2, "pts_90k": 6000}),
            record(K_END, {}),
            record(K_START, {"epoch": 3}),
            record(K_FRAME, {"epoch": 3, "seq": 3, "pts_90k": 9000}),
            record(K_END, {}),
        ]
        queued = AsyncMock()
        with patch("app.services.live_execution.av.CodecContext.create", side_effect=lambda *_: Context()), patch(
            "app.services.yolo._read_record", new=AsyncMock(side_effect=records + [asyncio.IncompleteReadError(b"", 4)])
        ), patch("app.services.yolo._queue_decoded_frame", new=queued):
            with self.assertRaises(asyncio.IncompleteReadError):
                await _decode_session(None, state)
        self.assertEqual(calls, ["reset", "reset", "reset", "reset"])
        self.assertEqual(state.current_epoch, 3)
        self.assertEqual(queued.await_count, 2)
        self.assertEqual([call.args[1]["seq"] for call in queued.await_args_list], [2, 3])
        self.assertEqual([call.args[2].pts for call in queued.await_args_list], [6000, 9000])
        self.assertEqual(state.metrics.decode_calls, 5)

    async def test_decoder_owns_reset_packets_flush_on_one_thread(self):
        metrics = VisionMetrics()
        calls = []

        class Context:
            def __init__(self):
                calls.append(("create", threading.get_ident()))

            def decode(self, packet="flush"):
                calls.append((packet, threading.get_ident()))
                if packet == "bad":
                    raise ValueError("bad packet")
                return [packet]

        decoder = OrderedDecoder(metrics, Context)
        try:
            await decoder.reset()
            self.assertEqual(await decoder.decode("first"), ["first"])
            with self.assertRaisesRegex(ValueError, "bad packet"):
                await decoder.decode("bad")
            await decoder.reset()
            self.assertEqual(await decoder.decode(), ["flush"])
        finally:
            await decoder.close()
        self.assertEqual([call[0] for call in calls], ["create", "first", "bad", "create", "flush"])
        self.assertEqual(len({call[1] for call in calls}), 1)
        self.assertNotEqual(calls[0][1], threading.get_ident())
        self.assertEqual(metrics.decode_calls, 3)
        self.assertGreater(metrics.decode_wait_ms_total, metrics.decode_ms_total)
        self.assertGreaterEqual(metrics.decode_thread_cpu_ms_total, 0)
        self.assertIsNone(decoder.context)

    async def test_blocked_decode_keeps_loop_responsive_and_cancel_drains(self):
        loop = asyncio.get_running_loop()
        started = loop.create_future()
        release = threading.Event()
        finished = threading.Event()

        class Context:
            def decode(self, packet):
                loop.call_soon_threadsafe(started.set_result, True)
                release.wait(5)
                finished.set()
                return []

        decoder = OrderedDecoder(VisionMetrics(), Context)
        await decoder.reset()
        task = asyncio.create_task(decoder.decode("packet"))
        try:
            await asyncio.wait_for(started, 2)
            # Reaching here before releasing decode proves the loop is free.
            self.assertFalse(finished.is_set())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        finally:
            release.set()
            await decoder.close()
        self.assertTrue(finished.is_set())
        self.assertIsNone(decoder.context)

    async def test_inference_dispatch_and_resume_are_separate(self):
        for fails in (False, True):
            metrics = VisionMetrics()

            def infer(frame):
                if fails:
                    raise ValueError("inference failed")
                return frame

            with patch("app.services.live_execution.perf_counter", side_effect=[1, 2, 3, 5]):
                if fails:
                    with self.assertRaises(ValueError):
                        await timed_inference(infer, "frame", metrics)
                else:
                    self.assertEqual(await timed_inference(infer, "frame", metrics), "frame")
            self.assertEqual(metrics.inference_attempts, 1)
            self.assertEqual(metrics.inference_dispatch_ms_total, 1000)
            self.assertEqual(metrics.inference_resume_ms_total, 2000)

    async def test_native_h264_matches_inline_decode(self):
        encoder = av.CodecContext.create("libx264", "w")
        encoder.width, encoder.height = 64, 48
        encoder.pix_fmt = "yuv420p"
        encoder.time_base = Fraction(1, 30)
        encoder.options = {"preset": "ultrafast", "tune": "zerolatency"}
        packets = []
        for index in range(4):
            frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), index * 50, dtype=np.uint8), format="bgr24")
            frame.pts = index
            packets.extend(encoder.encode(frame))
        packets.extend(encoder.encode())
        reference = av.CodecContext.create("h264", "r")
        decoder = OrderedDecoder(VisionMetrics())
        await decoder.reset()
        expected, actual = [], []
        try:
            for packet in packets:
                expected.extend(reference.decode(packet))
                actual.extend(await decoder.decode(packet))
            expected.extend(reference.decode())
            actual.extend(await decoder.decode())
        finally:
            await decoder.close()
        self.assertEqual(len(actual), 4)
        self.assertEqual([frame.pts for frame in actual], [frame.pts for frame in expected])
        for left, right in zip(expected, actual):
            np.testing.assert_array_equal(left.to_ndarray(format="bgr24"), right.to_ndarray(format="bgr24"))


if __name__ == "__main__":
    unittest.main()
