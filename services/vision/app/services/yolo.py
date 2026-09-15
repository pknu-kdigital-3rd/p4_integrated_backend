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

import av
import torch
from ultralytics import YOLO, FastSAM

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


def _yolo_detect_conf() -> float:
    """Use the new detector threshold, falling back to the legacy setting."""

    return (
        settings.YOLO_DETECT_CONF
        if settings.YOLO_DETECT_CONF is not None
        else settings.CONF_THRESHOLD_LOW
    )


def _allowed_yolo_classes() -> set[str] | None:
    values = {
        value.strip().casefold()
        for value in settings.YOLO_CLASS_ALLOWLIST.split(",")
        if value.strip()
    }
    return values or None


def _yolo_class_name(yolo_model: YOLO, class_id: int) -> str:
    names = yolo_model.names
    value = (
        names[class_id]
        if not isinstance(names, dict)
        else names.get(class_id, class_id)
    )
    return str(value)


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


def load_yolo_model() -> YOLO:
    print(f"YOLO inference device: {settings.YOLO_DEVICE}")
    model = YOLO(settings.YOLO_MODEL)
    if model.task not in {"detect", "segment"}:
        raise ValueError(
            f"YOLO_MODEL must be a detection or segmentation checkpoint; {settings.YOLO_MODEL!r} "
            f"is a {model.task!r} model"
        )
    model.to(settings.YOLO_DEVICE)
    # Fuse Conv+BatchNorm where supported. This is a one-time optimization and
    # avoids paying the unfused layer overhead on every frame.
    if hasattr(model, "fuse"):
        model.fuse()
    if settings.YOLO_DEVICE.startswith("cuda"):
        torch.backends.cudnn.benchmark = True
    if model.task == "detect":
        _load_fastsam_model()
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


fastsam: FastSAM | None = None


def _load_fastsam_model() -> FastSAM:
    global fastsam
    if fastsam is None:
        print(f"FastSAM mask device: {settings.YOLO_DEVICE}")
        fastsam = FastSAM("FastSAM-s.pt")
        fastsam.to(settings.YOLO_DEVICE)
        if hasattr(fastsam, "fuse"):
            fastsam.fuse()
    return fastsam


def _box_iou(left: list[float], right: list[float]) -> float:
    """Return IoU for two pixel-space xyxy boxes."""

    ix1 = max(left[0], right[0])
    iy1 = max(left[1], right[1])
    ix2 = min(left[2], right[2])
    iy2 = min(left[3], right[3])
    intersection = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    left_area = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    right_area = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union else 0.0


def _clip_polygon_to_box(polygon: object, box: list[float]) -> list[list[float]]:
    """Clip a normalized polygon to its normalized YOLO xyxy box."""

    raw_points = polygon.tolist() if hasattr(polygon, "tolist") else polygon
    points = [
        [float(point[0]), float(point[1])] for point in raw_points if len(point) >= 2
    ]
    if len(points) < 3:
        return []

    x_min, y_min, x_max, y_max = box
    boundaries = (
        (0, x_min, False),
        (0, x_max, True),
        (1, y_min, False),
        (1, y_max, True),
    )
    for axis, bound, keep_less in boundaries:
        if not points:
            break

        def inside(point: list[float]) -> bool:
            return point[axis] <= bound if keep_less else point[axis] >= bound

        def intersection(start: list[float], end: list[float]) -> list[float]:
            delta = end[axis] - start[axis]
            if abs(delta) < 1e-12:
                return end.copy()
            ratio = (bound - start[axis]) / delta
            return [
                start[0] + ratio * (end[0] - start[0]),
                start[1] + ratio * (end[1] - start[1]),
            ]

        clipped: list[list[float]] = []
        previous = points[-1]
        previous_inside = inside(previous)
        for current in points:
            current_inside = inside(current)
            if current_inside != previous_inside:
                clipped.append(intersection(previous, current))
            if current_inside:
                clipped.append(current)
            previous = current
            previous_inside = current_inside
        points = clipped
    return points


def _fastsam_polygons(
    image, boxes: list[list[float]], imgsz: int, quantize: int
) -> dict[int, object]:
    """Segment all detector boxes once and map masks back to detector boxes."""

    if not boxes:
        return {}
    # stream=False materializes the generator. The previous experimental code
    # assigned the stream generator to ``sam_result`` without consuming it.
    sam_results = _load_fastsam_model().predict(
        source=image,
        stream=False,
        bboxes=boxes,
        points=None,
        labels=None,
        device=settings.YOLO_DEVICE,
        imgsz=imgsz,
        quantize=quantize,
        retina_masks=True,
        conf=settings.FASTSAM_CONF,
        verbose=False,
    )
    if not sam_results:
        return {}
    sam_result = sam_results[0]
    if sam_result.masks is None:
        return {}
    polygons = sam_result.masks.xyn
    sam_boxes = [
        list(map(float, sam_box.detach().cpu().tolist()))
        for sam_box in sam_result.boxes.xyxy
    ]
    matches: dict[int, object] = {}
    used_masks: set[int] = set()
    for box_index, detector_box in enumerate(boxes):
        candidates = [
            (mask_index, _box_iou(detector_box, sam_box))
            for mask_index, sam_box in enumerate(sam_boxes)
            if mask_index not in used_masks
        ]
        if not candidates:
            break
        mask_index, overlap = max(candidates, key=lambda item: item[1])
        if overlap <= 0.0 or mask_index >= len(polygons):
            continue
        matches[box_index] = polygons[mask_index]
        used_masks.add(mask_index)
    return matches


