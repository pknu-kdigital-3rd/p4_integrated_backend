"""Live Busan bus positions with route-constrained historical interpolation.

Each configured public line keeps one selected vehicle, matching the
collector's one-bus-per-line data model.  BIMS fixes are used directly while
fresh.  Between updates, the selected vehicle is advanced through the
pre-collected trace at one-second resolution; if the live feed is stale for
longer than the configured threshold, that historical position remains the
source of truth until BIMS supplies another fix.
"""

from __future__ import annotations

import bisect
import csv
import json
import math
import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bims_client import (
    BimsQuotaExceededError,
    CSV_FIELDS as RAW_FIELDS,
    DEFAULT_BASE_URL,
    DEFAULT_LINES,
    LOCATION_OPERATION,
    Route,
    _extract_items,
    _first_field,
    _number,
    _payload_vehicles,
    _request_json,
    _resolve_route,
)


HYBRID_FIELDS = (
    "emitted_at_utc",
    "line_number",
    "line_id",
    "vehicle_id",
    "longitude",
    "latitude",
    "speed_kmh",
    "direction",
    "source",
    "live_observed_at_utc",
    "live_age_s",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _normal_line(value: Any) -> str:
    return "".join(str(value or "").split()).upper()


def _normal_direction(value: Any) -> str:
    raw = str(value or "").strip().lower()
    if raw in {"out", "outbound"}:
        return "outbound"
    if raw in {"in", "inbound"}:
        return "inbound"
    if raw in {"full_route", "full-route", "full route"}:
        return "full_route"
    # Numeric values in older CSVs are BIMS API direction codes, not the
    # collector's derived route direction.  Do not mistake 1/2 for inbound.
    return "full_route" if raw else ""


@dataclass(frozen=True)
class HistoryPoint:
    trace_time_s: float
    lat: float
    lon: float
    speed_kmh: float | None
    stop_index: float | None
    route_progress_pct: float | None = None


def _parse_datetime(value: Any) -> datetime | None:
    try:
        result = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return result if result.tzinfo else result.replace(tzinfo=timezone.utc)


def _valid_point(row: dict[str, Any]) -> tuple[float, float] | None:
    try:
        lat = float(row.get("latitude", ""))
        lon = float(row.get("longitude", ""))
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def load_history(path: Path) -> dict[tuple[str, str], list[HistoryPoint]]:
    """Load either prepared one-second history or the collector's raw CSV.

    The sibling collector writes the prepared file only after a complete
    trip.  Accepting its raw schema as well makes the web app useful while a
    collection is still being built, and avoids silently fabricating a trace.
    For raw data, the longest coherent logical trace is retained per
    line/direction.
    """

    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as source:
            rows = list(csv.DictReader(source))
    except (OSError, csv.Error):
        return {}
    if not rows:
        return {}

    prepared = "trace_time_s" in (rows[0].keys() if rows else {})
    groups: dict[tuple[str, str, str], list[HistoryPoint]] = {}
    raw_times: dict[tuple[str, str, str], list[datetime]] = {}
    for row in rows:
        line = _normal_line(row.get("line_number"))
        position = _valid_point(row)
        if not line or position is None:
            continue
        if not prepared:
            point_class = (row.get("point_class") or "changed").strip().lower()
            if point_class == "duplicate" or point_class.startswith("rejected"):
                continue
        direction = _normal_direction(row.get("direction"))
        trace_id = (
            (row.get("logical_trace_id") or "").strip()
            or (row.get("vehicle_id") or "").strip()
            or "legacy"
        )
        key = (line, direction, trace_id)
        lat, lon = position
        speed = _number(row.get("speed_kmh"))
        stop_index = _number(row.get("stop_index"))
        progress = _number(row.get("route_progress_pct"))
        route_stop_count = _number(row.get("route_stop_count"))
        if progress is None and stop_index is not None and route_stop_count:
            progress = max(0.0, min(100.0, stop_index / route_stop_count * 100.0))
        if prepared:
            trace_time = _number(row.get("trace_time_s"))
            if trace_time is None:
                continue
            groups.setdefault(key, []).append(
                HistoryPoint(trace_time, lat, lon, speed, stop_index, progress)
            )
        else:
            observed = _parse_datetime(row.get("observed_at_utc"))
            if observed is None:
                continue
            raw_times.setdefault(key, []).append(observed)
            groups.setdefault(key, []).append(
                HistoryPoint(0.0, lat, lon, speed, stop_index, progress)
            )

    # Convert raw wall-clock observations to a relative playback clock, then
    # remove duplicate/non-monotonic samples caused by polling retries.
    if not prepared:
        rebuilt: dict[tuple[str, str, str], list[HistoryPoint]] = {}
        for key, points in groups.items():
            times = raw_times[key]
            paired = sorted(zip(times, points), key=lambda item: item[0])
            if not paired:
                continue
            start = paired[0][0]
            ordered: list[HistoryPoint] = []
            previous_t = -1.0
            for timestamp, point in paired:
                trace_time = (timestamp - start).total_seconds()
                if trace_time <= previous_t:
                    continue
                ordered.append(
                    HistoryPoint(
                        trace_time,
                        point.lat,
                        point.lon,
                        point.speed_kmh,
                        point.stop_index,
                        point.route_progress_pct,
                    )
                )
                previous_t = trace_time
            rebuilt[key] = ordered
        groups = rebuilt

    # Choose one actual trip per line/direction.  This is the same semantic
    # as the collector's selected complete trace, and prevents a fallback
    # from jumping between unrelated buses or repeated runs.
    selected: dict[tuple[str, str], tuple[tuple[float, int], list[HistoryPoint]]] = {}
    for (line, direction, _trace), points in groups.items():
        ordered = sorted(points, key=lambda item: item.trace_time_s)
        if len(ordered) < 2:
            continue
        score = (ordered[-1].trace_time_s - ordered[0].trace_time_s, len(ordered))
        key = (line, direction)
        if key not in selected or score > selected[key][0]:
            selected[key] = (score, ordered)
    return {key: points for key, (_score, points) in selected.items()}


def load_route_ids(path: Path) -> dict[str, str]:
    """Read the collector's cached public-line -> BIMS-lineid mapping."""

    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    routes = raw.get("routes", {}) if isinstance(raw, dict) else {}
    if not isinstance(routes, dict):
        return {}
    result = {}
    for line, value in routes.items():
        if isinstance(value, dict) and value.get("line_id"):
            result[_normal_line(line)] = str(value["line_id"])
    return result


def _lerp(first: HistoryPoint, second: HistoryPoint, ratio: float) -> HistoryPoint:
    ratio = max(0.0, min(1.0, ratio))
    return HistoryPoint(
        first.trace_time_s + (second.trace_time_s - first.trace_time_s) * ratio,
        first.lat + (second.lat - first.lat) * ratio,
        first.lon + (second.lon - first.lon) * ratio,
        None if first.speed_kmh is None and second.speed_kmh is None else (
            (first.speed_kmh if first.speed_kmh is not None else second.speed_kmh) * (1 - ratio)
            + (second.speed_kmh if second.speed_kmh is not None else first.speed_kmh) * ratio
        ),
        None if first.stop_index is None and second.stop_index is None else (
            (first.stop_index if first.stop_index is not None else second.stop_index) * (1 - ratio)
            + (second.stop_index if second.stop_index is not None else first.stop_index) * ratio
        ),
        None if first.route_progress_pct is None and second.route_progress_pct is None else (
            (first.route_progress_pct if first.route_progress_pct is not None else second.route_progress_pct) * (1 - ratio)
            + (second.route_progress_pct if second.route_progress_pct is not None else first.route_progress_pct) * ratio
        ),
    )


def _point_at(points: list[HistoryPoint], trace_time_s: float) -> HistoryPoint:
    if trace_time_s <= points[0].trace_time_s:
        return points[0]
    if trace_time_s >= points[-1].trace_time_s:
        return points[-1]
    times = [point.trace_time_s for point in points]
    index = bisect.bisect_right(times, trace_time_s)
    first, second = points[index - 1], points[index]
    span = second.trace_time_s - first.trace_time_s
    return _lerp(first, second, 0.0 if span <= 0 else (trace_time_s - first.trace_time_s) / span)


def _project_to_trace(points: list[HistoryPoint], lat: float, lon: float) -> tuple[HistoryPoint, float]:
    """Return the closest point on the recorded route trace and its distance.

    Equirectangular meters are accurate enough over a single Busan bus
    segment and avoid introducing a GIS dependency into the web app.
    """

    if len(points) == 1:
        point = points[0]
        distance = math.hypot((point.lat - lat) * 111_000, (point.lon - lon) * 91_000)
        return point, distance
    cos_lat = math.cos(math.radians(lat))
    best_point = points[0]
    best_distance_sq = float("inf")
    for first, second in zip(points, points[1:]):
        scale_x = 111_000.0
        scale_y = max(1.0, 111_000.0 * cos_lat)
        ax, ay = (first.lon - lon) * scale_y, (first.lat - lat) * scale_x
        bx, by = (second.lon - lon) * scale_y, (second.lat - lat) * scale_x
        dx, dy = bx - ax, by - ay
        denominator = dx * dx + dy * dy
        ratio = 0.0 if denominator == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / denominator))
        candidate = _lerp(first, second, ratio)
        distance_sq = ((candidate.lon - lon) * scale_y) ** 2 + ((candidate.lat - lat) * scale_x) ** 2
        if distance_sq < best_distance_sq:
            best_distance_sq = distance_sq
            best_point = candidate
    return best_point, math.sqrt(best_distance_sq)


