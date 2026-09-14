"""Generic telemetry contracts around the preserved BIMS tracking engine."""
from __future__ import annotations

import csv
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class TelemetryObservation:
    external_id: str
    latitude: float
    longitude: float
    telemetry_source: str
    observed_at_utc: str | None = None
    speed_kmh: float | None = None
    heading_deg: float | None = None
    route_progress_pct: float | None = None
    source_metadata: dict | None = None


class TelemetrySource(Protocol):
    def snapshot(self) -> dict: ...


class BimsLiveSource:
    """Compatibility adapter; HybridBusService remains behavior-authoritative."""

    def __init__(self, service):
        self.service = service

    def snapshot(self) -> dict:
        raw = self.service.snapshot()
        observations = []
        for item in raw.get("vehicles", []):
            external_id = str(item.get("vehicle_id") or f"line:{item['line_number']}")
            state = item.get("source", "live")
            telemetry_source = "BIMS_LIVE" if state in {"live", "reconciling"} else "BIMS_REPLAY"
            observations.append(asdict(TelemetryObservation(
                external_id=external_id,
                latitude=item["lat"],
                longitude=item["lon"],
                speed_kmh=item.get("speed_kmh"),
                telemetry_source=telemetry_source,
                observed_at_utc=item.get("live_observed_at_utc") or raw.get("generated_at_utc"),
                route_progress_pct=item.get("route_progress_pct"),
                source_metadata={"lineNumber": item.get("line_number"), "lineId": item.get("line_id"), "state": state},
            )))
        return {"generated_at_utc": raw.get("generated_at_utc"), "vehicles": observations, "warnings": raw.get("warnings", [])}


class BimsPlaybackSource:
    """Deterministic CSV source that never invokes a live BIMS client."""

    def __init__(self, path: Path):
        self.path = path

    def snapshot(self) -> dict:
        latest: dict[str, dict] = {}
        if self.path.exists():
            with self.path.open(encoding="utf-8-sig", newline="") as stream:
                for row in csv.DictReader(stream):
                    external_id = row.get("vehicle_id") or f"line:{row.get('line_number', 'unknown')}"
                    latest[external_id] = asdict(TelemetryObservation(
                        external_id=external_id,
                        latitude=float(row["latitude"]),
                        longitude=float(row["longitude"]),
                        speed_kmh=float(row["speed_kmh"]) if row.get("speed_kmh") else None,
                        telemetry_source="BIMS_REPLAY",
                        observed_at_utc=row.get("observed_at_utc") or row.get("emitted_at_utc"),
                        source_metadata={"lineNumber": row.get("line_number"), "lineId": row.get("line_id"), "state": "replay"},
                    ))
        return {"generated_at_utc": None, "vehicles": list(latest.values()), "warnings": []}


class VehicleTracker:
    def __init__(self, source: TelemetrySource):
        self.source = source

    def snapshot(self) -> dict:
        return self.source.snapshot()
