"""Timestamp-synchronised ground-plane monocular distance estimation.

The QR code carries the timestamp of the source recording frame.  This module
keeps that synchronisation separate from inference so that a missing QR/data sample
can never turn into a guessed metric distance.
"""

from __future__ import annotations

import csv
import json
import math
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any


NANOSECONDS_PER_MS = 1_000_000
QR_REWIND_TOLERANCE_NS = 2 * NANOSECONDS_PER_MS


@dataclass(frozen=True)
class CameraCalibration:
    camera_height_m: float
    camera_pitch_offset_deg: float = 0.0
    camera_roll_offset_deg: float = 0.0
    camera_yaw_offset_deg: float = 0.0
    min_distance_m: float = 0.1
    max_distance_m: float = 200.0

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "CameraCalibration":
        height = float(value["camera_height_m"])
        if not math.isfinite(height) or height <= 0:
            raise ValueError("camera_height_m must be a positive finite value")
        minimum = float(value.get("min_distance_m", 0.1))
        maximum = float(value.get("max_distance_m", 200.0))
        if not (math.isfinite(minimum) and math.isfinite(maximum)) or minimum < 0 or maximum <= minimum:
            raise ValueError("distance bounds must satisfy 0 <= min_distance_m < max_distance_m")
        offsets = tuple(
            float(value.get(name, 0.0))
            for name in (
                "camera_pitch_offset_deg",
                "camera_roll_offset_deg",
                "camera_yaw_offset_deg",
            )
        )
        if not all(math.isfinite(offset) for offset in offsets):
            raise ValueError("camera pose offsets must be finite")
        return cls(
            camera_height_m=height,
            camera_pitch_offset_deg=offsets[0],
            camera_roll_offset_deg=offsets[1],
            camera_yaw_offset_deg=offsets[2],
            min_distance_m=minimum,
            max_distance_m=maximum,
        )


@dataclass(frozen=True)
class _FrameSample:
    frame_index: int
    timestamp_ns: int


@dataclass(frozen=True)
class _ImuSample:
    timestamp_ns: int
    pitch_deg: float
    roll_deg: float
    yaw_deg: float
    accuracy: int | None


@dataclass(frozen=True)
class TimelineMatch:
    source_timestamp_ns: int
    frame_index: int
    frame_timestamp_ns: int
    frame_delta_ns: int
    imu: _ImuSample | None
    imu_delta_ns: int | None


@dataclass(frozen=True)
class QRResolution:
    source_timestamp_ns: int | None
    status: str
    stale: bool
    age_ms: float | None
    epoch: int


class QRResolver:
    """Carry the last valid QR value only for a bounded capture-time gap."""

    def __init__(self, max_age_ms: float = 200.0) -> None:
        if max_age_ms < 0:
            raise ValueError("max_age_ms must be non-negative")
        self.max_age_ns = int(max_age_ms * NANOSECONDS_PER_MS)
        self.reset()

    def reset(self) -> None:
        self._last_source_ns: int | None = None
        self._last_capture_ns: int | None = None
        self._last_seq: int | None = None
        self._epoch = 0

    def resolve(
        self,
        source_timestamp_ns: int | None,
        capture_timestamp_ns: int | None,
        *,
        decode_success: bool = False,
        seq: int | None = None,
    ) -> QRResolution:
        if decode_success and source_timestamp_ns is not None:
            source_timestamp_ns = int(source_timestamp_ns)
            if (
                self._last_source_ns is not None
                and source_timestamp_ns < self._last_source_ns - QR_REWIND_TOLERANCE_NS
            ):
                # A monitor loop or an explicit replay jump starts a new QR
                # timeline.  Never carry a value across that discontinuity.
                self._epoch += 1
                self._last_capture_ns = None
                self._last_seq = None
            self._last_source_ns = source_timestamp_ns
            self._last_capture_ns = capture_timestamp_ns
            self._last_seq = seq
            return QRResolution(source_timestamp_ns, "ok", False, 0.0, self._epoch)

        if self._last_source_ns is None:
            return QRResolution(None, "qr_missing", False, None, self._epoch)

        age_ns: int | None = None
        if capture_timestamp_ns is not None and self._last_capture_ns is not None:
            age_ns = max(0, int(capture_timestamp_ns) - self._last_capture_ns)
        elif seq is not None and self._last_seq is not None:
            # The RTP feed may not have a QR event for this frame.  Use the
            # ordered frame sequence as a conservative 30-fps fallback for the
            # short carry window, rather than mixing clock domains.
            age_ns = max(0, int(seq) - self._last_seq) * 33_333_333

        if age_ns is not None and age_ns <= self.max_age_ns:
            return QRResolution(
                self._last_source_ns,
                "qr_stale",
                True,
                age_ns / NANOSECONDS_PER_MS,
                self._epoch,
            )
        return QRResolution(None, "qr_missing", False, None, self._epoch)


