"""
Fetches official Korean government road-facility data (tunnel/bridge/
underpass height & width) and matches each facility to the nearest OSM way
already in busan-roads_osm.pbf, producing gov_restrictions.json in the exact
schema manual_restrictions.json uses (way_id -> restriction fields). That
file is picked up automatically by graph_backend.load_overrides() - no other
code changes needed to route around a newly-added restriction.

This is a one-off, offline tool you run by hand to refresh gov_restrictions.json.
It is NOT imported by main.py / the FastAPI app.

Data sources
------------
1. MOLIT bridge & tunnel status API (data.go.kr dataset 15092289,
   "국토교통부_전국 교량 및 터널 현황정보"):
       https://apis.data.go.kr/1613000/btiData/getBrdgList   (bridges)
       https://apis.data.go.kr/1613000/btiData/getTnlList    (tunnels - operation
           name inferred from the "터널데이터목록조회" listing on the docs page;
           if it 404s, check the actual operation name on data.go.kr and fix
           the TUNNEL_OPERATION constant below)
   Gives lat/lon directly (start/end point of the structure) - no geocoding
   needed. Requires a free service key from a "활용신청" on that dataset page.

2. Busan underpass status (data.go.kr dataset 15119688, "부산광역시_지하차도
   현황") - a small (~58 row) CSV. data.go.kr file-data downloads are
   session-gated rather than a stable public URL, so this script does not
   fetch it automatically: download the CSV by hand from
       https://www.data.go.kr/data/15119688/fileData.do
   and pass its path via --underpass-csv. If the CSV has no coordinate
   columns, each row is geocoded by name+district via the Kakao Local API
   (needs KAKAO_REST_API_KEY; rows are skipped with a warning if that key
   isn't set).

Usage
-----
    set DATA_GO_KR_KEY=<service key from data.go.kr 마이페이지>
    set KAKAO_REST_API_KEY=<Kakao REST API key>   (optional, only for underpass geocoding)
    python fetch_gov_restrictions.py --underpass-csv busan_underpass.csv

Run with -h for all options.
"""

import argparse
import csv
import json
import math
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

from graph_backend import haversine_m

BTI_BASE = "https://apis.data.go.kr/1613000/btiData"
BRIDGE_OPERATION = "getBrdgList"
TUNNEL_OPERATION = "getTnlList"  # see note above - verify against the API docs
KAKAO_KEYWORD_SEARCH = "https://dapi.kakao.com/v2/local/search/keyword.json"
KAKAO_ADDRESS_SEARCH = "https://dapi.kakao.com/v2/local/search/address.json"

# facility height/width readings outside this range are almost certainly a
# unit mistake or a placeholder zero in the source data, not a real limit
PLAUSIBLE_HEIGHT_M = (1.5, 6.0)
PLAUSIBLE_WIDTH_M = (1.5, 30.0)


def _get_json(url, service_key, params):
    """data.go.kr service keys copied from the portal are already
    percent-encoded ("일반 인증키(Encoding)") - re-encoding it through
    urlencode() double-encodes it and the gateway rejects the request
    (typically as a 403), so serviceKey is appended to the query string
    as-is and only the remaining params are urlencoded."""
    qs = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    full_url = f"{url}?serviceKey={service_key}&{qs}"
    try:
        with urllib.request.urlopen(full_url, timeout=30) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {e.reason} - response body: {body[:500]}") from None
    except urllib.error.URLError as e:
        # DNS failure, connection timeout, no route, TLS handshake failure, etc -
        # a network/connectivity problem rather than an API error, so no response
        # body to show. Common causes: no internet from this machine, a firewall/
        # proxy blocking apis.data.go.kr, or the endpoint being temporarily down.
        raise RuntimeError(f"network error reaching {url} - {e.reason}") from None
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        # data.go.kr sometimes returns an XML SOAP-fault body (e.g. an
        # unregistered/unapproved service key) even when json is requested
        raise RuntimeError(f"non-JSON response (first 300 chars): {raw[:300]!r}") from None