@dataclass
class BusState:
    line_number: str
    line_id: str = ""
    selected_vehicle: str | None = None
    direction: str = ""
    live_lat: float | None = None
    live_lon: float | None = None
    speed_kmh: float | None = None
    gps_time: str = ""
    last_signature: tuple[Any, ...] | None = None
    live_received_mono: float | None = None
    live_observed_at_utc: str | None = None
    last_api_seen_mono: float | None = None
    current_lat: float | None = None
    current_lon: float | None = None
    current_progress_pct: float | None = None
    source: str = "waiting"
    warning: str | None = None
    fallback_key: tuple[str, str] | None = None
    fallback_trace_time_s: float | None = None
    fallback_started_mono: float | None = None
    reconcile_started_mono: float | None = None
    reconcile_from: tuple[float, float] | None = None
    reconcile_to: tuple[float, float] | None = None


class HybridBusService:
    def __init__(
        self,
        *,
        service_key: str | None,
        history_path: Path,
        output_path: Path,
        raw_path: Path,
        lines: tuple[str, ...] = DEFAULT_LINES,
        base_url: str = DEFAULT_BASE_URL,
        line_ids: dict[str, str] | None = None,
        poll_interval_s: float = 5.0,
        emit_interval_s: float = 1.0,
        stale_after_s: float = 15.0,
        reconcile_s: float = 3.0,
        request_timeout_s: float = 10.0,
        max_alignment_m: float = 300.0,
    ):
        self.service_key = service_key
        self.history_path = history_path
        self.output_path = output_path
        self.raw_path = raw_path
        self.lines = tuple(lines)
        self.base_url = base_url
        self.line_ids = {_normal_line(key): str(value) for key, value in (line_ids or {}).items()}
        self.poll_interval_s = max(1.0, poll_interval_s)
        self.emit_interval_s = max(0.2, emit_interval_s)
        self.stale_after_s = max(0.0, stale_after_s)
        self.reconcile_s = max(0.1, reconcile_s)
        self.request_timeout_s = max(1.0, request_timeout_s)
        self.max_alignment_m = max(1.0, max_alignment_m)
        self.histories = load_history(history_path)
        self.states = {line: BusState(line_number=line) for line in self.lines}
        self._snapshot: dict[str, Any] = {"generated_at_utc": None, "vehicles": [], "warnings": []}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._started_at: str | None = None
        self._last_poll_at: str | None = None
        self._sample_count = 0

    @classmethod
    def from_environment(
        cls,
        *,
        service_key: str | None,
        history_path: Path,
        output_path: Path,
        raw_path: Path,
        line_ids_json: str = "",
        line_ids: dict[str, str] | None = None,
        lines: tuple[str, ...] = DEFAULT_LINES,
    ) -> "HybridBusService":
        resolved_line_ids: dict[str, str] = {
            _normal_line(key): str(value)
            for key, value in (line_ids or {}).items()
            if str(value).strip()
        }
        if line_ids_json:
            try:
                value = json.loads(line_ids_json)
                if isinstance(value, dict):
                    resolved_line_ids.update({
                        _normal_line(key): str(item)
                        for key, item in value.items()
                        if str(item).strip()
                    })
            except json.JSONDecodeError:
                pass
        for env_name, env_default in (
            ("BUSAN_BUS_POLL_INTERVAL_S", 5.0),
            ("BUSAN_BUS_EMIT_INTERVAL_S", 1.0),
            ("BUSAN_BUS_STALE_AFTER_S", 15.0),
            ("BUSAN_BUS_RECONCILE_S", 3.0),
        ):
            try:
                value = float(os.environ.get(env_name, env_default))
            except (TypeError, ValueError):
                value = env_default
            if env_name == "BUSAN_BUS_POLL_INTERVAL_S":
                poll_interval_s = value
            elif env_name == "BUSAN_BUS_EMIT_INTERVAL_S":
                emit_interval_s = value
            elif env_name == "BUSAN_BUS_STALE_AFTER_S":
                stale_after_s = value
            else:
                reconcile_s = value
        configured_lines = tuple(
            _normal_line(value)
            for value in os.environ.get("BUSAN_BUS_LINES", "").split(",")
            if _normal_line(value)
        ) or lines
        return cls(
            service_key=service_key,
            history_path=history_path,
            output_path=output_path,
            raw_path=raw_path,
            lines=configured_lines,
            line_ids=resolved_line_ids,
            poll_interval_s=poll_interval_s,
            emit_interval_s=emit_interval_s,
            stale_after_s=stale_after_s,
            reconcile_s=reconcile_s,
        )

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._started_at = utc_now()
        self._thread = threading.Thread(target=self._run, name="hybrid-bus-service", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=self.request_timeout_s + 2)

    def info(self) -> dict[str, Any]:
        with self._lock:
            return {
                "available": bool(self.service_key),
                "started_at_utc": self._started_at,
                "last_poll_at_utc": self._last_poll_at,
                "poll_interval_s": self.poll_interval_s,
                "output_interval_s": self.emit_interval_s,
                "stale_after_s": self.stale_after_s,
                "reconcile_s": self.reconcile_s,
                "history_path": str(self.history_path),
                "history_lines": sorted({key[0] for key in self.histories}),
                "sample_count": self._sample_count,
                "lines": [
                    {
                        "line_number": line,
                        "line_id": state.line_id or None,
                        "vehicle_id": state.selected_vehicle,
                        "history_ready": any(key[0] == line for key in self.histories),
                        "status": state.source,
                        "warning": state.warning,
                    }
                    for line, state in self.states.items()
                ],
            }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "generated_at_utc": self._snapshot["generated_at_utc"],
                "vehicles": [dict(vehicle) for vehicle in self._snapshot["vehicles"]],
                "warnings": list(self._snapshot["warnings"]),
            }

    def _resolve_routes(self, executor: ThreadPoolExecutor) -> None:
        if not self.service_key:
            with self._lock:
                for state in self.states.values():
                    state.warning = "BUSAN_BIMS_SERVICE_KEY is not configured"
            return
        futures: dict[Future, str] = {}
        for line in self.lines:
            if line in self.line_ids:
                with self._lock:
                    self.states[line].line_id = self.line_ids[line]
                continue
            futures[executor.submit(
                _resolve_route,
                line,
                self.service_key,
                self.base_url,
                timeout=self.request_timeout_s,
                retries=1,
            )] = line
        for future, line in futures.items():
            try:
                route = future.result(timeout=self.request_timeout_s + 3)
            except Exception as exc:
                with self._lock:
                    self.states[line].warning = f"route lookup failed: {exc}"
            else:
                with self._lock:
                    self.states[line].line_id = route.line_id
                    self.states[line].warning = None

    def _fetch_line(self, route: Route) -> Any:
        return _request_json(
            f"{self.base_url.rstrip('/')}/{LOCATION_OPERATION}",
            self.service_key or "",
            {"lineid": route.line_id, "numOfRows": 100, "pageNo": 1, "resultType": "json"},
            timeout=self.request_timeout_s,
            retries=0,
        )

    def _run(self) -> None:
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.raw_path.parent.mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(max_workers=max(2, len(self.lines))) as executor:
            self._resolve_routes(executor)
            pending: dict[str, Future] = {}
            next_poll = time.monotonic()
            next_emit = time.monotonic()
            while not self._stop.is_set():
                now = time.monotonic()
                if self.service_key and now >= next_poll:
                    for line, state in self.states.items():
                        if state.line_id and line not in pending:
                            pending[line] = executor.submit(
                                self._fetch_line,
                                Route(line_number=line, line_id=state.line_id),
                            )
                    with self._lock:
                        self._last_poll_at = utc_now()
                    next_poll = now + self.poll_interval_s

                for line, future in list(pending.items()):
                    if not future.done():
                        continue
                    pending.pop(line)
                    try:
                        self._accept_payload(line, future.result(), time.monotonic())
                    except BimsQuotaExceededError as exc:
                        with self._lock:
                            self.states[line].warning = f"live API quota exhausted: {exc}"
                    except Exception as exc:
                        with self._lock:
                            self.states[line].warning = f"live API: {exc}"

                if now >= next_emit:
                    self._emit(now)
                    next_emit = now + self.emit_interval_s
                self._stop.wait(0.05)

    def _accept_payload(self, line: str, payload: Any, now: float) -> None:
        state_for_route = self.states[line]
        records = _extract_items(payload)
        vehicles = _payload_vehicles(Route(line, state_for_route.line_id), payload)
        with self._lock:
            state = self.states[line]
            state.last_api_seen_mono = now
            if state.selected_vehicle is None and vehicles:
                state.selected_vehicle = sorted(vehicle["vehicle_id"] for vehicle in vehicles)[0]
            matches = [vehicle for vehicle in vehicles if vehicle["vehicle_id"] == state.selected_vehicle]
            if not matches:
                state.warning = "selected bus absent; waiting for live or historical interpolation"
                return
            vehicle = matches[0]
            signature = (
                str(vehicle.get("gps_time") or ""),
                round(vehicle["latitude"], 7),
                round(vehicle["longitude"], 7),
            )
            if signature == state.last_signature:
                return

            observed = utc_now()
            was_interpolated = state.source in {"interpolated", "reconciling"}
            state.last_signature = signature
            state.direction = _normal_direction(vehicle.get("route_direction")) or "full_route"
            state.live_lat = vehicle["latitude"]
            state.live_lon = vehicle["longitude"]
            state.speed_kmh = vehicle.get("speed_kmh")
            state.gps_time = str(vehicle.get("gps_time") or "")
            state.live_received_mono = now
            state.live_observed_at_utc = observed
            state.warning = None
            state.fallback_key = None
            state.fallback_trace_time_s = None
            state.fallback_started_mono = None

            if was_interpolated and state.current_lat is not None and state.current_lon is not None:
                target_lat, target_lon = state.live_lat, state.live_lon
                key, history = self._history_for(state)
                if history:
                    projected, distance = _project_to_trace(history, target_lat, target_lon)
                    if distance <= self.max_alignment_m:
                        target_lat, target_lon = projected.lat, projected.lon
                        state.current_progress_pct = projected.route_progress_pct
                state.reconcile_started_mono = now
                state.reconcile_from = (state.current_lat, state.current_lon)
                state.reconcile_to = (target_lat, target_lon)
                state.source = "reconciling"
            else:
                state.reconcile_started_mono = None
                state.current_lat = state.live_lat
                state.current_lon = state.live_lon
                state.current_progress_pct = None
                _key, history = self._history_for(state)
                if history:
                    projected, distance = _project_to_trace(history, state.live_lat, state.live_lon)
                    if distance <= self.max_alignment_m:
                        state.current_progress_pct = projected.route_progress_pct
                state.source = "live"
            self._append_raw(state, vehicle, records, observed)

    def _append_raw(self, state: BusState, vehicle: dict[str, Any], records: list[dict[str, Any]], observed: str) -> None:
        try:
            write_header = not self.raw_path.exists() or self.raw_path.stat().st_size == 0
            stop_indexes = [
                value for record in records
                if (value := _number(_first_field(record, "bstopidx", "stopIndex"))) is not None
            ]
            row = {
                "observed_at_utc": observed,
                "collection_session_id": "",
                "logical_trace_id": "",
                "line_number": state.line_number,
                "line_id": state.line_id,
                "vehicle_id": state.selected_vehicle or "",
                "longitude": f"{vehicle['longitude']:.7f}",
                "latitude": f"{vehicle['latitude']:.7f}",
                "speed_kmh": "" if vehicle.get("speed_kmh") is None else f"{vehicle['speed_kmh']:.2f}",
                "direction": vehicle.get("route_direction", "full_route"),
                "api_direction_code": vehicle.get("api_direction_code", vehicle.get("direction", "")),
                "gps_time": vehicle.get("gps_time", ""),
                "low_plate": vehicle.get("low_plate", ""),
                "stop_index": "" if vehicle.get("stop_index") is None else vehicle["stop_index"],
                "route_stop_count": "" if not stop_indexes else max(stop_indexes),
                "route_point": vehicle.get("route_point", ""),
                "point_class": "changed",
                "continuation_from_vehicle_id": "",
            }
            with self.raw_path.open("a", encoding="utf-8-sig", newline="") as target:
                writer = csv.DictWriter(target, fieldnames=RAW_FIELDS, extrasaction="ignore")
                if write_header:
                    writer.writeheader()
                writer.writerow(row)
        except OSError as exc:
            state.warning = f"could not persist live observation: {exc}"

    def _history_for(self, state: BusState) -> tuple[tuple[str, str] | None, list[HistoryPoint] | None]:
        direction = _normal_direction(state.direction)
        exact = self.histories.get((state.line_number, direction))
        if exact:
            return (state.line_number, direction), exact
        candidates = [
            (key, points) for key, points in self.histories.items()
            if key[0] == state.line_number
        ]
        if len(candidates) == 1:
            return candidates[0]
        # A legacy raw trace may be full_route while the live endpoint has
        # derived a direction.  Prefer it only when no exact trace exists.
        full = next(((key, points) for key, points in candidates if key[1] == "full_route"), None)
        return full or (None, None)

    def _begin_interpolation(self, state: BusState, now: float) -> bool:
        key, history = self._history_for(state)
        if not history or state.live_lat is None or state.live_lon is None:
            state.warning = "no collected route history for the current line/direction"
            state.source = "hidden"
            return False
        anchor, distance = _project_to_trace(history, state.live_lat, state.live_lon)
        if distance > self.max_alignment_m:
            state.warning = f"collected route is {round(distance)} m from the live fix"
            state.source = "hidden"
            return False
        state.fallback_key = key
        state.fallback_trace_time_s = anchor.trace_time_s
        state.fallback_started_mono = now
        state.current_lat = anchor.lat
        state.current_lon = anchor.lon
        state.current_progress_pct = anchor.route_progress_pct
        state.source = "interpolated"
        state.warning = None
        return True

    def _position_state(self, state: BusState, now: float) -> None:
        if state.reconcile_started_mono is not None and state.reconcile_from and state.reconcile_to:
            ratio = min(1.0, max(0.0, (now - state.reconcile_started_mono) / self.reconcile_s))
            state.current_lat = state.reconcile_from[0] + (state.reconcile_to[0] - state.reconcile_from[0]) * ratio
            state.current_lon = state.reconcile_from[1] + (state.reconcile_to[1] - state.reconcile_from[1]) * ratio
            state.source = "reconciling"
            if ratio >= 1:
                state.reconcile_started_mono = None
                state.reconcile_from = None
                state.reconcile_to = None
                state.source = "live"
            return

        if state.live_received_mono is None:
            state.source = "waiting"
            return
        age = max(0.0, now - state.live_received_mono)
        if age <= self.stale_after_s:
            state.current_lat = state.live_lat
            state.current_lon = state.live_lon
            state.source = "live"
            return
        if state.fallback_trace_time_s is None and not self._begin_interpolation(state, now):
            return
        history = self.histories.get(state.fallback_key or ())
        if not history or state.fallback_started_mono is None or state.fallback_trace_time_s is None:
            state.source = "hidden"
            return
        trace_time = state.fallback_trace_time_s + (now - state.fallback_started_mono)
        point = _point_at(history, trace_time)
        state.current_lat = point.lat
        state.current_lon = point.lon
        state.current_progress_pct = point.route_progress_pct
        state.speed_kmh = point.speed_kmh
        state.source = "interpolated"
        if trace_time >= history[-1].trace_time_s:
            state.warning = "collected route history ended during the live outage"

    def _emit(self, now: float) -> None:
        emitted = utc_now()
        vehicles = []
        warnings = []
        with self._lock:
            for state in self.states.values():
                self._position_state(state, now)
                if state.warning:
                    warnings.append({"line_number": state.line_number, "message": state.warning})
                if state.source in {"waiting", "hidden"} or state.current_lat is None or state.current_lon is None:
                    continue
                age = 0.0 if state.live_received_mono is None else max(0.0, now - state.live_received_mono)
                vehicles.append({
                    "line_number": state.line_number,
                    "line_id": state.line_id,
                    "vehicle_id": state.selected_vehicle,
                    "lat": state.current_lat,
                    "lon": state.current_lon,
                    "speed_kmh": state.speed_kmh,
                    "direction": state.direction,
                    "source": state.source,
                    "live_observed_at_utc": state.live_observed_at_utc,
                    "live_age_s": round(age, 1),
                    "route_progress_pct": state.current_progress_pct,
                })
            self._snapshot = {"generated_at_utc": emitted, "vehicles": vehicles, "warnings": warnings}
            if vehicles:
                self._append_hybrid(emitted, vehicles)
                self._sample_count += len(vehicles)

    def _append_hybrid(self, emitted: str, vehicles: list[dict[str, Any]]) -> None:
        try:
            write_header = not self.output_path.exists() or self.output_path.stat().st_size == 0
            with self.output_path.open("a", encoding="utf-8-sig", newline="") as target:
                writer = csv.DictWriter(target, fieldnames=HYBRID_FIELDS)
                if write_header:
                    writer.writeheader()
                for vehicle in vehicles:
                    writer.writerow({
                        "emitted_at_utc": emitted,
                        "line_number": vehicle["line_number"],
                        "line_id": vehicle["line_id"],
                        "vehicle_id": vehicle["vehicle_id"],
                        "longitude": f"{vehicle['lon']:.7f}",
                        "latitude": f"{vehicle['lat']:.7f}",
                        "speed_kmh": "" if vehicle["speed_kmh"] is None else f"{vehicle['speed_kmh']:.2f}",
                        "direction": vehicle["direction"],
                        "source": vehicle["source"],
                        "live_observed_at_utc": vehicle["live_observed_at_utc"] or "",
                        "live_age_s": vehicle["live_age_s"],
                    })
        except OSError:
            # Snapshot serving must continue even if persistence is temporarily
            # unavailable (for example, a read-only deployment volume).
            pass
