"""Per-session GPS/IMU history and source-timestamp matching for live frames.

The media relay forwards validated telemetry batches keyed by the trusted
``recordingSessionId``. Each live video frame carries the same identity plus a
resolved source timestamp (see ``source_timeline``); ``TelemetryStore.match``
returns the GPS/IMU state at that instant. Matching never crosses sessions, and
extrapolated/interpolated positions are display-only - they are never persisted.
"""

from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field
from time import monotonic
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

NS_PER_MS = 1_000_000
NS_PER_S = 1_000_000_000
EARTH_RADIUS_M = 6_371_008.8

GPS_RETENTION_NS = 30 * NS_PER_S
IMU_RETENTION_NS = 10 * NS_PER_S
MAX_GPS_SAMPLES = 256
MAX_IMU_SAMPLES = 2048
MAX_SESSIONS = 16
SESSION_IDLE_EXPIRY_S = 120.0

GPS_MAX_INTERPOLATION_GAP_NS = 2_500 * NS_PER_MS
GPS_MAX_EXTRAPOLATION_NS = 1_500 * NS_PER_MS
IMU_MAX_DELTA_NS = 50 * NS_PER_MS
# Below this speed GPS bearing is noise; hold position instead of dead-reckoning.
MIN_EXTRAPOLATION_SPEED_MPS = 0.5

_INT64_PATTERN = r"^[1-9][0-9]{0,18}$"


class GpsSampleIn(BaseModel):
    timestamp_ns: int = Field(gt=0)
    utc_epoch_ms: int | None = None
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    altitude_m: float | None = None
    speed_mps: float | None = Field(default=None, ge=0)
    bearing_deg: float | None = Field(default=None, ge=0, lt=360)
    horizontal_accuracy_m: float | None = Field(default=None, ge=0)

    @field_validator("timestamp_ns", "utc_epoch_ms", mode="before")
    @classmethod
    def _int64_string(cls, value: Any) -> Any:
        return _parse_int64(value)


class ImuSampleIn(BaseModel):
    timestamp_ns: int = Field(gt=0)
    pitch_deg: float = Field(ge=-720, le=720)
    roll_deg: float = Field(ge=-720, le=720)
    yaw_deg: float = Field(ge=-720, le=720)
    accuracy: int | None = None

    @field_validator("timestamp_ns", mode="before")
    @classmethod
    def _int64_string(cls, value: Any) -> Any:
        return _parse_int64(value)


class TelemetryBatchIn(BaseModel):
    """Canonical batch from the media relay. Identity is relay-validated."""

    mode: Literal["REPLAY", "LIVE"]
    tripId: str = Field(pattern=_INT64_PATTERN)
    vehicleId: str = Field(pattern=_INT64_PATTERN)
    recordingSessionId: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
    sourceClockNs: int | None = None
    receivedAt: str | None = None
    gps: list[GpsSampleIn] = Field(default_factory=list, max_length=16)
    imu: list[ImuSampleIn] = Field(default_factory=list, max_length=64)

    @field_validator("sourceClockNs", mode="before")
    @classmethod
    def _int64_string(cls, value: Any) -> Any:
        return _parse_int64(value)


def _parse_int64(value: Any) -> Any:
    """64-bit values travel as JSON strings; reject floats that lost precision."""

    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit() and len(value) <= 19:
        return int(value)
    raise ValueError("expected a 64-bit integer or integer string")


class TelemetryIdentityError(ValueError):
    """A batch claimed a recordingSessionId already bound to another trip/vehicle."""


@dataclass
class SessionTelemetry:
    trip_id: str
    vehicle_id: str
    mode: str
    gps_ts: list[int] = field(default_factory=list)
    gps: list[GpsSampleIn] = field(default_factory=list)
    imu_ts: list[int] = field(default_factory=list)
    imu: list[ImuSampleIn] = field(default_factory=list)
    last_update: float = field(default_factory=monotonic)


@dataclass
class TelemetryCounters:
    batches_received: int = 0
    batches_rejected: int = 0
    match_ok: int = 0
    gps_stale: int = 0
    imu_stale: int = 0


def _insert(timestamps: list[int], values: list, sample, retention_ns: int, max_samples: int) -> None:
    ts = sample.timestamp_ns
    if timestamps and ts < timestamps[-1] - retention_ns:
        # A sample older than the retained window is a rewind; never mix the
        # previous source interval with the new one.
        timestamps.clear()
        values.clear()
    index = bisect_left(timestamps, ts)
    if index < len(timestamps) and timestamps[index] == ts:
        values[index] = sample
        return
    timestamps.insert(index, ts)
    values.insert(index, sample)
    cut = bisect_left(timestamps, timestamps[-1] - retention_ns)
    cut = max(cut, len(timestamps) - max_samples)
    if cut > 0:
        del timestamps[:cut]
        del values[:cut]


