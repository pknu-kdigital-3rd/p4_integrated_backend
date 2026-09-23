import unittest

import torch

from app.services.depth import masked_median_distances, scale_camera_intrinsic


class DepthUtilityTests(unittest.TestCase):
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
