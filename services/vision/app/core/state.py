from __future__ import annotations

import asyncio
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from time import monotonic
from typing import Any

from av import VideoFrame
from starlette.requests import HTTPConnection
from ultralytics import YOLO

from app.services.source_timeline import SourceTimelineResolver
from app.services.telemetry import TelemetryStore


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
    recording_identity: dict[str, str] | None = None
    # Position on the source recording timeline (QR anchor + PTS
    # extrapolation). Telemetry is matched on this, never on receive time.
    resolved_source_timestamp_ns: int | None = None
    source_timeline_status: str = "unavailable"
    source_timeline_generation: int = 0


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
class VisionMetrics:
    """Cheap process-local counters used by the periodic diagnostics task."""

    started_at: float = field(default_factory=monotonic)
    decoded_frames_received: int = 0
    inference_frames_dropped: int = 0
    frames_inferred: int = 0
    playback_frames_published: int = 0
    websocket_frames_sent: int = 0
    decode_ms_total: float = 0.0
    frame_convert_ms_total: float = 0.0
    model_ms_total: float = 0.0
    inference_ms_total: float = 0.0
    postprocess_ms_total: float = 0.0
    recording_samples_queued: int = 0
    recording_samples_dropped: int = 0
    recording_samples_uploaded: int = 0

    def record_inference(self, result: dict[str, Any]) -> None:
        self.frames_inferred += 1
        self.frame_convert_ms_total += float(result.get("frame_convert_ms", 0.0))
        self.model_ms_total += float(result.get("model_ms", 0.0))
        self.inference_ms_total += float(result.get("inference_ms", 0.0))
        self.postprocess_ms_total += float(result.get("postprocess_ms", 0.0))

    def snapshot(self) -> dict[str, float | int]:
        return {
            "decoded_frames_received": self.decoded_frames_received,
            "inference_frames_dropped": self.inference_frames_dropped,
            "frames_inferred": self.frames_inferred,
            "playback_frames_published": self.playback_frames_published,
            "websocket_frames_sent": self.websocket_frames_sent,
            "decode_ms_total": self.decode_ms_total,
            "frame_convert_ms_total": self.frame_convert_ms_total,
            "model_ms_total": self.model_ms_total,
            "inference_ms_total": self.inference_ms_total,
            "postprocess_ms_total": self.postprocess_ms_total,
            "recording_samples_queued": self.recording_samples_queued,
            "recording_samples_dropped": self.recording_samples_dropped,
            "recording_samples_uploaded": self.recording_samples_uploaded,
        }


def _new_inference_queue() -> asyncio.Queue[InferenceFrame]:
    # Import lazily to keep this state module independent from Settings during
    # configuration/bootstrap imports.
    from app.core.settings import settings

    return asyncio.Queue(maxsize=settings.YOLO_INFERENCE_QUEUE_SIZE)


@dataclass
class AppState:
    """Process-wide state for the single ordered inference/playback session."""

    yolo_model: YOLO | None = None
    android_live: bool = False
    current_epoch: int = 0
    session_id: str | None = None
    viewer_connected: bool = False
    last_presented: tuple[int, int] | None = None
    resync_generation: int = 0
    inference_queue: asyncio.Queue[InferenceFrame] = field(
        default_factory=_new_inference_queue
    )
    queued_sequences: set[tuple[int, int]] = field(default_factory=set)
    completed_sequences: set[tuple[int, int]] = field(default_factory=set)
    completed_sequence_order: deque[tuple[int, int]] = field(default_factory=deque)
    # Ordered insertion is important: reconnect replay walks this store from
    # the requested sequence without timestamp matching or latest-value loss.
    result_store: OrderedDict[tuple[int, int], PlaybackItem] = field(
        default_factory=OrderedDict
    )
    result_condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    feed_commands: asyncio.Queue[dict[str, Any]] = field(default_factory=asyncio.Queue)
    fault: str | None = None
    # Epoch whose frames the object tracker currently holds state for. Only the
    # inference worker touches it, which keeps the reset serialized with the
    # inference calls that mutate the same tracker.
    tracker_epoch: int | None = None
    inference_active: bool = False
    monocular_timeline: Any | None = None
    monocular_resolver: Any | None = None
    # The last completed result is used to create cheap passthrough results
    # when the bounded inference handoff evicts an older decoded frame.
    last_inference_result: dict[str, Any] | None = None
    last_inference_result_epoch: int | None = None
    metrics: VisionMetrics = field(default_factory=VisionMetrics)
    recording_writer: Any | None = None
    telemetry_store: TelemetryStore = field(default_factory=TelemetryStore)
    source_timeline: SourceTimelineResolver = field(default_factory=SourceTimelineResolver)

    @property
    def completed_sequence_limit(self) -> int:
        # A reconnect can replay from a retained keyframe before the last ACK.
        # Keep a bounded 60 FPS window matching the relay's time retention so
        # those frames are deduplicated without retaining an entire session.
        from app.core.settings import settings

        return max(120, int(settings.BACKLOG_MAX_SECONDS * 60))

    def mark_completed(self, epoch: int, seq: int) -> None:
        key = (epoch, seq)
        if key in self.completed_sequences:
            return
        self.completed_sequences.add(key)
        self.completed_sequence_order.append(key)
        while len(self.completed_sequence_order) > self.completed_sequence_limit:
            expired = self.completed_sequence_order.popleft()
            self.completed_sequences.discard(expired)

    def clear_completed_sequences(self) -> None:
        self.completed_sequences.clear()
        self.completed_sequence_order.clear()

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