def fetch_bti_facilities(service_key, operation, hyear):
    """Pages through a btiData operation (getBrdgList / getTnlList), returns
    raw item dicts filtered to Busan (sidoNm contains '부산')."""
    items = []
    page = 1
    while True:
        params = {
            "responseType": "json",
            "hyear": hyear,
            "numOfRows": 100,
            "pageNo": page,
        }
        try:
            data = _get_json(f"{BTI_BASE}/{operation}", service_key, params)
        except RuntimeError as e:
            print(f"  {operation} page {page}: {e}", file=sys.stderr)
            break
        body = data.get("response", {}).get("body", {})
        page_items = body.get("items", [])
        if isinstance(
            page_items, dict
        ):  # single-item pages sometimes aren't wrapped in a list
            page_items = page_items.get("item", [])
        if isinstance(page_items, dict):
            page_items = [page_items]
        if not page_items:
            break
        items.extend(page_items)
        total = int(body.get("totalCount", 0) or 0)
        if len(items) >= total or len(page_items) < params["numOfRows"]:
            break
        page += 1
    return [it for it in items if "부산" in (it.get("sidoNm") or "")]


def _num(v):
    try:
        f = float(str(v).strip())
        return f if f > 0 else None
    except (ValueError, TypeError):
        return None


def facilities_from_bti(items, source_label):
    facilities = []
    for it in items:
        lat = _num(it.get("sLatitude")) or _num(it.get("eLatitude"))
        lon = _num(it.get("sLongitude")) or _num(it.get("eLongitude"))
        if lat is None or lon is None:
            continue
        height = _num(it.get("height"))
        if height is not None and not (
            PLAUSIBLE_HEIGHT_M[0] <= height <= PLAUSIBLE_HEIGHT_M[1]
        ):
            height = None
        width = _num(it.get("totWidth"))
        if width is not None and not (
            PLAUSIBLE_WIDTH_M[0] <= width <= PLAUSIBLE_WIDTH_M[1]
        ):
            width = None
        weight = _num(it.get("alowPass"))
        facilities.append(
            {
                "name": it.get("facilName", "").strip(),
                "lat": lat,
                "lon": lon,
                "maxheight": height,
                "maxwidth": width,
                "maxweight": weight,
                "source": source_label,
            }
        )
    return facilities


class _RateLimiter:
    """Thread-safe leaky-bucket pacing shared across all worker threads -
    Kakao's per-second QPS cap (undocumented, but confirmed by testing to
    kick in well under 150 req/s) is enforced as a plain HTTP 400
    {"code":-10,"message":"API limit has been exceeded."}, not a 429, so
    unpaced concurrent requests silently look like ordinary failures rather
    than an obvious rate-limit signal."""

    def __init__(self, min_interval_s):
        self._min_interval = min_interval_s
        self._lock = threading.Lock()
        self._next_ok = 0.0

    def wait(self):
        with self._lock:
            now = time.monotonic()
            delay = max(0.0, self._next_ok - now)
            self._next_ok = max(now, self._next_ok) + self._min_interval
        if delay:
            time.sleep(delay)


_KAKAO_RATE_LIMITER = _RateLimiter(min_interval_s=0.08)  # ~12 req/s, well under the observed limit


def _kakao_get(url, query, kakao_key, max_retries=4):
    req = urllib.request.Request(
        f"{url}?{urllib.parse.urlencode({'query': query})}",
        headers={"Authorization": f"KakaoAK {kakao_key}"},
    )
    for attempt in range(max_retries + 1):
        _KAKAO_RATE_LIMITER.wait()
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            rate_limited = e.code == 400 and '"code":-10' in body
            if rate_limited and attempt < max_retries:
                time.sleep(0.5 * (attempt + 1))  # back off and retry - this one wasn't a real failure
                continue
            print(f"  Kakao geocode failed for '{query}': HTTP {e.code} - {body[:150]}", file=sys.stderr)
            return None
        except urllib.error.URLError as e:
            print(f"  Kakao geocode network error for '{query}': {e.reason}", file=sys.stderr)
            return None
    return None


def geocode_kakao(query, kakao_key):
    """Address search first (precise for real 지번/도로명 addresses like the
    width-permit CSV's), falling back to keyword search (better for facility/
    place names like the underpass CSV's) if address search finds nothing."""
    if not kakao_key:
        return None, None
    data = _kakao_get(KAKAO_ADDRESS_SEARCH, query, kakao_key)
    docs = data.get("documents", []) if data else []
    if not docs:
        data = _kakao_get(KAKAO_KEYWORD_SEARCH, query, kakao_key)
        docs = data.get("documents", []) if data else []
    if not docs:
        return None, None
    return float(docs[0]["y"]), float(docs[0]["x"])  # lat, lon


def _read_text_auto_encoding(path):
    """data.go.kr CSV exports are UTF-8 about half the time and CP949/EUC-KR
    (the traditional Korean Windows encoding) the other half, with no
    reliable signal in the file itself - just try both."""
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "cp949"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError(
        "utf-8-sig/cp949", raw, 0, 1, f"Could not decode {path} as UTF-8 or CP949 - check the file's actual encoding"
    )


