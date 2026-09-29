"""Vehicle-runtime BoT-SORT adapter with one shared sparseOptFlow warp."""
from __future__ import annotations

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from time import perf_counter
from types import SimpleNamespace
from typing import Any

import numpy as np

from app.core.settings import settings


GROUPS = ("person", "two_wheeler", "vehicle")
CLASS_GROUPS = {
    "person": "person",
    "bicycle": "two_wheeler",
    "motorcycle": "two_wheeler",
    "car": "vehicle",
    "truck": "vehicle",
    "bus": "vehicle",
}

_MASK_SMOOTH_POINTS = 32
_MASK_SMOOTH_ALPHA = 0.65
_MASK_CACHE_LIMIT = 256


def _resample_polygon(polygon: Any, point_count: int) -> np.ndarray | None:
    points = np.asarray(polygon, dtype=np.float32).reshape(-1, 2)
    if len(points) < 3 or not np.isfinite(points).all():
        return None
    closed = np.concatenate((points, points[:1]), axis=0)
    lengths = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    cumulative = np.concatenate(([0.0], np.cumsum(lengths)))
    perimeter = float(cumulative[-1])
    if perimeter <= 1e-8:
        return None
    targets = np.arange(point_count, dtype=np.float32) * (perimeter / point_count)
    return np.stack(
        [np.interp(targets, cumulative, closed[:, axis]) for axis in range(2)],
        axis=1,
    ).astype(np.float32)


def smooth_mask_polygon(
    previous: Any | None,
    current: Any,
    *,
    alpha: float = _MASK_SMOOTH_ALPHA,
    point_count: int = _MASK_SMOOTH_POINTS,
) -> np.ndarray:
    """Lightly blend same-track polygon outlines after perimeter resampling."""
    new = _resample_polygon(current, point_count)
    if new is None:
        return np.asarray(current, dtype=np.float32).reshape(-1, 2)
    old = _resample_polygon(previous, point_count) if previous is not None else None
    if old is None:
        return new

    # Contour extraction can start at any vertex and traverse either direction.
    # Align both outlines before blending so index shifts do not warp the mask.
    best = old
    best_cost = float("inf")
    for candidate in (old, old[::-1]):
        for shift in range(point_count):
            aligned = np.roll(candidate, shift, axis=0)
            delta = aligned - new
            cost = float(np.einsum("ij,ij->", delta, delta))
            if cost < best_cost:
                best, best_cost = aligned, cost
    return (best * (1.0 - alpha) + new * alpha).astype(np.float32)


def application_group(class_name: str) -> str | None:
    return CLASS_GROUPS.get(class_name.strip().casefold())


class _SharedWarpFactory:
    @staticmethod
    def build(config: dict[str, Any]):
        from ultralytics.trackers.bot_sort import BOTSORT

        class SharedWarpBOTSORT(BOTSORT):
            runtime_warp = None

            def _pre_first_associate(self, strack_pool, unconfirmed, img, results_high):
                if self.runtime_warp is None:
                    raise RuntimeError("shared sparseOptFlow warp was not supplied")
                from ultralytics.trackers.utils.stracks import multi_gmc

                multi_gmc(strack_pool, self.runtime_warp)
                multi_gmc(unconfirmed, self.runtime_warp)

        native = {
            "tracker_type": "botsort",
            "track_high_thresh": config["track_high_thresh"],
            "track_low_thresh": config["track_low_thresh"],
            "new_track_thresh": config["new_track_thresh"],
            "track_buffer": config["track_buffer"],
            "match_thresh": config["match_thresh"],
            "fuse_score": config["fuse_score"],
            "gmc_method": "sparseOptFlow",
            "proximity_thresh": config["proximity_thresh"],
            "appearance_thresh": config["appearance_thresh"],
            "with_reid": False,
            "model": "auto",
        }
        return SharedWarpBOTSORT(SimpleNamespace(**native))


