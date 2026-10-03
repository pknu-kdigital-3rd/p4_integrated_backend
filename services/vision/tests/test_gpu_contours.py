import ctypes
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
import torch
from ultralytics.engine.results import Masks

from app.services.gpu_contours import assemble_polygons, gpu_mask_polygons, validate_gpu_contours
from app.services.yolo import _bounded_mask_polygon, _normalized_mask_polygons
from tests.test_mask_transfer import cuda_tensor_operations_available, example_masks


class NativeContourGeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = shutil.which("g++")
        if not compiler:
            raise unittest.SkipTest("native geometry tests require g++")
        cache = Path(__file__).parents[1] / "__pycache__"
        cache.mkdir(exist_ok=True)
        directory = cache / f"p4-contour-tests-{uuid.uuid4().hex}"
        directory.mkdir()
        source = Path(__file__).parents[1] / "app/services/cuda/contour_cpu.cpp"
        library_path = directory / ("contours.dll" if sys.platform == "win32" else "contours.so")
        cls.addClassCleanup(directory.rmdir)
        cls.addClassCleanup(library_path.unlink, missing_ok=True)
        result = subprocess.run([compiler, "-std=c++17", "-O2", "-shared", "-fPIC",
                                 "-static-libgcc", "-static-libstdc++", str(source), "-o", str(library_path)],
                                capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(f"native contour test build failed: {result.stderr}")
        if sys.platform == "win32":
            import _ctypes

            dll_directory = os.add_dll_directory(str(Path(compiler).parent))
            cls.addClassCleanup(dll_directory.close)
        cls.library = ctypes.CDLL(str(library_path))
        if sys.platform == "win32":
            cls.addClassCleanup(_ctypes.FreeLibrary, cls.library._handle)
        cls.library.p4_trace_cpu.argtypes = [ctypes.c_void_p] * 5 + [ctypes.c_int] * 5
        cls.library.p4_trace_cpu.restype = None

    def trace(self, masks, orig_shape=None, max_points=4096, max_components=64):
        masks = np.ascontiguousarray(masks, dtype=np.uint8)
        count, height, width = masks.shape
        counts = np.zeros(count, np.int32)
        metadata = np.zeros((count, max_components, 3), np.int32)
        points = np.zeros((count, max_components, max_points, 2), np.int32)
        errors = np.zeros(count, np.int32)
        self.library.p4_trace_cpu(
            masks.ctypes.data, counts.ctypes.data, metadata.ctypes.data, points.ctypes.data,
            errors.ctypes.data, count, height, width, max_components, max_points,
        )
        if np.any(errors):
            return errors, counts
        chunks = [points[n, slot, :metadata[n, slot, 1]]
                  for n in range(count) for slot in range(counts[n])]
        payload = np.concatenate(chunks) if chunks else np.empty((0, 2), np.int32)
        return assemble_polygons(metadata, counts, payload, (height, width),
                                 orig_shape or (height, width))

    def assert_matches_legacy(self, masks, orig_shape=None):
        masks = np.asarray(masks, dtype=np.uint8)
        shape = orig_shape or masks.shape[1:]
        expected = Masks(masks, shape).xyn
        actual = self.trace(masks, shape)
        self.assertEqual(len(actual), len(expected))
        for index, (left, right) in enumerate(zip(actual, expected)):
            with self.subTest(instance=index):
                np.testing.assert_array_equal(left, right)

    def test_holes_disconnected_thin_and_edge_components(self):
        for shape in ((37, 61), (720, 1280), (100, 100)):
            self.assert_matches_legacy(example_masks().numpy(), shape)

    def test_nested_island_is_excluded_and_diagonal_contacts_are_connected(self):
        masks = np.zeros((3, 17, 19), np.uint8)
        masks[0, 1:16, 1:18] = 1
        masks[0, 3:14, 3:16] = 0
        masks[0, 6:10, 6:10] = 1
        for i in range(12):
            masks[1, i, i] = 1
        masks[2, :5, :5] = 1
        masks[2, 5:10, 5:10] = 1
        self.assert_matches_legacy(masks)

    def test_empty_full_single_pixel_and_two_pixel_masks(self):
        for shape in ((1, 1), (1, 8), (9, 1), (9, 11)):
            masks = np.zeros((4, *shape), np.uint8)
            masks[1] = 1
            masks[2, 0, 0] = 1
            masks[3].reshape(-1)[:2] = 1
            self.assert_matches_legacy(masks)

    def test_randomized_topology_and_order_against_opencv(self):
        rng = np.random.default_rng(42)
        for density in (0.1, 0.3, 0.5, 0.8, 0.95):
            with self.subTest(density=density):
                self.assert_matches_legacy((rng.random((25, 9, 11)) < density).astype(np.uint8))

    def test_gpu_point_sampling_policy_matches_existing_cap_for_single_component(self):
        masks = np.zeros((1, 40, 100), np.uint8)
        for column in range(100):
            masks[0, 5 + column % 9:35, column] = 1
        expected = _bounded_mask_polygon(Masks(masks, (40, 100)).xyn[0], 16)
        actual = self.trace(masks, max_points=16)[0]
        np.testing.assert_array_equal(actual, expected)

    def test_component_overflow_is_reported_instead_of_silently_dropping_regions(self):
        masks = np.zeros((1, 15, 15), np.uint8)
        masks[:, ::3, ::3] = 1
        errors, counts = self.trace(masks, max_components=2)
        self.assertEqual(errors.tolist(), [1])
        self.assertEqual(counts.tolist(), [25])


class GpuContourIntegrationTests(unittest.TestCase):
    def test_cpu_inference_keeps_legacy_path_in_gpu_mode(self):
        masks = example_masks()
        result = SimpleNamespace(masks=Masks(masks, (37, 61)))
        with patch("app.services.yolo.settings.YOLO_MASK_TRANSFER", "gpu"), patch(
            "app.services.gpu_contours.gpu_mask_polygons"
        ) as gpu:
            actual = _normalized_mask_polygons(result, [1, 0])
        gpu.assert_not_called()
        for left, right in zip(actual, Masks(masks[[1, 0]], (37, 61)).xyn):
            np.testing.assert_array_equal(left, right)

    def test_gpu_route_rejects_host_tensors(self):
        with self.assertRaises(ValueError):
            gpu_mask_polygons(example_masks(), (37, 61))

    @unittest.skipUnless(cuda_tensor_operations_available(), "requires a supported CUDA PyTorch GPU")
    def test_cuda_production_route_matches_legacy_without_cpu_contour_calls(self):
        validate_gpu_contours("cuda:0")
        masks = example_masks().cuda()
        original = masks.clone()
        result = SimpleNamespace(masks=Masks(masks, (720, 1280)))
        for contour_size in (640, 32):
            with patch("app.services.yolo.settings.YOLO_MASK_CONTOUR_SIZE", contour_size):
                with patch("app.services.yolo.settings.YOLO_MASK_TRANSFER", "legacy"):
                    expected = _normalized_mask_polygons(result, [2, 0, 1, 3])
                with patch("app.services.yolo.settings.YOLO_MASK_TRANSFER", "gpu"), patch(
                    "cv2.findContours", side_effect=AssertionError("CPU contour extraction in GPU mode")
                ), patch("numpy.unpackbits", side_effect=AssertionError("CPU mask unpacking in GPU mode")):
                    actual = _normalized_mask_polygons(result, [2, 0, 1, 3])
                    from app.services.mask_transfer import _transfer_state

                    metadata_buffer = _transfer_state.host_metadata
                    vertex_buffer = _transfer_state.host_vertices
                    repeated = _normalized_mask_polygons(result, [2, 0, 1, 3])
                    self.assertIs(_transfer_state.host_metadata, metadata_buffer)
                    self.assertIs(_transfer_state.host_vertices, vertex_buffer)
            for left, right, again in zip(actual, expected, repeated):
                np.testing.assert_array_equal(left, right)
                np.testing.assert_array_equal(left, again)
        torch.testing.assert_close(masks, original)


@unittest.skipUnless(os.getenv("P4_CONTOUR_TEST_NVRTC"), "explicit native CUDA validation not requested")
class NativeCudaKernelTests(NativeContourGeometryTests):
    @classmethod
    def setUpClass(cls):
        from tests.native_cuda_runner import NativeCudaRunner

        cls.runner = NativeCudaRunner(os.environ["P4_CONTOUR_TEST_NVRTC"])
        cls.addClassCleanup(cls.runner.close)

    def trace(self, masks, orig_shape=None, max_points=4096, max_components=64):
        return self.runner.trace(masks, orig_shape, max_points, max_components)


if __name__ == "__main__":
    unittest.main()
