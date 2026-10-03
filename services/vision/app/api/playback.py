from __future__ import annotations

import asyncio
import json
import logging
import uuid
import orjson
from contextlib import suppress
from pathlib import Path
from time import monotonic

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from app.core.settings import settings
from app.core.state import AppState, PlaybackItem, get_app_state

router = APIRouter()
logger = logging.getLogger("uvicorn.error")

# The sender delivers results strictly by sequence. If the next sequence
# never arrives while later ones do (for example a packet the H.264 decoder
# dropped without raising), waiting would freeze the viewer forever. After
# this long, rejoin live through a resync, as Jump to Live does.
SEQUENCE_GAP_RESYNC_SECONDS = 2.0
# How often the sender wakes up while waiting, to check for such a gap.
WAIT_POLL_SECONDS = 0.5
# Close code sent to a viewer replaced by a newer one. The page shows it as
# "opened elsewhere" and does not reconnect, so two viewers cannot fight.
VIEWER_REPLACED_CLOSE_CODE = 4001
LIVE_BACKLOG_SECONDS = 1.0
LIVE_SEND_WINDOW_FRAMES = 12


def _live_backlog_exceeded(state: AppState) -> bool:
    items = [item for item in state.result_store.values() if item.epoch == state.current_epoch]
    if not items:
        return False
    timestamps = [item.timestamp_us for item in items]
    return (
        max(timestamps) - min(timestamps) > LIVE_BACKLOG_SECONDS * 1_000_000
        or len(items) > 60
        or sum(len(item.encoded) for item in items) > settings.CLIENT_BUFFER_MAX_BYTES
    )


def _owns_viewer_slot(state: AppState, token: int) -> bool:
    return state.viewer_connected and state.viewer_token == token


async def _release_viewer_slot(state: AppState, token: int) -> None:
    """Free the slot, unless a newer viewer has taken it over meanwhile."""
    async with state.result_condition:
        if state.viewer_token == token:
            state.viewer_connected = False
            state.viewer_websocket = None
        state.result_condition.notify_all()


def _frame_telemetry(state: AppState, source: dict) -> dict:
    """GPS/IMU for this frame's source time, looked up only under the frame's
    own validated recording session. Built here rather than by the inference
    worker so skipped/passthrough frames get exactly the same treatment."""

    resolved = source.get("resolved_source_timestamp_ns")
    try:
        source_timestamp_ns = None if resolved is None else int(resolved)
    except (TypeError, ValueError):
        source_timestamp_ns = None
    telemetry = state.telemetry_store.match(source.get("recording"), source_timestamp_ns)
    telemetry["source_timeline_status"] = source.get("source_timeline_status", "unavailable")
    return telemetry


def _confidence_thresholds() -> dict[str, float | None] | None:
    """Server-side tracker thresholds, shown next to the viewer's own filter."""
    if not settings.YOLO_TRACKING:
        return None
    from app.services.yolo import tracker_confidence_config

    try:
        return tracker_confidence_config()[1]
    except (OSError, ValueError):
        return None


def _overlay_classes(state: AppState) -> list[str]:
    """Classes offered in the viewer's per-class overlay menu.

    Resolved once at model load from YOLO_CLASSES (or the default list);
    computed here only when the model is not loaded yet.
    """
    resolved = getattr(state.yolo_model, "_p4_overlay_classes", None)
    if isinstance(resolved, list):
        return resolved
    from app.services.yolo import overlay_class_names

    return overlay_class_names(None, None)


