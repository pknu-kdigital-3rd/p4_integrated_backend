import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
import torch
from ultralytics.models.yolo.segment.predict import SegmentationPredictor

from app.services.realtime_predictor import RealtimeSegmentationPredictor, StageTimer
from tests.test_mask_transfer import cuda_tensor_operations_available


class RealtimePredictorTests(unittest.TestCase):
    def test_async_engine_reuses_nondefault_stream_and_waits_for_caller(self):
        predictor = RealtimeSegmentationPredictor.__new__(RealtimeSegmentationPredictor)
        predictor.device = torch.device("cuda:0")
        predictor.model = SimpleNamespace(format="engine", backend=object())
        caller, service = Mock(), Mock()
        with patch("app.services.realtime_predictor.settings.YOLO_TRT_EXECUTION", "async"), patch(
            "app.services.realtime_predictor.enable_async_tensorrt", return_value=True
        ), patch("torch.cuda.current_stream", return_value=caller), patch(
            "torch.cuda.Stream", return_value=service
        ) as create, patch("torch.cuda.stream") as context:
            for _ in range(2):
                with predictor._frame_execution():
                    self.assertTrue(predictor._fast_frame_active)
        create.assert_called_once_with(device=predictor.device)
        self.assertEqual(service.wait_stream.call_count, 2)
        service.wait_stream.assert_called_with(caller)
        context.assert_called_with(service)
        self.assertFalse(predictor._fast_frame_active)

    def test_pinned_staging_matches_fork_values_reuses_buffers_and_keeps_source(self):
        predictor = RealtimeSegmentationPredictor.__new__(RealtimeSegmentationPredictor)
        predictor.device = torch.device("cuda:0")
        predictor.model = SimpleNamespace(fp16=False)
        predictor._fast_frame_active = True
        image = np.arange(8 * 12 * 3, dtype=np.uint8).reshape(8, 12, 3)
        original = image.copy()
        predictor.pre_transform = Mock(side_effect=lambda images: images)
        real_empty = torch.empty
        def allocate(shape, **kwargs):
            return real_empty(shape, dtype=kwargs["dtype"], device="cpu")
        with patch("app.services.realtime_predictor.settings.YOLO_PINNED_INPUT", True), patch(
            "torch.empty", side_effect=allocate
        ) as allocation:
            actual = predictor.preprocess([image])
            predictor.preprocess([image])
            self.assertEqual(allocation.call_count, 2)
            predictor.preprocess([np.zeros((4, 6, 3), np.uint8)])
            self.assertEqual(allocation.call_count, 4)
        expected = torch.from_numpy(image).permute(2, 0, 1).flip(0).float().unsqueeze(0) / 255
        torch.testing.assert_close(actual, expected)
        np.testing.assert_array_equal(image, original)

    def test_cuda_exception_drains_frame_before_buffer_reuse(self):
        predictor = RealtimeSegmentationPredictor.__new__(RealtimeSegmentationPredictor)
        predictor.device = torch.device("cuda:0")
        predictor.model = SimpleNamespace(format="pt")
        stream = Mock()
        event = Mock()
        with patch("torch.cuda.current_stream", return_value=stream), patch("torch.cuda.stream"), patch(
            "torch.cuda.Event", return_value=event
        ), self.assertRaisesRegex(ValueError, "failed frame"):
            with predictor._frame_execution():
                raise ValueError("failed frame")
        event.record.assert_called_once_with(stream)
        event.synchronize.assert_called_once()
        self.assertFalse(predictor._fast_frame_active)

    def test_file_sources_keep_upstream_stream_behavior(self):
        predictor = RealtimeSegmentationPredictor.__new__(RealtimeSegmentationPredictor)
        predictor.args = SimpleNamespace()
        with patch.object(SegmentationPredictor, "stream_inference", return_value=iter(["upstream"])) as upstream:
            self.assertEqual(list(predictor.stream_inference("video.mp4")), ["upstream"])
        upstream.assert_called_once_with("video.mp4", None)

    def test_cuda_stage_timing_waits_once_on_final_event(self):
        events = [Mock() for _ in range(6)]
        for event in events:
            event.elapsed_time.return_value = 5.0
        device = torch.device("cuda:0")
        with patch("torch.cuda.device"), patch("torch.cuda.current_stream", return_value="stream"), patch(
            "torch.cuda.Event", side_effect=events
        ) as create, patch("torch.cuda.synchronize", side_effect=AssertionError("device-wide wait")):
            stages = [StageTimer(device) for _ in range(3)]
            for stage in stages:
                with stage:
                    pass
            self.assertFalse(any(event.synchronize.called for event in events))
            StageTimer.finish(stages)
        for event in events[:-1]:
            event.synchronize.assert_not_called()
        events[-1].synchronize.assert_called_once()
        for stage in stages:
            self.assertEqual(stage.dt, 0.005)
            self.assertEqual(stage.t, 0.005)
        self.assertTrue(all(call.kwargs.get("blocking") for call in create.call_args_list[1::2]))

    def test_service_loop_preserves_tracking_callbacks_and_speed(self):
        predictor = RealtimeSegmentationPredictor.__new__(RealtimeSegmentationPredictor)
        predictor.args = SimpleNamespace()
        predictor.device = torch.device("cpu")
        predictor.model = SimpleNamespace(format="engine", end2end=True)
        predictor._lock = threading.Lock()
        predictor.done_warmup = True
        frame = np.zeros((8, 8, 3), np.uint8)
        predictor.dataset = [(["frame"], [frame], [""]) for _ in range(2)]
        predictor.setup_source = Mock()
        predictor.preprocess = Mock(return_value=torch.zeros((1, 3, 8, 8)))
        predictor.inference = Mock(return_value="prediction")
        predictor.postprocess = Mock(side_effect=lambda *_: [SimpleNamespace()])
        calls = []

        def callback(event):
            calls.append(event)
            if event == "on_predict_postprocess_end":
                predictor.results[0].track_id = 42

        predictor.run_callbacks = callback
        results = list(predictor.stream_inference(frame))
        self.assertEqual([result.track_id for result in results], [42, 42])
        self.assertEqual(predictor.seen, 2)
        self.assertEqual(predictor.pixels, 64)
        self.assertEqual(calls, ["on_predict_start"] + [
            "on_predict_batch_start", "on_predict_postprocess_end", "on_predict_batch_end"
        ] * 2 + ["on_predict_end"])
        self.assertEqual(set(predictor.speed), {"preprocess", "inference", "postprocess"})
        self.assertTrue(all(value >= 0 for value in predictor.speed.values()))

    def test_filtering_matches_fork_for_empty_and_nonempty_masks_and_reid(self):
        image = torch.zeros((1, 3, 8, 8))
        original = np.zeros((8, 8, 3), np.uint8)
        pred = torch.tensor([[0, 0, 4, 4, .9, 0, 1]] * 3)
        for retina in (False, True):
            for reid in (None, object()):
                for empty in (False, True):
                    predictor = RealtimeSegmentationPredictor.__new__(RealtimeSegmentationPredictor)
                    predictor.args = SimpleNamespace(retina_masks=retina)
                    predictor.model = SimpleNamespace(names={0: "car"})
                    predictor._feats = reid
                    masks = torch.ones((3, 8, 8), dtype=torch.uint8)
                    if empty:
                        masks[1] = 0
                    operation = "process_mask_native" if retina else "process_mask"
                    with patch(f"app.services.realtime_predictor.ops.{operation}", return_value=masks):
                        actual = predictor.construct_result(pred.clone(), image, original, "frame", None)
                        expected = SegmentationPredictor.construct_result(
                            predictor, pred.clone(), image, original, "frame", None
                        )
                    torch.testing.assert_close(actual.boxes.data, expected.boxes.data)
                    torch.testing.assert_close(actual.masks.data, expected.masks.data)
                    self.assertEqual(len(actual.boxes), 2 if empty and reid is None else 3)

    @unittest.skipUnless(cuda_tensor_operations_available(), "requires supported CUDA PyTorch GPU")
    def test_cuda_pinned_preprocessing_matches_upstream_and_updates_each_frame(self):
        predictor = RealtimeSegmentationPredictor.__new__(RealtimeSegmentationPredictor)
        predictor.device = torch.device("cuda:0")
        predictor.model = SimpleNamespace(fp16=True, format="pt")
        predictor.pre_transform = lambda images: images
        with patch("app.services.realtime_predictor.settings.YOLO_PINNED_INPUT", True):
            for value in (3, 17, 91):
                image = np.full((32, 48, 3), value, np.uint8)
                image[:, :, 2] += 1
                with predictor._frame_execution():
                    actual = predictor.preprocess([image])
                    ready = torch.cuda.Event(blocking=True)
                    ready.record(torch.cuda.current_stream(predictor.device))
                    ready.synchronize()
                reference = torch.from_numpy(image).to(predictor.device).unsqueeze(0).permute(0, 3, 1, 2)
                reference = reference.flip(1).contiguous().half().div_(255)
                torch.testing.assert_close(actual, reference, rtol=0, atol=0)

    @unittest.skipUnless(cuda_tensor_operations_available(), "requires supported CUDA PyTorch GPU")
    def test_cuda_events_measure_work_without_device_wide_wait(self):
        stages = [StageTimer(torch.device("cuda:0")) for _ in range(3)]
        with patch("torch.cuda.synchronize", side_effect=AssertionError("device-wide wait")):
            for stage in stages:
                with stage:
                    result = torch.ones((128, 128), device="cuda:0").sum()
            StageTimer.finish(stages)
        self.assertEqual(result.item(), 128 * 128)
        self.assertTrue(all(stage.dt >= 0 for stage in stages))


if __name__ == "__main__":
    unittest.main()
