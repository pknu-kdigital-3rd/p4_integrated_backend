import asyncio
from contextlib import suppress
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import av
import numpy as np
import torch
from ultralytics.engine.results import Boxes, Masks

from app.core.settings import BASE_DIR, Settings
from app.core.state import AppState, InferenceFrame, PlaybackItem
from app.services.yolo import (
    _box_field_values,
    _box_rows,
    _bounded_mask_polygon,
    _skipped_frame_result,
    _model_confidence_floor,
    overlay_class_names,
    _resolve_yolo_classes,
    _tracker_config_cache,
    tracker_confidence_config,
    _enqueue_inference_frame,
    _schedule_playback_deadline,
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
    def test_source_depth_is_converted_once_and_yolo_resized_from_shared_bgr(self):
        import av
        import cv2
        from app.services.depth import DepthFrame
        pixels = np.random.default_rng(4).integers(0, 256, (96, 128, 3), dtype=np.uint8)
        decoded = av.VideoFrame.from_ndarray(pixels, format="bgr24").reformat(format="yuv420p")
        source = SimpleNamespace(width=128, height=96,
                                 to_ndarray=Mock(wraps=decoded.to_ndarray), reformat=Mock(wraps=decoded.reformat))
        observed = {}
        class Model:
            names = {}
            def __call__(self, image, **kwargs):
                observed["yolo"] = image.copy()
                return [SimpleNamespace(boxes=[], masks=None)]
        class Depth:
            def predict(self, image, camera):
                observed["depth"] = image.copy()
                return DepthFrame(128, 96, torch.ones((96, 128)))
        with patch("app.services.yolo.settings.YOLO_TRACKING", False), patch(
            "app.services.yolo.settings.YOLO_INFERENCE_SIZE", "32x32"
        ), patch("app.services.yolo.settings.UNIDEPTH_INFERENCE_SIZE", "source"), patch(
            "app.services.yolo.settings.VISION_FRAME_PREP", "shared"
        ):
            run_yolo(InferenceFrame(1, source, None, None, None), Model(), Depth())
        source.to_ndarray.assert_called_once_with(format="bgr24")
        source.reformat.assert_not_called()
        expected = decoded.to_ndarray(format="bgr24")
        np.testing.assert_array_equal(observed["depth"], expected)
        np.testing.assert_array_equal(observed["yolo"], cv2.resize(expected, (32, 32), interpolation=cv2.INTER_AREA))

    def test_cpu_phase_timings_use_current_thread_clock(self):
        model = _SegmentationModel(SimpleNamespace(boxes=[], masks=None))
        frame = _SourceFrame(32, 32)
        with patch("app.services.yolo.settings.YOLO_TRACKING", False), patch(
            "app.services.yolo.settings.YOLO_INFERENCE_SIZE", "source"
        ), patch("app.services.yolo.thread_time", side_effect=[10, 10, 10.001, 10.002, 10.006,
                                                               10.007, 10.009, 10.010]):
            result = run_yolo(InferenceFrame(1, frame, None, None, None), model)
        self.assertAlmostEqual(result["frame_convert_thread_cpu_ms"], 1)
        self.assertAlmostEqual(result["yolo_thread_cpu_ms"], 4)
        self.assertAlmostEqual(result["postprocess_thread_cpu_ms"], 2)
        self.assertAlmostEqual(result["inference_thread_cpu_ms"], 10)
        self.assertEqual(result["depth_thread_cpu_ms"], 0)

    def test_prepared_inputs_skip_conversion_on_inference_thread(self):
        from app.services.depth import DepthFrame
        from app.services.frame_preparation import PreparedInputs
        image = np.full((32, 48, 3), 7, dtype=np.uint8)
        depth_input = np.full((64, 96, 3), 9, dtype=np.uint8)
        frame = SimpleNamespace(width=96, height=64, to_ndarray=Mock(), reformat=Mock())
        observed = {}

        class Model:
            names = {}
            def __call__(self, received, **kwargs):
                observed["yolo"] = received
                observed["imgsz"] = kwargs["imgsz"]
                return [SimpleNamespace(boxes=[], masks=None)]

        class Depth:
            def predict(self, received, camera):
                observed["depth"] = received
                return DepthFrame(96, 64, torch.ones((64, 96)))

        prepared = PreparedInputs(image, depth_input, 96, 64, (32, 48), True, 6.5, 6.0)
        with patch("app.services.yolo.settings.YOLO_TRACKING", False):
            result = run_yolo(InferenceFrame(1, frame, None, None, None, prepared=prepared), Model(), Depth())
        frame.to_ndarray.assert_not_called()
        frame.reformat.assert_not_called()
        self.assertIs(observed["yolo"], image)
        self.assertIs(observed["depth"], depth_input)
        self.assertEqual(observed["imgsz"], (32, 48))
        self.assertEqual(result["frame_convert_ms"], 6.5)
        self.assertEqual(result["frame_convert_thread_cpu_ms"], 6.0)
        self.assertEqual((result["width"], result["height"]), (96, 64))

    def test_prepared_inputs_for_other_depth_setting_are_converted_again(self):
        from app.services.frame_preparation import PreparedInputs
        frame = _SourceFrame(32, 32)
        stale = PreparedInputs(np.ones((8, 8, 3), dtype=np.uint8), None, 32, 32, 32, True, 1.0, 1.0)
        observed = {}

        class Model:
            names = {}
            def __call__(self, image, **kwargs):
                observed["shape"] = image.shape
                return [SimpleNamespace(boxes=[], masks=None)]

        with patch("app.services.yolo.settings.YOLO_TRACKING", False), patch(
            "app.services.yolo.settings.YOLO_INFERENCE_SIZE", "source"
        ):
            run_yolo(InferenceFrame(1, frame, None, None, None, prepared=stale), Model())
        self.assertEqual(observed["shape"], (32, 32, 3))

    def test_independent_depth_grid_scales_camera_and_masks_and_keeps_concurrency(self):
        import threading
        from app.services.depth import DepthFrame, make_depth_executor

        cases = (("yolo", (96, 64)), ("32x48", (48, 32)), ("96x144", (144, 96)), ("source", (192, 128)))
        for configured, expected_size, region in ((mode, size, region) for mode, size in cases
                                                  for region in ("mask", "inner_box")):
            with self.subTest(configured=configured, region=region):
                barrier = threading.Barrier(2)
                observed = {}
                masks = torch.zeros((1, 64, 96), dtype=torch.uint8)
                masks[:, :, :48] = 1
                boxes = Boxes(torch.tensor([[0., 0., 48., 64., .9, 0.]]), (64, 96))

                class Model:
                    names = {0: "person"}
                    def __call__(self, image, **kwargs):
                        observed["yolo_shape"] = image.shape
                        barrier.wait(timeout=3)
                        return [SimpleNamespace(boxes=boxes, masks=Masks(masks, (64, 96)))]

                class Depth:
                    def predict(self, image, camera):
                        observed["depth_shape"] = image.shape
                        observed["camera"] = camera
                        barrier.wait(timeout=3)
                        height, width = image.shape[:2]
                        depth = torch.arange(1, width + 1, dtype=torch.float32).expand(height, width)
                        return DepthFrame(width, height, depth)

                frame = _SourceFrame(192, 128)
                with patch("app.services.yolo.settings.YOLO_TRACKING", False), patch(
                    "app.services.yolo.settings.YOLO_INFERENCE_SIZE", "64x96"
                ), patch("app.services.yolo.settings.UNIDEPTH_INFERENCE_SIZE", configured), patch(
                    "app.services.yolo.settings.UNIDEPTH_DISTANCE_REGION", region
                ), patch("app.services.yolo.settings.UNIDEPTH_DISTANCE_BOX_SCALE", 1.0
                ), patch("app.services.yolo.settings.BBOX_FORMAT", "xyxy_normalized"), patch(
                    "app.services.yolo.settings.YOLO_DEVICE", "cpu"
                ), make_depth_executor() as executor:
                    result = run_yolo(InferenceFrame(1, frame, None, None, None), Model(), Depth(), executor)
                    timeline = result["model_timeline"]
                    self.assertEqual(timeline["mode"], "parallel")
                    self.assertGreater(timeline["overlap_ms"], 0)
                    self.assertLessEqual(timeline["yolo_start_ms"], timeline["yolo_end_ms"])
                    self.assertLessEqual(timeline["depth_start_ms"], timeline["depth_end_ms"])
                width, height = expected_size
                self.assertEqual(observed["yolo_shape"], (64, 96, 3))
                self.assertEqual(observed["depth_shape"], (height, width, 3))
                np.testing.assert_allclose(observed["camera"],
                    [[920 * width / 1280, 0, 640 * width / 1280],
                     [0, 690 * height / 720, 360 * height / 720], [0, 0, 1]], rtol=1e-6)
                self.assertEqual(result["depth"]["input_width"], width)
                self.assertEqual(result["depth"]["input_height"], height)
                self.assertEqual(result["items"][0]["distance_status"], "ok")
                self.assertEqual(result["items"][0]["distance_m"], (1 + width // 2) / 2)

    def test_mask_point_cap_preserves_order_and_small_polygons(self):
        polygon = np.arange(2000, dtype=np.float32).reshape(1000, 2)
        bounded = _bounded_mask_polygon(polygon, 256)
        self.assertEqual(bounded.shape, (256, 2))
        self.assertTrue(bounded.flags.c_contiguous)
        self.assertTrue(np.all(np.diff(bounded[:, 0]) > 0))
        small = polygon[:3]
        self.assertIs(_bounded_mask_polygon(small, 256), small)

    def test_run_yolo_shares_read_only_input_with_depth(self):
        from app.services.depth import DepthFrame
        image = np.arange(32 * 32 * 3, dtype=np.uint8).reshape(32, 32, 3)
        original = image.copy()
        frame = SimpleNamespace(width=32, height=32, to_ndarray=lambda **kwargs: image)
        inference_frame = InferenceFrame(0, frame, 0, 1 / 30, 0)
        observed = []
        class Model:
            names = {}
            def __call__(self, received, **kwargs):
                observed.append(received)
                return [SimpleNamespace(boxes=[], masks=None)]
        class Depth:
            def predict(self, received, camera):
                observed.append(received)
                return DepthFrame(32, 32, torch.ones((32, 32)))
        with patch("app.services.yolo.settings.YOLO_TRACKING", False), patch(
            "app.services.yolo.settings.YOLO_INFERENCE_SIZE", "source"
        ):
            run_yolo(inference_frame, Model(), Depth())
        self.assertEqual(len(observed), 2)
        self.assertIs(observed[0], image)
        self.assertIs(observed[1], image)
        np.testing.assert_array_equal(image, original)

    def test_fork_preprocessing_does_not_mutate_shared_image(self):
        from ultralytics.engine.predictor import BasePredictor
        predictor = BasePredictor.__new__(BasePredictor)
        predictor.device = torch.device("cpu")
        predictor.model = SimpleNamespace(fp16=False, format="engine", dynamic=False, stride=32)
        predictor.args = SimpleNamespace(rect=True)
        predictor.imgsz = (32, 32)
        image = np.arange(32 * 32 * 3, dtype=np.uint8).reshape(32, 32, 3)
        original = image.copy()
        tensor = predictor.preprocess([image])
        np.testing.assert_array_equal(image, original)
        self.assertEqual(tuple(tensor.shape), (1, 3, 32, 32))

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
        self.assertIs(result["items"][0]["mask"], polygons[1])
        self.assertTrue(result["items"][0]["mask"].flags.c_contiguous)
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


class AllocationReductionTests(unittest.TestCase):
    def test_mask_storage_converts_noncontiguous_arrays_and_preserves_lists(self):
        array = (np.arange(12, dtype=np.float64).reshape(3, 4) / 12)[:, ::2]
        self.assertFalse(array.flags.c_contiguous)
        for polygon in (array, array.tolist()):
            model = _SegmentationModel(SimpleNamespace(
                boxes=[_Box(0.9, 0, [0.1, 0.1, 0.8, 0.8])],
                masks=SimpleNamespace(xyn=[polygon]),
            ))
            frame = InferenceFrame(seq=1, frame=_SourceFrame(100, 100), pts=0, time_base=None, media_time=0)
            with patch("app.services.yolo.settings.YOLO_DEVICE", "cpu"), patch(
                "app.services.yolo.settings.YOLO_MASK_POLYGON_SIMPLIFY", False
            ):
                result = run_yolo(frame, model)
            mask = result["items"][0]["mask"]
            self.assertEqual(result["mask_count"], 1)
            if isinstance(polygon, np.ndarray):
                self.assertEqual(mask.dtype, np.float32)
                self.assertTrue(mask.flags.c_contiguous)
                np.testing.assert_allclose(mask, polygon, rtol=1e-6)
            else:
                self.assertIs(mask, polygon)

    def test_tensor_rows_match_original_fields_for_all_formats_and_tracking_modes(self):
        for dtype in (torch.float32, torch.float64):
            for tracking, with_ids in ((False, False), (True, False), (True, True), (False, True)):
                data = [[10, 20, 50, 60, 0.123456789, 0], [30, 40, 70, 80, 0.9, 1]]
                if with_ids:
                    data = [row[:4] + [index + 42] + row[4:] for index, row in enumerate(data)]
                boxes = Boxes(torch.tensor(data, dtype=dtype), orig_shape=(100, 100))
                for field in ("xyxy", "xyxyn", "xywh", "xywhn"):
                    with self.subTest(dtype=dtype, tracking=tracking, ids=with_ids, field=field):
                        expected_coords = _box_field_values(boxes, field)
                        expected_conf = _box_field_values(boxes, "conf")
                        expected_cls = _box_field_values(boxes, "cls")
                        expected_ids = boxes.id.tolist() if tracking and boxes.id is not None else None
                        original_cpu = torch.Tensor.cpu
                        transfers = []

                        def cpu(tensor, *args, **kwargs):
                            transfers.append(tensor.shape)
                            return original_cpu(tensor, *args, **kwargs)

                        with patch.object(torch.Tensor, "cpu", new=cpu):
                            rows = _box_rows(boxes, field, tracking)
                        self.assertEqual(len(transfers), 1)
                        for index, row in enumerate(rows):
                            self.assertEqual(row[:4], expected_coords[index])
                            self.assertEqual(row[4], expected_conf[index])
                            self.assertEqual(row[5], expected_cls[index])
                            self.assertEqual(row[6:] or None, [expected_ids[index]] if expected_ids else None)

    def test_tensor_and_test_double_paths_emit_identical_detections(self):
        frame = InferenceFrame(seq=1, frame=_SourceFrame(100, 100), pts=0, time_base=None, media_time=0)
        for tracking, with_ids in ((False, False), (True, False), (True, True)):
            data = [[10, 10, 20, 20, 0.2, 0], [40, 40, 80, 80, 0.9, 1]]
            if with_ids:
                data = [row[:4] + [index + 42] + row[4:] for index, row in enumerate(data)]
            boxes = Boxes(torch.tensor(data), orig_shape=(100, 100))
            double = [_Box(float(boxes.conf[i]), int(boxes.cls[i]), boxes.xyxyn[i].tolist(),
                           int(boxes.id[i]) if with_ids else None) for i in range(2)]
            with patch("app.services.yolo.settings.YOLO_DEVICE", "cpu"), patch(
                "app.services.yolo.settings.YOLO_TRACKING", tracking
            ), patch("app.services.yolo.settings.CONF_THRESHOLD_LOW", 0.3), patch(
                "app.services.yolo.settings.BBOX_FORMAT", "xyxy_normalized"
            ):
                actual = run_yolo(frame, _SegmentationModel(SimpleNamespace(boxes=boxes, masks=None)))
                expected = run_yolo(frame, _SegmentationModel(SimpleNamespace(boxes=double, masks=None)))
            self.assertEqual(actual["items"], expected["items"])

    def test_custom_fork_masks_are_contiguous_float32(self):
        data = torch.zeros((1, 16, 16))
        data[:, 2:12, 3:13] = 1
        polygon = Masks(data, orig_shape=(16, 16)).xyn[0]
        self.assertEqual(polygon.dtype, np.float32)
        self.assertEqual(polygon.shape[1], 2)
        self.assertTrue(polygon.flags.c_contiguous)
        self.assertIs(np.ascontiguousarray(polygon, dtype=np.float32), polygon)

    def test_held_items_are_cached_without_modifying_source(self):
        mask = np.array([[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]], dtype=np.float32)
        item = {"class": "car", "mask": mask, "distance_m": 12.3,
                "distance_status": "ok", "distance_anchor": [0.5, 0.6]}
        source = {"items": [item], "width": 100, "height": 100}
        state = AppState()
        frames = [InferenceFrame(seq=i, frame=None, pts=i, time_base=None, media_time=0) for i in (1, 2)]
        first = _skipped_frame_result(frames[0], source, state)
        second = _skipped_frame_result(frames[1], source, state)
        self.assertIsNot(first, second)
        self.assertIs(first["items"], second["items"])
        self.assertEqual(first["mask_count"], 1)
        self.assertIs(first["items"][0]["mask"], mask)
        self.assertEqual(first["items"][0]["held_distance_m"], 12.3)
        self.assertNotIn("distance_m", first["items"][0])
        self.assertNotIn("distance_anchor", first["items"][0])
        self.assertEqual(item["distance_status"], "ok")
        self.assertEqual(item["distance_m"], 12.3)
        self.assertEqual(second["source"]["seq"], 2)
        new_source = dict(source)
        third = _skipped_frame_result(frames[1], new_source, state)
        self.assertIsNot(first["items"], third["items"])
        empty = _skipped_frame_result(frames[1], None, state)
        self.assertEqual(empty["items"], [])
        self.assertEqual(empty["mask_count"], 0)
        state.clear_all_results()
        self.assertIsNone(state.held_items_cache)


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

    def test_playback_retention_is_bounded_without_acknowledgements(self):
        state = AppState()
        with patch("app.core.settings.settings.PLAYBACK_MAX_FRAMES", 2), patch(
            "app.core.settings.settings.BACKLOG_MAX_BYTES", 5
        ):
            for seq in range(100):
                state.put_result(PlaybackItem(1, seq, b"abc", seq, False, {}))
                self.assertLessEqual(len(state.result_store), 2)
                self.assertLessEqual(state.result_store_encoded_bytes, 5)
            self.assertEqual(list(state.result_store), [(1, 99)])
            self.assertEqual(state.result_store_evictions, 99)
            state.put_result(PlaybackItem(1, 99, b"x", 99, False, {}))
            self.assertEqual(state.result_store_encoded_bytes, 1)
            state.current_epoch = 1
            state.acknowledge(1, 99)
            self.assertEqual(state.result_store_encoded_bytes, 0)
            state.put_result(PlaybackItem(1, 100, b"abc", 100, False, {}))
            state.clear_epoch(1)
            self.assertEqual(state.result_store_encoded_bytes, 0)
            state.put_result(PlaybackItem(1, 101, b"abc", 101, False, {}))
            state.clear_all_results()
            self.assertEqual(state.result_store_encoded_bytes, 0)


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


class PlaybackDeadlineTests(unittest.IsolatedAsyncioTestCase):
    def _state_and_frame(self):
        state = AppState()
        state.current_epoch = 1
        state.last_inference_result = {
            "width": 1, "height": 1, "inference_ms": 1.0,
            "items": [{"class": "car", "distance_m": 5.0, "distance_status": "ok"}],
        }
        state.last_inference_result_epoch = 1
        frame = InferenceFrame(seq=0, frame=None, pts=0, time_base=1 / 90000,
                               media_time=0.0, epoch=1, encoded=b"frame")
        state.queued_sequences.add((1, 0))
        return state, frame

    async def _wait_until(self, condition):
        for _ in range(200):
            if condition():
                return
            await asyncio.sleep(0.005)
        self.fail("condition not reached")

    async def test_slow_inference_publishes_held_overlay_then_real_result_replaces_it(self):
        import threading
        from time import perf_counter
        state, frame = self._state_and_frame()
        release = threading.Event()
        real = {"width": 1, "height": 1, "items": [{"class": "bus"}], "inference_ms": 99.0}

        def slow_run_yolo(inference_frame, yolo_model, **_kwargs):
            release.wait(5)
            return real

        with patch("app.services.yolo.settings.PLAYBACK_DEADLINE_MS", 20.0), patch(
            "app.services.yolo.settings.YOLO_FRAME_DROP_POLICY", "latest"
        ), patch("app.services.yolo.run_yolo", side_effect=slow_run_yolo):
            await state.inference_queue.put(frame)
            _schedule_playback_deadline(state, frame, perf_counter())
            task = asyncio.create_task(yolo_worker(state))
            try:
                await self._wait_until(lambda: (1, 0) in state.result_store)
                held = state.result_store[(1, 0)].result
                self.assertTrue(held["inference_skipped"])
                self.assertEqual(held["items"][0]["held_distance_m"], 5.0)
                self.assertEqual(state.metrics.deadline_frames_published, 1)
                release.set()
                await self._wait_until(lambda: state.result_store[(1, 0)].result is real)
            finally:
                release.set()
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        self.assertEqual(state.metrics.late_inference_results, 1)
        self.assertEqual(state.metrics.playback_frames_published, 1)
        self.assertIs(state.last_inference_result, real)

    async def test_result_before_deadline_is_not_replaced_by_held_overlay(self):
        from time import perf_counter
        state, frame = self._state_and_frame()
        real = {"width": 1, "height": 1, "items": [], "inference_ms": 1.0}
        with patch("app.services.yolo.settings.PLAYBACK_DEADLINE_MS", 200.0), patch(
            "app.services.yolo.settings.YOLO_FRAME_DROP_POLICY", "latest"
        ), patch("app.services.yolo.run_yolo", return_value=real):
            await state.inference_queue.put(frame)
            _schedule_playback_deadline(state, frame, perf_counter())
            task = asyncio.create_task(yolo_worker(state))
            try:
                await self._wait_until(lambda: (1, 0) in state.result_store)
                self.assertIs(state.result_store[(1, 0)].result, real)
                await asyncio.sleep(0.25)
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        self.assertIs(state.result_store[(1, 0)].result, real)
        self.assertEqual(state.metrics.deadline_frames_published, 0)
        self.assertEqual(state.metrics.late_inference_results, 0)

    async def test_deadline_is_off_for_queue_policy_zero_deadline_and_faults(self):
        from time import perf_counter
        for policy, deadline, fault in (("queue", 20.0, None), ("latest", 0.0, None),
                                        ("latest", 20.0, "inference failed")):
            with self.subTest(policy=policy, deadline=deadline, fault=fault):
                state, frame = self._state_and_frame()
                state.fault = fault
                with patch("app.services.yolo.settings.PLAYBACK_DEADLINE_MS", deadline), patch(
                    "app.services.yolo.settings.YOLO_FRAME_DROP_POLICY", policy
                ):
                    _schedule_playback_deadline(state, frame, perf_counter())
                    await asyncio.sleep(0.06)
                self.assertEqual(state.result_store, {})
                self.assertEqual(state.metrics.deadline_frames_published, 0)


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



class OverlayClassNamesTests(unittest.TestCase):
    NAMES = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck", 16: "dog"}

    def test_yolo_classes_filter_defines_the_menu(self):
        self.assertEqual(overlay_class_names(self.NAMES, [3, 0]), ["motorcycle", "person"])

    def test_default_list_when_every_class_is_kept(self):
        self.assertEqual(
            overlay_class_names(self.NAMES, None),
            ["person", "bicycle", "car", "motorcycle", "bus", "truck"],
        )

    def test_default_list_skips_classes_the_model_lacks(self):
        self.assertEqual(overlay_class_names({0: "person", 16: "dog"}, None), ["person"])


if __name__ == "__main__":
    unittest.main()