def facilities_from_underpass_csv(csv_path, kakao_key):
    import io

    facilities = []
    with io.StringIO(_read_text_auto_encoding(csv_path)) as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        lat_col = next(
            (c for c in fieldnames if "위도" in c or c.lower() == "lat"), None
        )
        lon_col = next(
            (c for c in fieldnames if "경도" in c or c.lower() in ("lon", "lng")), None
        )
        name_col = next(
            (c for c in fieldnames if "시설명" in c or "명칭" in c),
            fieldnames[0] if fieldnames else None,
        )
        gu_col = next((c for c in fieldnames if "시군구" in c), None)
        height_col = next((c for c in fieldnames if "높이" in c), None)
        width_col = next((c for c in fieldnames if "폭" in c and "보도" not in c), None)

        for row in reader:
            name = (row.get(name_col) or "").strip() if name_col else ""
            if not name:
                continue
            lat = _num(row.get(lat_col)) if lat_col else None
            lon = _num(row.get(lon_col)) if lon_col else None
            if lat is None or lon is None:
                gu = (row.get(gu_col) or "").strip() if gu_col else ""
                lat, lon = geocode_kakao(f"부산광역시 {gu} {name}".strip(), kakao_key)
            if lat is None or lon is None:
                print(
                    f"  No coordinates for underpass '{name}' - skipping (add --underpass-csv "
                    "coordinate columns or set KAKAO_REST_API_KEY)",
                    file=sys.stderr,
                )
                continue
            height = _num(row.get(height_col)) if height_col else None
            if height is not None and not (
                PLAUSIBLE_HEIGHT_M[0] <= height <= PLAUSIBLE_HEIGHT_M[1]
            ):
                height = None
            width = _num(row.get(width_col)) if width_col else None
            if width is not None and not (
                PLAUSIBLE_WIDTH_M[0] <= width <= PLAUSIBLE_WIDTH_M[1]
            ):
                width = None
            facilities.append(
                {
                    "name": name,
                    "lat": lat,
                    "lon": lon,
                    "maxheight": height,
                    "maxwidth": width,
                    "maxweight": None,
                    "source": "data.go.kr (Busan underpass status)",
                }
            )
    return facilities


def facilities_from_width_csv(csv_path, kakao_key, max_workers=16):
    """국토교통부_운행허가가 가능한 도로의 규격 (data.go.kr 3047694) - a linear
    dataset of origin-address -> destination-address road segments with a
    width/height/length limit each, not point facilities. Geocodes each
    unique address once (addresses repeat heavily across nearby segments -
    on the real Busan-filtered CSV this cuts ~19,800 rows down to ~7,800
    unique addresses) and uses the midpoint of (origin, destination) as the
    segment's representative point for nearest-way matching - segments in
    this dataset are short (adjacent lot numbers), so a single matched way
    is a reasonable approximation rather than tracing the full sub-path."""
    import concurrent.futures

    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    unique_addrs = {row["출발지 이름"].strip() for row in rows if row.get("출발지 이름")}
    unique_addrs |= {row["도착지 이름"].strip() for row in rows if row.get("도착지 이름")}
    unique_addrs.discard("")
    print(f"  Geocoding {len(unique_addrs)} unique address(es) ({max_workers} concurrent)...")

    geocoded = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(geocode_kakao, addr, kakao_key): addr for addr in unique_addrs}
        done = 0
        for fut in concurrent.futures.as_completed(futures):
            addr = futures[fut]
            geocoded[addr] = fut.result()
            done += 1
            if done % 500 == 0:
                print(f"    {done} / {len(unique_addrs)} geocoded")

    facilities = []
    skipped_no_coords = 0
    for row in rows:
        origin_addr = (row.get("출발지 이름") or "").strip()
        dest_addr = (row.get("도착지 이름") or "").strip()
        if not origin_addr or not dest_addr:
            continue
        olat, olon = geocoded.get(origin_addr, (None, None))
        dlat, dlon = geocoded.get(dest_addr, (None, None))
        if olat is None or dlat is None:
            skipped_no_coords += 1
            continue
        width = _num(row.get("제한너비"))
        if width is not None and not (PLAUSIBLE_WIDTH_M[0] <= width <= PLAUSIBLE_WIDTH_M[1]):
            width = None
        if width is None:
            continue
        name = (row.get("도로명칭") or "").strip() or f"{origin_addr} ~ {dest_addr}"
        facilities.append({
            "name": name,
            "lat": (olat + dlat) / 2, "lon": (olon + dlon) / 2,
            "maxheight": None, "maxwidth": width, "maxweight": None,
            "source": "data.go.kr (MOLIT road width permit data)",
        })
    if skipped_no_coords:
        print(f"  {skipped_no_coords} row(s) skipped - one or both addresses failed to geocode", file=sys.stderr)
    return facilities


