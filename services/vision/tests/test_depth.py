import unittest
from unittest.mock import Mock, patch

import numpy as np

import torch

from app.services.depth import DepthEstimator, DepthFrame, masked_median_distances, predict_timed, scale_camera_intrinsic
from app.core.settings import Settings


class DepthUtilityTests(unittest.TestCase):
    def test_depth_timing_separates_thread_cpu_from_wall_time(self):
        frame = np.zeros((32, 48, 3), np.uint8)
        output = DepthFrame(48, 32, torch.ones((32, 48)))
        estimator = Mock()
        estimator.predict.return_value = output
        timing = {}
        with patch("app.services.depth.perf_counter", side_effect=[10, 10.020]), patch(
            "app.services.depth.thread_time", side_effect=[1, 1.002]
        ):
            result, wall_ms, cpu_ms = predict_timed(estimator, frame, np.eye(3), timing)
        self.assertIs(result, output)
        self.assertAlmostEqual(wall_ms, 20)
        self.assertAlmostEqual(cpu_ms, 2)
        self.assertEqual(timing, {"start": 10, "end": 10.020})

    def test_failed_depth_call_still_records_finish(self):
        estimator = Mock()
        estimator.predict.side_effect = RuntimeError("depth failed")
        timing = {}
        with patch("app.services.depth.perf_counter", side_effect=[10, 10.020]):
            with self.assertRaisesRegex(RuntimeError, "depth failed"):
                predict_timed(estimator, np.zeros((32, 48, 3), np.uint8), np.eye(3), timing)
        self.assertEqual(timing, {"start": 10, "end": 10.020})

    def test_depth_size_validation_and_selection(self):
        for value, normalized in (("", "yolo"), (" YOLO ", "yolo"), ("original", "source"),
                                   ("360 X 640", "360x640"), ("360,640", "360x640")):
            self.assertEqual(Settings(UNIDEPTH_INFERENCE_SIZE=value).UNIDEPTH_INFERENCE_SIZE, normalized)
        for value in ("auto", "31x640", "360x4097", "bad", 360):
            with self.assertRaises(ValueError):
                Settings(UNIDEPTH_INFERENCE_SIZE=value)

    def test_depth_warmup_uses_independent_grid_and_camera(self):
        estimator = DepthEstimator.__new__(DepthEstimator)
        estimator._torch = torch
        estimator._compiled = False
        observed = []
        def predict(frame, camera):
            observed.append((frame.shape, camera.copy()))
            return DepthFrame(48, 32, torch.ones((32, 48)))
        estimator.predict = predict
        estimator._infer = lambda frame, camera, reference=False: torch.ones((1, 1, 32, 48))
        with patch("app.services.depth.settings.UNIDEPTH_INFERENCE_SIZE", "32x48"), patch(
            "app.services.depth.settings.YOLO_INFERENCE_SIZE", "720x1280"
        ):
            estimator.warmup()
        self.assertEqual(observed[0][0], (32, 48, 3))
        np.testing.assert_allclose(observed[0][1],
            [[920 * 48 / 1280, 0, 640 * 48 / 1280],
             [0, 690 * 32 / 720, 360 * 32 / 720], [0, 0, 1]], rtol=1e-6)

    def test_cpu_staging_reuses_buffers_and_preserves_bgr_input(self):
        estimator = DepthEstimator.__new__(DepthEstimator)
        estimator._torch = torch
        estimator._device = torch.device("cpu")
        estimator._input_shape = None
        frame = np.arange(18, dtype=np.uint8).reshape(2, 3, 3)
        original = frame.copy()
        with patch.object(torch, "empty", wraps=torch.empty) as allocate:
            rgb = estimator._stage_input(frame)
            host, device = estimator._host_input, estimator._device_input
            estimator._stage_input(frame)
            self.assertEqual(allocate.call_count, 2)
            self.assertFalse(allocate.call_args_list[0].kwargs["pin_memory"])
            self.assertIs(estimator._host_input, host)
            self.assertIs(estimator._device_input, device)
            estimator._stage_input(np.zeros((3, 4, 3), dtype=np.uint8))
            self.assertEqual(allocate.call_count, 4)
            self.assertIsNot(estimator._host_input, host)
        np.testing.assert_array_equal(frame, original)
        np.testing.assert_array_equal(rgb.numpy(), original[:, :, ::-1].transpose(2, 0, 1))

    def test_staging_rejects_non_uint8_frames(self):
        estimator = DepthEstimator.__new__(DepthEstimator)
        with self.assertRaises(ValueError):
            estimator._stage_input(np.zeros((2, 3, 3), dtype=np.float32))

    def test_scales_camera_intrinsic_for_resized_frame(self):
        matrix = ((100.0, 0.0, 50.0), (0.0, 120.0, 40.0), (0.0, 0.0, 1.0))
        scaled = scale_camera_intrinsic(matrix, 640, 360, 1280, 720)
        self.assertEqual(scaled.tolist(), [[50.0, 0.0, 25.0], [0.0, 60.0, 20.0], [0.0, 0.0, 1.0]])

    def test_returns_exact_masked_median_and_rejects_invalid_depth(self):
        depth = torch.tensor([[1.0, 2.0, 0.0], [float("nan"), 8.0, 4.0]])
        masks = torch.tensor(
            [
                [[1, 1, 1], [1, 1, 0]],
                [[0, 0, 0], [0, 0, 0]],
                [[0, 0, 0], [1, 0, 0]],
            ],
            dtype=torch.float32,
        )
        self.assertEqual(
            masked_median_distances(depth, masks, [0, 1, 2, 9]),
            [(2.0, "ok"), (None, "empty_mask"), (None, "no_valid_depth"), (None, "mask_unavailable")],
        )

    def test_resizes_masks_to_depth_map(self):
        depth = torch.arange(1, 17, dtype=torch.float32).reshape(4, 4)
        masks = torch.ones((1, 2, 2), dtype=torch.float32)
        self.assertEqual(masked_median_distances(depth, masks, [0]), [(8.5, "ok")])


if __name__ == "__main__":
    unittest.main()
