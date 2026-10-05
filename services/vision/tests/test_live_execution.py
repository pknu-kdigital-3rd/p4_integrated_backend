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
from app.services.yolo import _decode_records, _decode_session, _source_metadata, K_START, K_FRAME, K_RESET, K_END, FRAME_META_LENGTH
from app.services.telemetry import TelemetryBatchIn


class LiveExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_relay_decode_preserves_qr_identity_and_telemetry(self):
        encoder = av.CodecContext.create("libx264", "w")
        encoder.width, encoder.height = 64, 48
        encoder.pix_fmt = "yuv420p"
        encoder.time_base = Fraction(1, 30)
        encoder.options = {"preset": "medium", "bf": "2"}
        packets = []
        for index in range(8):
            frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), index * 25, dtype=np.uint8), format="bgr24")
            frame.pts = index
            packets.extend(encoder.encode(frame))
        packets.extend(encoder.encode())
        source_origin = 1454597711189433
        records = [(K_START, memoryview(b'{"epoch":1}'))]
        expected_sources = {}
        for seq, packet in enumerate(packets):
            source_ns = source_origin + packet.pts * 33_333_333
            pts = 90000 + packet.pts * 3000
            metadata = {"epoch": 1, "seq": seq, "pts_90k": pts,
                        "timestamp_us": pts * 1000000 // 90000,
                        "keyframe": packet.is_keyframe,
                        "qr": {"source_timestamp_ns": str(source_ns), "decode_success": True},
                        "recording": {"trip_id": "8", "vehicle_id": "1", "recording_session_id": "native-test"}}
            expected_sources[seq] = source_ns
            body = json.dumps(metadata).encode()
            records.append((K_FRAME, memoryview(FRAME_META_LENGTH.pack(len(body)) + body + bytes(packet))))
        records.append((K_END, memoryview(b"")))

        class InlineDecoder:
            async def reset(self):
                self.context = av.CodecContext.create("h264", "r")

            async def decode(self, packet=None):
                return self.context.decode(packet) if packet is not None else self.context.decode()

            async def run(self, function, *args):
                return function(*args)

        async def run(decoder):
            state = AppState()
            timestamps = sorted(expected_sources.values())
            state.telemetry_store.ingest(TelemetryBatchIn(
                mode="REPLAY", tripId="8", vehicleId="1", recordingSessionId="native-test",
                gps=[{"timestamp_ns": ts, "latitude": 35, "longitude": 129} for ts in timestamps],
                imu=[{"timestamp_ns": ts, "pitch_deg": 1, "roll_deg": 2, "yaw_deg": 3} for ts in timestamps],
            ))
            frames = []

            async def retain(_state, frame):
                frames.append(frame)

            with patch("app.services.yolo._read_record", new=AsyncMock(
                side_effect=records + [asyncio.IncompleteReadError(b"", 4)]
            )), patch("app.services.yolo._enqueue_inference_frame", side_effect=retain):
                with self.assertRaises(asyncio.IncompleteReadError):
                    await _decode_records(None, state, decoder)
            observations = []
            self.assertEqual(len(frames), 8)
            for frame in frames:
                # Compare native decoded PTS to its selected metadata, not only
                # async output against an equally incorrect inline baseline.
                self.assertEqual(frame.frame.pts, frame.pts)
                self.assertEqual(frame.time_base, float(Fraction(1, 90000)))
                self.assertEqual(frame.resolved_source_timestamp_ns, expected_sources[frame.seq])
                source = await timed_inference(_source_metadata, frame, state.metrics)
                matched = state.telemetry_store.match(source["recording"], int(source["resolved_source_timestamp_ns"]))
                self.assertEqual(matched["status"], "ok")
                self.assertEqual(matched["match"]["gps"], "exact")
                self.assertEqual(matched["match"]["imu_delta_ms"], 0)
                self.assertEqual(frame.prepared.image.shape[:2], (48, 64))
                np.testing.assert_array_equal(frame.prepared.image, frame.frame.to_ndarray(format="bgr24"))
                observations.append((source, matched, frame.encoded, frame.frame.to_ndarray(format="bgr24")))
            return observations

        baseline = await run(InlineDecoder())
        decoder = OrderedDecoder(VisionMetrics())
        try:
            actual = await run(decoder)
        finally:
            await decoder.close()
        for before, after in zip(baseline, actual):
            self.assertEqual(before[:3], after[:3])
            np.testing.assert_array_equal(before[3], after[3])

    async def test_frame_preparation_runs_on_decode_thread_and_falls_back(self):
        from app.services.yolo import _queue_decoded_frame
        frame = av.VideoFrame.from_ndarray(np.zeros((48, 64, 3), dtype=np.uint8), format="bgr24")
        threads = []

        def prepare(received, depth_enabled):
            threads.append(threading.get_ident())
            self.assertIs(received, frame)
            self.assertFalse(depth_enabled)
            return "prepared"

        def fail(received, depth_enabled):
            raise ValueError("bad frame")

        decoder = OrderedDecoder(VisionMetrics())
        queued = []

        async def retain(_state, inference_frame):
            queued.append(inference_frame)

        try:
            await decoder.reset()
            decode_thread = await decoder.run(threading.get_ident)
            for seq, function, mode in ((1, prepare, "decode"), (2, fail, "decode"), (3, prepare, "inference")):
                state = AppState()
                with patch("app.services.yolo.prepare_inference_inputs", side_effect=function), patch(
                    "app.services.yolo.settings.VISION_FRAME_PREP_THREAD", mode
                ), patch("app.services.yolo._enqueue_inference_frame", side_effect=retain):
                    await _queue_decoded_frame(state, {"epoch": 1, "seq": seq, "_encoded": b""}, frame, decoder)
        finally:
            await decoder.close()
        self.assertEqual([item.prepared for item in queued], ["prepared", None, None])
        self.assertEqual(threads, [decode_thread])
        self.assertNotEqual(decode_thread, threading.get_ident())

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