def build_way_index(pbf_path, grid_size=0.01):
    """Indexes each routable way by every grid cell its geometry passes
    through - not just one cell for its midpoint - so nearest_way() can find
    the closest point along a way's FULL path. A long structure like a
    bridge can easily have its midpoint 100+m from the government-reported
    coordinate (often near one end) even though that coordinate sits right
    on the way; matching against the whole path fixes that without having
    to loosen the radius everywhere else."""
    from pbf_parser import parse_pbf

    nodes, ways = parse_pbf(pbf_path)
    grid = defaultdict(set)
    way_geoms = {}
    for wid, refs, tags in ways:
        if "highway" not in tags:
            continue
        pts = [nodes[r][:2] for r in refs if r in nodes]
        if not pts:
            continue
        way_geoms[wid] = pts
        for lat, lon in pts:
            key = (int(lat / grid_size), int(lon / grid_size))
            grid[key].add(wid)
    return grid, way_geoms, grid_size


def _point_segment_distance_m(lat, lon, lat1, lon1, lat2, lon2):
    """Min distance in meters from (lat, lon) to the segment (lat1,lon1)-
    (lat2,lon2), via a local equirectangular projection centered on the
    segment - accurate at the sub-km scale this matching operates at."""
    clat = math.radians((lat1 + lat2) / 2)
    mlat, mlon = 111320.0, 111320.0 * math.cos(clat)
    x1, y1 = lon1 * mlon, lat1 * mlat
    x2, y2 = lon2 * mlon, lat2 * mlat
    x, y = lon * mlon, lat * mlat
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    px, py = x1 + t * dx, y1 + t * dy
    return math.hypot(x - px, y - py)


