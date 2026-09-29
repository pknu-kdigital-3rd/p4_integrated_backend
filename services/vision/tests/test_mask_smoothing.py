import unittest

import numpy as np

from app.services.botsort import smooth_mask_polygon


class MaskSmoothingTests(unittest.TestCase):
    def test_first_polygon_is_resampled_without_temporal_lag(self):
        polygon = np.asarray([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)
        smoothed = smooth_mask_polygon(None, polygon)
        self.assertEqual(smoothed.shape, (32, 2))
        np.testing.assert_allclose(smoothed[0], polygon[0])

    def test_temporal_blend_tracks_most_of_a_polygon_translation(self):
        previous = np.asarray([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)
        current = previous + np.asarray([0.1, 0], dtype=np.float32)
        smoothed = smooth_mask_polygon(previous, current)
        # With alpha=.65, the smoothed outline follows 65% of the 0.1 shift.
        self.assertAlmostEqual(float(smoothed[:, 0].mean()), 0.565, places=3)

    def test_contour_start_and_direction_changes_do_not_disrupt_blend(self):
        polygon = np.asarray([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32)
        rotated_reversed = polygon[::-1][np.roll(np.arange(4), 1)]
        smoothed = smooth_mask_polygon(polygon, rotated_reversed)
        reference = smooth_mask_polygon(None, polygon)
        order = lambda points: np.lexsort((points[:, 1], points[:, 0]))
        np.testing.assert_allclose(
            smoothed[order(smoothed)], reference[order(reference)], atol=1e-5
        )


if __name__ == "__main__":
    unittest.main()
