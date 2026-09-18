from __future__ import annotations

import asyncio
import json
import struct
import uuid
from collections import deque
from contextlib import asynccontextmanager, suppress
from fractions import Fraction
from functools import partial
from time import perf_counter
from pathlib import Path

import av
import torch
import torch.nn.functional as F
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


def _take_latest_inference_frame(
    state: AppState, first: InferenceFrame
) -> tuple[InferenceFrame, list[InferenceFrame]]:
    """Keep the newest queued frame and return older frames for passthrough."""

    latest = first
    dropped: list[InferenceFrame] = []
    while True:
        try:
            candidate = state.inference_queue.get_nowait()
        except asyncio.QueueEmpty:
            return latest, dropped
        dropped.append(latest)
        latest = candidate


def _source_metadata(inference_frame: InferenceFrame) -> dict[str, object]:
    metadata: dict[str, object] = {
        "epoch": inference_frame.epoch,
        "seq": inference_frame.seq,
        "pts": inference_frame.pts,
        "pts_90k": inference_frame.pts,
        "time_base": inference_frame.time_base,
        "time": inference_frame.media_time,
        "timestamp_us": inference_frame.timestamp_us,
        # 64-bit nanoseconds are strings so they survive JavaScript numbers.
        "resolved_source_timestamp_ns": (
            None
            if inference_frame.resolved_source_timestamp_ns is None
            else str(inference_frame.resolved_source_timestamp_ns)
        ),
        "source_timeline_status": inference_frame.source_timeline_status,
        "source_timeline_generation": inference_frame.source_timeline_generation,
    }
    if inference_frame.recording_identity is not None:
        metadata["recording"] = inference_frame.recording_identity
    return metadata


def _fit_size(width: int, height: int, max_side: int) -> tuple[int, int]:
    """Return an aspect-preserving size no larger than ``max_side``."""

    if width <= 0 or height <= 0 or max_side <= 0:
        return max(1, width), max(1, height)
    scale = min(max_side / width, max_side / height, 1.0)
    return max(1, round(width * scale)), max(1, round(height * scale))


def _to_cpu_value(value: object) -> object:
    """Materialize one tensor/array only after the caller has batched fields."""

    if value is None:
        return None
    detach = getattr(value, "detach", None)
    if detach is not None:
        value = detach()
    cpu = getattr(value, "cpu", None)
    if cpu is not None:
        value = cpu()
    tolist = getattr(value, "tolist", None)
    if tolist is not None:
        value = tolist()
    return value


def _box_field_values(boxes: object, field: str) -> list:
    """Copy a Boxes field to Python once, with compatibility for test doubles."""

    bulk_value = getattr(boxes, field, None)
    if bulk_value is not None:
        value = _to_cpu_value(bulk_value)
        if isinstance(value, list):
            return value
        if value is None:
            return []
        return list(value) if isinstance(value, tuple) else [value]

    # Ultralytics exposes tensors on the Boxes container. This fallback exists
    # for lightweight Results-like objects used by tests and older wrappers;
    # it is not the production path and therefore may read one box at a time.
    values = []
    for box in boxes:
        value = getattr(box, field, None)
        if isinstance(value, (list, tuple)):
            value = value[0] if value else None
        values.append(_to_cpu_value(value))
    return values


def _scalar(value: object) -> object:
    if isinstance(value, (list, tuple)):
        return value[0] if value else None
    return value


def _simplify_mask_polygon(polygon: object) -> object:
    if not settings.YOLO_MASK_POLYGON_SIMPLIFY:
        return polygon
    try:
        if len(polygon) < 4:
            return polygon
    except TypeError:
        return polygon

    # Keep OpenCV out of the hot import path when simplification is disabled.
    import cv2
    import numpy as np

    contour = np.asarray(polygon, dtype=np.float32).reshape(-1, 1, 2)
    epsilon = settings.YOLO_MASK_POLYGON_EPSILON_RATIO * cv2.arcLength(contour, True)
    if epsilon <= 0:
        return polygon
    simplified = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
    return simplified if len(simplified) >= 3 else polygon