class MonocularTimeline:
    """Indexed frame/IMU sidecars and camera intrinsics for one recording."""

    def __init__(
        self,
        frame_samples: list[_FrameSample],
        imu_samples: list[_ImuSample],
        intrinsics: dict[str, Any],
        calibration: CameraCalibration | None,
    ) -> None:
        if not frame_samples:
            raise ValueError("no frame_*.csv samples found")
        self.frames = sorted(frame_samples, key=lambda sample: sample.timestamp_ns)
        self.frame_timestamps = [sample.timestamp_ns for sample in self.frames]
        self.imus = sorted(imu_samples, key=lambda sample: sample.timestamp_ns)
        self.imu_timestamps = [sample.timestamp_ns for sample in self.imus]
        self.intrinsics = intrinsics
        self.calibration = calibration
        self.fx = float(intrinsics["fx_pixels"])
        self.fy = float(intrinsics["fy_pixels"])
        self.cx = float(intrinsics["cx_pixels"])
        self.cy = float(intrinsics["cy_pixels"])
        self.width = int(intrinsics["video_width_px"])
        self.height = int(intrinsics["video_height_px"])
        if self.width <= 0 or self.height <= 0:
            raise ValueError("intrinsics video dimensions must be positive")
        if not all(math.isfinite(value) for value in (self.cx, self.cy)):
            raise ValueError("intrinsics principal point must be finite")
        if not all(math.isfinite(value) and value > 0 for value in (self.fx, self.fy)):
            raise ValueError("intrinsics fx_pixels and fy_pixels must be positive")

    @classmethod
    def load(
        cls,
        dataset_dir: str | Path,
        calibration_file: str | Path | None = None,
    ) -> "MonocularTimeline":
        root = Path(dataset_dir)
        if not root.is_dir():
            raise FileNotFoundError(f"monocular dataset directory not found: {root}")
        intrinsics_path = root / "intrinsics.json"
        if not intrinsics_path.exists():
            raise FileNotFoundError(f"missing monocular intrinsics: {intrinsics_path}")
        intrinsics = json.loads(intrinsics_path.read_text(encoding="utf-8"))

        frames: list[_FrameSample] = []
        for path in sorted(root.glob("frame_*.csv")):
            with path.open(newline="", encoding="utf-8") as stream:
                for row in csv.DictReader(stream):
                    try:
                        frames.append(
                            _FrameSample(
                                frame_index=int(row["frame_index"]),
                                timestamp_ns=int(row["timestamp_ns"]),
                            )
                        )
                    except (KeyError, TypeError, ValueError):
                        continue

        imus: list[_ImuSample] = []
        for path in sorted(root.glob("imu_*.csv")):
            with path.open(newline="", encoding="utf-8") as stream:
                for row in csv.DictReader(stream):
                    try:
                        imus.append(
                            _ImuSample(
                                timestamp_ns=int(row["timestamp_ns"]),
                                pitch_deg=float(row["pitch_deg"]),
                                roll_deg=float(row["roll_deg"]),
                                yaw_deg=float(row["yaw_deg"]),
                                accuracy=(
                                    int(row["accuracy"])
                                    if row.get("accuracy") not in (None, "")
                                    else None
                                ),
                            )
                        )
                    except (KeyError, TypeError, ValueError):
                        continue

        calibration_path = (
            Path(calibration_file)
            if calibration_file
            else root / "monocular_calibration.json"
        )
        calibration = None
        if calibration_path.exists():
            calibration = CameraCalibration.from_json(
                json.loads(calibration_path.read_text(encoding="utf-8"))
            )
        return cls(frames, imus, intrinsics, calibration)

    @staticmethod
    def _nearest_index(values: list[int], target: int) -> int | None:
        if not values:
            return None
        position = bisect_left(values, target)
        candidates = [index for index in (position - 1, position) if 0 <= index < len(values)]
        return min(candidates, key=lambda index: abs(values[index] - target))

    def lookup(
        self,
        source_timestamp_ns: int,
        *,
        max_frame_delta_ms: float = 50.0,
        max_imu_delta_ms: float = 50.0,
    ) -> tuple[TimelineMatch | None, str]:
        frame_index = self._nearest_index(self.frame_timestamps, int(source_timestamp_ns))
        if frame_index is None:
            return None, "dataset_timestamp_unavailable"
        frame = self.frames[frame_index]
        frame_delta = abs(frame.timestamp_ns - int(source_timestamp_ns))
        if frame_delta > max_frame_delta_ms * NANOSECONDS_PER_MS:
            return None, "dataset_timestamp_unavailable"

        imu: _ImuSample | None = None
        imu_delta_ns: int | None = None
        imu_index = self._nearest_index(self.imu_timestamps, frame.timestamp_ns)
        if imu_index is not None:
            candidate = self.imus[imu_index]
            candidate_delta = abs(candidate.timestamp_ns - frame.timestamp_ns)
            if candidate_delta <= max_imu_delta_ms * NANOSECONDS_PER_MS:
                imu = candidate
                imu_delta_ns = candidate_delta
        if imu is None:
            return (
                TimelineMatch(
                    source_timestamp_ns=int(source_timestamp_ns),
                    frame_index=frame.frame_index,
                    frame_timestamp_ns=frame.timestamp_ns,
                    frame_delta_ns=frame_delta,
                    imu=None,
                    imu_delta_ns=None,
                ),
                "imu_unavailable",
            )
        return (
            TimelineMatch(
                source_timestamp_ns=int(source_timestamp_ns),
                frame_index=frame.frame_index,
                frame_timestamp_ns=frame.timestamp_ns,
                frame_delta_ns=frame_delta,
                imu=imu,
                imu_delta_ns=imu_delta_ns,
            ),
            "ok",
        )


