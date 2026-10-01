import asyncio
from contextlib import suppress
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import av
import numpy as np

from app.core.settings import BASE_DIR, Settings
from app.core.state import AppState, InferenceFrame, PlaybackItem
from app.services.yolo import (
    _model_confidence_floor,
    _resolve_yolo_classes,
    _tracker_config_cache,
    tracker_confidence_config,
    _enqueue_inference_frame,
    _take_latest_inference_frame,
    load_yolo_model,
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
        self.predict_kwargs = None

    def __call__(self, *_args, **kwargs):
        self.predict_kwargs = kwargs
        return [self.result]

    def track(self, *_args, **kwargs):
        self.track_kwargs = kwargs
        return [self.result]


class _ResizedFrame:
    def __init__(self, width, height):
        self.width = width
        self.height = height

    def to_ndarray(self):
        return np.zeros((self.height, self.width, 3), dtype=np.uint8)


class _SourceFrame:
    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.reformat_args = None

    def reformat(self, *, width, height, format):
        self.reformat_args = {"width": width, "height": height, "format": format}
        return _ResizedFrame(width, height)

    def to_ndarray(self, format):
        return np.zeros((self.height, self.width, 3), dtype=np.uint8)


class RunYoloTests(unittest.TestCase):
    def test_class_filter_resolves_names_and_rejects_unknown_classes(self):
        names = {0: "person", 2: "car", 7: "bus"}
        self.assertIsNone(_resolve_yolo_classes("", names))
        self.assertEqual(_resolve_yolo_classes("car, person,2", names), [2, 0])
        with self.assertRaisesRegex(ValueError, "unknown class 'truck'"):
            _resolve_yolo_classes("car,truck", names)

    def test_class_filter_is_passed_to_tracking_and_prediction(self):
        model = _SegmentationModel(SimpleNamespace(boxes=[], masks=None))
        frame = av.VideoFrame.from_ndarray(
            np.zeros((64, 96, 3), dtype=np.uint8), format="bgr24"
        )
        inference_frame = InferenceFrame(
            seq=7, frame=frame, pts=9000, time_base=1 / 90000, media_time=0.1
        )
        with patch("app.services.yolo.settings.YOLO_CLASSES", "person"), patch(
            "app.services.yolo.settings.YOLO_DEVICE", "cpu"
        ), patch("app.services.yolo.settings.YOLO_TRACKING", True):
            run_yolo(inference_frame, model)
            self.assertEqual(model.track_kwargs["classes"], [0])
        with patch("app.services.yolo.settings.YOLO_CLASSES", "dog"), patch(
            "app.services.yolo.settings.YOLO_DEVICE", "cpu"
        ), patch("app.services.yolo.settings.YOLO_TRACKING", False):
            run_yolo(inference_frame, model)
            self.assertEqual(model.predict_kwargs["classes"], [1])

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
        ), patch(
            "app.services.yolo.settings.YOLO_RETINA_MASKS", True
        ):
            result = run_yolo(inference_frame, model)

        self.assertEqual(result["width"], 96)
        self.assertEqual(result["height"], 64)
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["mask_count"], 1)
        self.assertEqual(result["items"][0]["class"], "dog")
        self.assertEqual(result["items"][0]["mask_format"], "polygon_normalized")
        self.assertTrue(np.allclose(result["items"][0]["mask"], polygons[1]))
        self.assertTrue(model.predict_kwargs["retina_masks"])
        self.assertEqual(model.predict_kwargs["max_det"], 100)

    def test_resizes_before_bgr_and_maps_pixel_boxes_back_to_source(self):
        model = _SegmentationModel(
            SimpleNamespace(
                boxes=[_Box(0.9, 0, [0.1, 0.1, 0.2, 0.2])],
                masks=None,
            )
        )
        source_frame = _SourceFrame(1920, 1080)
        inference_frame = InferenceFrame(
            seq=7,
            frame=source_frame,
            pts=9000,
            time_base=1 / 90000,
            media_time=0.1,
        )

        with patch("app.services.yolo.settings.YOLO_TRACKING", False), patch(
            "app.services.yolo.settings.CONF_THRESHOLD_LOW", 0.3
        ), patch("app.services.yolo.settings.BBOX_FORMAT", "xyxy_pixels"), patch(
            "app.services.yolo.settings.YOLO_DEVICE", "cpu"
        ), patch(
            "app.services.yolo.settings.YOLO_MAX_IMGSZ", 640
        ):
            result = run_yolo(inference_frame, model)

        self.assertEqual(
            source_frame.reformat_args,
            {"width": 640, "height": 360, "format": "bgr24"},
        )
        self.assertEqual((result["width"], result["height"]), (1920, 1080))
        self.assertEqual(result["items"][0]["bbox"], [30.0, 30.0, 60.0, 60.0])

    def test_explicit_rectangular_inference_size_matches_model_input(self):
        model = _SegmentationModel(
            SimpleNamespace(
                boxes=[_Box(0.9, 0, [0.1, 0.1, 0.2, 0.2])],
                masks=None,
            )
        )
        source_frame = _SourceFrame(1920, 1080)
        inference_frame = InferenceFrame(
            seq=7,
            frame=source_frame,
            pts=9000,
            time_base=1 / 90000,
            media_time=0.1,
        )

        with patch("app.services.yolo.settings.YOLO_TRACKING", False), patch(
            "app.services.yolo.settings.BBOX_FORMAT", "xyxy_normalized"
        ), patch("app.services.yolo.settings.YOLO_DEVICE", "cpu"), patch(
            "app.services.yolo.settings.YOLO_INFERENCE_SIZE", "720x1280"
        ):
            run_yolo(inference_frame, model)

        self.assertEqual(
            source_frame.reformat_args,
            {"width": 1280, "height": 720, "format": "bgr24"},
        )
        self.assertEqual(model.predict_kwargs["imgsz"], (720, 1280))

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
        ), patch(
            "app.services.yolo.settings.YOLO_RETINA_MASKS", True
        ):
            result = run_yolo(inference_frame, model)

        # The 0.2 box survives despite the higher cutoff: the tracker owns that
        # decision now, and dropping it here would defeat the low-score
        # association that keeps an established track from blinking out.
        self.assertEqual([item["track_id"] for item in result["items"]], [4, 7])
        self.assertTrue(model.track_kwargs["persist"])
        self.assertEqual(model.track_kwargs["conf"], 0.3)
        self.assertTrue(model.track_kwargs["retina_masks"])
        self.assertEqual(model.track_kwargs["max_det"], 100)
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