def _normalized_mask_polygons(result: object, box_indices: list[int]) -> list:
    """Convert only retained result masks to normalized polygons.

    ``Masks.xyn`` performs a GPU-to-CPU copy and contour extraction for every
    mask on first access. Selecting the retained masks first avoids paying that
    cost for detections filtered by the service.
    """

    if not box_indices:
        return []
    masks = getattr(result, "masks", None)
    if masks is None:
        return []
    try:
        selected_masks = masks[box_indices]
    except (AttributeError, IndexError, TypeError):
        # Keep lightweight Results-like test doubles and older wrappers
        # working when their mask container does not support indexing.
        polygons = getattr(masks, "xyn", [])
        return [polygons[index] for index in box_indices if index < len(polygons)]

    mask_data = getattr(selected_masks, "data", None)
    contour_size = settings.YOLO_MASK_CONTOUR_SIZE
    if (
        not isinstance(mask_data, torch.Tensor)
        or mask_data.ndim != 3
        or max(int(mask_data.shape[-2]), int(mask_data.shape[-1])) <= contour_size
    ):
        return selected_masks.xyn

    mask_height, mask_width = map(int, mask_data.shape[-2:])
    scale = contour_size / max(mask_height, mask_width)
    contour_shape = (
        max(1, round(mask_height * scale)),
        max(1, round(mask_width * scale)),
    )
    # Masks.xyn calls cv2.findContours on CPU. Reduce the binary mask while it
    # is still on the inference device, so only a small grid crosses the
    # device boundary and contour work scales with contour_size, not camera
    # resolution.
    reduced_data = (
        F.interpolate(
            mask_data.unsqueeze(1).float(),
            size=contour_shape,
            mode="nearest",
        )
        .squeeze(1)
        .gt_(0)
    )
    reduced_masks = selected_masks.__class__(reduced_data, selected_masks.orig_shape)
    return reduced_masks.xyn


def _skipped_frame_result(
    inference_frame: InferenceFrame, previous_result: dict | None
) -> dict:
    """Build a cheap playback item for a frame not sent through the model."""

    frame = inference_frame.frame
    width = int((previous_result or {}).get("width") or getattr(frame, "width", 0) or 0)
    height = int(
        (previous_result or {}).get("height") or getattr(frame, "height", 0) or 0
    )
    previous_items = (previous_result or {}).get("items", [])
    if not isinstance(previous_items, (list, tuple)):
        previous_items = []
    # Inference results are immutable after they are stored. Reuse the item
    # dictionaries and only copy the outer list so a skipped media frame does
    # not spend time cloning every detection while the model is overloaded.
    items = list(previous_items)
    if previous_result and previous_result.get("monocular"):
        # A monocular distance is tied to the inferred frame's QR/IMU sample;
        # never present that stale measurement as if it belonged to this media
        # frame. The geometry/classification can still be held for continuity.
        items = []
        for item in previous_items:
            copied = dict(item) if isinstance(item, dict) else item
            if isinstance(copied, dict):
                for key in ("distance_m", "distance_status", "distance_anchor"):
                    copied.pop(key, None)
            items.append(copied)
    return {
        "source": _source_metadata(inference_frame),
        "width": width,
        "height": height,
        "items": items,
        "mask_count": sum(
            1 for item in items if isinstance(item, dict) and "mask" in item
        ),
        "inference_ms": 0.0,
        "inference_skipped": True,
        "monocular": {"status": "inference_skipped"},
    }


async def _publish_skipped_frames(
    state: AppState,
    frames: list[InferenceFrame],
    previous_result: dict | None,
    previous_result_epoch: int | None,
) -> int:
    """Publish media-preserving placeholders for frames omitted by inference."""

    if not frames:
        return 0
    published = 0
    async with state.result_condition:
        for inference_frame in frames:
            key = (inference_frame.epoch, inference_frame.seq)
            state.queued_sequences.discard(key)
            if inference_frame.epoch != state.current_epoch:
                continue
            result = _skipped_frame_result(
                inference_frame,
                (
                    previous_result
                    if previous_result_epoch == inference_frame.epoch
                    else None
                ),
            )
            state.mark_completed(*key)
            state.put_result(
                PlaybackItem(
                    epoch=inference_frame.epoch,
                    seq=inference_frame.seq,
                    encoded=inference_frame.encoded,
                    timestamp_us=inference_frame.timestamp_us,
                    keyframe=inference_frame.keyframe,
                    result=result,
                )
            )
            published += 1
        state.metrics.playback_frames_published += published
        if published:
            state.result_condition.notify_all()
    return published