def _normalized_box(item: dict[str, Any], width: int, height: int) -> tuple[float, float, float, float] | None:
    values = item.get("bbox") or []
    if len(values) < 4:
        return None
    try:
        x, y, w, h = (float(value) for value in values[:4])
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in (x, y, w, h)):
        return None
    fmt = str(item.get("bbox_format", "xyxy_normalized")).lower()
    if not fmt.endswith("normalized"):
        x /= max(width, 1)
        y /= max(height, 1)
        w /= max(width, 1)
        h /= max(height, 1)
    if fmt.startswith("xywh"):
        x, y = x - w / 2, y - h / 2
    else:
        w, h = w - x, h - y
    x1 = max(0.0, min(1.0, x))
    y1 = max(0.0, min(1.0, y))
    x2 = max(0.0, min(1.0, x + w))
    y2 = max(0.0, min(1.0, y + h))
    return (x1, y1, x2, y2) if x2 > x1 and y2 > y1 else None


def _ground_anchor(item: dict[str, Any], width: int, height: int) -> tuple[float, float] | None:
    class_name = str(item.get("class", "")).lower()
    if class_name != "person":
        points = item.get("mask")
        if isinstance(points, list):
            valid: list[tuple[float, float]] = []
            for point in points:
                if not isinstance(point, (list, tuple)) or len(point) < 2:
                    continue
                try:
                    px, py = float(point[0]), float(point[1])
                except (TypeError, ValueError):
                    continue
                if 0 <= px <= 1 and 0 <= py <= 1:
                    valid.append((px, py))
            if len(valid) >= 3:
                lowest = max(point[1] for point in valid)
                near_lowest = [point[0] for point in valid if lowest - point[1] <= 0.01]
                return (float(median(near_lowest)), lowest)
    box = _normalized_box(item, width, height)
    if box is None:
        return None
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2, y2)