class ModelLoadingTests(unittest.TestCase):
    def test_engine_model_skips_device_move_and_fuse(self):
        model = SimpleNamespace(task="segment", to=Mock(), fuse=Mock())
        with patch("app.services.yolo.YOLO", return_value=model) as yolo, patch(
            "app.services.yolo.settings.YOLO_MODEL", "/models/vision.engine"
        ), patch("app.services.yolo.settings.YOLO_DEVICE", "cpu"):
            loaded = load_yolo_model()

        self.assertIs(loaded, model)
        yolo.assert_called_once_with("/models/vision.engine")
        model.to.assert_not_called()
        model.fuse.assert_not_called()

    def test_checkpoint_model_moves_to_device_and_fuses(self):
        model = SimpleNamespace(task="segment", to=Mock(), fuse=Mock())
        with patch("app.services.yolo.YOLO", return_value=model), patch(
            "app.services.yolo.settings.YOLO_MODEL", "/models/vision.pt"
        ), patch("app.services.yolo.settings.YOLO_DEVICE", "cpu"):
            loaded = load_yolo_model()

        self.assertIs(loaded, model)
        model.to.assert_called_once_with("cpu")
        model.fuse.assert_called_once_with()


class VisionSettingsDefaultsTests(unittest.TestCase):
    def test_mask_defaults_keep_detail_first_behavior(self):
        self.assertIs(Settings.model_fields["YOLO_RETINA_MASKS"].default, True)
        self.assertEqual(Settings.model_fields["YOLO_MASK_CONTOUR_SIZE"].default, 640)

    def test_inference_size_accepts_rectangular_height_width(self):
        configured = Settings(_env_file=None, YOLO_INFERENCE_SIZE="720, 1280")
        self.assertEqual(configured.YOLO_INFERENCE_SIZE, "720x1280")

    def test_source_inference_size_uses_decoded_dimensions(self):
        configured = Settings(_env_file=None, YOLO_INFERENCE_SIZE="original")
        self.assertEqual(configured.YOLO_INFERENCE_SIZE, "source")

    def test_bare_model_filename_resolves_under_vision_models_directory(self):
        settings = Settings(_env_file=None, YOLO_MODEL="a4_best.engine")
        self.assertEqual(
            settings.YOLO_MODEL,
            str(BASE_DIR / "models" / "a4_best.engine"),
        )