async def _enqueue_inference_frame(
    state: AppState, inference_frame: InferenceFrame
) -> None:
    """Insert without blocking decode, publishing evicted frames for playback."""

    dropped: list[InferenceFrame] = []
    queue = state.inference_queue
    if settings.YOLO_FRAME_DROP_POLICY == "latest":
        # The queue is a handoff, not a history buffer. Replace all pending
        # decoded frames so the next model call stays at the live edge.
        while True:
            try:
                dropped.append(queue.get_nowait())
            except asyncio.QueueEmpty:
                break
    elif queue.full():
        # Ordered debugging mode retains already queued work and drops the
        # newly arrived frame when its finite queue is full. Ingest never
        # waits for inference in either policy.
        dropped.append(inference_frame)

    if dropped:
        state.metrics.inference_frames_dropped += len(dropped)
        await _publish_skipped_frames(
            state,
            dropped,
            state.last_inference_result,
            state.last_inference_result_epoch,
        )
        if dropped[-1] is inference_frame:
            return

    try:
        queue.put_nowait(inference_frame)
    except asyncio.QueueFull:
        # A finite queue cannot be full here in the normal event-loop path,
        # but keep the ownership/drop rule safe if a custom queue is injected
        # by a test or future caller.
        state.metrics.inference_frames_dropped += 1
        await _publish_skipped_frames(
            state,
            [inference_frame],
            state.last_inference_result,
            state.last_inference_result_epoch,
        )


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


async def _read_record(reader: asyncio.StreamReader) -> tuple[int, memoryview]:
    header = await reader.readexactly(RECORD_HEADER.size)
    (length,) = RECORD_HEADER.unpack(header)
    if length < 1 or length > MAX_RECORD_BYTES:
        raise ValueError(f"invalid feed record length {length}")
    payload = await reader.readexactly(length)
    view = memoryview(payload)
    return int(view[0]), view[1:]


async def _write_record(
    writer: asyncio.StreamWriter, kind: int, body: bytes = b""
) -> None:
    writer.write(_record(kind, body))
    await writer.drain()


def load_yolo_model() -> YOLO:
    print(f"YOLO inference device: {settings.YOLO_DEVICE}")
    model = YOLO(settings.YOLO_MODEL)
    if model.task != "segment":
        raise ValueError(
            f"YOLO_MODEL must be a segmentation checkpoint; {settings.YOLO_MODEL!r} "
            f"is a {model.task!r} model"
        )
    if Path(settings.YOLO_MODEL).suffix.lower() != ".engine":
        model.to(settings.YOLO_DEVICE)
        # Fuse Conv+BatchNorm where supported. This is a one-time optimization and
        # avoids paying the unfused layer overhead on every frame.
        if hasattr(model, "fuse"):
            model.fuse()
    if settings.YOLO_DEVICE.startswith("cuda"):
        torch.backends.cudnn.benchmark = True
    return model


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