def run_yolo(inference_frame: InferenceFrame, yolo_model: YOLO) -> dict:
    start = perf_counter()
    img = inference_frame.frame.to_ndarray(format="bgr24")
    frame_height, frame_width = img.shape[:2]
    longest_side = max(frame_width, frame_height)
    imgsz = min(((longest_side + 31) // 32) * 32, settings.YOLO_MAX_IMGSZ)
    quantize = (
        16 if settings.YOLO_HALF and settings.YOLO_DEVICE.startswith("cuda") else 32
    )
    tracking = settings.YOLO_TRACKING
    yolo_task = getattr(yolo_model, "task", "segment")
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
                conf=_yolo_detect_conf(),
                tracker=settings.YOLO_TRACKER_CONFIG,
                persist=True,
                verbose=False,
            )
        else:
            results = yolo_model(
                img,
                device=settings.YOLO_DEVICE,
                imgsz=imgsz,
                quantize=quantize,
                conf=_yolo_detect_conf(),
                verbose=False,
            )
    detections = []
    allowed_classes = _allowed_yolo_classes()
    for result in results:
        if yolo_task == "segment":
            # Segmentation checkpoints already provide the desired masks;
            # do not run the separate FastSAM model for the same frame.
            normalized_polygons = result.masks.xyn if result.masks is not None else []
            fastsam_polygons = {}
            fastsam_index_by_box: dict[int, int] = {}
        else:
            detector_boxes = []
            fastsam_index_by_box = {}
            for box_index, box in enumerate(result.boxes):
                conf = float(box.conf[0])
                if not tracking and conf <= _yolo_detect_conf():
                    continue
                cls_id = int(box.cls[0])
                class_name = _yolo_class_name(yolo_model, cls_id)
                if allowed_classes and class_name.casefold() not in allowed_classes:
                    continue
                fastsam_index_by_box[box_index] = len(detector_boxes)
                detector_boxes.append(
                    list(map(float, box.xyxy[0].detach().cpu().tolist()))
                )
            fastsam_polygons = _fastsam_polygons(img, detector_boxes, imgsz, quantize)
            normalized_polygons = []
        for box_index, box in enumerate(result.boxes):
            conf = float(box.conf[0])
            if not tracking and conf <= _yolo_detect_conf():
                continue
            cls_id = int(box.cls[0])
            class_name = _yolo_class_name(yolo_model, cls_id)
            if allowed_classes and class_name.casefold() not in allowed_classes:
                continue
            normalized_box = list(map(float, box.xyxyn[0].detach().cpu().tolist()))
            if settings.BBOX_FORMAT == "xyxy_normalized":
                bbox = normalized_box
            elif settings.BBOX_FORMAT == "xyxy_pixels":
                bbox = list(map(float, box.xyxy[0].detach().cpu().tolist()))
            elif settings.BBOX_FORMAT == "xywh_normalized":
                bbox = list(map(float, box.xywhn[0].detach().cpu().tolist()))
            else:
                bbox = list(map(float, box.xywh[0].detach().cpu().tolist()))
            detection = {
                "class": class_name,
                "confidence": round(conf, 2),
                "bbox": bbox,
                "bbox_format": settings.BBOX_FORMAT,
            }
            track_id = getattr(box, "id", None)
            if track_id is not None:
                detection["track_id"] = int(track_id[0])
            if yolo_task == "segment":
                polygon = (
                    normalized_polygons[box_index]
                    if box_index < len(normalized_polygons)
                    else None
                )
            else:
                polygon = fastsam_polygons.get(fastsam_index_by_box[box_index])
            if polygon is not None:
                polygon_points = (
                    _clip_polygon_to_box(polygon, normalized_box)
                    if settings.SEGMENTATION_CLIP_TO_YOLO_BOX
                    else (
                        polygon.tolist()
                        if hasattr(polygon, "tolist")
                        else polygon
                    )
                )
                if len(polygon_points) >= 3:
                    detection["mask"] = [
                        [float(x), float(y)] for x, y in polygon_points
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
    run_inference = partial(run_yolo, yolo_model=state.yolo_model)
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
        if state.tracker_epoch != inference_frame.epoch:
            # An epoch boundary is a hard discontinuity in the source, so the
            # tracker's identities and motion models must not survive it.
            await asyncio.to_thread(reset_tracker, state.yolo_model)
            state.tracker_epoch = inference_frame.epoch
        result = None
        last_error: Exception | None = None
        for attempt in range(max(1, settings.INFERENCE_RETRY_COUNT)):
            try:
                result = await asyncio.to_thread(run_inference, inference_frame)
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