def _lerp(a: float | None, b: float | None, fraction: float) -> float | None:
    if a is None:
        return b
    if b is None:
        return a
    return a + (b - a) * fraction


def interpolate_angle(a: float | None, b: float | None, fraction: float) -> float | None:
    """Shortest-arc interpolation in degrees, result in [0, 360)."""

    if a is None:
        return b
    if b is None:
        return a
    delta = ((b - a + 180.0) % 360.0) - 180.0
    return (a + delta * fraction) % 360.0


def interpolate_signed_angle(a: float, b: float, fraction: float) -> float:
    """Shortest-arc interpolation in degrees, result in (-180, 180]."""

    value = interpolate_angle(a % 360.0, b % 360.0, fraction) or 0.0
    return value - 360.0 if value > 180.0 else value


def gps_quality(accuracy_m: float | None) -> str:
    if accuracy_m is None:
        return "unknown"
    if accuracy_m <= 10:
        return "normal"
    if accuracy_m <= 30:
        return "degraded"
    return "low"


def _gps_view(latitude, longitude, speed_mps, bearing, altitude, accuracy) -> dict[str, Any]:
    return {
        "latitude": latitude,
        "longitude": longitude,
        "speed_kmh": None if speed_mps is None else speed_mps * 3.6,
        "bearing_deg": bearing,
        "altitude_m": altitude,
        "horizontal_accuracy_m": accuracy,
        "accuracy_quality": gps_quality(accuracy),
    }


def match_gps(timestamps: list[int], samples: list[GpsSampleIn], t: int) -> tuple[dict | None, str, float | None]:
    """Return (gps view, match kind, age ms). Kinds: exact, interpolated,
    extrapolated, held, stale, no_fix."""

    if not timestamps:
        return None, "no_fix", None
    index = bisect_right(timestamps, t)
    if index == 0:
        return None, "no_fix", None
    previous = samples[index - 1]
    if previous.timestamp_ns == t:
        return (
            _gps_view(previous.latitude, previous.longitude, previous.speed_mps, previous.bearing_deg,
                      previous.altitude_m, previous.horizontal_accuracy_m),
            "exact",
            0.0,
        )
    if index < len(samples):
        following = samples[index]
        gap = following.timestamp_ns - previous.timestamp_ns
        if gap <= GPS_MAX_INTERPOLATION_GAP_NS:
            fraction = (t - previous.timestamp_ns) / gap
            return (
                _gps_view(
                    _lerp(previous.latitude, following.latitude, fraction),
                    _lerp(previous.longitude, following.longitude, fraction),
                    _lerp(previous.speed_mps, following.speed_mps, fraction),
                    interpolate_angle(previous.bearing_deg, following.bearing_deg, fraction),
                    _lerp(previous.altitude_m, following.altitude_m, fraction),
                    _lerp(previous.horizontal_accuracy_m, following.horizontal_accuracy_m, fraction),
                ),
                "interpolated",
                0.0,
            )
    age_ns = t - previous.timestamp_ns
    if age_ns > GPS_MAX_EXTRAPOLATION_NS:
        return None, "stale", age_ns / NS_PER_MS
    view = _gps_view(previous.latitude, previous.longitude, previous.speed_mps, previous.bearing_deg,
                     previous.altitude_m, previous.horizontal_accuracy_m)
    if (
        previous.speed_mps is None
        or previous.bearing_deg is None
        or previous.speed_mps < MIN_EXTRAPOLATION_SPEED_MPS
    ):
        return view, "held", age_ns / NS_PER_MS
    distance = previous.speed_mps * age_ns / NS_PER_S
    bearing = math.radians(previous.bearing_deg)
    latitude = math.radians(previous.latitude)
    view["latitude"] = previous.latitude + math.degrees(distance * math.cos(bearing) / EARTH_RADIUS_M)
    view["longitude"] = previous.longitude + math.degrees(
        distance * math.sin(bearing) / (EARTH_RADIUS_M * max(math.cos(latitude), 1e-6))
    )
    return view, "extrapolated", age_ns / NS_PER_MS


def match_imu(timestamps: list[int], samples: list[ImuSampleIn], t: int) -> tuple[dict | None, str, float | None]:
    """Return (imu view, match kind, delta ms). Kinds: nearest, interpolated, stale, none."""

    if not timestamps:
        return None, "none", None
    index = bisect_left(timestamps, t)
    candidates = [i for i in (index - 1, index) if 0 <= i < len(timestamps)]
    nearest = min(candidates, key=lambda i: abs(timestamps[i] - t))
    delta_ns = abs(timestamps[nearest] - t)
    if delta_ns > IMU_MAX_DELTA_NS:
        return None, "stale", delta_ns / NS_PER_MS
    sample = samples[nearest]
    if 0 < index < len(timestamps) and timestamps[index] != t:
        before, after = samples[index - 1], samples[index]
        if t - before.timestamp_ns <= IMU_MAX_DELTA_NS and after.timestamp_ns - t <= IMU_MAX_DELTA_NS:
            fraction = (t - before.timestamp_ns) / (after.timestamp_ns - before.timestamp_ns)
            return (
                {
                    "pitch_deg": _lerp(before.pitch_deg, after.pitch_deg, fraction),
                    "roll_deg": _lerp(before.roll_deg, after.roll_deg, fraction),
                    "yaw_deg": interpolate_signed_angle(before.yaw_deg, after.yaw_deg, fraction),
                    "accuracy": sample.accuracy,
                },
                "interpolated",
                delta_ns / NS_PER_MS,
            )
    return (
        {"pitch_deg": sample.pitch_deg, "roll_deg": sample.roll_deg, "yaw_deg": sample.yaw_deg, "accuracy": sample.accuracy},
        "nearest",
        delta_ns / NS_PER_MS,
    )