class CompletedSequenceHistoryTests(unittest.TestCase):
    def test_completed_sequence_deduplication_is_bounded(self):
        with patch("app.core.settings.settings.BACKLOG_MAX_SECONDS", 1):
            state = AppState()
            for seq in range(121):
                state.mark_completed(1, seq)
            self.assertEqual(state.completed_sequence_limit, 120)
            self.assertEqual(len(state.completed_sequences), 120)
            self.assertNotIn((1, 0), state.completed_sequences)
            self.assertIn((1, 120), state.completed_sequences)


class InferenceQueueBoundsTests(unittest.TestCase):
    def test_app_state_uses_the_configured_finite_queue_size(self):
        with patch("app.core.settings.settings.YOLO_INFERENCE_QUEUE_SIZE", 3):
            state = AppState()

        self.assertEqual(state.inference_queue.maxsize, 3)


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

        def fake_run_yolo(inference_frame, yolo_model, **_kwargs):
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
        state.inference_queue = asyncio.Queue(maxsize=len(frames))
        for frame in frames:
            state.queued_sequences.add((frame.epoch, frame.seq))
            await state.inference_queue.put(frame)
        calls = []

        def fake_run_yolo(inference_frame, yolo_model, **_kwargs):
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
        state.inference_queue = asyncio.Queue(maxsize=len(frames))
        for frame in frames:
            state.queued_sequences.add((frame.epoch, frame.seq))
            await state.inference_queue.put(frame)
        calls = []

        def fake_run_yolo(inference_frame, yolo_model, **_kwargs):
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
        state.inference_queue = asyncio.Queue(maxsize=len(frames))
        for frame in frames[1:]:
            await state.inference_queue.put(frame)

        latest, dropped = _take_latest_inference_frame(state, frames[0])

        self.assertEqual(latest.seq, 2)
        self.assertEqual([frame.seq for frame in dropped], [0, 1])
        self.assertTrue(state.inference_queue.empty())

    async def test_latest_enqueue_replaces_pending_frame_and_publishes_the_drop(self):
        state = AppState()
        state.current_epoch = 1
        old = InferenceFrame(
            seq=1, frame=None, pts=1, time_base=None, media_time=None, epoch=1
        )
        new = InferenceFrame(
            seq=2, frame=None, pts=2, time_base=None, media_time=None, epoch=1
        )
        state.queued_sequences.update({(1, 1), (1, 2)})
        state.inference_queue.put_nowait(old)

        with patch("app.services.yolo.settings.YOLO_FRAME_DROP_POLICY", "latest"):
            await _enqueue_inference_frame(state, new)

        self.assertEqual((await state.inference_queue.get()).seq, 2)
        self.assertEqual(state.metrics.inference_frames_dropped, 1)
        self.assertEqual(state.metrics.inference_enqueue_dropped, 1)
        self.assertEqual(state.metrics.inference_worker_dropped, 0)
        self.assertTrue(state.result_store[(1, 1)].result["inference_skipped"])
        self.assertEqual(state.result_store[(1, 1)].encoded, b"")

    async def test_queue_enqueue_drops_new_frame_when_finite_queue_is_full(self):
        state = AppState()
        state.current_epoch = 1
        old = InferenceFrame(
            seq=1, frame=None, pts=1, time_base=None, media_time=None, epoch=1
        )
        new = InferenceFrame(
            seq=2, frame=None, pts=2, time_base=None, media_time=None, epoch=1
        )
        state.queued_sequences.update({(1, 1), (1, 2)})
        state.inference_queue.put_nowait(old)

        with patch("app.services.yolo.settings.YOLO_FRAME_DROP_POLICY", "queue"):
            await _enqueue_inference_frame(state, new)

        self.assertEqual((await state.inference_queue.get()).seq, 1)
        self.assertEqual(state.metrics.inference_frames_dropped, 1)
        self.assertEqual(state.metrics.inference_enqueue_dropped, 1)
        self.assertEqual(state.metrics.inference_worker_dropped, 0)
        self.assertTrue(state.result_store[(1, 2)].result["inference_skipped"])


