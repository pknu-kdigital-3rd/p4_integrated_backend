from contextlib import nullcontext
import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch
import unittest

import numpy as np
import torch

from app.core.settings import Settings
from app.services.depth import DepthEstimator, DepthFrame, load_depth_on_worker, make_depth_executor


def estimator(device="cuda"):
    result = DepthEstimator.__new__(DepthEstimator)
    result._device = torch.device(device)
    result._torch = Mock()
    result._depth_path = SimpleNamespace(eager_forward=Mock(), forward=None)
    result._optimized = True
    return result


class DepthWorkerStartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_load_and_subsequent_work_share_persistent_thread(self):
        with make_depth_executor() as executor:
            loaded_thread = await load_depth_on_worker(executor, threading.get_ident)
            next_thread = await asyncio.get_running_loop().run_in_executor(executor, threading.get_ident)
        self.assertEqual(loaded_thread, next_thread)
        self.assertNotEqual(loaded_thread, threading.get_ident())

    async def test_failed_startup_shuts_worker_down(self):
        executor = make_depth_executor()
        try:
            with self.assertRaisesRegex(RuntimeError, "load failed"):
                await load_depth_on_worker(executor, Mock(side_effect=RuntimeError("load failed")))
            with self.assertRaises(RuntimeError):
                executor.submit(lambda: None)
        finally:
            executor.shutdown(wait=True)


class DepthCompileTests(unittest.TestCase):
    def test_modes_and_cpu_selection(self):
        for device, requested, expected in (("cuda", "reduce-overhead", "reduce-overhead"),
                                             ("cuda", "default", "default"),
                                             ("cpu", "reduce-overhead", "default")):
            with self.subTest(device=device, requested=requested):
                model = estimator(device)
                with patch("app.services.depth.settings.UNIDEPTH_COMPILE", True), patch(
                    "app.services.depth.settings.UNIDEPTH_COMPILE_MODE", requested
                ), patch("app.services.depth.print"):
                    model._configure_compile(True)
                model._torch.compile.assert_called_once_with(model._depth_path.eager_forward,
                                                               mode=expected, fullgraph=False)
                self.assertEqual(model._cuda_graph_mode(), device == "cuda" and expected == "reduce-overhead")
        self.assertEqual(Settings().UNIDEPTH_COMPILE_MODE, "reduce-overhead")
        with self.assertRaises(ValueError):
            Settings(UNIDEPTH_COMPILE_MODE="bad")

    def test_disabled_compiler_missing_and_setup_failure(self):
        for enabled, available in ((False, True), (True, False)):
            model = estimator()
            with patch("app.services.depth.settings.UNIDEPTH_COMPILE", enabled), patch("app.services.depth.print"):
                model._configure_compile(available)
            self.assertFalse(model._compiled)
            model._torch.compile.assert_not_called()
        model = estimator()
        model._torch.compile.side_effect = RuntimeError("compile failed")
        with patch("app.services.depth.settings.UNIDEPTH_COMPILE", True), patch("app.services.depth.print"):
            model._configure_compile(True)
        self.assertFalse(model._compiled)
        self.assertIs(model._depth_path.forward, model._depth_path.eager_forward)

    def test_graph_step_and_owned_output_only_on_compiled_graph_path(self):
        model = estimator()
        model._compiled = True
        model._compile_mode = "reduce-overhead"
        model._stream = None
        model._torch.inference_mode.side_effect = nullcontext
        model._torch.autocast.side_effect = lambda *args, **kwargs: nullcontext()
        source = Mock()
        source.detach.return_value.float.return_value = source
        model._depth_path = Mock(return_value=source)
        model._model = Mock()
        model._model.infer.return_value = {"depth": source}
        model._stage_input = Mock()
        result = model._infer(np.zeros((2, 3, 3), np.uint8), np.eye(3))
        self.assertIs(result, source.clone.return_value)
        model._torch.compiler.cudagraph_mark_step_begin.assert_called_once()
        source.clone.assert_called_once()
        model._torch.compiler.cudagraph_mark_step_begin.reset_mock()
        source.clone.reset_mock()
        model._infer(np.zeros((2, 3, 3), np.uint8), np.eye(3), reference=True)
        model._torch.compiler.cudagraph_mark_step_begin.assert_not_called()
        source.clone.assert_not_called()

    def test_runtime_failure_retries_eager_and_turns_graph_mode_off(self):
        model = estimator()
        model._compiled = True
        model._compile_mode = "reduce-overhead"
        output = torch.ones((1, 1, 2, 3))
        model._infer = Mock(side_effect=[RuntimeError("graph failed"), output])
        with patch("app.services.depth.print"):
            result = model.predict(np.zeros((2, 3, 3), np.uint8), np.eye(3))
        self.assertEqual(result.tensor.shape, (2, 3))
        self.assertFalse(model._cuda_graph_mode())
        self.assertEqual(model._infer.call_count, 2)
        self.assertIs(model._depth_path.forward, model._depth_path.eager_forward)

    def test_warmup_checks_changing_frames_and_retained_outputs(self):
        for reuse_output in (False, True):
            model = estimator()
            model._torch = torch
            model._compiled = True
            model._compile_mode = "reduce-overhead"
            frames = []
            storage = torch.zeros((32, 48))
            def predict(frame, camera):
                frames.append(frame.copy())
                tensor = torch.from_numpy(frame[:, :, 0].copy()).float()
                if reuse_output:
                    storage.copy_(tensor)
                    tensor = storage
                return DepthFrame(48, 32, tensor)
            model.predict = predict
            model._infer = lambda frame, camera, reference=False: torch.from_numpy(
                frame[:, :, 0].copy()).float()[None, None]
            with patch("app.services.depth.settings.UNIDEPTH_INFERENCE_SIZE", "32x48"), patch(
                "app.services.depth.print"
            ):
                model.warmup()
            self.assertGreaterEqual(len(frames), 2)
            self.assertFalse(np.array_equal(frames[0], frames[1]))
            self.assertEqual(model._compiled, not reuse_output)
            self.assertEqual(model._optimized, not reuse_output)

    def test_cuda_graph_inference_preserves_prior_frame(self):
        if not torch.cuda.is_available():
            self.skipTest("CUDA unavailable")
        major, minor = torch.cuda.get_device_capability()
        if f"sm_{major}{minor}" not in torch.cuda.get_arch_list():
            self.skipTest("local GPU unsupported by locked Torch build")
        model = estimator()
        model._torch = torch
        model._compiled = True
        model._compile_mode = "reduce-overhead"
        model._input_shape = None
        model._stream = torch.cuda.Stream()
        model._ready = torch.cuda.Event(blocking=True)
        forward = torch.compile(lambda rgb: rgb[:1].float().unsqueeze(0) * 2,
                                mode="reduce-overhead", fullgraph=True)
        model._depth_path = lambda rgb, camera: forward(rgb)
        prior = []
        for value in (3, 7, 11):
            frame = np.full((8, 12, 3), value, np.uint8)
            result = model.predict(frame, np.eye(3))
            prior.append((result.tensor, value * 2))
            for retained, expected in prior:
                torch.testing.assert_close(retained, torch.full_like(retained, expected))


if __name__ == "__main__":
    unittest.main()
