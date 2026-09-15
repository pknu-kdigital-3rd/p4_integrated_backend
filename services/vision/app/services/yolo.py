from __future__ import annotations

import asyncio
import json
import struct
import uuid
from collections import deque
from contextlib import asynccontextmanager, suppress
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from time import perf_counter

import av
import numpy as np
import torch
from ultralytics import YOLO

from app.core.settings import settings
from app.core.state import AppState, InferenceFrame, PlaybackItem
from app.services.monocular import annotate_result

# The Go feed uses a length-prefixed record stream.  The length includes the
# one-byte record kind and the kind-specific body.
RECORD_HEADER = struct.Struct(">I")
FRAME_META_LENGTH = struct.Struct(">I")
K_START = 1
K_FRAME = 2
K_END = 3
K_RESET = 4
K_BEGIN = 10
K_PRESENTED_ACK = 12
K_RESYNC = 13
K_STOP = 14
RTP_VIDEO_TIME_BASE = Fraction(1, 90000)
MAX_RECORD_BYTES = 256 * 1024 * 1024


def _discard_inference_queue(state: AppState) -> None:
    while True:
        try:
            state.inference_queue.get_nowait()
        except asyncio.QueueEmpty:
            return


def _record(kind: int, body: bytes = b"") -> bytes:
    payload = bytes([kind]) + body
    return RECORD_HEADER.pack(len(payload)) + payload


def _optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


