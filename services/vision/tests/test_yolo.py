import asyncio
from contextlib import suppress
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import av
import numpy as np

from app.core.state import AppState, InferenceFrame, PlaybackItem
from app.services.yolo import (
    _take_latest_inference_frame,
    reset_tracker,
    run_yolo,
    yolo_worker,
)


class _Vector:
    def __init__(self, values):
        self.values = values

    def detach(self):
        return self

    def cpu(self):
        return self

    def tolist(self):
        return self.values


class _Box:
    def __init__(self, confidence, class_id, bbox, track_id=None):
        self.conf = [confidence]
        self.cls = [class_id]
        self.id = None if track_id is None else [track_id]
        self.xyxyn = [_Vector(bbox)]
        self.xyxy = [_Vector([value * 100 for value in bbox])]
        self.xywhn = [_Vector(bbox)]
        self.xywh = [_Vector([value * 100 for value in bbox])]


class _SegmentationModel:
    names = {0: "person", 1: "dog"}

    def __init__(self, result):
        self.result = result
        self.track_kwargs = None

    def __call__(self, *_args, **_kwargs):
        return [self.result]

    def track(self, *_args, **kwargs):
        self.track_kwargs = kwargs
        return [self.result]


class RunYoloTests(unittest.TestCase):
    def test_emits_the_mask_matching_each_retained_box(self):
        boxes = [
            _Box(0.2, 0, [0.1, 0.1, 0.2, 0.2]),
            _Box(0.9, 1, [0.4, 0.4, 0.8, 0.8]),
        ]
        polygons = [
            np.array([[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]], dtype=np.float32),
            np.array([[0.4, 0.4], [0.8, 0.4], [0.6, 0.8]], dtype=np.float32),
        ]
        model = _SegmentationModel(
            SimpleNamespace(boxes=boxes, masks=SimpleNamespace(xyn=polygons))
        )
        frame = av.VideoFrame.from_ndarray(
            np.zeros((64, 96, 3), dtype=np.uint8), format="bgr24"
        )
        inference_frame = InferenceFrame(
            seq=7,
            frame=frame,
            pts=9000,
            time_base=1 / 90000,
            media_time=0.1,
        )

        with patch("app.services.yolo.settings.YOLO_TRACKING", False), patch(
            "app.services.yolo.settings.CONF_THRESHOLD_LOW", 0.3
        ), patch("app.services.yolo.settings.BBOX_FORMAT", "xyxy_normalized"), patch(
            "app.services.yolo.settings.YOLO_DEVICE", "cpu"
        ), patch(
            "app.services.yolo.settings.YOLO_MAX_IMGSZ", 704
        ):
            result = run_yolo(inference_frame, model)

        self.assertEqual(result["width"], 96)
        self.assertEqual(result["height"], 64)
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["mask_count"], 1)
        self.assertEqual(result["items"][0]["class"], "dog")
        self.assertEqual(result["items"][0]["mask_format"], "polygon_normalized")
        self.assertTrue(np.allclose(result["items"][0]["mask"], polygons[1]))

    def test_tracking_emits_ids_and_leaves_weak_boxes_to_the_tracker(self):
        boxes = [
            _Box(0.2, 0, [0.1, 0.1, 0.2, 0.2], track_id=4),
            _Box(0.9, 1, [0.4, 0.4, 0.8, 0.8], track_id=7),
        ]
        model = _SegmentationModel(SimpleNamespace(boxes=boxes, masks=None))
        frame = av.VideoFrame.from_ndarray(
            np.zeros((64, 96, 3), dtype=np.uint8), format="bgr24"
        )
        inference_frame = InferenceFrame(
            seq=7, frame=frame, pts=9000, time_base=1 / 90000, media_time=0.1
        )

        with patch("app.services.yolo.settings.YOLO_TRACKING", True), patch(
            "app.services.yolo.settings.CONF_THRESHOLD_LOW", 0.3
        ), patch("app.services.yolo.settings.BBOX_FORMAT", "xyxy_normalized"), patch(
            "app.services.yolo.settings.YOLO_DEVICE", "cpu"
        ), patch(
            "app.services.yolo.settings.YOLO_MAX_IMGSZ", 704
        ), patch(
            "app.services.yolo.settings.YOLO_TRACKER_CONFIG", "bytetrack.yaml"
        ):
            result = run_yolo(inference_frame, model)

        # The 0.2 box survives despite the higher cutoff: the tracker owns that
        # decision now, and dropping it here would defeat the low-score
        # association that keeps an established track from blinking out.
        self.assertEqual([item["track_id"] for item in result["items"]], [4, 7])
        self.assertTrue(model.track_kwargs["persist"])
        self.assertEqual(model.track_kwargs["conf"], 0.3)
        self.assertEqual(model.track_kwargs["tracker"], "bytetrack.yaml")

    def test_reset_tracker_clears_state_for_a_new_epoch(self):
        class _Tracker:
            def __init__(self):
                self.was_reset = False

            def reset(self):
                self.was_reset = True

        tracker = _Tracker()
        model = SimpleNamespace(predictor=SimpleNamespace(trackers=[tracker]))
        reset_tracker(model)
        self.assertTrue(tracker.was_reset)

    def test_reset_tracker_drops_trackers_that_cannot_reset(self):
        predictor = SimpleNamespace(trackers=[object()])
        reset_tracker(SimpleNamespace(predictor=predictor))
        self.assertFalse(hasattr(predictor, "trackers"))

    def test_reset_tracker_is_a_no_op_before_the_first_inference(self):
        reset_tracker(SimpleNamespace(predictor=None))
        reset_tracker(SimpleNamespace())


