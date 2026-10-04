"""Service-owned async adapter for the pinned Ultralytics TensorRT backend."""

import torch


class AsyncTensorRT:
    def __init__(self, backend):
        self.backend = backend
        self.addresses = {}

    def forward(self, image):
        backend = self.backend
        context = backend.context
        if backend.dynamic and image.shape != backend.bindings["images"].shape:
            if backend.is_trt10:
                if not context.set_input_shape("images", image.shape):
                    raise RuntimeError("TensorRT rejected the input shape")
            else:
                if not context.set_binding_shape(backend.model.get_binding_index("images"), image.shape):
                    raise RuntimeError("TensorRT rejected the input shape")
            backend.bindings["images"] = backend.bindings["images"]._replace(shape=image.shape)
            for name in backend.output_names:
                shape = (context.get_tensor_shape(name) if backend.is_trt10
                         else context.get_binding_shape(backend.model.get_binding_index(name)))
                backend.bindings[name].data.resize_(tuple(shape))
        expected = backend.bindings["images"].shape
        if tuple(image.shape) != tuple(expected):
            raise ValueError(f"TensorRT input shape {tuple(image.shape)} does not match {tuple(expected)}")
        # The binding retains the input until the next frame. The service waits
        # for completion before reusing inputs or resizing output buffers.
        backend.bindings["images"] = backend.bindings["images"]._replace(data=image)
        stream = torch.cuda.current_stream(image.device)
        if backend.is_trt10:
            for name, binding in backend.bindings.items():
                pointer = binding.data.data_ptr()
                if self.addresses.get(name) != pointer:
                    if not context.set_tensor_address(name, pointer):
                        raise RuntimeError(f"TensorRT rejected buffer address for {name}")
                    self.addresses[name] = pointer
            success = context.execute_async_v3(stream_handle=stream.cuda_stream)
        else:
            success = context.execute_async_v2(
                bindings=[binding.data.data_ptr() for binding in backend.bindings.values()],
                stream_handle=stream.cuda_stream,
            )
        if not success:
            # Never retry a partly enqueued context through another execution API.
            raise RuntimeError("TensorRT asynchronous execution failed")
        return [backend.bindings[name].data for name in sorted(backend.output_names)]


def enable_async_tensorrt(backend):
    if getattr(backend, "_p4_async_disabled", False):
        return False
    if getattr(backend, "_p4_async_execution", False):
        return True
    modern = getattr(backend, "is_trt10", False)
    context = getattr(backend, "context", None)
    supported = (hasattr(context, "execute_async_v3") and hasattr(context, "set_tensor_address")
                 if modern else hasattr(context, "execute_async_v2"))
    if not supported:
        backend._p4_async_disabled = True
        print("YOLO TensorRT async API unavailable; retaining synchronous execution", flush=True)
        return False
    backend._p4_sync_forward = backend.forward
    backend.forward = AsyncTensorRT(backend).forward
    backend._p4_async_execution = True
    backend._p4_async_validated = False
    print(f"YOLO TensorRT async execution enabled; API={'v3' if modern else 'v2'}", flush=True)
    return True


def validate_async_tensorrt(backend, image):
    """Once per engine, compare enqueued raw outputs with its original backend."""
    if not getattr(backend, "_p4_async_execution", False) or backend._p4_async_validated:
        return
    stream = torch.cuda.current_stream(image.device)
    ready = torch.cuda.Event(blocking=True)
    # The synchronous reference executes independently of our service stream.
    # Finish its prepared input first; these waits occur only at validation.
    ready.record(stream)
    ready.synchronize()
    reference = [output.clone() for output in backend._p4_sync_forward(image)]
    outputs = backend.forward(image)
    ready.record(stream)
    ready.synchronize()
    try:
        if len(outputs) != len(reference):
            raise AssertionError("TensorRT output counts differ")
        for actual, expected in zip(outputs, reference):
            torch.testing.assert_close(actual, expected, rtol=1e-3, atol=1e-3)
    except AssertionError as exc:
        backend.forward = backend._p4_sync_forward
        backend._p4_async_execution = False
        backend._p4_async_disabled = True
        print(f"YOLO TensorRT async validation failed; retaining synchronous execution: {exc}", flush=True)
    else:
        backend._p4_async_validated = True
        print("YOLO TensorRT async startup validation passed (rtol=0.001, atol=0.001)", flush=True)
