from __future__ import annotations

import asyncio
import math
from collections import OrderedDict
from typing import Any

import httpx

MAX_BATCH_SIZE = 20


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, value))


def normalized_detections(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert Vision boxes into compact normalized xyxy replay samples."""

    width = int(result.get("width") or 0)
    height = int(result.get("height") or 0)
    if width <= 0 or height <= 0:
        return []
    normalized: list[dict[str, Any]] = []
    for item in result.get("items", []):
        if not isinstance(item, dict):
            continue
        try:
            x1, y1, a, b = (float(value) for value in item["bbox"])
            fmt = item.get("bbox_format", "xyxy_normalized")
            if fmt.startswith("xywh_"):
                x2, y2 = x1 + a, y1 + b
            else:
                x2, y2 = a, b
            if fmt.endswith("_pixels"):
                x1, x2 = x1 / width, x2 / width
                y1, y2 = y1 / height, y2 / height
            coords = [_clamp(value) for value in (x1, y1, x2, y2)]
            x1, y1, x2, y2 = coords
            x1, x2 = min(x1, x2), max(x1, x2)
            y1, y2 = min(y1, y2), max(y1, y2)
            confidence = float(item["confidence"])
            label = str(item["class"])
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if not all(math.isfinite(value) for value in (x1, y1, x2, y2, confidence)):
            continue
        detection: dict[str, Any] = {
            "class": label[:100],
            "confidence": _clamp(confidence),
            "bbox": [round(x1, 6), round(y1, 6), round(x2, 6), round(y2, 6)],
        }
        track_id = item.get("track_id")
        if isinstance(track_id, int) and 0 <= track_id <= 2_147_483_647:
            detection["trackId"] = track_id
        normalized.append(detection)
    return normalized[:200]


class RecordingDetectionWriter:
    """Bounded, retrying background writer; offer() never waits on network I/O."""

    def __init__(
        self,
        base_url: str,
        token: str | None,
        queue_size: int = 256,
        sample_every_n_frames: int = 1,
    ):
        self.url = f"{base_url.rstrip('/')}/internal/recordings/detections"
        self.token = token
        self.sample_every_n_frames = max(1, int(sample_every_n_frames))
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=queue_size)
        self.stopping = asyncio.Event()
        self._inference_counts: OrderedDict[tuple[str, str, int], int] = OrderedDict()

    @property
    def enabled(self) -> bool:
        return bool(self.token)

    def offer(self, result: dict[str, Any], metrics: Any) -> None:
        if not self.enabled:
            return
        source = result.get("source")
        identity = source.get("recording") if isinstance(source, dict) else None
        if not isinstance(identity, dict):
            return
        trip_id = str(identity.get("tripId", ""))
        session_id = str(identity.get("recordingSessionId", ""))
        pts = source.get("pts_90k")
        if not trip_id.isdecimal() or not session_id or pts is None:
            return
        try:
            pts = int(pts)
            epoch = int(source["epoch"])
            frame_seq = int(source["seq"])
        except (KeyError, TypeError, ValueError):
            return
        key = (trip_id, session_id, epoch)
        inference_count = self._inference_counts.get(key, 0) + 1
        self._inference_counts[key] = inference_count
        self._inference_counts.move_to_end(key)
        while len(self._inference_counts) > 64:
            self._inference_counts.popitem(last=False)
        if inference_count % self.sample_every_n_frames != 0:
            return
        sample = {
            "tripId": trip_id,
            "recordingSessionId": session_id,
            "relayEpoch": str(epoch),
            "frameSeq": str(frame_seq),
            "videoPts90k": str(pts),
            "detections": normalized_detections(result),
        }
        try:
            self.queue.put_nowait(sample)
            metrics.recording_samples_queued += 1
        except asyncio.QueueFull:
            metrics.recording_samples_dropped += 1

    async def _post(self, client: httpx.AsyncClient, samples: list[dict[str, Any]]) -> bool:
        for attempt, delay in enumerate((0.0, 0.25, 0.5, 1.0)):
            if delay:
                await asyncio.sleep(delay)
            try:
                response = await client.post(
                    self.url,
                    json={"samples": samples},
                    headers={"X-Internal-Service-Token": self.token or ""},
                )
                response.raise_for_status()
                return True
            except (httpx.HTTPError, OSError) as exc:
                if attempt == 3:
                    print(
                        "replay detection batch dropped after retries: "
                        f"{len(samples)} samples ({exc})",
                        flush=True,
                    )
        return False

    async def run(self, metrics: Any) -> None:
        if not self.enabled:
            return
        timeout = httpx.Timeout(5.0, connect=2.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            while not self.stopping.is_set() or not self.queue.empty():
                try:
                    first = await asyncio.wait_for(self.queue.get(), timeout=0.25)
                except asyncio.TimeoutError:
                    continue
                batch = [first]
                while len(batch) < MAX_BATCH_SIZE:
                    try:
                        batch.append(await asyncio.wait_for(self.queue.get(), timeout=0.35))
                    except asyncio.TimeoutError:
                        break
                if await self._post(client, batch):
                    metrics.recording_samples_uploaded += len(batch)
                for _ in batch:
                    self.queue.task_done()

    def stop(self) -> None:
        self.stopping.set()