class BotSortTracker:
    """Maintains independent person, two-wheeler and vehicle track pools."""

    def __init__(self) -> None:
        config = {
            "track_high_thresh": 0.25,
            "track_low_thresh": 0.10,
            "new_track_thresh": 0.25,
            "track_buffer": 30,
            "match_thresh": 0.8,
            "fuse_score": True,
            "proximity_thresh": 0.5,
            "appearance_thresh": 0.8,
        }
        self._backends = {group: _SharedWarpFactory.build(config) for group in GROUPS}
        from ultralytics.trackers.utils.gmc import GMC

        self._gmc = GMC(
            method="sparseOptFlow", downscale=settings.BOTSORT_GMC_DOWNSCALE
        )
        self._gmc.feature_params["maxCorners"] = settings.BOTSORT_GMC_MAX_CORNERS
        print(
            f"BoT-SORT GMC: downscale={self._gmc.downscale}; "
            f"max_corners={self._gmc.feature_params['maxCorners']}",
            flush=True,
        )
        self._gmc_lock = Lock()
        self._gmc_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="botsort-gmc")
        self.last_gmc_ms = 0.0
        self._frame_id = 0
        self._identities: dict[tuple[str, int], int] = {}
        self._class_ids: dict[str, int] = {}
        self._mask_polygons: OrderedDict[int, np.ndarray] = OrderedDict()

    def reset(self) -> None:
        for backend in self._backends.values():
            backend.reset()
            backend.runtime_warp = None
        with self._gmc_lock:
            self._gmc.reset_params()
        self.last_gmc_ms = 0.0
        self._frame_id = 0
        self._identities.clear()
        self._class_ids.clear()
        self._mask_polygons.clear()

    def smooth_mask(self, track_id: int, polygon: Any) -> np.ndarray:
        smoothed = smooth_mask_polygon(self._mask_polygons.get(track_id), polygon)
        self._mask_polygons[track_id] = smoothed
        self._mask_polygons.move_to_end(track_id)
        while len(self._mask_polygons) > _MASK_CACHE_LIMIT:
            self._mask_polygons.popitem(last=False)
        return smoothed

    def prepare_gmc(self, frame: np.ndarray):
        # Own the pixels while YOLO uses its input on another thread.
        return self._gmc_executor.submit(self._compute_gmc, frame.copy())

    def _compute_gmc(self, frame: np.ndarray):
        with self._gmc_lock:
            started = perf_counter()
            warp = self._gmc.apply(frame)
            return warp, (perf_counter() - started) * 1000

    def close(self) -> None:
        self._gmc_executor.shutdown(wait=True, cancel_futures=True)

    def update(
        self, frame: np.ndarray, rows: list[dict[str, Any]], *, gmc_result=None
    ) -> list[int | None]:
        from ultralytics.engine.results import Boxes

        assignments: list[int | None] = [None] * len(rows)
        eligible = [
            index
            for index, row in enumerate(rows)
            if application_group(row["class_name"]) is not None
        ]
        for index in eligible:
            class_name = rows[index]["class_name"]
            self._class_ids.setdefault(class_name, len(self._class_ids))

        values = np.empty((len(eligible), 6), dtype=np.float32)
        groups = []
        for local_index, row_index in enumerate(eligible):
            row = rows[row_index]
            values[local_index] = (
                *row["bbox"],
                row["confidence"],
                self._class_ids[row["class_name"]],
            )
            groups.append(application_group(row["class_name"]))

        warp, self.last_gmc_ms = (
            self._compute_gmc(frame) if gmc_result is None else gmc_result
        )
        group_values = np.asarray(groups)
        for group, backend in self._backends.items():
            indices = np.flatnonzero(group_values == group)
            backend.runtime_warp = warp
            tracked = backend.update(Boxes(values[indices], frame.shape[:2]), img=frame)
            for track in tracked:
                if len(track) != 8:
                    raise RuntimeError("unsupported installed BoT-SORT output schema")
                local_index = int(track[-1])
                if local_index < 0 or local_index >= len(indices) or track[-1] != local_index:
                    raise ValueError("invalid BoT-SORT detection index")
                row_index = eligible[int(indices[local_index])]
                key = group, int(track[4])
                assignments[row_index] = self._identities.setdefault(
                    key, len(self._identities) + 1
                )

        identities = [identity for identity in assignments if identity is not None]
        if len(identities) != len(set(identities)):
            raise ValueError("duplicate track ID in one frame")
        self._frame_id += 1
        return assignments
