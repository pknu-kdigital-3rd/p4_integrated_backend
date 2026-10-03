import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import torch
from ultralytics.engine.results import Masks

from app.core.settings import _default_yolo_device
from app.services.mask_transfer import compact_mask_polygons, pack_binary_masks, unpack_binary_masks
from app.services.mask_transfer import _transfer_state
from app.services.yolo import _normalized_mask_polygons


def example_masks():
    masks = torch.zeros((4, 37, 61), dtype=torch.uint8)
    masks[0, 3:30, 5:40] = 1
    masks[0, 10:20, 10:20] = 0  # hole: preserve existing external-contour behavior
    masks[1, 0:6, 0:8] = 1
    masks[1, 25:37, 45:61] = 1  # disconnected components touching image edges
    masks[2, :, 20] = 1  # thin object
    return masks  # final mask intentionally empty


class MaskTransferTests(unittest.TestCase):
    def test_round_trip_matches_numpy_packbits_without_instance_padding(self):
        generator = torch.Generator().manual_seed(42)
        for shape in ((0, 3, 5), (1, 1, 1), (3, 7, 9), (2, 32, 64)):
            for dtype in (torch.uint8, torch.bool, torch.float32):
                with self.subTest(shape=shape, dtype=dtype):
                    masks = torch.randint(0, 2, shape, generator=generator).to(dtype)
                    packed = pack_binary_masks(masks).numpy()
                    expected = np.packbits(masks.numpy().astype(np.uint8).reshape(-1), bitorder="little")
                    np.testing.assert_array_equal(packed, expected)
                    np.testing.assert_array_equal(unpack_binary_masks(packed, shape), masks.numpy())
                    self.assertEqual(packed.nbytes, (masks.numel() + 7) // 8)

    def test_noncontiguous_masks_round_trip(self):
        masks = example_masks().transpose(1, 2)
        self.assertFalse(masks.is_contiguous())
        restored = unpack_binary_masks(pack_binary_masks(masks).numpy(), tuple(masks.shape))
        self.assertTrue(restored.flags.c_contiguous)
        np.testing.assert_array_equal(restored, masks.numpy())

    def test_bad_shapes_and_payloads_are_rejected(self):
        with self.assertRaises(ValueError):
            pack_binary_masks(torch.zeros((3, 4)))
        for payload, shape in ((np.zeros(2, np.uint8), (1, 1, 1)),
                               (np.zeros(1, np.float32), (1, 1, 1)),
                               (np.zeros(1, np.uint8), (1, -1, 1))):
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                unpack_binary_masks(payload, shape)

    def test_contours_match_fork_for_holes_components_empty_and_letterbox(self):
        masks = example_masks()
        original = masks.clone()
        for shape in ((37, 61), (720, 1280), (100, 100)):
            expected = Masks(masks, shape).xyn
            actual = compact_mask_polygons(masks, shape)
            self.assertEqual(len(actual), len(expected))
            for left, right in zip(actual, expected):
                np.testing.assert_array_equal(left, right)
            self.assertTrue(all(p.dtype == np.float32 for p in actual))
        torch.testing.assert_close(masks, original)

    def test_retained_selection_and_downsampling_match_existing_path(self):
        masks = example_masks()
        result = SimpleNamespace(masks=Masks(masks, (720, 1280)))
        with patch("app.services.yolo.settings.YOLO_MASK_CONTOUR_SIZE", 32):
            expected = _normalized_mask_polygons(result, [2, 0])
            # Exercise compact transport after the actual selection/reduction,
            # including a float binary grid and normalized coordinate scaling.
            with patch("app.services.yolo._mask_polygons_for_transfer",
                       side_effect=lambda selected: compact_mask_polygons(selected.data, selected.orig_shape)):
                actual = _normalized_mask_polygons(result, [2, 0])
        for left, right in zip(actual, expected):
            np.testing.assert_array_equal(left, right)

    def test_cpu_inference_avoids_packing(self):
        result = SimpleNamespace(masks=Masks(example_masks(), (37, 61)))
        with patch("app.services.yolo.compact_mask_polygons") as compact:
            _normalized_mask_polygons(result, [0, 1])
        compact.assert_not_called()

    @unittest.skipUnless(_default_yolo_device().startswith("cuda"), "requires a supported CUDA GPU")
    def test_cuda_production_route_and_staging_reuse_match_legacy(self):
        for size in (61, 61, 45, 61):
            masks = example_masks()[:, :, :size].cuda()
            original = masks.clone()
            result = SimpleNamespace(masks=Masks(masks, (720, 1280)))
            for contour_size in (640, 32):
                with patch("app.services.yolo.settings.YOLO_MASK_CONTOUR_SIZE", contour_size):
                    with patch("app.services.yolo.settings.YOLO_MASK_TRANSFER", "legacy"):
                        expected = _normalized_mask_polygons(result, [2, 0, 1, 3])
                    with patch("app.services.yolo.settings.YOLO_MASK_TRANSFER", "packed"):
                        actual = _normalized_mask_polygons(result, [2, 0, 1, 3])
                        host = _transfer_state.host
                        event = _transfer_state.ready
                        repeated = _normalized_mask_polygons(result, [2, 0, 1, 3])
                        self.assertIs(_transfer_state.host, host)
                        self.assertIs(_transfer_state.ready, event)
                self.assertEqual(len(actual), len(expected))
                for left, right, again in zip(actual, expected, repeated):
                    np.testing.assert_array_equal(left, right)
                    np.testing.assert_array_equal(left, again)
            torch.testing.assert_close(masks, original)


if __name__ == "__main__":
    unittest.main()
