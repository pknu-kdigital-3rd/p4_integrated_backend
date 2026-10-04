"""Service predictor for in-memory frames, with stream-scoped CUDA timing."""

from time import perf_counter
from contextlib import contextmanager

import numpy as np
import torch
from ultralytics.engine.results import Results
from ultralytics.models.yolo.segment.predict import SegmentationPredictor
from ultralytics.utils import ops
from ultralytics.utils.torch_utils import smart_inference_mode

from app.services.mask_transfer import _copy_tensor_to_host
from app.core.settings import settings
from app.services.tensorrt_execution import enable_async_tensorrt, validate_async_tensorrt


class StageTimer:
    def __init__(self, device):
        self.device = device
        self.t = 0.0
        self.dt = 0.0
        self.cuda = device.type == "cuda"
        if self.cuda:
            with torch.cuda.device(device):
                self.start_event = torch.cuda.Event(enable_timing=True)
                self.end_event = torch.cuda.Event(enable_timing=True, blocking=True)

    def __enter__(self):
        if self.cuda:
            self.start_event.record(torch.cuda.current_stream(self.device))
        else:
            self.started = perf_counter()
        return self

    def __exit__(self, *_):
        if self.cuda:
            self.end_event.record(torch.cuda.current_stream(self.device))
        else:
            self.dt = perf_counter() - self.started
            self.t += self.dt

    @staticmethod
    def finish(stages):
        if stages[-1].cuda:
            # The final event follows all stages on the same stream. Sleep
            # once, then read every timestamp without device-wide waits.
            stages[-1].end_event.synchronize()
            for stage in stages:
                stage.dt = stage.start_event.elapsed_time(stage.end_event) / 1000
                stage.t += stage.dt


class RealtimeSegmentationPredictor(SegmentationPredictor):
    @contextmanager
    def _frame_execution(self):
        if self.device.type != "cuda":
            yield
            return
        async_engine = False
        if self.model.format == "engine" and settings.YOLO_TRT_EXECUTION == "async":
            backend = getattr(self.model, "backend", None)
            if backend is not None:
                async_engine = enable_async_tensorrt(backend)
        stream = torch.cuda.current_stream(self.device)
        if async_engine:
            if not hasattr(self, "_service_stream"):
                self._service_stream = torch.cuda.Stream(device=self.device)
            self._service_stream.wait_stream(stream)
            stream = self._service_stream
        with torch.cuda.stream(stream):
            self._fast_frame_active = True
            try:
                yield
            except BaseException:
                # Even a failing frame must finish queued copies/kernels before
                # its pinned host slot or TensorRT context can be reused.
                ready = torch.cuda.Event(blocking=True)
                ready.record(stream)
                ready.synchronize()
                raise
            finally:
                self._fast_frame_active = False

    def preprocess(self, images):
        if (not settings.YOLO_PINNED_INPUT or self.device.type != "cuda"
                or not getattr(self, "_fast_frame_active", False)
                or not isinstance(images, list) or len(images) != 1):
            return super().preprocess(images)
        image = self.pre_transform(images)[0]
        if image.dtype != np.uint8:
            return super().preprocess(images)
        key = (image.shape, self.device)
        if getattr(self, "_input_buffer_key", None) != key:
            self._host_image = torch.empty(image.shape, dtype=torch.uint8, pin_memory=True)
            self._host_image_array = self._host_image.numpy()
            self._device_image = torch.empty(image.shape, dtype=torch.uint8, device=self.device)
            self._input_buffer_key = key
        np.copyto(self._host_image_array, image)
        self._device_image.copy_(self._host_image, non_blocking=True)
        tensor = self._device_image.unsqueeze(0).permute(0, 3, 1, 2)
        if tensor.shape[1] == 3:
            tensor = tensor.flip(1)
        tensor = tensor.contiguous()
        return (tensor.half() if self.model.fp16 else tensor.float()).div_(255)

    @smart_inference_mode()
    def stream_inference(self, source=None, model=None, *args, **kwargs):
        # Other Ultralytics consumers retain upstream saving/streaming behavior.
        if not isinstance(source, np.ndarray) or any(
            getattr(self.args, name, False)
            for name in ("verbose", "save", "save_txt", "save_crop", "show", "embed", "visualize", "augment")
        ):
            yield from super().stream_inference(source, model, *args, **kwargs)
            return
        if self.model is None:
            self.setup_model(model)
        with self._lock:
            if self.model.format == "pt" and self.model.end2end:
                self.model.model.set_head_attr(max_det=max(self.args.max_det, 300), agnostic_nms=self.args.agnostic_nms)
            self.setup_source(source)
            self.seen, self.speed, self.pixels = 0, None, None
            self.windows, self.batch = [], None
            pixels = 0
            stages = tuple(StageTimer(self.device) for _ in range(3))
            self.run_callbacks("on_predict_start")
            for batch in self.dataset:
                self.batch = batch
                self.run_callbacks("on_predict_batch_start")
                _, originals, _ = batch
                with self._frame_execution():
                    with stages[0]:
                        image = self.preprocess(originals)
                    backend = getattr(self.model, "backend", None)
                    if backend is not None and getattr(backend, "_p4_async_execution", False):
                        validate_async_tensorrt(backend, image)
                    if not self.done_warmup:
                        self.model.warmup(im=image)
                        self.done_warmup = True
                    with stages[1]:
                        predictions = self.inference(image, *args, **kwargs)
                    with stages[2]:
                        self.results = self.postprocess(predictions, image, originals)
                    StageTimer.finish(stages)
                # Tracking consumes ready results through the upstream callback.
                self.run_callbacks("on_predict_postprocess_end")
                count = len(originals)
                self.seen += count
                pixels += count * image.shape[2] * image.shape[3]
                for result in self.results:
                    result.speed = dict(zip(("preprocess", "inference", "postprocess"),
                                            (stage.dt * 1000 / count for stage in stages)))
                self.run_callbacks("on_predict_batch_end")
                yield from self.results
            if self.seen:
                self.speed = dict(zip(("preprocess", "inference", "postprocess"),
                                      (stage.t * 1000 / self.seen for stage in stages)))
                self.pixels = round(pixels / self.seen)
        self.run_callbacks("on_predict_end")

    def construct_result(self, pred, img, orig_img, img_path, proto):
        # Match the fork's mask reconstruction/filtering, with one reduced
        # host flag instead of Python all() reading one CUDA scalar per mask.
        if pred.shape[0] == 0:
            masks = None
        elif self.args.retina_masks:
            pred[:, :4] = ops.scale_boxes(img.shape[2:], pred[:, :4], orig_img.shape)
            masks = ops.process_mask_native(proto, pred[:, 6:], pred[:, :4], orig_img.shape[:2])
        else:
            masks = ops.process_mask(proto, pred[:, 6:], pred[:, :4], img.shape[2:], upsample=True)
            pred[:, :4] = ops.scale_boxes(img.shape[2:], pred[:, :4], orig_img.shape)
        if masks is not None and getattr(self, "_feats", None) is None:
            keep = masks.amax((-2, -1)) > 0
            if not _copy_tensor_to_host(keep.all(), slot="mask_validity").item():
                pred, masks = pred[keep], masks[keep]
        return Results(orig_img, path=img_path, names=self.model.names, boxes=pred[:, :6], masks=masks)