def ground_distance_m(
    item: dict[str, Any],
    match: TimelineMatch,
    timeline: MonocularTimeline,
) -> tuple[float | None, str, tuple[float, float] | None]:
    if timeline.calibration is None:
        return None, "calibration_missing", None
    if match.imu is None:
        return None, "imu_unavailable", None
    anchor = _ground_anchor(item, timeline.width, timeline.height)
    if anchor is None:
        return None, "anchor_unavailable", None

    u, v = anchor
    ray_x = (u * timeline.width - timeline.cx) / timeline.fx
    ray_y = (v * timeline.height - timeline.cy) / timeline.fy
    ray_z = 1.0

    # Camera coordinates are x-right, y-down, z-forward.  Positive pitch
    # offset means the optical axis points down; roll/yaw use the Android
    # SensorManager Euler convention plus the measured camera-to-device offset.
    pitch = math.radians(match.imu.pitch_deg + timeline.calibration.camera_pitch_offset_deg)
    roll = math.radians(match.imu.roll_deg + timeline.calibration.camera_roll_offset_deg)
    cos_roll, sin_roll = math.cos(roll), math.sin(roll)
    roll_x = cos_roll * ray_x - sin_roll * ray_y
    roll_y = sin_roll * ray_x + cos_roll * ray_y
    cos_pitch, sin_pitch = math.cos(pitch), math.sin(pitch)
    ground_y = cos_pitch * roll_y + sin_pitch * ray_z
    ground_z = -sin_pitch * roll_y + cos_pitch * ray_z
    if ground_y <= 1e-6:
        return None, "invalid_ray", anchor

    scale = timeline.calibration.camera_height_m / ground_y
    distance = math.hypot(scale * roll_x, scale * ground_z)
    if not math.isfinite(distance):
        return None, "invalid_ray", anchor
    if not (timeline.calibration.min_distance_m <= distance <= timeline.calibration.max_distance_m):
        return None, "distance_out_of_range", anchor
    return distance, "ok", anchor


def annotate_result(
    result: dict[str, Any],
    frame: Any,
    timeline: MonocularTimeline | None,
    resolver: QRResolver,
    *,
    max_frame_delta_ms: float = 50.0,
    max_imu_delta_ms: float = 50.0,
) -> dict[str, Any]:
    """Add QR/timeline diagnostics and nullable per-item distances in place."""

    qr = resolver.resolve(
        getattr(frame, "qr_source_timestamp_ns", None),
        getattr(frame, "qr_capture_timestamp_ns", None),
        decode_success=bool(getattr(frame, "qr_decode_success", False)),
        seq=getattr(frame, "seq", None),
    )
    diagnostics: dict[str, Any] = {
        "mode": "ground_plane",
        "units": "m",
        "qr_status": qr.status,
        "qr_epoch": qr.epoch,
        "qr_source_timestamp_ns": qr.source_timestamp_ns,
        "qr_age_ms": qr.age_ms,
    }
    if timeline is None:
        diagnostics["status"] = "dataset_unavailable"
        for item in result.get("items", []):
            item["distance_m"] = None
            item["distance_status"] = "dataset_unavailable"
        result["monocular"] = diagnostics
        return result
    if qr.source_timestamp_ns is None:
        diagnostics["status"] = qr.status
        for item in result.get("items", []):
            item["distance_m"] = None
            item["distance_status"] = qr.status
        result["monocular"] = diagnostics
        return result

    match, match_status = timeline.lookup(
        qr.source_timestamp_ns,
        max_frame_delta_ms=max_frame_delta_ms,
        max_imu_delta_ms=max_imu_delta_ms,
    )
    diagnostics.update(
        {
            "status": match_status if match_status != "ok" else qr.status,
            "dataset_frame_index": match.frame_index if match else None,
            "frame_delta_ms": match.frame_delta_ns / NANOSECONDS_PER_MS if match else None,
            "imu_delta_ms": match.imu_delta_ns / NANOSECONDS_PER_MS if match and match.imu_delta_ns is not None else None,
        }
    )
    for item in result.get("items", []):
        if match is None:
            item["distance_m"] = None
            item["distance_status"] = match_status
            continue
        distance, status, anchor = ground_distance_m(
            item,
            match,
            timeline,
        )
        item["distance_m"] = round(distance, 2) if distance is not None else None
        item["distance_status"] = status if status != "ok" else qr.status
        if anchor is not None:
            item["distance_anchor"] = [round(anchor[0], 6), round(anchor[1], 6)]
    result["monocular"] = diagnostics
    return result
