"""Generic telemetry contracts around the preserved BIMS tracking engine."""
from __future__ import annotations

import csv
import json
import urllib.request
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


DEVICE_TELEMETRY_SOURCES = frozenset({"DEVICE_GPS", "RECORDED_GPS"})


def _fetch_json(url: str, timeout: float) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 - internal loopback URL
        return json.loads(response.read().decode("utf-8"))


class DeviceRelaySource:
    """Current Android/device positions from the media relay.

    The relay has already validated identity; this source only normalizes the
    snapshot. `external_id` (``device:<vehicleId>``) is a tracking-contract key,
    never a BIMS identity - the real vehicle/trip/session ids stay in
    ``source_metadata``. A relay outage degrades to a warning so BIMS tracking
    keeps working.
    """

    def __init__(self, base_url: str, timeout: float = 1.0, fetch=_fetch_json):
        self.url = base_url.rstrip("/") + "/internal/telemetry/vehicles"
        self.timeout = timeout
        self.fetch = fetch

    def snapshot(self) -> dict:
        try:
            raw = self.fetch(self.url, self.timeout)
        except (OSError, ValueError) as exc:
            return {
                "generated_at_utc": None,
                "vehicles": [],
                "warnings": [{"source": "device_relay", "message": f"media relay telemetry unavailable: {exc}"}],
            }
        observations = []
        for item in raw.get("vehicles", []) or []:
            if item.get("telemetry_source") not in DEVICE_TELEMETRY_SOURCES:
                continue
            metadata = item.get("source_metadata") or {}
            if not metadata.get("vehicleId") or not metadata.get("recordingSessionId"):
                continue
            try:
                observations.append(asdict(TelemetryObservation(
                    external_id=str(item["external_id"]),
                    latitude=float(item["latitude"]),
                    longitude=float(item["longitude"]),
                    telemetry_source=item["telemetry_source"],
                    observed_at_utc=item.get("observed_at_utc"),
                    speed_kmh=item.get("speed_kmh"),
                    heading_deg=item.get("heading_deg"),
                    route_progress_pct=None,
                    source_metadata=dict(metadata),
                )))
            except (KeyError, TypeError, ValueError):
                continue
        return {"generated_at_utc": raw.get("generated_at_utc"), "vehicles": observations, "warnings": list(raw.get("warnings", []) or [])}


class CompositeTelemetrySource:
    """BIMS observations plus device observations in one snapshot.

    The primary (BIMS) source's generation time is kept. Device observations are
    de-duplicated by vehicleId + recordingSessionId; BIMS observations are never
    suppressed because device vehicles carry their own identities.
    """

    def __init__(self, primary: TelemetrySource, *secondary: TelemetrySource):
        self.sources = (primary, *secondary)

    def snapshot(self) -> dict:
        vehicles: list[dict] = []
        warnings: list = []
        generated_at = None
        device_index: dict[tuple, int] = {}
        for position, source in enumerate(self.sources):
            result = source.snapshot()
            if position == 0:
                generated_at = result.get("generated_at_utc")
            warnings.extend(result.get("warnings", []) or [])
            for vehicle in result.get("vehicles", []) or []:
                if vehicle.get("telemetry_source") in DEVICE_TELEMETRY_SOURCES:
                    metadata = vehicle.get("source_metadata") or {}
                    key = (metadata.get("vehicleId"), metadata.get("recordingSessionId"))
                    if key in device_index:
                        vehicles[device_index[key]] = vehicle
                        continue
                    device_index[key] = len(vehicles)
                vehicles.append(vehicle)
        return {"generated_at_utc": generated_at, "vehicles": vehicles, "warnings": warnings}


class VehicleTracker:
    def __init__(self, source: TelemetrySource):
        self.source = source

    def snapshot(self) -> dict:
        return self.source.snapshot()