def _frame_message(state: AppState, item: PlaybackItem) -> bytes:
    result = item.result
    source = result.get("source", {})
    metadata = {
        "type": "frame",
        "session_id": state.session_id,
        "model_filename": Path(settings.YOLO_MODEL).name,
        "confidence_thresholds": _confidence_thresholds(),
        "epoch": item.epoch,
        "seq": item.seq,
        "source": source,
        "telemetry": _frame_telemetry(state, source),
        "encoded": {
            "codec": "avc1.42E01F",
            "keyframe": item.keyframe,
        },
        "frame": {
            "width": result.get("width", 0),
            "height": result.get("height", 0),
        },
        "inference": {
            "duration_ms": result.get("inference_ms", 0),
            "items": result.get("items", []),
            "depth": result.get("depth", {}),
        },
    }
    metadata_bytes = orjson.dumps(metadata, option=orjson.OPT_SERIALIZE_NUMPY)
    return len(metadata_bytes).to_bytes(4, "big") + metadata_bytes + item.encoded


async def _wait_for_item(
    state: AppState, epoch: int, seq: int, timeout: float | None = None, token: int | None = None
) -> PlaybackItem | None:
    """Wait for a result; None on epoch change, disconnect, fault or timeout."""
    deadline = None if timeout is None else monotonic() + timeout
    async with state.result_condition:
        while True:
            if state.current_epoch != epoch:
                return None
            if not state.viewer_connected or (token is not None and state.viewer_token != token):
                return None
            item = state.result_store.get((epoch, seq))
            if item is not None:
                return item
            if state.fault:
                return None
            if deadline is None:
                await state.result_condition.wait()
                continue
            remaining = deadline - monotonic()
            if remaining <= 0:
                return None
            try:
                await asyncio.wait_for(state.result_condition.wait(), remaining)
            except asyncio.TimeoutError:
                return None


def _has_later_result(state: AppState, epoch: int, seq: int) -> bool:
    return any(key[0] == epoch and key[1] > seq for key in state.result_store)


async def _request_resync(state: AppState, reason: str) -> None:
    """Drop queued results and ask the relay for a new live epoch."""
    async with state.result_condition:
        state.clear_all_results()
        state.fault = None
        state.last_presented = None
        state.resync_generation += 1
        state.result_condition.notify_all()
    await state.feed_commands.put({"type": "resync", "reason": reason})


async def _receive_controls(
    websocket: WebSocket, state: AppState, epoch_ref: list[int], token: int
) -> None:
    try:
        while True:
            message = json.loads(await websocket.receive_text())
            if state.viewer_token != token:
                # Replaced by a newer viewer: its controls own the stream now.
                return
            message_type = message.get("type")
            if message_type == "presented":
                epoch = int(message.get("epoch", -1))
                seq = int(message.get("seq", -1))
                state.acknowledge(epoch, seq)
                await state.feed_commands.put(
                    {"type": "presented", "epoch": epoch, "seq": seq}
                )
                async with state.result_condition:
                    state.result_condition.notify_all()
            elif message_type in {"jump_to_live", "resync"}:
                await _request_resync(state, message_type)
            elif message_type == "stop":
                logger.info("playback stop received client=%s", websocket.client)
                await state.feed_commands.put({"type": "stop"})
                await _release_viewer_slot(state, token)
                return
            elif message_type == "open":
                # OPEN is consumed before this task starts.  Ignore duplicate
                # OPEN messages instead of treating them as an implicit resync.
                continue
    except (WebSocketDisconnect, asyncio.IncompleteReadError, json.JSONDecodeError):
        logger.info("playback control channel disconnected client=%s", websocket.client)
        await _release_viewer_slot(state, token)


