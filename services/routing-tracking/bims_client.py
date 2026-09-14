"""Small client for Busan's official BIMS OpenAPI service.

The collector project has a larger version of this client.  The web app keeps
the small read-only subset it needs locally so the app can be deployed
without importing code from the sibling collector directory.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any, Iterable

DEFAULT_LINES = ("126", "103", "3006", "1001", "111-1", "131", "33")
DEFAULT_BASE_URL = "https://apis.data.go.kr/6260000/BusanBIMS"
ROUTE_LOOKUP_OPERATION = "busInfo"
LOCATION_OPERATION = "busInfoByRouteId"

CSV_FIELDS = (
    "observed_at_utc",
    "collection_session_id",
    "logical_trace_id",
    "line_number",
    "line_id",
    "vehicle_id",
    "longitude",
    "latitude",
    "speed_kmh",
    "direction",
    "api_direction_code",
    "gps_time",
    "low_plate",
    "stop_index",
    "route_stop_count",
    "route_point",
    "point_class",
    "continuation_from_vehicle_id",
)


class BimsApiError(RuntimeError):
    """An API, authentication, or response-format error."""


class BimsQuotaExceededError(BimsApiError):
    """The data.go.kr daily quota for the service key has been exhausted."""


class BimsAuthenticationError(BimsApiError):
    """The service key is missing, invalid, expired, or unauthorized."""


_QUOTA_EXCEEDED_MARKERS = (
    "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
    'returnReasonCode":"22"',
    'returnReasonCode": "22"',
)


@dataclass(frozen=True)
class Route:
    line_number: str
    line_id: str


def _normal_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _normal_line(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "")).strip().upper()


def _first_field(item: dict[str, Any], *names: str) -> Any:
    fields = {_normal_key(key): value for key, value in item.items()}
    for name in names:
        value = fields.get(_normal_key(name))
        if value is not None and str(value).strip() != "":
            return value
    return None


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(str(value).strip().replace(",", ""))
    except (TypeError, ValueError):
        return None


def _xml_items(raw: bytes) -> dict[str, Any]:
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise BimsApiError("BIMS returned unreadable XML data") from exc

    def local_name(tag: str) -> str:
        return tag.rsplit("}", 1)[-1]

    result_code = None
    result_message = None
    pagination: dict[str, str] = {}
    items: list[dict[str, str]] = []
    for node in root.iter():
        name = local_name(node.tag)
        if name in {"resultCode", "returnReasonCode"} and node.text:
            result_code = node.text.strip()
        elif name in {"resultMsg", "returnAuthMsg", "errMsg"} and node.text:
            result_message = node.text.strip()
        elif name in {"totalCount", "pageNo", "numOfRows"} and node.text:
            pagination[name] = node.text.strip()
        elif name == "item":
            item = {
                local_name(child.tag): (child.text or "").strip()
                for child in list(node)
            }
            if item:
                items.append(item)
    return {
        "response": {
            "header": {"resultCode": result_code, "resultMsg": result_message},
            "body": {"items": {"item": items}, **pagination},
        }
    }


def _find_field_recursive(node: Any, wanted: str) -> Any:
    if isinstance(node, dict):
        for key, value in node.items():
            if _normal_key(key) == _normal_key(wanted):
                return value
            found = _find_field_recursive(value, wanted)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _find_field_recursive(value, wanted)
            if found is not None:
                return found
    return None


def _success_code(value: Any) -> bool:
    if value is None:
        return True
    code = str(value).strip().upper()
    return code in {"00", "000", "0000", "NORMAL_CODE"} or code.endswith("-000")


def _check_api_response(payload: Any) -> None:
    code = _find_field_recursive(payload, "resultCode")
    if code is None:
        code = _find_field_recursive(payload, "returnReasonCode")
    if not _success_code(code):
        message = (_find_field_recursive(payload, "resultMsg")
                   or _find_field_recursive(payload, "returnAuthMsg") or "unknown API error")
        numeric_code = str(code).strip().lstrip("0")
        if numeric_code == "22" or "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR" in str(message):
            raise BimsQuotaExceededError(f"BIMS daily request quota exceeded ({code})")
        if numeric_code in {"20", "30", "31"}:
            raise BimsAuthenticationError(f"BIMS authentication failed ({code}); check the service key and service approval")
        raise BimsApiError(f"BIMS API error {code}: {message}")


def _build_url(endpoint: str, service_key: str, params: dict[str, Any]) -> str:
    # A key copied from data.go.kr may already contain percent escapes.  Keep
    # those escapes intact, but encode raw plus signs and other delimiters.
    encoded_key = urllib.parse.quote(service_key.strip(), safe="%")
    query = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    separator = "&" if "?" in endpoint else "?"
    return f"{endpoint}{separator}serviceKey={encoded_key}&{query}"


def _request_json(
    endpoint: str,
    service_key: str,
    params: dict[str, Any],
    *,
    timeout: float,
    retries: int,
) -> Any:
    request = urllib.request.Request(
        _build_url(endpoint, service_key, params),
        headers={
            "Accept": "application/json, application/xml;q=0.9, */*;q=0.1",
            "User-Agent": "busan-bus-route-explorer/1.0",
        },
    )
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
            try:
                payload = json.loads(raw.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload = _xml_items(raw)
            _check_api_response(payload)
            return payload
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            body = raw.decode("utf-8", errors="replace")
            message = f"HTTP {exc.code} from {endpoint}"
            if any(marker in body for marker in _QUOTA_EXCEEDED_MARKERS):
                raise BimsQuotaExceededError(message) from exc
            try:
                try:
                    error_payload = json.loads(body)
                except json.JSONDecodeError:
                    error_payload = _xml_items(raw)
                _check_api_response(error_payload)
            except (BimsQuotaExceededError, BimsAuthenticationError):
                raise
            except BimsApiError:
                pass
            if exc.code in {401, 403}:
                raise BimsAuthenticationError(message) from exc
            last_error = BimsApiError(message)
        except urllib.error.URLError as exc:
            last_error = BimsApiError(f"network error reaching {endpoint}: {exc.reason}")
        except (BimsQuotaExceededError, BimsAuthenticationError):
            raise
        except (BimsApiError, TimeoutError) as exc:
            last_error = exc
        if attempt < retries:
            time.sleep(min(2.0**attempt, 8.0))
    assert last_error is not None
    raise last_error


def _iter_dicts(node: Any) -> Iterable[dict[str, Any]]:
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _iter_dicts(value)
    elif isinstance(node, list):
        for value in node:
            yield from _iter_dicts(value)


def _extract_items(payload: Any) -> list[dict[str, Any]]:
    """Extract records from JSON wrappers used by BIMS and data.go.kr."""

    items: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if _normal_key(key) in {"item", "items"}:
                    if isinstance(value, dict):
                        candidate = value.get("item", value)
                        if isinstance(candidate, dict):
                            items.append(candidate)
                        elif isinstance(candidate, list):
                            items.extend(item for item in candidate if isinstance(item, dict))
                    elif isinstance(value, list):
                        items.extend(item for item in value if isinstance(item, dict))
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(payload)
    if not items:
        for candidate in _iter_dicts(payload):
            if any(_first_field(candidate, name) is not None for name in (
                "lineid", "lineno", "lin", "lat", "carno",
            )):
                items.append(candidate)

    unique: list[dict[str, Any]] = []
    seen: set[int] = set()
    for item in items:
        if id(item) not in seen:
            seen.add(id(item))
            unique.append(item)
    return unique


def _resolve_route(
    line_number: str,
    service_key: str,
    base_url: str,
    *,
    timeout: float,
    retries: int,
) -> Route:
    payload = _request_json(
        f"{base_url.rstrip('/')}/{ROUTE_LOOKUP_OPERATION}",
        service_key,
        {"lineno": line_number, "numOfRows": 100, "pageNo": 1, "resultType": "json"},
        timeout=timeout,
        retries=retries,
    )
    records = _extract_items(payload)
    requested = _normal_line(line_number)
    candidates: list[tuple[str, dict[str, Any]]] = []
    for record in records:
        line_id = _first_field(record, "lineid", "lineId", "routeid", "routeId")
        if line_id is not None:
            candidates.append((str(line_id).strip(), record))
    exact = [item for item in candidates if _normal_line(
        _first_field(item[1], "buslinenum", "busLineNum", "lineno", "lineNo", "lineNumber")
    ) == requested]
    selected = exact or candidates
    if not selected:
        raise BimsApiError(
            f"no BIMS lineid was returned for public line {line_number!r}"
        )
    return Route(line_number=line_number, line_id=sorted({value for value, _ in selected})[0])


def _parse_vehicle(record: dict[str, Any], row_number: int = 0) -> dict[str, Any] | None:
    longitude = _number(_first_field(record, "lin", "gpsx", "gpsX", "longitude", "lon", "x"))
    latitude = _number(_first_field(record, "lat", "gpsy", "gpsY", "latitude", "y"))
    if longitude is None or latitude is None or not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        return None

    vehicle = _first_field(record, "carno", "carNo", "vehicleNo", "vehicleId", "busNo", "busId")
    vehicle_id = str(vehicle).strip() if vehicle is not None else ""
    # Route-stop records can contain coordinates but never have a vehicle id.
    if not vehicle_id:
        return None
    return {
        "vehicle_key": vehicle_id,
        "vehicle_id": vehicle_id,
        "longitude": longitude,
        "latitude": latitude,
        "speed_kmh": _number(_first_field(record, "speed", "speedKmh", "speedKMH", "speed_kmh")),
        "direction": _first_field(record, "direction", "dir") or "",
        "api_direction_code": _first_field(record, "direction", "dir") or "",
        "gps_time": _first_field(record, "gpsym", "gpsTime", "gps_time") or "",
        "low_plate": _first_field(record, "lowplate", "lowPlate") or "",
        "stop_index": _number(_first_field(record, "bstopidx", "stopIndex")),
        "route_point": _first_field(record, "rpoint", "routePoint") or "",
    }


def _payload_vehicles(route: Route, payload: Any) -> list[dict[str, Any]]:
    records = _extract_items(payload)
    stop_indexes = [
        value for record in records
        if (value := _number(_first_field(record, "bstopidx", "stopIndex"))) is not None
    ]
    route_count = max(stop_indexes, default=None)
    turnaround_indexes = []
    for record in records:
        marker = str(_first_field(record, "rpoint", "routePoint") or "").strip().lower()
        index = _number(_first_field(record, "bstopidx", "stopIndex"))
        if index is not None and marker not in {"", "0", "false", "n", "no"}:
            turnaround_indexes.append(index)
    turnaround = min(turnaround_indexes, default=None)

    vehicles = []
    for row_number, record in enumerate(records):
        vehicle = _parse_vehicle(record, row_number)
        if vehicle is None:
            continue
        stop_index = vehicle.get("stop_index")
        if turnaround and stop_index is not None:
            route_direction = "outbound" if stop_index <= turnaround else "inbound"
            direction_start = 1 if route_direction == "outbound" else turnaround
            direction_end = turnaround if route_direction == "outbound" else route_count
        else:
            route_direction = "full_route"
            direction_start = 1
            direction_end = route_count
        vehicle.update({
            "line_number": route.line_number,
            "line_id": route.line_id,
            "route_stop_count": route_count,
            "turnaround_stop_index": turnaround,
            "route_direction": route_direction,
            "direction_start_index": direction_start,
            "direction_end_index": direction_end,
        })
        vehicles.append(vehicle)
    return vehicles