class TrackerConfidenceConfigTests(unittest.TestCase):
    def setUp(self):
        _tracker_config_cache.clear()

    def _config(self, appear, keep):
        with patch("app.services.yolo.settings.YOLO_TRACKER_CONFIG", str(BASE_DIR / "app" / "trackers" / "bytetrack.yaml")), patch(
            "app.services.yolo.settings.YOLO_APPEAR_CONFIDENCE", appear
        ), patch("app.services.yolo.settings.YOLO_KEEP_CONFIDENCE", keep):
            return tracker_confidence_config()

    def test_without_overrides_uses_the_yaml_unchanged(self):
        path, thresholds = self._config(None, None)
        self.assertEqual(path, str(BASE_DIR / "app" / "trackers" / "bytetrack.yaml"))
        self.assertEqual(thresholds, {"appear": 0.35, "keep": 0.10})

    def test_overrides_are_written_with_high_threshold_between_keep_and_appear(self):
        import yaml

        path, thresholds = self._config(0.2, 0.05)
        self.assertEqual(thresholds, {"appear": 0.2, "keep": 0.05})
        written = yaml.safe_load(open(path, encoding="utf-8"))
        self.assertEqual(written["new_track_thresh"], 0.2)
        self.assertEqual(written["track_low_thresh"], 0.05)
        # The YAML's 0.25 would block new tracks between 0.2 and 0.25.
        self.assertEqual(written["track_high_thresh"], 0.2)
        self.assertEqual(written["tracker_type"], "bytetrack")

    def test_keep_above_appear_is_rejected(self):
        with self.assertRaises(ValueError):
            self._config(0.3, 0.5)

    def test_lower_keep_lowers_the_model_confidence_floor(self):
        with patch("app.services.yolo.settings.CONF_THRESHOLD_LOW", 0.1), patch(
            "app.services.yolo.settings.YOLO_KEEP_CONFIDENCE", 0.05
        ):
            self.assertEqual(_model_confidence_floor(), 0.05)
        with patch("app.services.yolo.settings.CONF_THRESHOLD_LOW", 0.1), patch(
            "app.services.yolo.settings.YOLO_KEEP_CONFIDENCE", None
        ):
            self.assertEqual(_model_confidence_floor(), 0.1)

    def test_blank_environment_values_mean_unset(self):
        configured = Settings(YOLO_APPEAR_CONFIDENCE="", YOLO_KEEP_CONFIDENCE=" ")
        self.assertIsNone(configured.YOLO_APPEAR_CONFIDENCE)
        self.assertIsNone(configured.YOLO_KEEP_CONFIDENCE)


if __name__ == "__main__":
    unittest.main()
