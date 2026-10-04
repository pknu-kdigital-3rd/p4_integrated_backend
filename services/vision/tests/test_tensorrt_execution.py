from collections import OrderedDict, namedtuple
from types import SimpleNamespace
from unittest.mock import Mock, patch
import unittest
import torch

from app.services.tensorrt_execution import AsyncTensorRT, enable_async_tensorrt, validate_async_tensorrt


Binding = namedtuple("Binding", "name dtype shape data")


class Buffer:
    device = "cuda:0"
    def __init__(self, pointer, shape):
        self.pointer, self.shape = pointer, shape
    def data_ptr(self):
        return self.pointer
    def resize_(self, shape):
        self.shape = tuple(shape)
        self.pointer += 100


def backend(modern=True, dynamic=False):
    shape = (1, 3, 32, 32)
    bindings = OrderedDict((name, Binding(name, None, size, Buffer(pointer, size)))
                           for name, size, pointer in (("images", shape, 1), ("z", (1, 2), 2), ("a", (1, 4), 3)))
    context = Mock()
    context.set_input_shape.return_value = True
    context.set_binding_shape.return_value = True
    context.set_tensor_address.return_value = True
    context.execute_async_v3.return_value = True
    context.execute_async_v2.return_value = True
    context.get_tensor_shape.return_value = (1, 6)
    context.get_binding_shape.return_value = (1, 6)
    return SimpleNamespace(bindings=bindings, output_names=["z", "a"], context=context,
                           is_trt10=modern, dynamic=dynamic, model=Mock(), forward=Mock())


class TensorRTExecutionTests(unittest.TestCase):
    def test_validation_compares_raw_outputs_once_and_disables_bad_results(self):
        for mismatch in (False, True):
            original = Mock(return_value=[torch.ones((1, 2))])
            engine = SimpleNamespace(_p4_async_execution=True, _p4_async_validated=False,
                                     _p4_sync_forward=original,
                                     forward=Mock(return_value=[torch.full((1, 2), 2 if mismatch else 1.)]))
            event = Mock()
            with patch("torch.cuda.current_stream", return_value="stream"), patch(
                "torch.cuda.Event", return_value=event
            ), patch("app.services.tensorrt_execution.print"):
                validate_async_tensorrt(engine, SimpleNamespace(device="cuda:0"))
                validate_async_tensorrt(engine, SimpleNamespace(device="cuda:0"))
            original.assert_called_once()
            self.assertEqual(event.synchronize.call_count, 2)
            self.assertEqual(engine._p4_async_validated, not mismatch)
            if mismatch:
                self.assertIs(engine.forward, original)
                self.assertFalse(enable_async_tensorrt(engine))

    def test_modern_named_bindings_cache_addresses_and_use_callers_stream(self):
        engine = backend()
        adapter = AsyncTensorRT(engine)
        image = Buffer(10, (1, 3, 32, 32))
        with patch("torch.cuda.current_stream", return_value=SimpleNamespace(cuda_stream=123)):
            output = adapter.forward(image)
            adapter.forward(image)
            adapter.forward(Buffer(11, image.shape))
        self.assertEqual(output, [engine.bindings["a"].data, engine.bindings["z"].data])
        self.assertEqual(engine.context.set_tensor_address.call_count, 4)
        engine.context.execute_async_v3.assert_called_with(stream_handle=123)
        engine.context.execute_v2.assert_not_called()
        self.assertEqual(engine.bindings["images"].data.data_ptr(), 11)

    def test_dynamic_shape_changes_resize_outputs_and_rebind_pointers(self):
        for modern in (True, False):
            engine = backend(modern, True)
            adapter = AsyncTensorRT(engine)
            image = Buffer(10, (1, 3, 64, 64))
            with patch("torch.cuda.current_stream", return_value=SimpleNamespace(cuda_stream=123)):
                adapter.forward(image)
            self.assertEqual(engine.bindings["images"].shape, image.shape)
            self.assertEqual(engine.bindings["a"].data.shape, (1, 6))
            if modern:
                engine.context.set_input_shape.assert_called_once_with("images", image.shape)
                engine.context.set_tensor_address.assert_any_call("a", 103)
            else:
                engine.context.execute_async_v2.assert_called_once_with(bindings=[10, 102, 103], stream_handle=123)

    def test_failures_do_not_retry_synchronously(self):
        engine = backend()
        adapter = AsyncTensorRT(engine)
        with self.assertRaises(ValueError):
            adapter.forward(Buffer(10, (1, 3, 64, 64)))
        engine.context.set_tensor_address.return_value = False
        with patch("torch.cuda.current_stream", return_value=SimpleNamespace(cuda_stream=123)):
            with self.assertRaisesRegex(RuntimeError, "address"):
                adapter.forward(Buffer(10, (1, 3, 32, 32)))
            engine.context.set_tensor_address.return_value = True
            engine.context.execute_async_v3.return_value = False
            with self.assertRaisesRegex(RuntimeError, "execution failed"):
                adapter.forward(Buffer(10, (1, 3, 32, 32)))
        engine.context.execute_v2.assert_not_called()

    def test_install_is_idempotent_and_unsupported_context_is_unchanged(self):
        engine = backend()
        with patch("app.services.tensorrt_execution.print"):
            self.assertTrue(enable_async_tensorrt(engine))
            forward = engine.forward
            self.assertTrue(enable_async_tensorrt(engine))
        self.assertIs(engine.forward, forward)
        engine = backend()
        engine.context = object()
        original = engine.forward
        with patch("app.services.tensorrt_execution.print"):
            self.assertFalse(enable_async_tensorrt(engine))
        self.assertIs(engine.forward, original)


if __name__ == "__main__":
    unittest.main()