def run_yolo(inference_frame: InferenceFrame, yolo_model: YOLO) -> dict:
    start = perf_counter()
    frame_convert_start = start
    source_width = int(getattr(inference_frame.frame, "width", 0) or 0)
    source_height = int(getattr(inference_frame.frame, "height", 0) or 0)
    if source_width > 0 and source_height > 0:
        target_width, target_height = _fit_size(
            source_width, source_height, settings.YOLO_MAX_IMGSZ
        )
    else:
        target_width, target_height = source_width, source_height
    if (target_width, target_height) != (source_width, source_height):
        model_frame = inference_frame.frame.reformat(
            width=target_width,
            height=target_height,
            format="bgr24",
        )
        img = model_frame.to_ndarray()
    else:
        img = inference_frame.frame.to_ndarray(format="bgr24")
    frame_convert_ms = (perf_counter() - frame_convert_start) * 1000
    frame_height, frame_width = img.shape[:2]
    if source_width <= 0:
        source_width = frame_width
    if source_height <= 0:
        source_height = frame_height
    longest_side = max(frame_width, frame_height)
    imgsz = min(((longest_side + 31) // 32) * 32, settings.YOLO_MAX_IMGSZ)
    quantize = (
        16 if settings.YOLO_HALF and settings.YOLO_DEVICE.startswith("cuda") else 32
    )
    tracking = settings.YOLO_TRACKING
    model_start = perf_counter()
    with torch.inference_mode():
        if tracking:
            results = yolo_model.track(
                img,
                device=settings.YOLO_DEVICE,
                imgsz=imgsz,
                quantize=quantize,
                # Hand the weak detections to the tracker rather than dropping
                # them here; its second association stage is what keeps an
                # established track alive through a confidence dip.
                conf=settings.CONF_THRESHOLD_LOW,
                max_det=settings.YOLO_MAX_DETECTIONS,
                tracker=settings.YOLO_TRACKER_CONFIG,
                persist=True,
                verbose=False,
                retina_masks=settings.YOLO_RETINA_MASKS,
            )
        else:
            results = yolo_model(
                img,
                device=settings.YOLO_DEVICE,
                imgsz=imgsz,
                quantize=quantize,
                max_det=settings.YOLO_MAX_DETECTIONS,
                verbose=False,
                retina_masks=settings.YOLO_RETINA_MASKS,
            )
    model_ms = (perf_counter() - model_start) * 1000
    postprocess_start = perf_counter()
    detections = []
    coordinate_field = {
        "xyxy_normalized": "xyxyn",
        "xyxy_pixels": "xyxy",
        "xywh_normalized": "xywhn",
        "xywh_pixels": "xywh",
    }[settings.BBOX_FORMAT]
    for result in results:
        boxes = result.boxes
        confidence_values = _box_field_values(boxes, "conf")
        class_values = _box_field_values(boxes, "cls")
        coordinate_values = _box_field_values(boxes, coordinate_field)
        track_values = _box_field_values(boxes, "id") if tracking else []
        retained_indices = []
        for box_index in range(len(boxes)):
            conf = float(_scalar(confidence_values[box_index]))
            if not tracking and conf <= settings.CONF_THRESHOLD_LOW:
                continue
            retained_indices.append(box_index)
        normalized_polygons = _normalized_mask_polygons(result, retained_indices)
        for polygon_index, box_index in enumerate(retained_indices):
            conf = float(_scalar(confidence_values[box_index]))
            cls_id = int(_scalar(class_values[box_index]))
            bbox = [float(value) for value in coordinate_values[box_index]]
            if settings.BBOX_FORMAT.endswith("_pixels"):
                scale_x = source_width / max(frame_width, 1)
                scale_y = source_height / max(frame_height, 1)
                if settings.BBOX_FORMAT == "xyxy_pixels":
                    bbox[0] *= scale_x
                    bbox[1] *= scale_y
                    bbox[2] *= scale_x
                    bbox[3] *= scale_y
                else:
                    bbox[0] *= scale_x
                    bbox[1] *= scale_y
                    bbox[2] *= scale_x
                    bbox[3] *= scale_y
            detection = {
                "class": yolo_model.names[cls_id],
                "confidence": round(conf, 2),
                "bbox": bbox,
                "bbox_format": settings.BBOX_FORMAT,
            }
            track_id = (
                track_values[box_index] if box_index < len(track_values) else None
            )
            track_id = _scalar(track_id)
            if track_id is not None:
                detection["track_id"] = int(track_id)
            if polygon_index < len(normalized_polygons):
                polygon = _simplify_mask_polygon(normalized_polygons[polygon_index])
                if len(polygon) >= 3:
                    detection["mask"] = (
                        polygon.tolist() if hasattr(polygon, "tolist") else polygon
                    )
                    detection["mask_format"] = "polygon_normalized"
            detections.append(detection)
    return {
        "source": _source_metadata(inference_frame),
        "width": source_width,
        "height": source_height,
        "items": detections,
        "mask_count": sum(1 for detection in detections if "mask" in detection),
        "inference_ms": round((perf_counter() - start) * 1000, 1),
        "frame_convert_ms": round(frame_convert_ms, 1),
        "model_ms": round(model_ms, 1),
        "postprocess_ms": round((perf_counter() - postprocess_start) * 1000, 1),
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
    state.metrics.decoded_frames_received += 1
    state.queued_sequences.add(key)
    time_base = float(RTP_VIDEO_TIME_BASE)
    qr = metadata.get("qr") if isinstance(metadata.get("qr"), dict) else {}
    qr_source_timestamp_ns = _optional_int(qr.get("source_timestamp_ns"))
    qr_decode_success = bool(qr.get("decode_success", False))
    # Resolved here, in decode order, for every frame - including frames the
    # inference worker later skips - so telemetry never depends on YOLO.
    source_time = state.source_timeline.resolve(pts, qr_source_timestamp_ns, qr_decode_success)
    await _enqueue_inference_frame(
        state,
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
            qr_source_timestamp_ns=qr_source_timestamp_ns,
            qr_capture_timestamp_ns=_optional_int(qr.get("capture_timestamp_ns")),
            qr_decode_success=qr_decode_success,
            resolved_source_timestamp_ns=source_time.source_timestamp_ns,
            source_timeline_status=source_time.status,
            source_timeline_generation=source_time.generation,
            recording_identity=(
                {
                    "tripId": str(metadata["recording"]["trip_id"]),
                    "vehicleId": str(metadata["recording"]["vehicle_id"]),
                    "recordingSessionId": str(metadata["recording"]["recording_session_id"]),
                }
                if isinstance(metadata.get("recording"), dict)
                and metadata["recording"].get("trip_id") is not None
                and metadata["recording"].get("recording_session_id")
                else None
            ),
        ),
    )


async def _decode_session(reader: asyncio.StreamReader, state: AppState) -> None:
    decoder = av.CodecContext.create("h264", "r")
    pending: deque[dict] = deque()
    pending_by_pts: dict[int, deque[dict]] = {}
    while True:
        kind, body = await _read_record(reader)
        if kind == K_START:
            metadata = json.loads(body.tobytes() or b"{}")
            epoch = int(metadata.get("epoch", 0))
            if epoch and epoch != state.current_epoch:
                async with state.result_condition:
                    state.current_epoch = epoch
                    state.clear_all_results()
                    state.queued_sequences.clear()
                    state.clear_completed_sequences()
                    state.last_presented = None
                    _discard_inference_queue(state)
                    state.last_inference_result = None
                    state.last_inference_result_epoch = None
                    state.fault = None
                    state.result_condition.notify_all()
            decoder = av.CodecContext.create("h264", "r")
            pending.clear()
            pending_by_pts.clear()
            if state.monocular_resolver is not None:
                state.monocular_resolver.reset()
            state.source_timeline.reset()
        elif kind == K_RESET:
            metadata = json.loads(body.tobytes() or b"{}")
            new_epoch = int(metadata.get("new_epoch", metadata.get("epoch", 0)))
            async with state.result_condition:
                state.current_epoch = new_epoch
                state.clear_all_results()
                state.queued_sequences.clear()
                state.clear_completed_sequences()
                state.last_presented = None
                _discard_inference_queue(state)
                state.last_inference_result = None
                state.last_inference_result_epoch = None
                state.fault = None
                state.result_condition.notify_all()
            decoder = av.CodecContext.create("h264", "r")
            pending.clear()
            pending_by_pts.clear()
            if state.monocular_resolver is not None:
                state.monocular_resolver.reset()
            state.source_timeline.reset()
        elif kind == K_FRAME:
            if len(body) < FRAME_META_LENGTH.size:
                raise ValueError("short FRAME record")
            (meta_len,) = FRAME_META_LENGTH.unpack(body[:4])
            if meta_len > len(body) - 4:
                raise ValueError("invalid FRAME metadata length")
            metadata = json.loads(body[4 : 4 + meta_len].tobytes())
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
            decode_started = perf_counter()
            try:
                decoded = decoder.decode(packet)
            except av.error.InvalidDataError as exc:
                state.metrics.decode_ms_total += (
                    perf_counter() - decode_started
                ) * 1000
                pending.clear()
                pending_by_pts.clear()
                await state.feed_commands.put(
                    {"type": "resync", "reason": "decode_error"}
                )
                raise RuntimeError(
                    "H.264 decode failed; requested a new epoch"
                ) from exc
            state.metrics.decode_ms_total += (perf_counter() - decode_started) * 1000
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
    """Infer queued decoded frames using the configured drop policy."""
    print(
        f"YOLO frame drop policy: {settings.YOLO_FRAME_DROP_POLICY}",
        flush=True,
    )
    print(
        "YOLO mask settings: "
        f"retina_masks={settings.YOLO_RETINA_MASKS}; "
        f"max_det={settings.YOLO_MAX_DETECTIONS}; "
        f"contour_size={settings.YOLO_MASK_CONTOUR_SIZE}",
        flush=True,
    )
    run_inference = partial(run_yolo, yolo_model=state.yolo_model)
    retry_frame: InferenceFrame | None = None
    previous_result: dict | None = None
    previous_result_epoch: int | None = None
    window_started = perf_counter()
    window_completed = 0
    while True:
        retrying = retry_frame is not None
        inference_frame = retry_frame or await state.inference_queue.get()
        retry_frame = None
        if settings.YOLO_FRAME_DROP_POLICY == "latest" and not retrying:
            inference_frame, dropped_frames = _take_latest_inference_frame(
                state, inference_frame
            )
            state.metrics.inference_frames_dropped += len(dropped_frames)
            await _publish_skipped_frames(
                state,
                dropped_frames,
                previous_result,
                previous_result_epoch,
            )
        if inference_frame.epoch != state.current_epoch:
            if previous_result_epoch != state.current_epoch:
                previous_result = None
                previous_result_epoch = None
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
        if state.tracker_epoch != inference_frame.epoch:
            # An epoch boundary is a hard discontinuity in the source, so the
            # tracker's identities and motion models must not survive it.
            await asyncio.to_thread(reset_tracker, state.yolo_model)
            state.tracker_epoch = inference_frame.epoch
        result = None
        last_error: Exception | None = None
        state.inference_active = True
        try:
            for attempt in range(max(1, settings.INFERENCE_RETRY_COUNT)):
                try:
                    result = await asyncio.to_thread(run_inference, inference_frame)
                    break
                except Exception as exc:  # retry the same frame, never skip it
                    last_error = exc
                    if attempt + 1 < settings.INFERENCE_RETRY_COUNT:
                        delays = settings.INFERENCE_RETRY_DELAYS or (0.1,)
                        await asyncio.sleep(delays[min(attempt, len(delays) - 1)])
        finally:
            state.inference_active = False
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
            previous_result = None
            previous_result_epoch = None
            state.last_inference_result = None
            state.last_inference_result_epoch = None
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
        previous_result = result
        previous_result_epoch = inference_frame.epoch
        state.last_inference_result = result
        state.last_inference_result_epoch = inference_frame.epoch
        state.metrics.record_inference(result)
        if state.recording_writer is not None:
            state.recording_writer.offer(result, state.metrics)

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
            state.mark_completed(item.epoch, item.seq)
            state.put_result(item)
            state.metrics.playback_frames_published += 1
            state.result_condition.notify_all()
        window_completed += 1
        if window_completed >= 30:
            elapsed = max(perf_counter() - window_started, 1e-6)
            print(
                "YOLO throughput: "
                f"{window_completed / elapsed:.1f} fps; "
                f"last={result['inference_ms']:.1f} ms; "
                f"masks={result.get('mask_count', 0)}; "
                f"pending={state.inference_queue.qsize()}; "
                f"dropped_total={state.metrics.inference_frames_dropped}",
                flush=True,
            )
            window_started = perf_counter()
            window_completed = 0
