from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from av import VideoFrame
from starlette.requests import HTTPConnection


@dataclass
class InferenceFrame:
    """One encoded source access unit and its decoded inference image."""

    seq: int
    frame: VideoFrame
    pts: int | None
    time_base: float | None
    media_time: float | None
    epoch: int = 0
    encoded: bytes = b""
    timestamp_us: int = 0
    keyframe: bool = False
    # QR metadata is attached by relay-go to the matching access unit.  The
    # source timestamp belongs to the recorded dataset, while capture timestamp
    # belongs to the Android frame clock used for the live transport join.
    qr_source_timestamp_ns: int | None = None
    qr_capture_timestamp_ns: int | None = None
    qr_decode_success: bool = False


@dataclass
class PlaybackItem:
    """A result that can be replayed until the browser acknowledges it."""

    epoch: int
    seq: int
    encoded: bytes
    timestamp_us: int
    keyframe: bool
    result: dict[str, Any]


@dataclass
class AppState:
    """Process-wide state for the single ordered inference/playback session."""

    # Holds the SAM3 model used by the inference worker.
    inference_model: Any | None = None
    android_live: bool = False
    current_epoch: int = 0
    session_id: str | None = None
    viewer_connected: bool = False
    last_presented: tuple[int, int] | None = None
    resync_generation: int = 0
    inference_queue: asyncio.Queue[InferenceFrame] = field(
        default_factory=asyncio.Queue
    )
    queued_sequences: set[tuple[int, int]] = field(default_factory=set)
    completed_sequences: set[tuple[int, int]] = field(default_factory=set)
    # Ordered insertion is important: reconnect replay walks this store from
    # the requested sequence without timestamp matching or latest-value loss.
    result_store: OrderedDict[tuple[int, int], PlaybackItem] = field(
        default_factory=OrderedDict
    )
    result_condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    feed_commands: asyncio.Queue[dict[str, Any]] = field(default_factory=asyncio.Queue)
    fault: str | None = None
    # Epoch whose frames the inference backend currently holds state for. Only
    # the inference worker touches it, which keeps reset serialized with model
    # calls that may mutate backend state.
    inference_epoch: int | None = None
    monocular_timeline: Any | None = None
    monocular_resolver: Any | None = None

    def put_result(self, item: PlaybackItem) -> None:
        self.result_store[(item.epoch, item.seq)] = item

    def acknowledge(self, epoch: int, seq: int) -> None:
        """Cumulatively remove results already painted by the browser."""

        if epoch != self.current_epoch:
            return
        for key in list(self.result_store):
            item_epoch, item_seq = key
            if item_epoch == epoch and item_seq <= seq:
                self.result_store.pop(key, None)
        if self.last_presented is None or self.last_presented[0] != epoch:
            self.last_presented = (epoch, seq)
        else:
            self.last_presented = (epoch, max(self.last_presented[1], seq))

    def clear_epoch(self, epoch: int | None = None) -> None:
        target = self.current_epoch if epoch is None else epoch
        for key in list(self.result_store):
            if key[0] == target:
                self.result_store.pop(key, None)

    def clear_all_results(self) -> None:
        self.result_store.clear()


def get_app_state(conn: HTTPConnection) -> AppState:
    return conn.app.state.app_state