@router.websocket("/ws/playback")
async def playback(websocket: WebSocket, state: AppState = Depends(get_app_state)):
    await websocket.accept()
    logger.info("playback websocket accepted client=%s", websocket.client)
    control_task: asyncio.Task | None = None
    # Only the connection that holds the single viewer slot may release it
    # (see _release_viewer_slot); a takeover hands the slot to a new token.
    token: int | None = None
    try:
        first = json.loads(await websocket.receive_text())
        if first.get("type") != "open":
            await websocket.close(code=1008, reason="open message required")
            return

        requested_session = first.get("session_id")
        # One viewer owns the playback slot. The newest viewer takes it over,
        # so a forgotten background tab cannot block the one being watched;
        # the replaced viewer is closed with VIEWER_REPLACED_CLOSE_CODE and
        # does not reconnect on its own.
        if state.viewer_connected:
            previous = state.viewer_websocket
            async with state.result_condition:
                state.viewer_token += 1
                state.viewer_connected = False
                state.viewer_websocket = None
                state.result_condition.notify_all()
            logger.info("playback viewer replaced by client=%s", websocket.client)
            if previous is not None:
                with suppress(Exception):
                    await previous.close(
                        code=VIEWER_REPLACED_CLOSE_CODE, reason="replaced by another viewer"
                    )
        session_mismatch = (
            state.session_id is not None
            and bool(requested_session)
            and requested_session != state.session_id
        )
        if state.session_id is None:
            state.session_id = requested_session or uuid.uuid4().hex
        state.viewer_token += 1
        token = state.viewer_token
        state.viewer_connected = True
        state.viewer_websocket = websocket

        requested_epoch = int(first.get("epoch", state.current_epoch))
        live_mode = first.get("live") is True
        requested_seq = int(first.get("last_presented_seq", -1)) + 1
        decoder_state_preserved = bool(first.get("decoder_state_preserved"))
        decoder_reset = bool(first.get("session_id")) and not decoder_state_preserved
        resume_unavailable = bool(first.get("session_id")) and (
            session_mismatch or requested_epoch != state.current_epoch or decoder_reset
        )
        if live_mode or session_mismatch or requested_epoch != state.current_epoch or decoder_reset:
            requested_epoch = state.current_epoch
            requested_seq = 0
            mode = "new"
        else:
            mode = "resumed" if first.get("session_id") else "new"

        await websocket.send_text(
            json.dumps(
                {
                    "type": "session",
                    "mode": mode,
                    "session_id": state.session_id,
                    "epoch": state.current_epoch,
                    "codec": "avc1.42E01F",
                    "clock_rate": 90000,
                    "buffer": {
                        "target_seconds": settings.CLIENT_PREFETCH_SECONDS,
                        "low_watermark_seconds": settings.CLIENT_LOW_WATERMARK_SECONDS,
                        "client_max_bytes": settings.CLIENT_BUFFER_MAX_BYTES,
                    },
                    "backlog": {
                        "max_seconds": settings.BACKLOG_MAX_SECONDS,
                        "max_bytes": settings.BACKLOG_MAX_BYTES,
                    },
                    "android_live": state.android_live,
                    "overlay_classes": _overlay_classes(state),
                }
            )
        )
        seen_feed_reset_generation = state.playback_reset_generation
        waiting_for_reset = mode == "new"
        if mode == "new":
            if live_mode:
                resync_reason = "jump_to_live"
            elif resume_unavailable:
                resume_reason = (
                    "decoder_state_not_preserved"
                    if decoder_reset
                    else "epoch_unavailable"
                )
                await websocket.send_text(
                    json.dumps(
                        {
                            "type": "resume_unavailable",
                            "previous_epoch": int(first.get("epoch", 0)),
                            "reason": resume_reason,
                            "next_action": "starting_new_epoch",
                        }
                    )
                )
                resync_reason = "resume_data_unavailable"
            else:
                # No prior session to resume, so there is nothing to catch this
                # viewer up on: without a resync here, they would silently
                # replay the backlog from wherever the current epoch began
                # instead of joining live, which looks like a frozen stream on
                # old, possibly static footage.
                resync_reason = "viewer_start"
            async with state.result_condition:
                state.clear_all_results()
                state.fault = None
                state.last_presented = None
                state.resync_generation += 1
                state.result_condition.notify_all()
            await state.feed_commands.put({"type": "resync", "reason": resync_reason})

        epoch_ref = [requested_epoch]
        control_task = asyncio.create_task(
            _receive_controls(websocket, state, epoch_ref, token)
        )
        next_seq = requested_seq
        gap_since: float | None = None
        reported_fault = False
        sent_sizes: dict[tuple[int, int], int] = {}
        seen_resync_generation = state.resync_generation
        while True:
            if not _owns_viewer_slot(state, token):
                break
            if state.resync_generation != seen_resync_generation:
                sent_sizes.clear()
                seen_resync_generation = state.resync_generation
                waiting_for_reset = True
                await websocket.send_json({"type": "resyncing"})
            if (state.current_epoch != epoch_ref[0]
                    or state.playback_reset_generation != seen_feed_reset_generation):
                seen_feed_reset_generation = state.playback_reset_generation
                epoch_ref[0] = state.current_epoch
                next_seq = 0
                gap_since = None
                sent_sizes.clear()
                waiting_for_reset = False
                await websocket.send_json({"type": "epoch", "epoch": state.current_epoch, "reason": "resync"})
            if waiting_for_reset:
                # Do not send old inference completions while the relay is
                # obtaining the new IDR. A reset may keep the same epoch.
                await asyncio.sleep(0.05)
                continue
            if live_mode and _live_backlog_exceeded(state):
                await _request_resync(state, "live_backlog")
                continue
            # Keep only a small window in the browser/network. Wake regularly
            # to enforce the live limit even when a background viewer stops ACKs.
            async with state.result_condition:
                ack = state.last_presented
                if ack is not None:
                    for key in list(sent_sizes):
                        if key[0] == ack[0] and key[1] <= ack[1]:
                            sent_sizes.pop(key, None)
                window_frames = LIVE_SEND_WINDOW_FRAMES if live_mode else 120
                if (sum(sent_sizes.values()) >= settings.CLIENT_BUFFER_MAX_BYTES
                        or len(sent_sizes) >= window_frames):
                    with suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(state.result_condition.wait(), WAIT_POLL_SECONDS)
                    continue
            item = await _wait_for_item(
                state, epoch_ref[0], next_seq, timeout=WAIT_POLL_SECONDS, token=token
            )
            if item is None:
                if not _owns_viewer_slot(state, token):
                    break
                if state.fault:
                    if not reported_fault:
                        await websocket.send_text(
                            json.dumps({"type": "fault", "detail": state.fault})
                        )
                        reported_fault = True
                    async with state.result_condition:
                        await state.result_condition.wait()
                    continue
                reported_fault = False
                if state.current_epoch != epoch_ref[0]:
                    continue
                if _has_later_result(state, epoch_ref[0], next_seq):
                    gap_since = gap_since if gap_since is not None else monotonic()
                    if monotonic() - gap_since >= SEQUENCE_GAP_RESYNC_SECONDS:
                        logger.warning(
                            "playback sequence gap: epoch=%s seq=%s missing while later results exist; resyncing",
                            epoch_ref[0],
                            next_seq,
                        )
                        gap_since = None
                        await _request_resync(state, "sequence_gap")
                    continue
                gap_since = None
                continue
            gap_since = None
            if (state.resync_generation != seen_resync_generation
                    or state.playback_reset_generation != seen_feed_reset_generation):
                continue
            if live_mode and _live_backlog_exceeded(state):
                await _request_resync(state, "live_backlog")
                continue
            await websocket.send_bytes(_frame_message(state, item))
            state.metrics.websocket_frames_sent += 1
            sent_sizes[(item.epoch, item.seq)] = len(item.encoded)
            next_seq += 1
    except (WebSocketDisconnect, asyncio.IncompleteReadError):
        logger.info("playback websocket disconnected client=%s", websocket.client)
    except RuntimeError:
        # A send can race with the takeover closing this socket.
        if token is None or state.viewer_token == token:
            raise
        logger.info("playback websocket replaced client=%s", websocket.client)
    finally:
        if control_task is not None:
            control_task.cancel()
            await asyncio.gather(control_task, return_exceptions=True)
        if token is not None:
            await _release_viewer_slot(state, token)
        logger.info("playback websocket closed client=%s", websocket.client)
