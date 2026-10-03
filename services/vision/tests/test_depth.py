import unittest
from unittest.mock import patch

import numpy as np

import torch

from app.services.depth import DepthEstimator, masked_median_distances, scale_camera_intrinsic


class DepthUtilityTests(unittest.TestCase):
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
