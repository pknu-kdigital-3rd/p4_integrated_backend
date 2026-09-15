from __future__ import annotations

import asyncio
import json
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from app.core.settings import settings
from app.core.state import AppState, PlaybackItem, get_app_state

router = APIRouter()
logger = logging.getLogger("uvicorn.error")


def _segmentation_model_filename() -> str:
    return Path(settings.SAM3_CHECKPOINT_PATH).name


def _frame_message(state: AppState, item: PlaybackItem) -> bytes:
    result = item.result
    metadata = {
        "type": "frame",
        "session_id": state.session_id,
        "segmentation_backend": "sam3.1_multiplex",
        "model_filename": _segmentation_model_filename(),
        "epoch": item.epoch,
        "seq": item.seq,
        "source": result.get("source", {}),
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
            "monocular": result.get("monocular", {}),
        },
    }
    metadata_bytes = json.dumps(metadata, separators=(",", ":")).encode()
    return len(metadata_bytes).to_bytes(4, "big") + metadata_bytes + item.encoded


async def _wait_for_item(state: AppState, epoch: int, seq: int) -> PlaybackItem | None:
    async with state.result_condition:
        while True:
            if state.current_epoch != epoch:
                return None
            if not state.viewer_connected:
                return None
            item = state.result_store.get((epoch, seq))
            if item is not None:
                return item
            if state.fault:
                return None
            await state.result_condition.wait()


async def _receive_controls(
    websocket: WebSocket, state: AppState, epoch_ref: list[int]
) -> None:
    try:
        while True:
            message = json.loads(await websocket.receive_text())
            message_type = message.get("type")
            if message_type == "presented":
                epoch = int(message.get("epoch", -1))
                seq = int(message.get("seq", -1))
                state.acknowledge(epoch, seq)
                await state.feed_commands.put({"type": "presented", "epoch": epoch, "seq": seq})
                async with state.result_condition:
                    state.result_condition.notify_all()
            elif message_type in {"jump_to_live", "resync"}:
                async with state.result_condition:
                    state.clear_all_results()
                    state.fault = None
                    state.last_presented = None
                    state.resync_generation += 1
                    state.result_condition.notify_all()
                await state.feed_commands.put({"type": "resync", "reason": message_type})
            elif message_type == "stop":
                logger.info("playback stop received client=%s", websocket.client)
                await state.feed_commands.put({"type": "stop"})
                state.viewer_connected = False
                async with state.result_condition:
                    state.result_condition.notify_all()
                return
            elif message_type == "open":
                # OPEN is consumed before this task starts.  Ignore duplicate
                # OPEN messages instead of treating them as an implicit resync.
                continue
    except (WebSocketDisconnect, asyncio.IncompleteReadError, json.JSONDecodeError):
        logger.info("playback control channel disconnected client=%s", websocket.client)
        state.viewer_connected = False
        async with state.result_condition:
            state.result_condition.notify_all()


@router.websocket("/ws/playback")
async def playback(websocket: WebSocket, state: AppState = Depends(get_app_state)):
    await websocket.accept()
    logger.info("playback websocket accepted client=%s", websocket.client)
    control_task: asyncio.Task | None = None
    try:
        first = json.loads(await websocket.receive_text())
        if first.get("type") != "open":
            await websocket.close(code=1008, reason="open message required")
            return

        requested_session = first.get("session_id")
        # A live viewer owns the single playback slot. Check this before
        # comparing session IDs so a stale ID from sessionStorage cannot
        # mutate the active session or turn a reconnect into a close loop.
        if state.viewer_connected:
            await websocket.close(code=1008, reason="shared playback session is in use")
            return
        session_mismatch = (
            state.session_id is not None
            and bool(requested_session)
            and requested_session != state.session_id
        )
        if state.session_id is None:
            state.session_id = requested_session or uuid.uuid4().hex
        state.viewer_connected = True

        requested_epoch = int(first.get("epoch", state.current_epoch))
        requested_seq = int(first.get("last_presented_seq", -1)) + 1
        decoder_state_preserved = bool(first.get("decoder_state_preserved"))
        decoder_reset = bool(first.get("session_id")) and not decoder_state_preserved
        resume_unavailable = bool(first.get("session_id")) and (
            session_mismatch or requested_epoch != state.current_epoch or decoder_reset
        )
        if session_mismatch or requested_epoch != state.current_epoch or decoder_reset:
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
                }
            )
        )
        if mode == "new":
            if resume_unavailable:
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
        control_task = asyncio.create_task(_receive_controls(websocket, state, epoch_ref))
        next_seq = requested_seq
        reported_fault = False
        sent_sizes: dict[tuple[int, int], int] = {}
        seen_resync_generation = state.resync_generation
        while True:
            # Bound the amount sent ahead of the browser without deleting any
            # unseen result. ACKs release this window; a stalled viewer causes
            # TCP/application backpressure instead of frame loss.
            async with state.result_condition:
                if state.current_epoch != epoch_ref[0]:
                    sent_sizes.clear()
                if state.resync_generation != seen_resync_generation:
                    sent_sizes.clear()
                    seen_resync_generation = state.resync_generation
                while state.viewer_connected:
                    ack = state.last_presented
                    if ack is not None:
                        for key in list(sent_sizes):
                            if key[0] == ack[0] and key[1] <= ack[1]:
                                sent_sizes.pop(key, None)
                    outstanding_bytes = sum(sent_sizes.values())
                    outstanding_frames = len(sent_sizes)
                    if outstanding_bytes <= settings.CLIENT_BUFFER_MAX_BYTES and outstanding_frames <= 120:
                        break
                    await state.result_condition.wait()
            item = await _wait_for_item(state, epoch_ref[0], next_seq)
            if item is None:
                if not state.viewer_connected:
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
                    epoch_ref[0] = state.current_epoch
                    next_seq = 0
                    await websocket.send_text(
                        json.dumps(
                            {
                                "type": "epoch",
                                "epoch": state.current_epoch,
                                "reason": "resync",
                            }
                        )
                    )
                    continue
                await asyncio.sleep(0.05)
                continue
            await websocket.send_bytes(_frame_message(state, item))
            sent_sizes[(item.epoch, item.seq)] = len(item.encoded)
            next_seq += 1
    except (WebSocketDisconnect, asyncio.IncompleteReadError):
        logger.info("playback websocket disconnected client=%s", websocket.client)
    finally:
        if control_task is not None:
            control_task.cancel()
            await asyncio.gather(control_task, return_exceptions=True)
        state.viewer_connected = False
        logger.info("playback websocket closed client=%s", websocket.client)