class TelemetryStore:
    def __init__(self, *, clock=monotonic) -> None:
        self._sessions: dict[str, SessionTelemetry] = {}
        self._clock = clock
        self.counters = TelemetryCounters()

    def ingest(self, batch: TelemetryBatchIn) -> SessionTelemetry:
        """Add a relay batch. Raises TelemetryIdentityError when the session id
        is already bound to a different trip/vehicle."""

        self._expire()
        session = self._sessions.get(batch.recordingSessionId)
        if session is not None and (session.trip_id != batch.tripId or session.vehicle_id != batch.vehicleId):
            self.counters.batches_rejected += 1
            raise TelemetryIdentityError("recordingSessionId is bound to a different trip/vehicle")
        if session is None:
            session = SessionTelemetry(trip_id=batch.tripId, vehicle_id=batch.vehicleId, mode=batch.mode)
            self._sessions[batch.recordingSessionId] = session
            self._evict()
        session.mode = batch.mode
        session.last_update = self._clock()
        for sample in batch.gps:
            _insert(session.gps_ts, session.gps, sample, GPS_RETENTION_NS, MAX_GPS_SAMPLES)
        for sample in batch.imu:
            _insert(session.imu_ts, session.imu, sample, IMU_RETENTION_NS, MAX_IMU_SAMPLES)
        self.counters.batches_received += 1
        return session

    def session(self, recording_session_id: str) -> SessionTelemetry | None:
        return self._sessions.get(recording_session_id)

    def buffer_sizes(self) -> tuple[int, int]:
        return (
            sum(len(item.gps) for item in self._sessions.values()),
            sum(len(item.imu) for item in self._sessions.values()),
        )

    def _expire(self) -> None:
        cutoff = self._clock() - SESSION_IDLE_EXPIRY_S
        for key in [key for key, item in self._sessions.items() if item.last_update < cutoff]:
            del self._sessions[key]

    def _evict(self) -> None:
        while len(self._sessions) > MAX_SESSIONS:
            oldest = min(self._sessions, key=lambda key: self._sessions[key].last_update)
            del self._sessions[oldest]

    def match(
        self,
        recording: dict[str, str] | None,
        source_timestamp_ns: int | None,
    ) -> dict[str, Any]:
        """Telemetry for one frame. ``recording`` is the frame's relay-validated
        identity; telemetry is only ever looked up under that session."""

        if not recording or not recording.get("recordingSessionId"):
            return {"status": "no_recording_identity"}
        base: dict[str, Any] = {
            "recording": {
                "tripId": recording.get("tripId"),
                "vehicleId": recording.get("vehicleId"),
                "recordingSessionId": recording["recordingSessionId"],
            },
        }
        session = self._sessions.get(recording["recordingSessionId"])
        if session is None:
            return {**base, "status": "waiting_for_telemetry"}
        if session.trip_id != str(recording.get("tripId")) or session.vehicle_id != str(recording.get("vehicleId")):
            return {**base, "status": "session_mismatch"}
        base["mode"] = session.mode
        if source_timestamp_ns is None:
            return {**base, "status": "source_timestamp_unavailable"}

        gps, gps_match, gps_age_ms = match_gps(session.gps_ts, session.gps, source_timestamp_ns)
        imu, imu_match, imu_delta_ms = match_imu(session.imu_ts, session.imu, source_timestamp_ns)
        if gps is None and imu is None:
            status = "stale"
        elif gps is None:
            status = "gps_stale"
        elif imu is None:
            status = "imu_stale"
        else:
            status = "ok"
        if status == "ok":
            self.counters.match_ok += 1
        if gps is None:
            self.counters.gps_stale += 1
        if imu is None:
            self.counters.imu_stale += 1
        return {
            **base,
            "status": status,
            "source_timestamp_ns": str(source_timestamp_ns),
            "gps": gps,
            "imu": imu,
            "match": {
                "gps": gps_match,
                "imu": imu_match,
                "gps_age_ms": gps_age_ms,
                "imu_delta_ms": imu_delta_ms,
            },
        }
