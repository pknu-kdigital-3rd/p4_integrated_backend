"""Versioned, seekable inference artifacts. This module has no model dependencies."""
from __future__ import annotations

from bisect import bisect_left
import hashlib
import json
from pathlib import Path

FORMAT_VERSION = 1
TIME_BASE = 90000


def sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def sample_fingerprint(path: Path) -> str:
    """Cheap browser identity check; the server additionally verifies the full hash."""
    size = path.stat().st_size
    with path.open("rb") as stream:
        first = stream.read(min(size, 1024 * 1024))
        stream.seek(max(0, size - 1024 * 1024))
        last = stream.read()
    return hashlib.sha256(first + last).hexdigest()


def file_identity(path: Path) -> dict:
    return {"name": path.name, "size": path.stat().st_size,
            "sha256": sha256_file(path), "sample_sha256": sample_fingerprint(path)}


class InferenceBundle:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory)
        self.manifest = json.loads((self.directory / "manifest.json").read_text(encoding="utf-8"))
        manifest = self.manifest
        if manifest.get("version") != FORMAT_VERSION or manifest.get("complete") is not True:
            raise ValueError("Unsupported or incomplete inference bundle")
        if manifest.get("time_base") != TIME_BASE:
            raise ValueError("Unsupported inference bundle time base")
        self.video = self.directory / "playback.mp4"
        self.results = self.directory / "inference.jsonl"
        for name, path in (("video", self.video), ("results", self.results)):
            identity = manifest[name]
            if path.stat().st_size != identity["size"] or sha256_file(path) != identity["sha256"]:
                raise ValueError(f"Inference bundle {name} checksum mismatch")
        self.index = manifest["frames"]
        if not self.index or len(self.index) != manifest["frame_count"]:
            raise ValueError("Inference bundle frame count mismatch")
        previous_pts, end = -1, 0
        for row in self.index:
            if (len(row) != 3 or any(type(value) is not int for value in row)
                    or row[0] <= previous_pts or row[1] != end or row[2] <= 0):
                raise ValueError("Invalid inference bundle frame index")
            previous_pts, end = row[0], row[1] + row[2]
        if end != self.results.stat().st_size:
            raise ValueError("Incomplete inference bundle result index")
        self.timestamps = [row[0] for row in self.index]

    def result_at(self, pts: int) -> dict:
        index = bisect_left(self.timestamps, pts)
        if index == len(self.index) or self.timestamps[index] != pts:
            raise ValueError(f"No saved inference for video PTS {pts}")
        timestamp, offset, length = self.index[index]
        with self.results.open("rb") as stream:
            stream.seek(offset)
            record = json.loads(stream.read(length))
        if record.get("pts_90k") != timestamp or not isinstance(record.get("result"), dict):
            raise ValueError(f"Invalid saved inference at PTS {timestamp}")
        result = record["result"]
        if (result.get("width") != self.manifest["width"]
                or result.get("height") != self.manifest["height"]
                or not isinstance(result.get("items"), list)):
            raise ValueError(f"Invalid saved inference dimensions/items at PTS {timestamp}")
        return result


def source_metadata(frame) -> dict:
    return {
        "epoch": frame.epoch, "seq": frame.seq, "pts": frame.pts,
        "pts_90k": frame.pts, "time_base": frame.time_base, "time": frame.media_time,
        "timestamp_us": frame.timestamp_us,
        "resolved_source_timestamp_ns": (str(frame.resolved_source_timestamp_ns)
                                         if frame.resolved_source_timestamp_ns is not None else None),
        "source_timeline_status": frame.source_timeline_status,
        "source_timeline_generation": frame.source_timeline_generation,
        "recording": frame.recording_identity,
    }
