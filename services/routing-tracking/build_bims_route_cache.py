"""Build a static BIMS stop catalog and enrich recorded route-stop metadata.

Uses only the Python standard library and the bundled BIMS client. Importing
this module does not start the app, load OSM, or issue requests.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote, unquote

from bims_client import (
    DEFAULT_BASE_URL, DEFAULT_LINES, BimsApiError, _check_api_response,
    _extract_items, _find_field_recursive, _request_json,
)

PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_ROUTES = PROJECT_DIR.parent / "busan_bus_gps_data_20260911" / "data" / "busan_bus_routes.json"
STOP_ENDPOINT = f"{DEFAULT_BASE_URL}/busStopList"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def identifier(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def ars_identifier(value: Any) -> str:
    value = identifier(value)
    return value.zfill(5) if value.isascii() and value.isdigit() else value


def integer(value: Any, field: str, minimum: int = 0) -> int:
    text = identifier(value)
    if not text.isascii() or not text.isdigit() or int(text) < minimum:
        raise ValueError(f"Invalid {field}: expected an integer >= {minimum}")
    return int(text)


def coordinates(stop: dict[str, Any]) -> tuple[float, float] | None:
    # Only busStopList's static coordinate fields are accepted here.
    try:
        lat, lon = float(stop["gpsy"]), float(stop["gpsx"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or lat == 0 or lon == 0:
        return None
    return lat, lon


def read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8-sig") as source:
        data = json.load(source)
    if not isinstance(data, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return data


def write_json(path: Path, data: dict[str, Any]) -> None:
    """Publish one complete JSON document atomically; preserve old file on failure."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as target:
            temporary = Path(target.name)
            json.dump(data, target, ensure_ascii=False, indent=2, allow_nan=False)
            target.write("\n")
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def load_routes(path: Path, lines: list[str]) -> dict[str, Any]:
    data = read_json(path)
    routes = data.get("routes")
    if not isinstance(routes, dict):
        raise ValueError("Route input must contain a routes object keyed by public line number")
    selected = {}
    for line in lines:
        route = routes.get(line)
        if not isinstance(route, dict) or not identifier(route.get("line_id")):
            raise ValueError(f"Missing route metadata/line_id for line {line}")
        if identifier(route.get("line_number", line)) != line:
            raise ValueError(f"Conflicting public line number for {line}")
        stops = route.get("stops")
        if not isinstance(stops, list) or not stops:
            raise ValueError(f"No ordered stops for line {line}")
        indexes = []
        for stop in stops:
            if not isinstance(stop, dict):
                raise ValueError(f"Invalid stop entry on line {line}")
            indexes.append(integer(stop.get("stop_index"), "stop_index", 1))
        if len(indexes) != len(set(indexes)):
            raise ValueError(f"Duplicate stop_index on line {line}")
        selected[line] = copy.deepcopy(route)
    return selected


def download_catalog(service_key: str, *, page_size: int = 100,
                     timeout: float = 15, retries: int = 2,
                     interval: float = 0.25) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    seen_pages: set[str] = set()
    seen_records: set[str] = set()
    expected_total: int | None = None
    for page in range(1, 10001):
        if page > 1:
            time.sleep(interval)
        payload = _request_json(STOP_ENDPOINT, service_key,
                                {"pageNo": page, "numOfRows": page_size},
                                timeout=timeout, retries=retries)
        _check_api_response(payload)
        total = integer(_find_field_recursive(payload, "totalCount"), "totalCount")
        returned_page = integer(_find_field_recursive(payload, "pageNo"), "pageNo", 1)
        if returned_page != page:
            raise BimsApiError(f"BIMS returned page {returned_page} when page {page} was requested")
        if expected_total is None:
            expected_total = total
        if total != expected_total:
            raise BimsApiError("Stop catalog changed during pagination; rerun to get a consistent catalog")
        items = _extract_items(payload)
        if not items or total == 0:
            raise BimsApiError("Empty or truncated BIMS stop catalog; existing cache was preserved")
        if any(not identifier(item.get("bstopid")) for item in items):
            raise BimsApiError("Stop catalog contains an entry without bstopid")
        signature = json.dumps(items, sort_keys=True, ensure_ascii=True)
        if signature in seen_pages:
            raise BimsApiError("BIMS repeated a catalog page; refusing incomplete pagination")
        fingerprints = {json.dumps(item, sort_keys=True, ensure_ascii=True) for item in items}
        if len(fingerprints) != len(items) or fingerprints & seen_records:
            raise BimsApiError("BIMS returned overlapping/duplicate catalog rows; rerun the download")
        seen_pages.add(signature)
        seen_records.update(fingerprints)
        records.extend(items)
        print(f"Stop catalog: page {page}, {len(records)}/{total} entries", flush=True)
        if len(records) > total:
            raise BimsApiError("BIMS stop catalog exceeds its reported totalCount")
        if len(records) == total:
            return {"version": 1, "complete": True, "generated_at_utc": utc_now(),
                    "source": STOP_ENDPOINT, "total_count": total, "stops": records}
    raise BimsApiError("Stop catalog exceeded the pagination limit")