class PutResultTests(unittest.TestCase):
    """Regression test for the actual root cause: AppState.put_result used to
    unconditionally overwrite current_epoch with whatever epoch the result
    being stored happened to carry. A stale, already-superseded result could
    therefore regress current_epoch backward and silently undo a reset -
    causing every subsequent, correctly-tagged frame to be rejected by
    yolo_worker's epoch check until some unrelated event (in production, only
    a 30-second backlog-overflow reset) forced current_epoch to resync.
    current_epoch is authoritative state driven by the relay's K_START/K_RESET
    messages (see _decode_session); storing a result must never touch it.
    """

    def test_storing_a_result_does_not_change_current_epoch(self):
        state = AppState()
        state.current_epoch = 2
        state.put_result(
            PlaybackItem(
                epoch=1,
                seq=0,
                encoded=b"",
                timestamp_us=0,
                keyframe=False,
                result={},
            )
        )
        self.assertEqual(state.current_epoch, 2)


class YoloWorkerEpochRaceTests(unittest.IsolatedAsyncioTestCase):
    """A frame's epoch is checked against state.current_epoch before
    inference starts, but inference runs in its own thread via
    asyncio.to_thread with no mid-flight cancellation - so a reset can land on
    current_epoch while an old-epoch frame is still being inferred. This
    covers the second half of the fix: yolo_worker must re-check the epoch
    after inference completes too, and discard a result that's gone stale in
    the meantime rather than storing it.
    """

    async def test_a_stale_result_is_discarded_not_stored(self):
        state = AppState()
        state.current_epoch = 1
        frame = InferenceFrame(
            seq=0,
            frame=None,
            pts=0,
            time_base=1 / 90000,
            media_time=0.0,
            epoch=1,
            timestamp_us=0,
        )
        await state.inference_queue.put(frame)

        def fake_run_yolo(inference_frame, yolo_model):
            # Stand in for a reset landing on Python's side while this
            # frame's inference was already running in its own thread -
            # exactly the race that used to regress current_epoch.
            state.current_epoch = 2
            return {"width": 1, "height": 1, "items": [], "inference_ms": 1.0}

        with patch("app.services.yolo.run_yolo", side_effect=fake_run_yolo):
            task = asyncio.create_task(yolo_worker(state))
            for _ in range(100):
                await asyncio.sleep(0)
                if state.result_store or state.current_epoch != 1:
                    break
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        self.assertEqual(state.current_epoch, 2)
        self.assertEqual(state.result_store, {})


class YoloWorkerFramePolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_latest_policy_infers_only_the_newest_queued_frame(self):
        state = AppState()
        state.current_epoch = 1
        frames = [
            InferenceFrame(
                seq=seq,
                frame=None,
                pts=seq,
                time_base=1 / 90000,
                media_time=seq / 30,
                epoch=1,
                encoded=bytes([seq]),
            )
            for seq in range(4)
        ]
        for frame in frames:
            state.queued_sequences.add((frame.epoch, frame.seq))
            await state.inference_queue.put(frame)
        calls = []

        def fake_run_yolo(inference_frame, yolo_model):
            calls.append(inference_frame.seq)
            return {
                "source": {"seq": inference_frame.seq},
                "width": 1,
                "height": 1,
                "items": [{"class": "person", "confidence": 0.9}],
                "inference_ms": 10.0,
            }

        with patch(
            "app.services.yolo.settings.YOLO_FRAME_DROP_POLICY", "latest"
        ), patch("app.services.yolo.run_yolo", side_effect=fake_run_yolo):
            task = asyncio.create_task(yolo_worker(state))
            for _ in range(100):
                await asyncio.sleep(0)
                if len(state.result_store) == len(frames):
                    break
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        self.assertEqual(calls, [3])
        self.assertEqual(list(state.result_store), [(1, 0), (1, 1), (1, 2), (1, 3)])
        self.assertTrue(state.result_store[(1, 0)].result["inference_skipped"])
        self.assertTrue(state.result_store[(1, 1)].result["inference_skipped"])
        self.assertFalse(state.queued_sequences)

    async def test_queue_policy_preserves_current_ordered_behavior(self):
        state = AppState()
        state.current_epoch = 1
        frames = [
            InferenceFrame(
                seq=seq,
                frame=None,
                pts=seq,
                time_base=1 / 90000,
                media_time=seq / 30,
                epoch=1,
                encoded=bytes([seq]),
            )
            for seq in range(3)
        ]
        for frame in frames:
            state.queued_sequences.add((frame.epoch, frame.seq))
            await state.inference_queue.put(frame)
        calls = []

        def fake_run_yolo(inference_frame, yolo_model):
            calls.append(inference_frame.seq)
            return {
                "source": {"seq": inference_frame.seq},
                "width": 1,
                "height": 1,
                "items": [],
                "inference_ms": 10.0,
            }

        with patch("app.services.yolo.settings.YOLO_FRAME_DROP_POLICY", "queue"), patch(
            "app.services.yolo.run_yolo", side_effect=fake_run_yolo
        ):
            task = asyncio.create_task(yolo_worker(state))
            for _ in range(100):
                await asyncio.sleep(0)
                if len(state.result_store) == len(frames):
                    break
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        self.assertEqual(calls, [0, 1, 2])
        self.assertEqual(list(state.result_store), [(1, 0), (1, 1), (1, 2)])
        self.assertFalse(state.queued_sequences)
        self.assertNotIn("inference_skipped", state.result_store[(1, 0)].result)

    async def test_latest_helper_returns_old_frames_and_keeps_newest(self):
        state = AppState()
        frames = [
            InferenceFrame(
                seq=seq,
                frame=None,
                pts=None,
                time_base=None,
                media_time=None,
            )
            for seq in range(3)
        ]
        for frame in frames[1:]:
            await state.inference_queue.put(frame)

        latest, dropped = _take_latest_inference_frame(state, frames[0])

        self.assertEqual(latest.seq, 2)
        self.assertEqual([frame.seq for frame in dropped], [0, 1])
        self.assertTrue(state.inference_queue.empty())


if __name__ == "__main__":
    unittest.main()