async def _read_record(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    header = await reader.readexactly(RECORD_HEADER.size)
    (length,) = RECORD_HEADER.unpack(header)
    if length < 1 or length > MAX_RECORD_BYTES:
        raise ValueError(f"invalid feed record length {length}")
    payload = await reader.readexactly(length)
    return payload[0], payload[1:]


async def _write_record(
    writer: asyncio.StreamWriter, kind: int, body: bytes = b""
) -> None:
    writer.write(_record(kind, body))
    await writer.drain()


def _parallel_devices() -> list[str]:
    """Return the configured device list, with the normal device as fallback."""

    if settings.YOLO_PARALLEL_DEVICES.strip().lower() == "auto":
        count = torch.cuda.device_count() if torch.cuda.is_available() else 0
        return [f"cuda:{index}" for index in range(count)] or [settings.YOLO_DEVICE]
    configured = [
        value.strip()
        for value in settings.YOLO_PARALLEL_DEVICES.split(",")
        if value.strip()
    ]
    return configured or [settings.YOLO_DEVICE]


def load_yolo_model(device: str | None = None) -> YOLO:
    device = device or settings.YOLO_DEVICE
    print(f"YOLO inference device: {device}")
    model = YOLO(settings.YOLO_MODEL)
    if model.task != "segment":
        raise ValueError(
            f"YOLO_MODEL must be a segmentation checkpoint; {settings.YOLO_MODEL!r} "
            f"is a {model.task!r} model"
        )
    model.to(device)
    # Fuse Conv+BatchNorm where supported. This is a one-time optimization and
    # avoids paying the unfused layer overhead on every frame.
    if hasattr(model, "fuse"):
        model.fuse()
    if device.startswith("cuda"):
        torch.backends.cudnn.benchmark = True
    return model


def load_yolo_models() -> list[YOLO]:
    """Load one independent segmentation model per configured device.

    Each model is used by exactly one inference thread.  This avoids concurrent
    predictor/tracker mutation while still allowing the GPU work itself to run
    in parallel.  Tracking is applied later by the single ordered tracker.
    """

    devices = _parallel_devices()
    if len(devices) > 1:
        print(
            "YOLO parallel segmentation enabled without object tracking "
            f"on {len(devices)} devices",
            flush=True,
        )
    return [load_yolo_model(device) for device in devices]


class _TrackerArray:
    """Small tensor-compatible wrapper for tracker versions using ``.cpu()``."""

    def __init__(self, values: np.ndarray):
        self.values = np.asarray(values, dtype=np.float32)

    def __array__(self, dtype=None):
        return self.values.astype(dtype) if dtype is not None else self.values

    def cpu(self):
        return self

    def numpy(self):
        return self.values

    def __len__(self):
        return len(self.values)

    def __iter__(self):
        return iter(self.values)

    def __getitem__(self, selection):
        return self.values[selection]

    def __ge__(self, other):
        return self.values >= other

    def __gt__(self, other):
        return self.values > other

    def __lt__(self, other):
        return self.values < other


class _TrackerDetections:
    """Minimal Results-like view consumed by Ultralytics BYTETracker.

    Keeping this adapter on CPU means the central tracker never touches CUDA
    tensors.  ``idx`` preserves the serialized detection index so assigned
    track IDs can be copied back to the corresponding mask result.
    """

    def __init__(self, xyxy: np.ndarray, conf: np.ndarray, cls: np.ndarray):
        xyxy = np.asarray(xyxy, dtype=np.float32).reshape((-1, 4))
        conf = np.asarray(conf, dtype=np.float32).reshape((-1,))
        cls = np.asarray(cls, dtype=np.float32).reshape((-1,))
        if len(xyxy):
            x1, y1, x2, y2 = xyxy.T
            xywh = np.column_stack(
                ((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1)
            ).astype(np.float32)
        else:
            xywh = np.empty((0, 4), dtype=np.float32)
        self.xyxy = _TrackerArray(xyxy)
        self.conf = _TrackerArray(conf)
        self.cls = _TrackerArray(cls)
        self.xywh = _TrackerArray(xywh)

    def __len__(self) -> int:
        return len(self.conf)

    def __getitem__(self, selection):
        return _TrackerDetections(
            self.xyxy[selection], self.conf[selection], self.cls[selection]
        )


def load_central_tracker():
    """Create one ByteTrack instance for all parallel inference workers."""

    from ultralytics.trackers.byte_tracker import BYTETracker
    import yaml

    config_path = Path(settings.YOLO_TRACKER_CONFIG)
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    return BYTETracker(SimpleNamespace(**config))


def _bbox_to_pixels(item: dict, width: int, height: int) -> list[float]:
    values = [float(value) for value in item["bbox"]]
    bbox_format = item.get("bbox_format", settings.BBOX_FORMAT)
    if bbox_format == "xyxy_normalized":
        x1, y1, x2, y2 = values
        return [x1 * width, y1 * height, x2 * width, y2 * height]
    if bbox_format == "xyxy_pixels":
        return values
    if bbox_format == "xywh_normalized":
        cx, cy, box_width, box_height = values
        cx, cy = cx * width, cy * height
        box_width, box_height = box_width * width, box_height * height
    else:
        cx, cy, box_width, box_height = values
    return [
        cx - box_width / 2,
        cy - box_height / 2,
        cx + box_width / 2,
        cy + box_height / 2,
    ]


def apply_central_tracking(result: dict, tracker, model_names: dict | list) -> None:
    """Apply ByteTrack in source order and write IDs into serialized items."""

    if not isinstance(model_names, dict):
        model_names = dict(enumerate(model_names))
    items = result["items"]
    boxes = [_bbox_to_pixels(item, result["width"], result["height"]) for item in items]
    class_ids = [
        next(
            (key for key, name in model_names.items() if name == item["class"]),
            -1,
        )
        for item in items
    ]
    tracker_input = _TrackerDetections(
        np.asarray(boxes, dtype=np.float32),
        np.asarray([item["confidence"] for item in items], dtype=np.float32),
        np.asarray(class_ids, dtype=np.float32),
    )
    tracked = tracker.update(tracker_input)
    for row in tracked:
        if len(row) < 8:
            continue
        detection_index = int(row[7])
        if 0 <= detection_index < len(items):
            items[detection_index]["track_id"] = int(row[4])


def reset_central_tracker(tracker) -> None:
    if tracker is not None and hasattr(tracker, "reset"):
        tracker.reset()


async def _commit_result(
    state: AppState,
    inference_frame: InferenceFrame,
    result: dict,
    tracker=None,
    model_names: dict | None = None,
) -> None:
    """Apply ordered postprocessing and publish one completed frame."""

    if tracker is not None:
        apply_central_tracking(result, tracker, model_names or {})
    if state.monocular_resolver is not None:
        annotate_result(
            result,
            inference_frame,
            state.monocular_timeline,
            state.monocular_resolver,
            max_frame_delta_ms=settings.MONOCULAR_SOURCE_MAX_DELTA_MS,
            max_imu_delta_ms=settings.MONOCULAR_IMU_MAX_DELTA_MS,
        )

    item = PlaybackItem(
        epoch=inference_frame.epoch,
        seq=inference_frame.seq,
        encoded=inference_frame.encoded,
        timestamp_us=inference_frame.timestamp_us,
        keyframe=inference_frame.keyframe,
        result=result,
    )
    async with state.result_condition:
        state.queued_sequences.discard((item.epoch, item.seq))
        state.completed_sequences.add((item.epoch, item.seq))
        state.put_result(item)
        state.result_condition.notify_all()


async def _infer_with_retry(
    inference_frame: InferenceFrame,
    yolo_model: YOLO,
    device: str,
    tracking: bool,
) -> tuple[dict | None, Exception | None]:
    last_error: Exception | None = None
    for attempt in range(max(1, settings.INFERENCE_RETRY_COUNT)):
        try:
            result = await asyncio.to_thread(
                run_yolo,
                inference_frame,
                yolo_model,
                device,
                tracking,
            )
            return result, None
        except Exception as exc:  # retry the same frame, never skip it
            last_error = exc
            if attempt + 1 < settings.INFERENCE_RETRY_COUNT:
                delays = settings.INFERENCE_RETRY_DELAYS or (0.1,)
                await asyncio.sleep(delays[min(attempt, len(delays) - 1)])
    return None, last_error


async def _parallel_yolo_worker(state: AppState) -> None:
    """Run segmentation concurrently and publish strictly in source order.

    Each model is confined to one asyncio task/thread. Results may finish out
    of order, but the ``sequence_order`` deque prevents playback from observing
    that reordering.
    """

    models = state.yolo_models or ([state.yolo_model] if state.yolo_model else [])
    devices = _parallel_devices()
    if len(models) < 2:
        raise RuntimeError("parallel worker requires at least two YOLO models")
    tracker = None
    model_names = None
    sequence_order: deque[tuple[int, int]] = deque()
    pending: dict[asyncio.Task, InferenceFrame] = {}
    ready: dict[tuple[int, int], tuple[InferenceFrame, dict]] = {}
    next_model = 0
    tracker_epoch: int | None = None
    window_started = perf_counter()
    window_completed = 0
    retry_frame: InferenceFrame | None = None

    while True:
        current_epoch = state.current_epoch
        if tracker_epoch != current_epoch:
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            pending.clear()
            ready.clear()
            sequence_order.clear()
            reset_central_tracker(tracker)
            tracker_epoch = current_epoch
            state.tracker_epoch = current_epoch

        if state.fault is not None:
            async with state.result_condition:
                while state.fault is not None and state.current_epoch == current_epoch:
                    await state.result_condition.wait()
            continue

        while len(pending) < len(models):
            if retry_frame is not None:
                inference_frame = retry_frame
                retry_frame = None
            else:
                inference_frame = await state.inference_queue.get()
            if inference_frame.epoch != state.current_epoch:
                continue
            sequence_order.append((inference_frame.epoch, inference_frame.seq))
            model_index = next_model % len(models)
            next_model += 1
            task = asyncio.create_task(
                _infer_with_retry(
                    inference_frame,
                    models[model_index],
                    devices[model_index],
                    False,
                )
            )
            pending[task] = inference_frame

        done, _ = await asyncio.wait(
            pending, return_when=asyncio.FIRST_COMPLETED
        )
        for task in done:
            inference_frame = pending.pop(task)
            result, last_error = task.result()
            if result is None:
                retry_frame = inference_frame
                state.fault = (
                    f"inference failed at epoch={inference_frame.epoch} "
                    f"seq={inference_frame.seq}: {last_error}"
                )
                async with state.result_condition:
                    state.result_condition.notify_all()
                break
            if inference_frame.epoch == state.current_epoch:
                ready[(inference_frame.epoch, inference_frame.seq)] = (
                    inference_frame,
                    result,
                )

        if state.fault is not None:
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            pending.clear()
            ready.clear()
            sequence_order.clear()
            continue

        while sequence_order and sequence_order[0] in ready:
            key = sequence_order.popleft()
            inference_frame, result = ready.pop(key)
            if inference_frame.epoch != state.current_epoch:
                continue
            await _commit_result(state, inference_frame, result, tracker, model_names)
            window_completed += 1
            if window_completed >= 30:
                elapsed = max(perf_counter() - window_started, 1e-6)
                print(
                    "YOLO parallel throughput: "
                    f"{window_completed / elapsed:.1f} fps; "
                    f"last={result['inference_ms']:.1f} ms; "
                    f"pending={state.inference_queue.qsize()}; "
                    f"in_flight={len(pending)}",
                    flush=True,
                )
                window_started = perf_counter()
                window_completed = 0


def reset_tracker(yolo_model: YOLO) -> None:
    """Drop tracker state so a new epoch cannot inherit old track identities."""

    predictor = getattr(yolo_model, "predictor", None)
    trackers = getattr(predictor, "trackers", None)
    if not trackers:
        return
    try:
        for tracker in trackers:
            tracker.reset()
    except AttributeError:
        # Without a reset method, drop the trackers so the next track() call
        # rebuilds them instead of carrying the old epoch's tracks forward.
        del predictor.trackers


def run_yolo(
    inference_frame: InferenceFrame,
    yolo_model: YOLO,
    device: str | None = None,
    tracking_override: bool | None = None,
) -> dict:
    start = perf_counter()
    img = inference_frame.frame.to_ndarray(format="bgr24")
    frame_height, frame_width = img.shape[:2]
    longest_side = max(frame_width, frame_height)
    imgsz = min(((longest_side + 31) // 32) * 32, settings.YOLO_MAX_IMGSZ)
    device = device or settings.YOLO_DEVICE
    quantize = 16 if settings.YOLO_HALF and device.startswith("cuda") else 32
    tracking = settings.YOLO_TRACKING if tracking_override is None else tracking_override
    with torch.inference_mode():
        if tracking:
            results = yolo_model.track(
                img,
                device=device,
                imgsz=imgsz,
                quantize=quantize,
                # Hand the weak detections to the tracker rather than dropping
                # them here; its second association stage is what keeps an
                # established track alive through a confidence dip.
                conf=settings.CONF_THRESHOLD_LOW,
                tracker=settings.YOLO_TRACKER_CONFIG,
                persist=True,
                verbose=False,
                retina_masks=True,
            )
        else:
            results = yolo_model(
                img,
                device=device,
                imgsz=imgsz,
                quantize=quantize,
                verbose=False,
                retina_masks=True,
            )
    detections = []
    for result in results:
        normalized_polygons = result.masks.xyn if result.masks is not None else []
        for box_index, box in enumerate(result.boxes):
            conf = float(box.conf[0])
            if not tracking and conf <= settings.CONF_THRESHOLD_LOW:
                continue
            cls_id = int(box.cls[0])
            if settings.BBOX_FORMAT == "xyxy_normalized":
                bbox = list(map(float, box.xyxyn[0].detach().cpu().tolist()))
            elif settings.BBOX_FORMAT == "xyxy_pixels":
                bbox = list(map(float, box.xyxy[0].detach().cpu().tolist()))
            elif settings.BBOX_FORMAT == "xywh_normalized":
                bbox = list(map(float, box.xywhn[0].detach().cpu().tolist()))
            else:
                bbox = list(map(float, box.xywh[0].detach().cpu().tolist()))
            detection = {
                "class": yolo_model.names[cls_id],
                "confidence": round(conf, 2),
                "bbox": bbox,
                "bbox_format": settings.BBOX_FORMAT,
            }
            track_id = getattr(box, "id", None)
            if track_id is not None:
                detection["track_id"] = int(track_id[0])
            if box_index < len(normalized_polygons):
                polygon = normalized_polygons[box_index]
                if len(polygon) >= 3:
                    detection["mask"] = [
                        [float(x), float(y)] for x, y in polygon.tolist()
                    ]
                    detection["mask_format"] = "polygon_normalized"
            detections.append(detection)
    return {
        "source": {
            "epoch": inference_frame.epoch,
            "seq": inference_frame.seq,
            "pts": inference_frame.pts,
            "time_base": inference_frame.time_base,
            "time": inference_frame.media_time,
            "timestamp_us": inference_frame.timestamp_us,
        },
        "width": frame_width,
        "height": frame_height,
        "items": detections,
        "inference_ms": round((perf_counter() - start) * 1000, 1),
    }


async def _feed_command_sender(writer: asyncio.StreamWriter, state: AppState) -> None:
    while True:
        command = await state.feed_commands.get()
        command_type = command.get("type")
        if command_type == "presented":
            await _write_record(
                writer,
                K_PRESENTED_ACK,
                json.dumps(
                    {"epoch": int(command["epoch"]), "seq": int(command["seq"])},
                    separators=(",", ":"),
                ).encode(),
            )
        elif command_type in {"jump_to_live", "resync"}:
            await _write_record(writer, K_RESYNC, json.dumps(command).encode())
        elif command_type == "stop":
            await _write_record(writer, K_STOP, b"")
            return


async def _queue_decoded_frame(
    state: AppState,
    metadata: dict,
    frame: av.VideoFrame,
) -> None:
    pts = metadata.get("pts_90k")
    timestamp_us = int(metadata.get("timestamp_us", 0))
    key = (int(metadata["epoch"]), int(metadata["seq"]))
    if key in state.queued_sequences or key in state.completed_sequences:
        return
    state.queued_sequences.add(key)
    time_base = float(RTP_VIDEO_TIME_BASE)
    qr = metadata.get("qr") if isinstance(metadata.get("qr"), dict) else {}
    await state.inference_queue.put(
        InferenceFrame(
            epoch=int(metadata["epoch"]),
            seq=int(metadata["seq"]),
            frame=frame,
            encoded=bytes(metadata["_encoded"]),
            pts=pts,
            time_base=time_base,
            media_time=(pts * time_base if pts is not None else None),
            timestamp_us=timestamp_us,
            keyframe=bool(metadata.get("keyframe", False)),
            qr_source_timestamp_ns=_optional_int(qr.get("source_timestamp_ns")),
            qr_capture_timestamp_ns=_optional_int(qr.get("capture_timestamp_ns")),
            qr_decode_success=bool(qr.get("decode_success", False)),
        )
    )


async def _decode_session(reader: asyncio.StreamReader, state: AppState) -> None:
    decoder = av.CodecContext.create("h264", "r")
    pending: deque[dict] = deque()
    pending_by_pts: dict[int, deque[dict]] = {}
    while True:
        kind, body = await _read_record(reader)
        if kind == K_START:
            metadata = json.loads(body or b"{}")
            epoch = int(metadata.get("epoch", 0))
            if epoch and epoch != state.current_epoch:
                async with state.result_condition:
                    state.current_epoch = epoch
                    state.clear_all_results()
                    state.queued_sequences.clear()
                    state.completed_sequences.clear()
                    state.last_presented = None
                    _discard_inference_queue(state)
                    state.fault = None
                    state.result_condition.notify_all()
            decoder = av.CodecContext.create("h264", "r")
            pending.clear()
            pending_by_pts.clear()
            if state.monocular_resolver is not None:
                state.monocular_resolver.reset()
        elif kind == K_RESET:
            metadata = json.loads(body or b"{}")
            new_epoch = int(metadata.get("new_epoch", metadata.get("epoch", 0)))
            async with state.result_condition:
                state.current_epoch = new_epoch
                state.clear_all_results()
                state.queued_sequences.clear()
                state.completed_sequences.clear()
                state.last_presented = None
                _discard_inference_queue(state)
                state.fault = None
                state.result_condition.notify_all()
            decoder = av.CodecContext.create("h264", "r")
            pending.clear()
            pending_by_pts.clear()
            if state.monocular_resolver is not None:
                state.monocular_resolver.reset()
        elif kind == K_FRAME:
            if len(body) < FRAME_META_LENGTH.size:
                raise ValueError("short FRAME record")
            (meta_len,) = FRAME_META_LENGTH.unpack(body[:4])
            if meta_len > len(body) - 4:
                raise ValueError("invalid FRAME metadata length")
            metadata = json.loads(body[4 : 4 + meta_len])
            encoded = body[4 + meta_len :]
            metadata["_encoded"] = encoded
            packet = av.Packet(encoded)
            packet.pts = metadata.get("pts_90k")
            packet.time_base = RTP_VIDEO_TIME_BASE
            pending.append(metadata)
            if metadata.get("pts_90k") is not None:
                pending_by_pts.setdefault(int(metadata["pts_90k"]), deque()).append(
                    metadata
                )
            try:
                decoded = decoder.decode(packet)
            except av.error.InvalidDataError as exc:
                pending.clear()
                pending_by_pts.clear()
                await state.feed_commands.put(
                    {"type": "resync", "reason": "decode_error"}
                )
                raise RuntimeError(
                    "H.264 decode failed; requested a new epoch"
                ) from exc
            for frame in decoded:
                source = None
                if frame.pts is not None and pending_by_pts.get(int(frame.pts)):
                    source = pending_by_pts[int(frame.pts)].popleft()
                    if not pending_by_pts[int(frame.pts)]:
                        pending_by_pts.pop(int(frame.pts), None)
                    with suppress(ValueError):
                        pending.remove(source)
                if source is None:
                    source = pending.popleft() if pending else metadata
                await _queue_decoded_frame(state, source, frame)
        elif kind == K_END:
            state.android_live = False
            for frame in decoder.decode():
                if pending:
                    source = pending.popleft()
                    if source.get("pts_90k") is not None and pending_by_pts.get(
                        int(source["pts_90k"])
                    ):
                        pending_by_pts[int(source["pts_90k"])].popleft()
                    await _queue_decoded_frame(state, source, frame)
            async with state.result_condition:
                state.result_condition.notify_all()
            return


@asynccontextmanager
async def _relay_connection(state: AppState):
    logged = False
    while True:
        try:
            reader, writer = await asyncio.open_unix_connection(
                settings.YOLO_FEED_SOCKET
            )
            break
        except OSError as exc:
            if not logged:
                print(
                    f"frame_receiver: relay not reachable at {settings.YOLO_FEED_SOCKET} "
                    f"({exc}); retrying..."
                )
                logged = True
            await asyncio.sleep(0.5)

    if state.session_id is None:
        state.session_id = uuid.uuid4().hex
    await _write_record(
        writer,
        K_BEGIN,
        json.dumps(
            {
                "session_id": state.session_id,
                "epoch": state.current_epoch,
                "last_presented_seq": (
                    state.last_presented[1] if state.last_presented else -1
                ),
            },
            separators=(",", ":"),
        ).encode(),
    )
    command_task = asyncio.create_task(_feed_command_sender(writer, state))
    print(f"frame_receiver: connected to {settings.YOLO_FEED_SOCKET}")
    try:
        yield reader
    finally:
        command_task.cancel()
        await asyncio.gather(command_task, return_exceptions=True)
        writer.close()
        with suppress(ConnectionError, OSError):
            await writer.wait_closed()


async def frame_receiver(state: AppState) -> None:
    """Read every reliable access unit from Go and enqueue it in order."""
    while True:
        try:
            async with _relay_connection(state) as reader:
                await _decode_session(reader, state)
        except asyncio.CancelledError:
            raise
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            print(
                "frame_receiver: relay feed disconnected; preserving session for resume"
            )
        except Exception:
            import traceback

            traceback.print_exc()
        await asyncio.sleep(0.5)


async def yolo_worker(state: AppState) -> None:
    """Infer every queued decoded frame; a failed frame never advances."""
    if len(state.yolo_models) > 1:
        await _parallel_yolo_worker(state)
        return
    retry_frame: InferenceFrame | None = None
    window_started = perf_counter()
    window_completed = 0
    while True:
        inference_frame = retry_frame or await state.inference_queue.get()
        retry_frame = None
        if inference_frame.epoch != state.current_epoch:
            continue
        if state.fault is not None:
            # Do not silently process later sequences after a failed frame.
            retry_frame = inference_frame
            async with state.result_condition:
                while (
                    state.fault is not None
                    and inference_frame.epoch == state.current_epoch
                ):
                    await state.result_condition.wait()
            continue
        if settings.YOLO_TRACKING and state.tracker_epoch != inference_frame.epoch:
            # An epoch boundary is a hard discontinuity in the source, so the
            # tracker's identities and motion models must not survive it.
            await asyncio.to_thread(reset_tracker, state.yolo_model)
            state.tracker_epoch = inference_frame.epoch
        result = None
        last_error: Exception | None = None
        for attempt in range(max(1, settings.INFERENCE_RETRY_COUNT)):
            try:
                result = await asyncio.to_thread(
                    run_yolo,
                    inference_frame,
                    state.yolo_model,
                    settings.YOLO_DEVICE,
                    False,
                )
                break
            except Exception as exc:  # retry the same frame, never skip it
                last_error = exc
                if attempt + 1 < settings.INFERENCE_RETRY_COUNT:
                    delays = settings.INFERENCE_RETRY_DELAYS or (0.1,)
                    await asyncio.sleep(delays[min(attempt, len(delays) - 1)])
        if result is None:
            retry_frame = inference_frame
            state.fault = f"inference failed at epoch={inference_frame.epoch} seq={inference_frame.seq}: {last_error}"
            async with state.result_condition:
                state.result_condition.notify_all()
            continue
        if inference_frame.epoch != state.current_epoch:
            # A reset can land while this frame's inference was running in
            # its own thread (asyncio.to_thread has no mid-flight cancellation
            # here), so the epoch gate at the top of the loop isn't enough on
            # its own - re-check before storing anything under a now-stale
            # epoch.
            continue

        if state.monocular_resolver is not None:
            annotate_result(
                result,
                inference_frame,
                state.monocular_timeline,
                state.monocular_resolver,
                max_frame_delta_ms=settings.MONOCULAR_SOURCE_MAX_DELTA_MS,
                max_imu_delta_ms=settings.MONOCULAR_IMU_MAX_DELTA_MS,
            )

        item = PlaybackItem(
            epoch=inference_frame.epoch,
            seq=inference_frame.seq,
            encoded=inference_frame.encoded,
            timestamp_us=inference_frame.timestamp_us,
            keyframe=inference_frame.keyframe,
            result=result,
        )
        async with state.result_condition:
            state.queued_sequences.discard((item.epoch, item.seq))
            state.completed_sequences.add((item.epoch, item.seq))
            state.put_result(item)
            state.result_condition.notify_all()
        window_completed += 1
        if window_completed >= 30:
            elapsed = max(perf_counter() - window_started, 1e-6)
            print(
                "YOLO throughput: "
                f"{window_completed / elapsed:.1f} fps; "
                f"last={result['inference_ms']:.1f} ms; "
                f"pending={state.inference_queue.qsize()}",
                flush=True,
            )
            window_started = perf_counter()
            window_completed = 0