def validate_catalog(catalog: dict[str, Any]) -> None:
    stops = catalog.get("stops")
    if (catalog.get("version") != 1 or catalog.get("complete") is not True
            or catalog.get("source") != STOP_ENDPOINT
            or not isinstance(stops, list) or not stops
            or catalog.get("total_count") != len(stops)
            or any(not isinstance(stop, dict) or not identifier(stop.get("bstopid")) for stop in stops)):
        raise ValueError("Invalid/incomplete static stop catalog; rerun with --refresh and a BIMS key")


def enrich_routes(routes: dict[str, Any], catalog: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    validate_catalog(catalog)
    by_ars: dict[str, list[dict[str, Any]]] = {}
    by_id: dict[str, list[dict[str, Any]]] = {}
    for item in catalog["stops"]:
        ars, stop_id = ars_identifier(item.get("arsno")), identifier(item.get("bstopid"))
        if ars:
            by_ars.setdefault(ars, []).append(item)
        by_id.setdefault(stop_id, []).append(item)
    generated = utc_now()
    cache = {"version": 1, "generated_at_utc": generated,
             "catalog_generated_at_utc": catalog.get("generated_at_utc"), "routes": {}}
    report: dict[str, Any] = {"version": 1, "generated_at_utc": generated,
                              "total_stops": 0, "matched_stops": 0, "lines": {}}
    for line, original in routes.items():
        route = copy.deepcopy(original)
        route["stops"].sort(key=lambda stop: integer(stop["stop_index"], "stop_index", 1))
        unresolved = []
        matched = 0
        for stop in route["stops"]:
            ars = ars_identifier(stop.get("ars_number"))
            node_id = identifier(stop.get("node_id"))
            candidates = by_ars.get(ars, []) if ars else by_id.get(node_id, [])
            method = "ars_number" if ars else "node_id"
            # An ID can disambiguate repeated ARS results, but an ID conflict
            # must not silently pick a same-number stop somewhere else.
            if node_id and candidates:
                candidates = [item for item in candidates if identifier(item.get("bstopid")) == node_id]
                if not candidates:
                    reason = "identifier_conflict"
                else:
                    reason = "ambiguous_match"
            else:
                reason = "ambiguous_match" if candidates else "not_found"
            unique = {json.dumps(item, sort_keys=True): item for item in candidates}
            candidates = list(unique.values())
            stop.update(stop_lat=None, stop_lon=None, coordinate_source=None, coordinate_match=None)
            if len(candidates) == 1:
                point = coordinates(candidates[0])
                if point is not None:
                    stop.update(stop_lat=point[0], stop_lon=point[1],
                                coordinate_source="busStopList", coordinate_match=method)
                    matched += 1
                    continue
                reason = "invalid_static_coordinates"
            unresolved.append({"stop_index": stop["stop_index"], "direction": stop.get("direction"),
                               "ars_number": stop.get("ars_number"), "node_id": stop.get("node_id"),
                               "stop_name": stop.get("stop_name"), "reason": reason})
        cache["routes"][line] = route
        report["lines"][line] = {"total_stops": len(route["stops"]), "matched_stops": matched,
                                 "unresolved_stops": unresolved}
        report["total_stops"] += len(route["stops"])
        report["matched_stops"] += matched
    report["unresolved_count"] = report["total_stops"] - report["matched_stops"]
    cache["complete"] = report["complete"] = report["unresolved_count"] == 0
    return cache, report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--lines", default=",".join(DEFAULT_LINES), help="Comma-separated public line numbers")
    result.add_argument("--routes", type=Path, default=DEFAULT_ROUTES, help="Recorded route metadata JSON")
    result.add_argument("--output", type=Path, default=PROJECT_DIR / "data" / "bims_route_cache.json")
    result.add_argument("--stop-cache", type=Path, help="Catalog path (default: beside output)")
    result.add_argument("--report", type=Path, help="Diagnostic report path (default: beside output)")
    mode = result.add_mutually_exclusive_group()
    mode.add_argument("--offline", action="store_true", help="Require saved catalog; never access BIMS")
    mode.add_argument("--refresh", action="store_true", help="Download a fresh complete stop catalog")
    result.add_argument("--page-size", type=int, default=100)
    result.add_argument("--timeout", type=float, default=15)
    result.add_argument("--retries", type=int, default=2)
    result.add_argument("--request-interval", type=float, default=0.25, help="Seconds between catalog pages")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    key = os.environ.get("BUSAN_BIMS_SERVICE_KEY", "").strip()
    try:
        if (not 1 <= args.page_size <= 1000 or not 0 <= args.retries <= 10
                or not math.isfinite(args.timeout) or args.timeout <= 0
                or not math.isfinite(args.request_interval) or args.request_interval < 0):
            raise ValueError("Use page-size 1..1000, retries 0..10, a positive timeout and a nonnegative request interval")
        lines = list(dict.fromkeys(line.strip() for line in args.lines.split(",") if line.strip()))
        if not lines:
            raise ValueError("At least one public line number is required")
        stop_path = args.stop_cache or args.output.parent / "bims_stop_catalog.json"
        report_path = args.report or args.output.parent / "bims_route_cache_report.json"
        paths = [args.routes.resolve(), args.output.resolve(), stop_path.resolve(), report_path.resolve()]
        if len(set(paths)) != len(paths):
            raise ValueError("Input, output, stop catalog and report paths must be different")
        routes = load_routes(args.routes, lines)
        if stop_path.exists() and not args.refresh:
            catalog = read_json(stop_path)
            validate_catalog(catalog)
            print(f"Reusing stop catalog: {stop_path}")
        else:
            if args.offline:
                raise ValueError(f"Offline mode requires a complete saved catalog: {stop_path}")
            if not key:
                raise ValueError("Set BUSAN_BIMS_SERVICE_KEY locally to download the static stop catalog")
            catalog = download_catalog(key, page_size=args.page_size, timeout=args.timeout,
                                       retries=args.retries, interval=args.request_interval)
            validate_catalog(catalog)
            write_json(stop_path, catalog)
        cache, report = enrich_routes(routes, catalog)
        cache["route_metadata_path"] = str(args.routes.resolve())
        write_json(report_path, report)
        write_json(args.output, cache)
        for line, summary in report["lines"].items():
            print(f"Line {line}: {summary['matched_stops']}/{summary['total_stops']} stops resolved")
        print(f"Route cache: {args.output}\nReport: {report_path}")
        if not report["complete"]:
            print(f"INCOMPLETE: {report['unresolved_count']} stops remain unresolved; see report.")
            return 2
        print("COMPLETE: all selected route stops have verified static coordinates.")
        return 0
    except (OSError, ValueError, BimsApiError) as exc:
        message = str(exc)
        if key:
            for secret in sorted({key, unquote(key), quote(key, safe="")}, key=len, reverse=True):
                if secret:
                    message = message.replace(secret, "[redacted]")
        print(f"Error: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
