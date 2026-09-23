"""Vehicle-runtime BoT-SORT adapter with one shared sparseOptFlow warp."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np


GROUPS = ("person", "two_wheeler", "vehicle")
CLASS_GROUPS = {
    "person": "person",
    "bicycle": "two_wheeler",
    "motorcycle": "two_wheeler",
    "car": "vehicle",
    "truck": "vehicle",
    "bus": "vehicle",
}


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

        self._gmc = GMC(method="sparseOptFlow")
        self._frame_id = 0
        self._identities: dict[tuple[str, int], int] = {}
        self._class_ids: dict[str, int] = {}

    def reset(self) -> None:
        for backend in self._backends.values():
            backend.reset()
            backend.runtime_warp = None
        self._gmc.reset_params()
        self._frame_id = 0
        self._identities.clear()
        self._class_ids.clear()

    def update(self, frame: np.ndarray, rows: list[dict[str, Any]]) -> list[int | None]:
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

        warp = self._gmc.apply(frame)
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