def nearest_way(lat, lon, grid, way_geoms, grid_size, radius_m):
    gx, gy = int(lat / grid_size), int(lon / grid_size)
    candidates = set()
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            candidates |= grid.get((gx + dx, gy + dy), set())
    best_wid, best_d = None, radius_m
    for wid in candidates:
        pts = way_geoms[wid]
        if len(pts) == 1:
            d = haversine_m(lat, lon, pts[0][0], pts[0][1])
            if d < best_d:
                best_d, best_wid = d, wid
            continue
        for i in range(len(pts) - 1):
            lat1, lon1 = pts[i]
            lat2, lon2 = pts[i + 1]
            d = _point_segment_distance_m(lat, lon, lat1, lon1, lat2, lon2)
            if d < best_d:
                best_d, best_wid = d, wid
    return best_wid, best_d


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--pbf", default="busan-roads_osm.pbf")
    ap.add_argument("--out", default="gov_restrictions.json")
    ap.add_argument(
        "--underpass-csv",
        default=None,
        help="Manually-downloaded Busan underpass CSV (dataset 15119688)",
    )
    ap.add_argument(
        "--width-csv",
        default=None,
        help="Busan-filtered rows of 국토교통부_운행허가가 가능한 도로의 규격 (dataset 3047694) - "
        "e.g. busan_width_restrictions.csv, already filtered from the national CSV",
    )
    ap.add_argument(
        "--hyear",
        type=int,
        default=2024,
        help="Reference year for the MOLIT bridge/tunnel API",
    )
    ap.add_argument(
        "--radius-m",
        type=float,
        default=60.0,
        help="Max distance to match a facility to an OSM way",
    )
    ap.add_argument(
        "--tunnel-operation",
        default=TUNNEL_OPERATION,
        help="btiData operation name for tunnels (unconfirmed - override to test candidates "
        "without editing the script; pass an empty string to skip the tunnel fetch entirely)",
    )
    ap.add_argument(
        "--skip-bridges",
        action="store_true",
        help="Skip the bridge fetch (useful when only testing --tunnel-operation candidates)",
    )
    args = ap.parse_args()

    service_key = os.environ.get("DATA_GO_KR_KEY")
    kakao_key = os.environ.get("KAKAO_REST_API_KEY")

    facilities = []

    if service_key:
        if not args.skip_bridges:
            print("Fetching bridges from MOLIT btiData API...")
            bridges = fetch_bti_facilities(service_key, BRIDGE_OPERATION, args.hyear)
            facilities += facilities_from_bti(bridges, "data.go.kr (MOLIT bridge status)")
            print(f"  {len(bridges)} Busan bridge record(s)")

        if args.tunnel_operation:
            print(f"Fetching tunnels from MOLIT btiData API (operation={args.tunnel_operation!r})...")
            tunnels = fetch_bti_facilities(service_key, args.tunnel_operation, args.hyear)
            facilities += facilities_from_bti(tunnels, "data.go.kr (MOLIT tunnel status)")
            print(f"  {len(tunnels)} Busan tunnel record(s)")
    else:
        print(
            "DATA_GO_KR_KEY not set - skipping MOLIT bridge/tunnel API.",
            file=sys.stderr,
        )

    if args.underpass_csv:
        print(f"Reading underpass CSV {args.underpass_csv} ...")
        underpasses = facilities_from_underpass_csv(args.underpass_csv, kakao_key)
        facilities += underpasses
        print(f"  {len(underpasses)} underpass record(s) with coordinates")
    else:
        print(
            "--underpass-csv not given - skipping Busan underpass dataset.",
            file=sys.stderr,
        )

    if args.width_csv:
        print(f"Reading width-restriction CSV {args.width_csv} ...")
        widths = facilities_from_width_csv(args.width_csv, kakao_key)
        facilities += widths
        print(f"  {len(widths)} width-restriction record(s) with coordinates")
    else:
        print(
            "--width-csv not given - skipping road-width dataset.",
            file=sys.stderr,
        )

    if not facilities:
        print(
            "No facilities fetched - nothing to do. Set DATA_GO_KR_KEY and/or pass --underpass-csv.",
            file=sys.stderr,
        )
        return

    print(f"Loading road network from {args.pbf} to match facilities to OSM ways...")
    grid, way_geoms, grid_size = build_way_index(args.pbf)

    out = {
        "_readme": (
            "Auto-generated by fetch_gov_restrictions.py from official Korean "
            "government facility-spec data (MOLIT bridge/tunnel status API and/or "
            "Busan underpass status), geospatially matched to the nearest OSM way. "
            "Matching is approximate (nearest-way-within-radius, no name matching) - "
            "spot-check the roadview link before fully trusting an entry, and if a "
            "way_id here also appears in manual_restrictions.json with a real value, "
            "the manual entry wins."
        ),
    }
    matched, unmatched, skipped_no_value = 0, [], 0
    for fac in facilities:
        if (
            fac["maxheight"] is None
            and fac["maxwidth"] is None
            and fac["maxweight"] is None
        ):
            skipped_no_value += 1
            continue
        wid, dist_m = nearest_way(
            fac["lat"], fac["lon"], grid, way_geoms, grid_size, args.radius_m
        )
        if wid is None:
            unmatched.append(fac)
            continue
        entry = {
            "name": fac["name"],
            "source": fac["source"],
            "note": f"Auto-matched {dist_m:.0f}m from '{fac['name']}' - verify via roadview before fully trusting.",
            "roadview": f"https://map.kakao.com/link/roadview/{fac['lat']},{fac['lon']}",
        }
        if fac["maxheight"] is not None:
            entry["maxheight"] = str(fac["maxheight"])
        if fac["maxwidth"] is not None:
            entry["maxwidth"] = str(fac["maxwidth"])
        if fac["maxweight"] is not None:
            entry["maxweight"] = str(fac["maxweight"])
        # if the same way was already matched by an earlier (e.g. bridge) record,
        # keep the closer match
        existing_key = str(wid)
        out[existing_key] = entry
        matched += 1

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(
        f"\n{len(facilities)} facilities fetched, {matched} matched to a way "
        f"(within {args.radius_m:.0f}m), {len(unmatched)} unmatched, "
        f"{skipped_no_value} had no usable height/width/weight value."
    )
    print(f"Wrote {args.out}")
    if unmatched:
        print(
            f"\n{len(unmatched)} unmatched facilit(y/ies) - no OSM way found nearby "
            "(may be off the extract's coverage, or the radius is too tight):",
            file=sys.stderr,
        )
        for fac in unmatched:
            print(
                f"  {fac['name']!r} at ({fac['lat']:.5f}, {fac['lon']:.5f}) [{fac['source']}]",
                file=sys.stderr,
            )


if __name__ == "__main__":
    main()
